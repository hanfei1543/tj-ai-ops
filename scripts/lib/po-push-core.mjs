// VPS PO 推送器核心 —— 可 import 测试，import 本模块不产生任何副作用
// （不读 env、不连网、不启动轮询、不推送）。入口 scripts/tj-po-push.mjs 只负责装配依赖。
//
// 安全边界（永久）：
//   * 合并单（combined）不推送——永久冻结。
//   * 合并单的来源单不推送——必须查来源关系（source_po_ids），不能只看 status。
//     来源判定用「针对当前 po_id 的服务端 array contains + limit 1」定向查询，
//     不拉全量合并单（全量第一页会漏掉分页之外的引用），且拒绝发生在 bridge 之前。
//   * 普通 standard 单保持原路径：pending_push -> 生成 8 列 PO_Lines（含 Website PO Date）-> bridge write -> exported。
//     Website PO Date 必须是显式业务日期；缺失/非法即 fail closed，绝不退回旧 7 列。
//   * 显式 public schema（Accept-Profile / Content-Profile: public），避免被 PostgREST
//     默认 schema 或环境变量悄悄切到预览库。
//   * GR 正式 push/post 不在此实现，永远不启用。
import { createHash } from 'node:crypto'
import { buildPoLineRows, EXPORT_MODE_STANDARD, EXPORT_MODE_COMBINED } from '../../web/src/lib/core/po-lines.js'
import { assertVerifiedApprovedSnapshot } from '../../web/src/lib/core/approved-snapshot.js'
import { buildWorkbook } from '../../web/src/lib/core/xlsx.js'
import { evaluatePushEligibility } from '../../web/src/lib/core/push-policy.js'

export const PUBLIC_SCHEMA = 'public'
export const BRIDGE_URL = 'http://127.0.0.1:9000'
export const TARGET_DIR = 'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Pending'
export const POLL_SEC = 30

// ---------------------------------------------------------------------------
// PO Push 投递幂等：不确定投递窗口（第一版修正）。
//
// 规则（用户明确要求，不得放宽）：
//   1) 调用 bridge 之前，先持久化 dispatch_started 投递意图。
//   2) bridge 已被调用、但网站尚未可靠记录 delivered 就发生异常
//      （含 bridge 抛错 / ok:false / 记录 delivered 失败）→ 一律标记
//      delivery_uncertain，绝不允许自动再次发送。
//   3) 同一个 PO（按 po_header_id）即使 content_sha256 不同，也不能凭新的
//      唯一键再投递——必须检查该 PO 是否已存在任何历史投递意图。
//   4) 不得因为 Windows Pending 文件不存在就认为可以重新投递。
//   5) 防重复：一旦该 PO 已进入投递（dispatch_started / delivered / uncertain），
//      不得再生成 Pending 文件（防止 Windows 已移入 Processing 后再写 Pending）。
//
// 投递意图表 tj_po_push_intents 是投递的唯一真相源（schema 见
// supabase/migrations/20261114_po_push_intents.sql，尚未应用）：
//   UNIQUE(po_header_id) —— 一个 PO 一生只允许一条投递意图（覆盖规则 3）。
//   state ∈ dispatch_started | delivered | delivery_uncertain | needs_review
// ---------------------------------------------------------------------------
export const PUSH_INTENT_TABLE = 'tj_po_push_intents'

export const PUSH_INTENT_STATES = Object.freeze({
  DISPATCH_STARTED: 'dispatch_started',
  DELIVERED: 'delivered',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
  NEEDS_REVIEW: 'needs_review',
})

/** 数值归一为规范十进制串：12.50 / "12.500000" / 12.5 → 都归一到 "12.5"。
 * 保证同一存储值无论 PostgREST 以 number 或 string 返回，内容摘要一致。
 *
 * 精度安全（重要）：字符串输入绝不经过 Number —— Number 会把大数（> 2^53）或
 * 6 位小数的长整数舍入掉。numeric(20,6) 由 PostgREST 以字符串返回，这里必须
 * 纯字符串归一，避免内容摘要把两个不同的大数误判为同 sha。 */
export function normalizeDecimal(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '') return null
  // number（JSON number，已是 float，精度在解析时定死，无法恢复）：只做有限性检查
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    return String(v)
  }
  return normalizeDecimalString(s)
}

/** 展开指数记法：1e3 → 1000；1.5e-3 → 0.0015。返回 null 表示非法。 */
function expandExponent(s) {
  const [mant, expStr] = s.split(/[eE]/)
  const exp = parseInt(expStr, 10)
  if (!Number.isInteger(exp)) return null
  const [intPart, fracPart = ''] = mant.split('.')
  const digits = intPart + fracPart
  const pointPos = intPart.length + exp
  if (pointPos <= 0) return '0.' + '0'.repeat(-pointPos) + digits
  if (pointPos >= digits.length) return digits + '0'.repeat(pointPos - digits.length)
  return digits.slice(0, pointPos) + '.' + digits.slice(pointPos)
}

/** 纯字符串十进制归一：去正负号、展开指数、去前导零与尾随零；非法返回 null。 */
function normalizeDecimalString(s) {
  if (/^(nan|infinity|\+?infinity|-infinity)$/i.test(s)) return null
  let str = s
  let neg = false
  if (str[0] === '+') str = str.slice(1)
  if (str[0] === '-') {
    neg = true
    str = str.slice(1)
  }
  if (/[eE]/.test(str)) {
    str = expandExponent(str)
    if (str === null) return null
  }
  const m = /^(\d+)(?:\.(\d*))?$/.exec(str)
  if (!m) return null
  let intPart = m[1].replace(/^0+(?=\d)/, '')
  let fracPart = (m[2] ?? '').replace(/0+$/, '')
  const out = intPart + (fracPart ? '.' + fracPart : '')
  return neg && out !== '0' ? '-' + out : out
}

/**
 * XLSX 文件字节指纹（与 ACK source_sha256 / 投递清单 xlsx_sha256 同算法同字节）：
 * sha256 over 导出文件的精确 bytes，小写 hex。绝不与 content_sha256（业务 JSON）互比。
 * @param {Buffer|Uint8Array|ArrayBuffer} bytes
 * @returns {string} 64 位小写十六进制
 */
export function computeXlsxSha256(bytes) {
  if (bytes === null || bytes === undefined) {
    throw new Error('computeXlsxSha256 需要 XLSX 文件字节（不能对空值计算哈希）')
  }
  let buf
  if (Buffer.isBuffer(bytes)) buf = bytes
  else if (bytes instanceof Uint8Array) buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  else if (bytes instanceof ArrayBuffer) buf = Buffer.from(bytes)
  else {
    throw new Error(
      'computeXlsxSha256 只接受 Buffer / Uint8Array / ArrayBuffer（Blob 请先 await arrayBuffer()）',
    )
  }
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 投递内容指纹：只取业务字段（排除 status/updated_at/created_at/frozen/po_revision
 * 等可变状态），按固定键序 JSON 序列化后 sha256。同 PO 同内容恒同 sha；改任何
 * 业务字段（含 website_po_date / 行 qty / 单价 / 描述）必得不同 sha。
 */
export function computePushContentSha256(header, lines) {
  const h = header ?? {}
  const headerPart = {
    po_type: h.po_type ?? null,
    supplier_code: h.supplier_code ?? null,
    supplier_name: h.supplier_name ?? null,
    website_po_date: h.website_po_date ?? null,
  }
  const ls = (Array.isArray(lines) ? lines : []).map((l) => ({
    item_code: l.item_code ?? null,
    description: l.description ?? null,
    uom: l.uom ?? null,
    qty: normalizeDecimal(l.qty),
    unit_price: normalizeDecimal(l.unit_price),
    original_qty: l.original_qty != null ? normalizeDecimal(l.original_qty) : null,
  }))
  const canonical = JSON.stringify({ header: headerPart, lines: ls })
  return createHash('sha256').update(canonical).digest('hex')
}

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

  /** 查该 PO 是否已存在任何历史投递意图（规则 3/4/5：按 po_header_id，不看 sha） */
  async function findIntentByPoHeader(poHeaderId) {
    const rows = await sbFetch(
      `${PUSH_INTENT_TABLE}?select=*&po_header_id=eq.${encodeURIComponent(poHeaderId)}&order=created_at.desc&limit=1`,
    )
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  }

  /** 规则 1：调用 bridge 之前先持久化 dispatch_started（UNIQUE(po_header_id) 兜底并发） */
  async function insertIntent({ poHeaderId, poId, contentSha256, xlsxSha256 = null, state }) {
    await sbFetch(PUSH_INTENT_TABLE, {
      method: 'POST',
      body: JSON.stringify({
        po_header_id: poHeaderId,
        po_id: poId,
        content_sha256: contentSha256,
        // 文件字节指纹：ACK 的 source_sha256 只与这个比较（绝不与 content_sha256 互比）
        xlsx_sha256: xlsxSha256,
        state,
      }),
    })
  }

  /** 更新该 PO 投递意图状态（+ 可选错误说明），只按 po_header_id 定位 */
  async function updateIntentState(poHeaderId, state, extra = {}) {
    await sbFetch(`${PUSH_INTENT_TABLE}?po_header_id=eq.${encodeURIComponent(poHeaderId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state, updated_at: now().toISOString(), ...extra }),
    })
  }

  /** 把单据从 pending_push 拉回 confirmed，让轮询停止重扫（意图表仍是真相源，阻断重投） */
  async function stopPollingForReview(poHeaderId, error) {
    try {
      await sbFetch(`tj_po_headers?id=eq.${encodeURIComponent(poHeaderId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'confirmed', updated_at: now().toISOString() }),
      })
    } catch (e) {
      // 拉回失败不致命：意图表仍是真相源，下次仍会在这里阻断；仅记日志
      log.error(`[warn] ${poHeaderId} 停止轮询（confirmed）失败：${e.message}`)
    }
    return error
  }

  /** PAD 格式生成器：普通单 8 列（含 Website PO Date）；合并单内部验证 8 列（不解除 pushOne 的冻结）。 */
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
    const contentSha = computePushContentSha256(latest, Array.isArray(lines) ? lines : [])

    // 规则 3/4/5：任何历史投递意图都不允许自动重投——按 po_header_id 判定，
    // 不看 content_sha256 是否相同，也不看 Windows Pending 文件是否存在。
    const existing = await findIntentByPoHeader(latest.id)
    if (existing) {
      const prevState = existing.state
      const prevSha = existing.content_sha256
      // 幂等重放：同 PO 同内容已 delivered → 只补状态 exported，绝不再次写 bridge。
      if (prevState === PUSH_INTENT_STATES.DELIVERED && prevSha === contentSha) {
        log.log(`[replay] ${latest.po_id} 已投递（同内容），补状态 exported，不重复发送`)
        await sbFetch(`tj_po_headers?id=eq.${encodeURIComponent(latest.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'exported', updated_at: now().toISOString() }),
        })
        return existing.filename ?? `${latest.po_id}.xlsx`
      }
      // 残留 dispatch_started（上次进程在 bridge 调用期间中断）→ 升级为 delivery_uncertain。
      if (prevState === PUSH_INTENT_STATES.DISPATCH_STARTED) {
        await updateIntentState(latest.id, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, {
          error: '上次投递在 bridge 调用期间中断，结果不确定',
        })
      }
      const reason =
        prevSha !== contentSha
          ? `该 PO 已存在历史投递意图（内容 sha 不同：${prevSha} ≠ ${contentSha}），拒绝自动重投`
          : `该 PO 已有投递意图处于 ${prevState}，拒绝自动重投`
      throw new Error(
        await stopPollingForReview(
          latest.id,
          `${reason}：请人工核对 Windows Queue 实况后再决定，绝不因 Pending 不存在而重发`,
        ),
      )
    }

    const buf = await buildXlsx(latest, Array.isArray(lines) ? lines : [])
    const xlsxSha256 = computeXlsxSha256(buf)
    const filename = `${latest.po_id}.xlsx`

    // 规则 1：调用 bridge 之前，先持久化 dispatch_started 投递意图。
    // 并发兜底：UNIQUE(po_header_id) 冲突说明另一进程已抢到 → 走已有意图判定，不重投。
    try {
      await insertIntent({
        poHeaderId: latest.id,
        poId: latest.po_id,
        contentSha256: contentSha,
        xlsxSha256,
        state: PUSH_INTENT_STATES.DISPATCH_STARTED,
      })
    } catch (e) {
      const raced = await findIntentByPoHeader(latest.id)
      if (raced) {
        throw new Error(`该 PO 已存在投递意图（${raced.state}），并发保护拒绝自动重投，请人工核对`)
      }
      throw e
    }
    const winPath = `${targetDir}\\${filename}`
    // 规则 2：bridge 调用窗口。任何异常（含 ok:false）都视为结果不确定——
    // 标记 delivery_uncertain 并停止轮询，绝不自动再次发送。
    let res
    try {
      res = await bridgeCall({ write: { path: winPath, b64: buf.toString('base64') } })
    } catch (e) {
      await updateIntentState(latest.id, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, {
        error: `bridge 调用异常：${e.message}`,
      })
      throw new Error(
        await stopPollingForReview(
          latest.id,
          `bridge 调用结果不确定（${e.message}）：已标记 delivery_uncertain，停止自动重试，转人工核对`,
        ),
      )
    }
    if (!res || !res.ok) {
      await updateIntentState(latest.id, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, {
        error: `bridge 返回 ok:false（${res?.error ?? '未确认写入'}）`,
      })
      throw new Error(
        await stopPollingForReview(
          latest.id,
          'bridge 未确认写入（ok:false）：已标记 delivery_uncertain，停止自动重试，转人工核对',
        ),
      )
    }

    // bridge 确认成功 → 先可靠记录 delivered，再写审计、再置 exported。
    try {
      await updateIntentState(latest.id, PUSH_INTENT_STATES.DELIVERED, { filename })
    } catch (e) {
      // bridge 已成功但 delivered 没记上 → 结果不确定，绝不重投。
      try {
        await updateIntentState(latest.id, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, {
          error: `记录 delivered 失败：${e.message}`,
        })
      } catch (_) {
        /* 状态都记不上：意图行仍在 dispatch_started，下次会按残留升级为 uncertain */
      }
      throw new Error(
        await stopPollingForReview(
          latest.id,
          `bridge 已成功但投递记录失败（${e.message}）：已标记 delivery_uncertain，停止自动重试`,
        ),
      )
    }

    const nowIso = now().toISOString()
    // 审计行失败不致命：delivered 已记录，意图表是真相源；不重投，仅记日志。
    try {
      await sbFetch('tj_po_exports', {
        method: 'POST',
        body: JSON.stringify({
          po_header_id: latest.id,
          po_id: latest.po_id,
          filename,
          exported_at: nowIso,
        }),
      })
    } catch (e) {
      log.error(`[warn] ${latest.po_id} 审计行写入失败（${e.message}），delivered 已记录，不重投`)
    }
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

  return {
    runOnce,
    pushOne,
    buildXlsx,
    fetchPending,
    findSourceOwners,
    readHeaderById,
    findIntentByPoHeader,
    insertIntent,
    updateIntentState,
    stopPollingForReview,
  }
}
