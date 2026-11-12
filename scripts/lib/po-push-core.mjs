// VPS PO 推送器核心 —— 可 import 测试，import 本模块不产生任何副作用
// （不读 env、不连网、不启动轮询、不推送）。入口 scripts/tj-po-push.mjs 只负责装配依赖。
//
// 安全边界（永久）：
//   * 合并单（combined）不推送——永久冻结。
//   * 合并单的来源单不推送——必须查来源关系（source_po_ids），不能只看 status。
//     来源判定用「针对当前 po_id 的服务端 array contains + limit 1」定向查询，
//     不拉全量合并单（全量第一页会漏掉分页之外的引用），且拒绝发生在 bridge 之前。
//   * 普通 standard 单保持原路径：pending_push -> 生成 7 列 PO_Lines -> bridge write -> exported。
//   * 显式 public schema（Accept-Profile / Content-Profile: public），避免被 PostgREST
//     默认 schema 或环境变量悄悄切到预览库。
//   * GR 正式 push/post 不在此实现，永远不启用。
import { buildPoLineRows, EXPORT_MODE_STANDARD, EXPORT_MODE_COMBINED } from '../../web/src/lib/core/po-lines.js'
import { assertVerifiedApprovedSnapshot } from '../../web/src/lib/core/approved-snapshot.js'
import { buildWorkbook } from '../../web/src/lib/core/xlsx.js'
import { evaluatePushEligibility } from '../../web/src/lib/core/push-policy.js'

export const PUBLIC_SCHEMA = 'public'
export const BRIDGE_URL = 'http://127.0.0.1:9000'
export const TARGET_DIR = 'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Pending'
export const POLL_SEC = 30

/** 生成 Supabase REST 访问器：只走显式 schema，调用方可注入 fetch 做测试 */
export function createSupabaseRest({
  url,
  serviceKey,
  fetchImpl = fetch,
  schema = PUBLIC_SCHEMA,
} = {}) {
  if (!url || !serviceKey) {
    throw new Error('缺 Supabase 凭据（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）')
  }
  // 推送器只允许生产 public：任何注入 tj_preview/其他 schema 的装配都直接失败，
  // 防止误配环境把预览测试单写进 Windows Queue。
  if (schema !== PUBLIC_SCHEMA) {
    throw new Error(
      `推送器只允许 public schema，拒绝注入 schema=${String(schema)}（预览库不可进入 Windows Queue）`,
    )
  }
  return async function sbFetch(pathname, opts = {}) {
    const method = (opts.method ?? 'GET').toUpperCase()
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
      'Accept-Profile': schema,
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
      headers['Content-Profile'] = schema
    }
    const r = await fetchImpl(`${url}/rest/v1/${pathname}`, {
      method,
      headers,
      body: opts.body,
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }
}

/**
 * Postgres 数组字面量（用于 PostgREST `cs.` 过滤）：元素一律双引号包裹并转义，
 * 防止 PO 编号里的符号破坏过滤表达式（筛选注入）。
 * @param {string[]} values
 * @returns {string} 例如 {"PO-000001"}
 */
export function postgresArrayLiteral(values) {
  const esc = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return `{${(values ?? []).map(esc).join(',')}}`
}

/**
 * 来源关系查询路径：只查「当前 po_id 是否被某个合并单引用」，
 * 服务端 array contains + limit 1 —— 不拉全量合并单、不分页、不受第一页影响。
 * @param {string} poNumber
 * @returns {string} 例如 tj_po_headers?select=...&po_type=eq.combined&source_po_ids=cs.%7B...%7D&limit=1
 */
export function buildOwnerLookupPath(poNumber) {
  const filter = `cs.${postgresArrayLiteral([poNumber])}`
  return (
    'tj_po_headers?select=po_id,po_type,source_po_ids' +
    '&po_type=eq.combined' +
    `&source_po_ids=${encodeURIComponent(filter)}` +
    '&limit=1'
  )
}

/** 桥（Windows 侧 write 服务）调用器 */
export function createBridgeCall({ bridgeUrl = BRIDGE_URL, fetchImpl = fetch } = {}) {
  return async function bridgeCall(payload) {
    const r = await fetchImpl(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}: ${text}`)
    return JSON.parse(text)
  }
}

/**
 * 创建推送器。依赖全部注入，测试用 mock 即可证明「拒绝路径 bridge 零调用」。
 * @param {{sbFetch: Function, bridgeCall: Function, log?: object, now?: () => Date, targetDir?: string}} deps
 */
export function createPusher({
  sbFetch,
  bridgeCall,
  log = console,
  now = () => new Date(),
  targetDir = TARGET_DIR,
} = {}) {
  if (typeof sbFetch !== 'function') throw new Error('createPusher 需要 sbFetch')
  if (typeof bridgeCall !== 'function') throw new Error('createPusher 需要 bridgeCall')

  async function fetchPending() {
    const rows = await sbFetch('tj_po_headers?select=*&status=eq.pending_push&order=created_at')
    return Array.isArray(rows) ? rows : []
  }

  /** 定向查「这个 po_id 被哪个合并单引用」：服务端 array contains + limit 1 */
  async function findSourceOwners(poNumber) {
    if (!poNumber) return []
    const rows = await sbFetch(buildOwnerLookupPath(poNumber))
    return Array.isArray(rows) ? rows : []
  }

  /** 读最新 header 事实：不信任调用方/上一轮列表里的旧行（状态、po_type 都可能已变） */
  async function readHeaderById(id) {
    if (!id) throw new Error('缺少 header.id，无法读取最新单据事实')
    const rows = await sbFetch(
      `tj_po_headers?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    )
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`找不到待推送的采购单（id=${id}）`)
    }
    return rows[0]
  }

  /** PAD 格式生成器：普通单 7 列；合并单内部验证 8 列（不解除 pushOne 的冻结）。 */
  async function buildXlsx(header, lines) {
    const combined = header?.po_type === 'combined'
    if (combined) await assertVerifiedApprovedSnapshot(header, lines)
    const { columns, rows } = buildPoLineRows(header, lines, {
      mode: combined ? EXPORT_MODE_COMBINED : EXPORT_MODE_STANDARD,
    })
    const blob = await buildWorkbook([{ name: 'PO_Lines', columns, rows }])
    return Buffer.from(await blob.arrayBuffer())
  }

  async function pushOne(header) {
    // 深度防御：pushOne 可能被直接调用（不经 runOnce），必须自行查来源关系后判定，
    // 不能信任调用方是否做过批量检查。任何拒绝都必须发生在 bridge 之前。
    if (header?.po_type === 'combined') {
      throw new Error('合并单永久冻结推送（po_type=combined）')
    }
    // 读最新事实：列表行可能是旧的（状态被改回、po_type 被改），以库为准
    const latest = await readHeaderById(header?.id)
    if (latest?.po_type === 'combined') {
      throw new Error('合并单永久冻结推送（po_type=combined）')
    }
    const owners = await findSourceOwners(latest.po_id)
    const verdict = evaluatePushEligibility({ header: latest, combinedHeaders: owners })
    if (!verdict.allowed) {
      throw new Error(`${verdict.code}: ${verdict.reason}`)
    }
    const lines = await sbFetch(
      `tj_po_lines?select=*&po_header_id=eq.${encodeURIComponent(latest.id)}&order=line_no`,
    )
    const buf = await buildXlsx(latest, Array.isArray(lines) ? lines : [])
    const filename = `${latest.po_id}.xlsx`
    const winPath = `${targetDir}\\${filename}`
    const res = await bridgeCall({ write: { path: winPath, b64: buf.toString('base64') } })
    if (!res || !res.ok) {
      throw new Error('bridge write 失败: ' + (res?.error || JSON.stringify(res)))
    }
    const nowIso = now().toISOString()
    await sbFetch('tj_po_exports', {
      method: 'POST',
      body: JSON.stringify({
        po_header_id: latest.id,
        po_id: latest.po_id,
        filename,
        exported_at: nowIso,
      }),
    })
    await sbFetch(`tj_po_headers?id=eq.${encodeURIComponent(latest.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'exported', updated_at: nowIso }),
    })
    return filename
  }

  /** 跑一轮：返回结构化结果，便于 cron 日志与测试断言 */
  async function runOnce() {
    const pending = await fetchPending()
    const summary = {
      scanned: pending.length,
      pushed: [],
      rejected: [],
      failed: [],
    }
    for (const header of pending) {
      // 合并单直接判定，不发任何关系查询
      if (header?.po_type === 'combined') {
        const verdict = evaluatePushEligibility({ header, combinedHeaders: [] })
        summary.rejected.push({ po_id: header.po_id, code: verdict.code, reason: verdict.reason })
        log.log(`[reject] ${header.po_id} ${verdict.code}: ${verdict.reason}`)
        continue
      }
      let owners
      try {
        owners = await findSourceOwners(header?.po_id)
      } catch (e) {
        // 关系查询失败 = 无法证明安全 → 不推送（fail closed）
        summary.failed.push({ po_id: header?.po_id, error: `来源关系查询失败：${e.message}` })
        log.error(`[err] ${header?.po_id}: 来源关系查询失败：${e.message}`)
        continue
      }
      const verdict = evaluatePushEligibility({ header, combinedHeaders: owners })
      if (!verdict.allowed) {
        summary.rejected.push({ po_id: header.po_id, code: verdict.code, reason: verdict.reason })
        log.log(`[reject] ${header.po_id} ${verdict.code}: ${verdict.reason}`)
        continue
      }
      try {
        const filename = await pushOne(header)
        summary.pushed.push({ po_id: header.po_id, filename })
        log.log(`[ok] ${header.po_id} -> ${filename} (${now().toISOString()})`)
      } catch (e) {
        summary.failed.push({ po_id: header.po_id, error: e.message })
        log.error(`[err] ${header.po_id}: ${e.message}`)
      }
    }
    return summary
  }

  return { runOnce, pushOne, buildXlsx, fetchPending, findSourceOwners, readHeaderById }
}
