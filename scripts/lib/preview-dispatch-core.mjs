// Preview PO 投递核心 —— tj_preview 请求 → Windows Pending（新 PO）单次投递。
//
// 可 import、可注入依赖、import 本模块不产生任何 IO（不读 env / 不连库 / 不连 bridge /
// 不启动轮询）。CLI 只做装配：scripts/preview-po-dispatch.mjs。
//
// 永久安全边界：
//   * 只操作 tj_preview schema；任何生成的 SQL 都经 assertPreviewSql 拒绝 public.
//     （生产 public 走原 scripts/lib/po-push-core.mjs，本模块不读/不改 public。）
//   * 只允许新 PO 进入 Pending；绝不碰 Done / Processing / Outbox / IRS。
//   * 一次请求只允许一次 bridge write：bridge 调用窗口后任何失败 → delivery_uncertain，
//     绝不自动重试。同名文件已存在 → 拒绝覆写（旧 bridge 会覆盖，必须在服务端先挡）。
//   * 原件证据：先把 XLSX 原始字节永久落盘（非 scratch）并读回校验，再写 server_prepared
//     证据；bridge read 回同一文件字节/hash 一致才写 windows_received 并置 delivered。
//   * 业务摘要 content_sha256（业务 JSON）与文件字节 xlsx_sha256 分开存放，绝不互比。
//   * SQL 字面值统一 sqlLiteral：单引号双写、拒绝 NUL；请求 id / uuid 先做格式校验。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildPoLineRows, EXPORT_MODE_STANDARD } from '../../web/src/lib/core/po-lines.js'
import { buildWorkbook } from '../../web/src/lib/core/xlsx.js'
import { computePushContentSha256 } from './po-push-core.mjs'

export const PREVIEW_SCHEMA = 'tj_preview'
export const BRIDGE_URL = 'http://127.0.0.1:9000'
export const TARGET_DIR = 'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Pending'
export const QUEUE_ROOT = 'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue'
export const DEFAULT_ARTIFACT_ROOT = 'private/preview-deliveries'
/** 预检（只读）目录：同 PO 在任何 Queue 状态目录已有同名文件都不得再写 Pending。 */
export const QUEUE_CHECK_DIRS = Object.freeze(['Pending', 'Processing', 'Done', 'Failed', 'NeedsReview'])

export const REQUEST_TABLE = 'tj_po_preview_push_requests'
export const INTENT_TABLE = 'tj_po_push_intents'
export const EVIDENCE_TABLE = 'tj_po_push_delivery_evidence'
export const HEADER_TABLE = 'tj_po_headers'
export const LINE_TABLE = 'tj_po_lines'

export const DELIVERY_CHANNEL = 'windows_bridge_v1'
export const LEGACY_DELIVERY_CHANNEL = 'legacy_local_unverified'

export const REQUEST_STATES = Object.freeze({
  REQUESTED: 'requested',
  DISPATCH_STARTED: 'dispatch_started',
  DELIVERED: 'delivered',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
})

export const EVIDENCE_STAGES = Object.freeze({
  SERVER_PREPARED: 'server_prepared',
  WINDOWS_RECEIVED: 'windows_received',
})

/** 投递规则错误：code 给测试/调用方断言，message 直接给操作员看 */
export class PreviewDispatchError extends Error {
  constructor(code, message, { uncertain = false } = {}) {
    super(message)
    this.name = 'PreviewDispatchError'
    this.code = code
    this.uncertain = uncertain
  }
}

// ---------------------------------------------------------------------------
// 字面值 / 标识符校验
// ---------------------------------------------------------------------------

/**
 * Postgres 文本字面值：单引号双写。standard_conforming_strings 默认 on，
 * 反斜杠按字面保留（Windows 路径不能改写）。拒绝 NUL（Postgres 文本不接受）。
 * @param {unknown} value
 * @returns {string} 例如 'O''Brien'
 */
export function sqlLiteral(value) {
  if (value === null || value === undefined) {
    throw new PreviewDispatchError('INVALID_SQL_LITERAL', 'SQL 字面值不能为 null/undefined')
  }
  const s = String(value)
  if (s.includes('\u0000')) {
    throw new PreviewDispatchError('INVALID_SQL_LITERAL', 'SQL 字面值不能包含 NUL')
  }
  return `'${s.replace(/'/g, "''")}'`
}

/** 任何生成 SQL 都不得指向 public（防误配/注入把预览投递写进生产表） */
export function assertPreviewSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new PreviewDispatchError('EMPTY_SQL', '生成的 SQL 为空')
  }
  if (/(^|[^A-Za-z0-9_])public\./i.test(sql)) {
    throw new PreviewDispatchError(
      'PUBLIC_SCHEMA_FORBIDDEN',
      'Preview 投递只允许 tj_preview schema：生成的 SQL 命中了 public，已拒绝执行',
    )
  }
  return sql
}

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILENAME_RE = /^PO-\d{6}\.xlsx$/
const SHA256_RE = /^[0-9a-f]{64}$/

export function assertRequestId(requestId) {
  const s = String(requestId ?? '').trim()
  if (!REQUEST_ID_RE.test(s)) {
    throw new PreviewDispatchError(
      'INVALID_REQUEST_ID',
      'request_id 必须是 8-128 位字母/数字/._:-（不允许空格、引号或 SQL 片段）',
    )
  }
  return s
}

export function assertUuid(value, label = 'uuid') {
  const s = String(value ?? '').trim()
  if (!UUID_RE.test(s)) {
    throw new PreviewDispatchError('INVALID_UUID', `${label} 不是合法 uuid：${String(value)}`)
  }
  return s
}

/**
 * 目标目录只允许 Pending（新 PO 入口）：绝不写 Done/Processing/Outbox/IRS。
 * @param {string} targetDir
 * @returns {string} 规范化后的目录（无反斜杠结尾）
 */
export function requirePendingDir(targetDir = TARGET_DIR) {
  const raw = String(targetDir ?? '').trim()
  const normalized = raw.replace(/[\\/]+$/, '')
  if (normalized.toLowerCase() !== TARGET_DIR.toLowerCase()) {
    throw new PreviewDispatchError(
      'INVALID_TARGET_DIR',
      `Preview 投递只允许写入 Pending（${TARGET_DIR}），拒绝目标：${raw || '(空)'}`,
    )
  }
  return TARGET_DIR
}

/** Queue 子目录拼接：只允许单段字母/数字/下划线，不解释分隔符或 .. */
export function windowsPathJoinDir(root, sub) {
  const s = String(sub ?? '')
  if (!/^[A-Za-z0-9_]+$/.test(s)) {
    throw new PreviewDispatchError('INVALID_QUEUE_DIR', `Queue 子目录非法：${s}`)
  }
  return `${String(root).replace(/[\\/]+$/, '')}\\${s}`
}

/** Windows 路径拼接：只允许 PO-######.xlsx，不解释 . / .. / 分隔符 */
export function windowsPathJoin(dir, filename) {
  if (!FILENAME_RE.test(String(filename ?? ''))) {
    throw new PreviewDispatchError('INVALID_FILENAME', `文件名必须形如 PO-000123.xlsx，收到：${filename}`)
  }
  return `${String(dir).replace(/[\\/]+$/, '')}\\${filename}`
}

// ---------------------------------------------------------------------------
// SQL 生成（全部限定 tj_preview；调用前 assertPreviewSql）
// ---------------------------------------------------------------------------

/** 读请求行（只读）。 */
export function buildReadRequestSql(requestId) {
  return assertPreviewSql(
    `select id, po_header_id, request_id, state from ${PREVIEW_SCHEMA}.${REQUEST_TABLE}` +
      ` where request_id = ${sqlLiteral(assertRequestId(requestId))} limit 1`,
  )
}

/**
 * 原子抢单：单条 data-modifying CTE（Postgres 单语句 = 单事务）。
 *   * UPDATE 只在 state='requested' 且该 PO 尚无任何 intent 时命中；
 *   * intent INSERT ... ON CONFLICT (po_header_id) DO NOTHING —— 绝不覆盖旧 intent；
 *   * 返回空数组 = 没抢到（调用方必须查原因并拒绝，不能继续写 bridge）。
 */
export function buildClaimSql({ requestId, poId, contentSha256 }) {
  const rid = sqlLiteral(assertRequestId(requestId))
  const pid = sqlLiteral(String(poId ?? '').trim())
  if (!SHA256_RE.test(String(contentSha256 ?? ''))) {
    throw new PreviewDispatchError('INVALID_CONTENT_SHA', 'content_sha256 必须是 64 位小写十六进制')
  }
  const sha = sqlLiteral(contentSha256)
  return assertPreviewSql(`
with claimed as (
  update ${PREVIEW_SCHEMA}.${REQUEST_TABLE} r
     set state = '${REQUEST_STATES.DISPATCH_STARTED}', updated_at = now()
   where r.request_id = ${rid}
     and r.state = '${REQUEST_STATES.REQUESTED}'
     and not exists (
       select 1 from ${PREVIEW_SCHEMA}.${INTENT_TABLE} i where i.po_header_id = r.po_header_id
     )
  returning r.id, r.po_header_id, r.request_id
), ins as (
  insert into ${PREVIEW_SCHEMA}.${INTENT_TABLE}
    (po_header_id, po_id, content_sha256, state, delivery_channel)
  select c.po_header_id, ${pid}, ${sha}, '${REQUEST_STATES.DISPATCH_STARTED}', ${sqlLiteral(DELIVERY_CHANNEL)}
    from claimed c
  on conflict (po_header_id) do nothing
  returning id, po_header_id
)
select c.id as request_uuid, c.po_header_id, c.request_id, ins.id as intent_id
  from claimed c left join ins on ins.po_header_id = c.po_header_id`)
}

/** 抢单失败后的只读诊断：区分「已 delivered / 进行中 / 旧 intent 存在」。 */
export function buildDiagnoseClaimSql(requestId) {
  const rid = sqlLiteral(assertRequestId(requestId))
  return assertPreviewSql(
    `select r.state as request_state, i.id as intent_id, i.state as intent_state` +
      ` from ${PREVIEW_SCHEMA}.${REQUEST_TABLE} r` +
      ` left join ${PREVIEW_SCHEMA}.${INTENT_TABLE} i on i.po_header_id = r.po_header_id` +
      ` where r.request_id = ${rid} limit 1`,
  )
}

/** 读 PO 事实（header + 按 line_no 排序的 lines，单次往返）。 */
export function buildLoadPoSql(poHeaderId) {
  const id = sqlLiteral(assertUuid(poHeaderId, 'po_header_id'))
  return assertPreviewSql(`
select json_build_object(
  'header', to_jsonb(h),
  'lines', coalesce((
    select json_agg(l order by l.line_no)
      from ${PREVIEW_SCHEMA}.${LINE_TABLE} l
     where l.po_header_id = h.id
  ), '[]'::json)
) as payload
  from ${PREVIEW_SCHEMA}.${HEADER_TABLE} h
 where h.id = ${id}
 limit 1`)
}

/**
 * server_prepared 证据（原件已永久落盘并读回校验）。
 * ON CONFLICT (intent_id, stage) DO NOTHING + 回读，重放不产生第二行。
 */
export function buildPreparedEvidenceSql({ intentId, xlsxSha256, byteCount, targetPath, evidence }) {
  const iid = sqlLiteral(assertUuid(intentId, 'intent_id'))
  if (!SHA256_RE.test(String(xlsxSha256 ?? ''))) {
    throw new PreviewDispatchError('INVALID_XLSX_SHA', 'xlsx_sha256 必须是 64 位小写十六进制')
  }
  if (!Number.isInteger(byteCount) || byteCount <= 0) {
    throw new PreviewDispatchError('INVALID_BYTE_COUNT', 'byte_count 必须是正整数')
  }
  const payload = JSON.stringify(evidence ?? {})
  return assertPreviewSql(`
with ins as (
  insert into ${PREVIEW_SCHEMA}.${EVIDENCE_TABLE}
    (intent_id, stage, xlsx_sha256, byte_count, target_path, evidence)
  values (${iid}, '${EVIDENCE_STAGES.SERVER_PREPARED}', ${sqlLiteral(xlsxSha256)}, ${byteCount},` +
    ` ${sqlLiteral(targetPath)}, ${sqlLiteral(payload)}::jsonb)
  on conflict (intent_id, stage) do nothing
  returning id, intent_id, stage, xlsx_sha256, byte_count, target_path
)
select id, intent_id, stage, xlsx_sha256, byte_count, target_path from ins
union all
select id, intent_id, stage, xlsx_sha256, byte_count, target_path
  from ${PREVIEW_SCHEMA}.${EVIDENCE_TABLE}
 where intent_id = ${iid} and stage = '${EVIDENCE_STAGES.SERVER_PREPARED}'`)
}

/**
 * windows_received 证据 + intent/request 置 delivered：单条语句（单事务）。
 * 只有 intent 仍为 dispatch_started 才更新；request 只有在 intent 更新成功后才更新。
 * 返回 evidence_rows / intent_state / request_state 供调用方校验。
 */
export function buildFinalizeSql({
  requestId,
  intentId,
  xlsxSha256,
  byteCount,
  targetPath,
  filename,
  evidence,
}) {
  const rid = sqlLiteral(assertRequestId(requestId))
  const iid = sqlLiteral(assertUuid(intentId, 'intent_id'))
  if (!SHA256_RE.test(String(xlsxSha256 ?? ''))) {
    throw new PreviewDispatchError('INVALID_XLSX_SHA', 'xlsx_sha256 必须是 64 位小写十六进制')
  }
  if (!Number.isInteger(byteCount) || byteCount <= 0) {
    throw new PreviewDispatchError('INVALID_BYTE_COUNT', 'byte_count 必须是正整数')
  }
  if (!FILENAME_RE.test(String(filename ?? ''))) {
    throw new PreviewDispatchError('INVALID_FILENAME', `文件名必须形如 PO-000123.xlsx，收到：${filename}`)
  }
  const payload = JSON.stringify(evidence ?? {})
  return assertPreviewSql(`
with ev as (
  insert into ${PREVIEW_SCHEMA}.${EVIDENCE_TABLE}
    (intent_id, stage, xlsx_sha256, byte_count, target_path, evidence)
  values (${iid}, '${EVIDENCE_STAGES.WINDOWS_RECEIVED}', ${sqlLiteral(xlsxSha256)}, ${byteCount},` +
    ` ${sqlLiteral(targetPath)}, ${sqlLiteral(payload)}::jsonb)
  on conflict (intent_id, stage) do nothing
  returning id
), evc as (
  select id from ev
  union all
  select id from ${PREVIEW_SCHEMA}.${EVIDENCE_TABLE}
   where intent_id = ${iid} and stage = '${EVIDENCE_STAGES.WINDOWS_RECEIVED}'
), u as (
  update ${PREVIEW_SCHEMA}.${INTENT_TABLE} i
     set state = '${REQUEST_STATES.DELIVERED}',
         xlsx_sha256 = ${sqlLiteral(xlsxSha256)},
         filename = ${sqlLiteral(filename)},
         updated_at = now()
   where i.id = ${iid} and i.state = '${REQUEST_STATES.DISPATCH_STARTED}'
  returning i.id, i.state
), r as (
  update ${PREVIEW_SCHEMA}.${REQUEST_TABLE} q
     set state = '${REQUEST_STATES.DELIVERED}', updated_at = now()
   where q.request_id = ${rid}
     and q.state = '${REQUEST_STATES.DISPATCH_STARTED}'
     and exists (select 1 from u)
  returning q.id, q.state
)
select (select count(*)::int from evc) as evidence_rows,
       (select state from u) as intent_state,
       (select state from r) as request_state`)
}

/** 投递不确定：intent（如已知）与 request 一起停住，绝不自动重试。 */
export function buildMarkUncertainSql({ requestId, intentId = null, reason }) {
  const rid = sqlLiteral(assertRequestId(requestId))
  const why = sqlLiteral(String(reason ?? '投递结果不确定'))
  if (intentId) {
    const iid = sqlLiteral(assertUuid(intentId, 'intent_id'))
    return assertPreviewSql(`
with i as (
  update ${PREVIEW_SCHEMA}.${INTENT_TABLE}
     set state = '${REQUEST_STATES.DELIVERY_UNCERTAIN}', error = ${why}, updated_at = now()
   where id = ${iid} and state <> '${REQUEST_STATES.DELIVERED}'
  returning id
)
update ${PREVIEW_SCHEMA}.${REQUEST_TABLE}
   set state = '${REQUEST_STATES.DELIVERY_UNCERTAIN}', updated_at = now()
 where request_id = ${rid} and state <> '${REQUEST_STATES.DELIVERED}'
returning id, state`)
  }
  return assertPreviewSql(
    `update ${PREVIEW_SCHEMA}.${REQUEST_TABLE}` +
      ` set state = '${REQUEST_STATES.DELIVERY_UNCERTAIN}', updated_at = now()` +
      ` where request_id = ${rid} and state <> '${REQUEST_STATES.DELIVERED}'` +
      ` returning id, state`,
  )
}

// ---------------------------------------------------------------------------
// 依赖实现（bounded IO，只在函数内发生）
// ---------------------------------------------------------------------------

/**
 * 永久 artifact store：默认 private/preview-deliveries（gitignored，非系统 scratch）。
 * 同名同字节 = 幂等复用；同名不同字节 = 拒绝覆盖。
 */
export function createFileArtifactStore({ root = DEFAULT_ARTIFACT_ROOT, fsImpl = fs } = {}) {
  const absRoot = path.resolve(root)
  return {
    root: absRoot,
    async prepare({ requestId, filename, bytes }) {
      if (!FILENAME_RE.test(String(filename ?? ''))) {
        throw new PreviewDispatchError('INVALID_FILENAME', `文件名必须形如 PO-000123.xlsx，收到：${filename}`)
      }
      const rid = assertRequestId(requestId)
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      if (buf.length === 0) throw new PreviewDispatchError('EMPTY_ARTIFACT', 'XLSX 字节为空，拒绝落盘')
      const dir = path.join(absRoot, rid)
      fsImpl.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, filename)
      let created = false
      if (fsImpl.existsSync(file)) {
        const existing = fsImpl.readFileSync(file)
        if (!existing.equals(buf)) {
          throw new PreviewDispatchError(
            'ARTIFACT_CONFLICT',
            `永久原件已存在且字节不同，拒绝覆盖：${file}`,
          )
        }
      } else {
        fsImpl.writeFileSync(file, buf, { flag: 'wx' })
        created = true
      }
      // 读回校验：落盘的内容必须与内存字节完全一致
      const readBack = fsImpl.readFileSync(file)
      const sha256 = sha256Hex(readBack)
      return { path: file, sha256, byteCount: readBack.length, created, bytes: readBack }
    },
    async read(file) {
      return fsImpl.readFileSync(file)
    },
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** bridge 协议客户端：POST {write:{path,b64}} / {read:path} / {list:dir} */
export function createBridgeClient({ bridgeUrl = BRIDGE_URL, fetchImpl = fetch } = {}) {
  return async function bridge(payload) {
    const r = await fetchImpl(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}: ${text.slice(0, 200)}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('bridge 返回不是 JSON')
    }
  }
}

function entryName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    const raw = entry.name ?? entry.path ?? ''
    return String(raw).split(/[\\/]/).pop()
  }
  return ''
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

/**
 * 执行一次 Preview 投递（单 request，单次 bridge write）。
 *
 * @param {{
 *   requestId: string,
 *   dbQuery: (sql: string) => Promise<any[]>,
 *   bridge: (payload: object) => Promise<object>,
 *   artifacts: ReturnType<typeof createFileArtifactStore>,
 *   targetDir?: string,
 *   log?: {log: Function, error: Function},
 *   now?: () => Date,
 * }} deps
 */
export async function runPreviewDispatch({
  requestId,
  dbQuery,
  bridge,
  artifacts,
  targetDir = TARGET_DIR,
  log = console,
  now = () => new Date(),
} = {}) {
  if (typeof dbQuery !== 'function') throw new PreviewDispatchError('MISSING_DB', '缺少 dbQuery')
  if (typeof bridge !== 'function') throw new PreviewDispatchError('MISSING_BRIDGE', '缺少 bridge')
  if (!artifacts || typeof artifacts.prepare !== 'function' || typeof artifacts.read !== 'function') {
    throw new PreviewDispatchError('MISSING_ARTIFACTS', '缺少永久 artifact store')
  }
  const rid = assertRequestId(requestId)
  const pendingDir = requirePendingDir(targetDir)

  // ---- 1. 读请求（只读，不改变任何状态） ----
  const reqRows = await dbQuery(buildReadRequestSql(rid))
  const req = Array.isArray(reqRows) ? reqRows[0] : null
  if (!req) {
    throw new PreviewDispatchError('UNKNOWN_REQUEST', `找不到投递请求 ${rid}（不猜测、不新建）`)
  }
  if (req.state === REQUEST_STATES.DELIVERED) {
    log.log(`[already] ${rid} 已 delivered：不重复投递`)
    return { alreadyDelivered: true, requestId: rid, state: REQUEST_STATES.DELIVERED }
  }
  if (req.state === REQUEST_STATES.DELIVERY_UNCERTAIN) {
    throw new PreviewDispatchError(
      'REQUEST_UNCERTAIN',
      `请求 ${rid} 已标记 delivery_uncertain：必须人工核对 Windows Queue，绝不自动重试`,
      { uncertain: true },
    )
  }
  if (req.state === REQUEST_STATES.DISPATCH_STARTED) {
    // 上次进程在投递窗口中断：结果未知，停住，不写。
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId: null,
      reason: '上次投递在 bridge 调用期间中断，结果不确定',
      log,
    })
    throw new PreviewDispatchError(
      'REQUEST_IN_PROGRESS',
      `请求 ${rid} 残留 dispatch_started：已标记 delivery_uncertain，停止自动重试，转人工核对`,
      { uncertain: true },
    )
  }
  if (req.state !== REQUEST_STATES.REQUESTED) {
    throw new PreviewDispatchError(
      'NOT_REQUESTED',
      `请求 ${rid} 状态为 ${req.state}，只有 requested 才能投递`,
    )
  }
  const poHeaderId = assertUuid(req.po_header_id, 'po_header_id')

  // ---- 2. 读 PO 事实并做业务/格式门禁（失败发生在任何状态变更之前） ----
  const poRows = await dbQuery(buildLoadPoSql(poHeaderId))
  const payload = Array.isArray(poRows) ? poRows[0]?.payload : null
  if (!payload || !payload.header) {
    throw new PreviewDispatchError('PO_NOT_FOUND', `找不到预览 PO ${poHeaderId}（不重建、不猜内容）`)
  }
  const header = payload.header
  const lines = Array.isArray(payload.lines) ? payload.lines : []
  assertDispatchable(header, lines)
  const contentSha256 = computePushContentSha256(header, lines)
  // 8 列 / 显式日期 fail closed：必须在任何状态变更之前完成。
  // 缺日期/非法日期是「不能投递」，不是「投递结果不确定」——请求保持 requested，
  // 由人工补日期后再请求；绝不把状态改成 uncertain 来掩盖业务门禁。
  let rowSpec
  try {
    rowSpec = buildPoLineRows(header, lines, { mode: EXPORT_MODE_STANDARD })
  } catch (e) {
    throw toDispatchError(e, 'XLSX_ROWS_INVALID')
  }

  // ---- 3. 原子抢单（状态 + 唯一 intent） ----
  const claimRows = await dbQuery(buildClaimSql({ requestId: rid, poId: header.po_id, contentSha256 }))
  const claim = Array.isArray(claimRows) ? claimRows[0] : null
  if (!claim || !claim.intent_id) {
    const diagRows = await dbQuery(buildDiagnoseClaimSql(rid))
    const diag = Array.isArray(diagRows) ? diagRows[0] : null
    const reason = diag?.intent_id
      ? `该 PO 已存在历史投递意图（${diag.intent_state ?? 'unknown'}，渠道可能为旧版本地投递），拒绝覆盖并重投`
      : `请求未能抢单（当前状态 ${diag?.request_state ?? 'unknown'}），拒绝继续`
    await markUncertain(dbQuery, { requestId: rid, intentId: diag?.intent_id ?? null, reason, log })
    throw new PreviewDispatchError(
      diag?.intent_id ? 'INTENT_ALREADY_EXISTS' : 'CLAIM_REJECTED',
      `${reason}：请人工核对 Windows Queue 实况，绝不因 Pending 不存在而重发`,
      { uncertain: true },
    )
  }
  const intentId = assertUuid(claim.intent_id, 'intent_id')

  // ---- 4. 生成 XLSX（8 列 standard，日期必填）+ 永久原件 ----
  let buf
  try {
    const blob = await buildWorkbook([
      { name: 'PO_Lines', columns: rowSpec.columns, rows: rowSpec.rows },
    ])
    buf = Buffer.from(await blob.arrayBuffer())
  } catch (e) {
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId,
      reason: `生成 XLSX 失败：${e.message}`,
      log,
    })
    throw toDispatchError(e, 'XLSX_BUILD_FAILED')
  }
  const filename = `${header.po_id}.xlsx`
  const winPath = windowsPathJoin(pendingDir, filename)
  const xlsxSha256 = sha256Hex(buf)

  let artifact
  try {
    artifact = await artifacts.prepare({ requestId: rid, filename, bytes: buf })
    const readBack = await artifacts.read(artifact.path)
    if (!Buffer.from(readBack).equals(buf) || sha256Hex(readBack) !== xlsxSha256) {
      throw new PreviewDispatchError('ARTIFACT_READBACK_MISMATCH', '永久原件读回字节/hash 与内存不一致')
    }
  } catch (e) {
    await markUncertain(dbQuery, { requestId: rid, intentId, reason: `原件落盘失败：${e.message}`, log })
    throw toDispatchError(e, 'ARTIFACT_FAILED')
  }

  // ---- 5. server_prepared 证据（先持久，再碰 bridge） ----
  try {
    const evRows = await dbQuery(
      buildPreparedEvidenceSql({
        intentId,
        xlsxSha256,
        byteCount: buf.length,
        targetPath: winPath,
        evidence: {
          channel: DELIVERY_CHANNEL,
          schema: PREVIEW_SCHEMA,
          request_id: rid,
          artifact_path: artifact.path,
          prepared_at: now().toISOString(),
        },
      }),
    )
    const ev = Array.isArray(evRows) ? evRows[0] : null
    if (!ev || ev.stage !== EVIDENCE_STAGES.SERVER_PREPARED) {
      throw new PreviewDispatchError('EVIDENCE_NOT_PERSISTED', 'server_prepared 证据未落库')
    }
    if (ev.xlsx_sha256 !== xlsxSha256 || Number(ev.byte_count) !== buf.length) {
      throw new PreviewDispatchError(
        'EVIDENCE_MISMATCH',
        `server_prepared 证据与原件不一致（${ev.xlsx_sha256}/${ev.byte_count}）`,
      )
    }
  } catch (e) {
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId,
      reason: `server_prepared 证据写入失败：${e.message}`,
      log,
    })
    throw toDispatchError(e, 'EVIDENCE_PREPARED_FAILED')
  }

  // ---- 6. 各 Queue 目录只读预检：同 PO 已存在同名文件 → 拒绝覆写 ----
  // 旧 bridge 会覆盖现有文件；除 Pending 外，Processing/Done/Failed/NeedsReview 出现同名
  // 文件说明该 PO 已被处理或正在处理，绝不能当新单重投。只列目录，不写这些目录。
  for (const sub of QUEUE_CHECK_DIRS) {
    const dir = windowsPathJoinDir(QUEUE_ROOT, sub)
    let listing
    try {
      listing = await bridge({ list: { dir } })
    } catch (e) {
      await markUncertain(dbQuery, {
        requestId: rid,
        intentId,
        reason: `bridge 目录检查失败（${sub}）：${e.message}`,
        log,
      })
      throw new PreviewDispatchError(
        'BRIDGE_LIST_FAILED',
        `bridge 目录检查失败（${sub}：${e.message}）：无法证明目标文件不存在，绝不写，已标记 delivery_uncertain`,
        { uncertain: true },
      )
    }
    if (!listing || listing.ok !== true || !Array.isArray(listing.entries)) {
      await markUncertain(dbQuery, {
        requestId: rid,
        intentId,
        reason: `bridge 目录检查未返回可用清单（${sub}）`,
        log,
      })
      throw new PreviewDispatchError(
        'BRIDGE_LIST_FAILED',
        `bridge 目录检查（${sub}）未返回 entries 数组：无法证明目标文件不存在，绝不写`,
        { uncertain: true },
      )
    }
    const exists = listing.entries.some((e) => entryName(e).toLowerCase() === filename.toLowerCase())
    if (exists) {
      const where = sub === 'Pending' ? 'Pending' : sub
      const reason =
        sub === 'Pending'
          ? `Pending 已存在同名文件 ${filename}（可能上次已写入或 Windows 尚未取走），拒绝覆写`
          : `${where} 已存在同 PO 文件 ${filename}：该 PO 已进入处理/完成流程，禁止当新单重投`
      await markUncertain(dbQuery, { requestId: rid, intentId, reason, log })
      throw new PreviewDispatchError(
        sub === 'Pending' ? 'TARGET_EXISTS' : 'QUEUE_FILE_EXISTS',
        `${reason}：已标记 delivery_uncertain，转人工核对`,
        { uncertain: true },
      )
    }
  }

  // ---- 7. bridge 写入一次（此窗口之后任何失败都不允许重试） ----
  let writeRes
  try {
    writeRes = await bridge({ write: { path: winPath, b64: buf.toString('base64') } })
  } catch (e) {
    const reason = `bridge 写调用异常：${e.message}`
    await markUncertain(dbQuery, { requestId: rid, intentId, reason, log })
    throw new PreviewDispatchError(
      'BRIDGE_WRITE_FAILED',
      `bridge 调用结果不确定（${e.message}）：已标记 delivery_uncertain，停止自动重试`,
      { uncertain: true },
    )
  }
  if (!writeRes || writeRes.ok !== true) {
    const reason = `bridge 返回 ok:false（${writeRes?.error ?? '未确认写入'}）`
    await markUncertain(dbQuery, { requestId: rid, intentId, reason, log })
    throw new PreviewDispatchError(
      'BRIDGE_WRITE_FAILED',
      `${reason}：已标记 delivery_uncertain，停止自动重试，转人工核对`,
      { uncertain: true },
    )
  }
  if (writeRes.path && String(writeRes.path).toLowerCase() !== winPath.toLowerCase()) {
    const reason = `bridge 写入路径与目标不一致：${writeRes.path} ≠ ${winPath}`
    await markUncertain(dbQuery, { requestId: rid, intentId, reason, log })
    throw new PreviewDispatchError('BRIDGE_PATH_MISMATCH', reason, { uncertain: true })
  }
  if (writeRes.size !== undefined && Number(writeRes.size) !== buf.length) {
    const reason = `bridge 报告写入 ${writeRes.size} 字节，原件 ${buf.length} 字节`
    await markUncertain(dbQuery, { requestId: rid, intentId, reason, log })
    throw new PreviewDispatchError('BRIDGE_SIZE_MISMATCH', reason, { uncertain: true })
  }

  // ---- 8. read 回同一文件，逐字节/hash 校验 ----
  let readRes
  try {
    readRes = await bridge({ read: winPath })
  } catch (e) {
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId,
      reason: `bridge 读回异常：${e.message}`,
      log,
    })
    throw new PreviewDispatchError(
      'READBACK_FAILED',
      `bridge 读回异常（${e.message}）：无法证明 Windows 收到同一文件，已标记 uncertain`,
      { uncertain: true },
    )
  }
  if (!readRes || readRes.ok !== true || typeof readRes.b64 !== 'string') {
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId,
      reason: 'bridge 读回未返回文件内容',
      log,
    })
    throw new PreviewDispatchError('READBACK_FAILED', 'bridge 读回未返回文件内容（ok:false），已标记 uncertain', {
      uncertain: true,
    })
  }
  const readBytes = Buffer.from(readRes.b64, 'base64')
  if (
    readBytes.length !== buf.length ||
    !readBytes.equals(buf) ||
    sha256Hex(readBytes) !== xlsxSha256
  ) {
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId,
      reason: 'Windows read 回字节/hash 与原件不一致',
      log,
    })
    throw new PreviewDispatchError(
      'READBACK_MISMATCH',
      'Windows 读回的 XLSX 与原件字节/hash 不一致：拒绝声称 delivered，已标记 delivery_uncertain',
      { uncertain: true },
    )
  }

  // ---- 9. windows_received 证据 + delivered（同一语句，读回校验） ----
  let finalRow
  try {
    const rows = await dbQuery(
      buildFinalizeSql({
        requestId: rid,
        intentId,
        xlsxSha256,
        byteCount: buf.length,
        targetPath: winPath,
        filename,
        evidence: {
          channel: DELIVERY_CHANNEL,
          verified: 'readback_bytes_exact',
          readback_sha256: sha256Hex(readBytes),
          bridge_reported_size: writeRes.size ?? null,
          received_at: now().toISOString(),
        },
      }),
    )
    finalRow = Array.isArray(rows) ? rows[0] : null
  } catch (e) {
    await markUncertain(dbQuery, {
      requestId: rid,
      intentId,
      reason: `记录 delivered 失败：${e.message}`,
      log,
    })
    throw new PreviewDispatchError(
      'FINALIZE_FAILED',
      `bridge 已写入且读回一致，但 delivered 落库失败（${e.message}）：已标记 uncertain，绝不重投`,
      { uncertain: true },
    )
  }
  if (
    !finalRow ||
    Number(finalRow.evidence_rows) !== 1 ||
    finalRow.intent_state !== REQUEST_STATES.DELIVERED ||
    finalRow.request_state !== REQUEST_STATES.DELIVERED
  ) {
    const reason = `delivered 状态校验失败（evidence=${finalRow?.evidence_rows}, intent=${finalRow?.intent_state}, request=${finalRow?.request_state}）`
    await markUncertain(dbQuery, { requestId: rid, intentId, reason, log })
    throw new PreviewDispatchError(
      'FINALIZE_FAILED',
      `${reason}：不得声称 delivered，已标记 delivery_uncertain`,
      { uncertain: true },
    )
  }

  log.log(`[delivered] ${header.po_id} -> ${winPath} sha256=${xlsxSha256} bytes=${buf.length}`)
  return {
    ok: true,
    requestId: rid,
    poId: header.po_id,
    filename,
    state: REQUEST_STATES.DELIVERED,
    deliveryChannel: DELIVERY_CHANNEL,
    xlsxSha256,
    artifactSha256: artifact.sha256,
    byteCount: buf.length,
    artifactPath: artifact.path,
    targetPath: winPath,
    evidence: {
      serverPrepared: true,
      windowsReceived: true,
      stages: [EVIDENCE_STAGES.SERVER_PREPARED, EVIDENCE_STAGES.WINDOWS_RECEIVED],
    },
  }
}

/** 业务门禁：只允许新 PO（普通/未合并/confirmed/未冻结/有显式日期） */
export function assertDispatchable(header, lines) {
  const h = header ?? {}
  if (h.po_type === 'combined') {
    throw new PreviewDispatchError('PE_COMBINED_FROZEN', '合并单永久冻结推送（po_type=combined）')
  }
  if (h.po_type && h.po_type !== 'standard') {
    throw new PreviewDispatchError('INVALID_PO_TYPE', `Preview 投递只支持 standard 单，收到 ${h.po_type}`)
  }
  if (h.frozen === true) {
    throw new PreviewDispatchError('PO_FROZEN', '该采购单已冻结：拒绝投递')
  }
  if (h.status !== 'confirmed') {
    throw new PreviewDispatchError('INVALID_STATUS', `只有 confirmed 单可以请求预览投递，当前 ${h.status}`)
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PreviewDispatchError('PO_HAS_NO_LINES', '该采购单没有明细行：拒绝投递')
  }
}

function toDispatchError(e, fallbackCode) {
  if (e instanceof PreviewDispatchError) return e
  const code = typeof e?.code === 'string' ? e.code : fallbackCode
  return new PreviewDispatchError(code, e?.message ?? String(e))
}

async function markUncertain(dbQuery, { requestId, intentId = null, reason, log }) {
  try {
    await dbQuery(buildMarkUncertainSql({ requestId, intentId, reason }))
  } catch (e) {
    // 标记失败也不能重投：原错误继续上抛，日志留痕
    log?.error?.(`[warn] 标记 delivery_uncertain 失败：${e.message}`)
  }
}
