// GR Preview Task Dispatcher 核心 —— 纯逻辑、依赖注入、import 无副作用。
// 职责：把 tj_preview.tj_gr_outbox 里 kind='gr_task_dispatch' / status='pending' /
//       mock_only=true 的任务，经 bridge 投递到 Windows GR Queue，再把 outbox 标记为
//       mock_dispatched（幂等：同一 request_id 只投递一次）。
//
// 安全边界（永久）：
//   * 只投递 environment=preview / schema=tj.gr.v1 / type=GOODS_RECEIVE / mock_only=true。
//   * 投递前必须离线复算 payload_sha256 与 event_payload_sha256（JS==SQL canonical），
//     任何一项不符即拒绝，绝不投递。
//   * payload 内出现 http(s)/bridge 地址、Windows 盘符/UNC 路径 → 拒绝（防真实出队线索）。
//   * 不 claim、不 result、不触发 IRS Save/Post；本模块只做「投递」。
//
// 与 scripts/gr-mock-dispatcher.mjs 的区别：mock dispatcher 只把 outbox 渲染成**本地 POSIX
// 文件**；本模块经 bridge 把任务真正投递到 Windows（真实传输通道），并回写 outbox 状态。
import { createHash } from 'node:crypto'
import {
  GR_SCHEMA_VERSION,
  GR_ENVIRONMENT,
  canonicalEventPayload,
} from '../web/src/lib/core/receipt-core.js'
import { canonicalTaskPayloadFromPayload } from '../web/src/lib/core/receipt-tasks.js'

export const DISPATCH_SCHEMA = 'tj.gr.dispatch.v1'
export const DISPATCH_KIND = 'GOODS_RECEIVE'
export const OUTBOX_KIND = 'gr_task_dispatch'

// 与 mock dispatcher 相同的「真实出队线索」拒绝（防止把 preview 任务误投到生产）
const FORBIDDEN_VALUE = /(https?:\/\/|\\\\|PO_Queue|[A-Za-z]:\\\\\\)/i

export class DispatchRefused extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DispatchRefused'
    this.code = code
  }
}

function refuse(code, message) {
  throw new DispatchRefused(code, message)
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

function deepScanForForbidden(value, trail, hits) {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) hits.push({ path: trail, value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => deepScanForForbidden(v, `${trail}[${i}]`, hits))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) deepScanForForbidden(v, `${trail}.${k}`, hits)
  }
}

/**
 * 校验一条原始 outbox 行（来自 tj_preview.tj_gr_outbox），返回规范化投递条目。
 * 环境/契约/mock 标识从 payload.task 读取（outbox 顶层只有 mock_only，没有 environment/schema）。
 */
export function validateOutboxRow(row, index = 0) {
  if (!row || typeof row !== 'object') refuse('GR_DISPATCH_INVALID', `第 ${index} 行不是对象`)
  const payload = row.payload ?? {}
  const task = payload.task ?? {}

  if ((task.environment ?? row.environment) !== GR_ENVIRONMENT) {
    refuse('GR_DISPATCH_ENV', `第 ${index} 行 environment=${task.environment}（只允许 preview）`)
  }
  if (row.mock_only !== true && task.mock_only !== true) {
    refuse('GR_DISPATCH_MOCK_ONLY', `第 ${index} 行 mock_only!=true（生产任务不得模拟出队）`)
  }
  if ((task.type ?? task.task_type ?? row.task_type ?? DISPATCH_KIND) !== DISPATCH_KIND) {
    refuse('GR_DISPATCH_TASK_TYPE', `第 ${index} 行 type 非 GOODS_RECEIVE`)
  }
  if ((task.schema ?? task.schema_version ?? row.schema ?? GR_SCHEMA_VERSION) !== GR_SCHEMA_VERSION) {
    refuse('GR_DISPATCH_SCHEMA', `第 ${index} 行 schema 非 tj.gr.v1`)
  }
  if (!row.task_id || !/^[0-9a-f-]{36}$/i.test(String(row.task_id))) {
    refuse('GR_DISPATCH_TASK_ID', `第 ${index} 行缺少合法 task_id`)
  }
  const hash = row.payload_sha256
  if (!/^[0-9a-f]{64}$/.test(String(hash ?? ''))) {
    refuse('GR_DISPATCH_HASH', `第 ${index} 行 payload_sha256 不是 64 位 hex`)
  }

  // payload 必须自带完整事件快照（全部行+来源），否则无法离线重算
  const snapshot = payload.approved_event_snapshot
  const scopeLines = payload.scope?.lines
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Array.isArray(snapshot.lines) ||
    snapshot.lines.length === 0 ||
    !Array.isArray(scopeLines) ||
    scopeLines.length === 0 ||
    !payload.task ||
    !payload.mapping
  ) {
    refuse(
      'GR_DISPATCH_PAYLOAD_INCOMPLETE',
      `第 ${index} 行 payload 缺少完整 approved_event_snapshot/scope/task/mapping`,
    )
  }

  // source_refs 必须覆盖本轮任务的每一条来源分配（不多不少）
  const lineIds = new Set(scopeLines.map((l) => String(l?.line_id ?? '')))
  const expectedAlloc = new Set()
  for (const line of snapshot.lines) {
    if (!lineIds.has(String(line?.id ?? ''))) continue
    for (const s of Array.isArray(line.sources) ? line.sources : []) {
      expectedAlloc.add(`${line.id}|${s.po_line_id}|${String(s.accepted_qty)}`)
    }
  }
  const refs = Array.isArray(payload.source_refs) ? payload.source_refs : []
  const gotAlloc = new Set(refs.map((r) => `${r.receipt_line_id}|${r.po_line_id}|${String(r.accepted_qty)}`))
  if (expectedAlloc.size === 0 || gotAlloc.size !== expectedAlloc.size) {
    refuse('GR_DISPATCH_PAYLOAD_INCOMPLETE', `第 ${index} 行 source_refs 与 scope 来源分配数量不一致`)
  }
  for (const key of expectedAlloc) {
    if (!gotAlloc.has(key)) refuse('GR_DISPATCH_PAYLOAD_INCOMPLETE', `第 ${index} 行 source_refs 缺少分配：${key}`)
  }

  // 真正重算 payload_sha256（JS canonical；与 SQL tj_gr_task_canonical 逐字节一致）
  const recomputed = sha256Hex(canonicalTaskPayloadFromPayload(payload))
  if (recomputed !== String(hash)) {
    refuse(
      'GR_DISPATCH_HASH_MISMATCH',
      `第 ${index} 行 payload_sha256 与内容重算不一致（库内 ${hash}，重算 ${recomputed}）`,
    )
  }
  // 事件快照哈希独立复算
  const eventHash = sha256Hex(canonicalEventPayload(snapshot))
  if (eventHash !== String(payload.event_payload_sha256 ?? '')) {
    refuse(
      'GR_DISPATCH_EVENT_HASH_MISMATCH',
      `第 ${index} 行 event_payload_sha256 与快照重算不一致`,
    )
  }

  const hits = []
  deepScanForForbidden(payload, `[${index}].payload`, hits)
  if (hits.length > 0) {
    refuse('GR_DISPATCH_REAL_BRIDGE', `第 ${index} 行 payload 含真实出队线索：${JSON.stringify(hits[0])}`)
  }

  return {
    task_id: String(row.task_id),
    request_id: row.request_id ? String(row.request_id) : null,
    receipt_event_id: row.receipt_event_id ? String(row.receipt_event_id) : null,
    po_header_id: row.po_header_id ? String(row.po_header_id) : null,
    payload_sha256: String(hash),
    status: row.status ?? 'pending',
    payload,
  }
}

/** 投递信封（与 mock dispatcher 同款 tj.gr.dispatch.v1 / mode=mock） */
export function buildDispatchEnvelope(item, { now = () => new Date(), mode = 'mock' } = {}) {
  return {
    schema: DISPATCH_SCHEMA,
    mode,
    dispatched_at: now().toISOString(),
    task: {
      task_id: item.task_id,
      request_id: item.request_id,
      receipt_event_id: item.receipt_event_id,
      po_header_id: item.po_header_id,
      payload_sha256: item.payload_sha256,
      status: item.status,
      payload: item.payload,
    },
  }
}

/**
 * 创建 dispatcher。依赖全部注入，测试用 mock 即可证明「拒绝路径 deliver 零调用」。
 * @param {{
 *   listPending: () => Promise<Array<object>>,   // 读 pending outbox 行
 *   markDispatched: (row, status, dispatchedAt) => Promise<void>,  // 回写 outbox 状态
 *   deliver: (filename, envelope) => Promise<{ok:boolean, error?:string}>,  // 投递到 Windows
 *   targetDir?: string,
 *   log?: object,
 *   now?: () => Date,
 * }} deps
 */
export function createDispatcher({ listPending, markDispatched, deliver, log = console, now = () => new Date() } = {}) {
  if (typeof listPending !== 'function') throw new Error('createDispatcher 需要 listPending')
  if (typeof markDispatched !== 'function') throw new Error('createDispatcher 需要 markDispatched')
  if (typeof deliver !== 'function') throw new Error('createDispatcher 需要 deliver')

  async function dispatchOne(row) {
    const item = validateOutboxRow(row)
    const envelope = buildDispatchEnvelope(item, { now })
    const filename = `task-${item.task_id}.json`
    const res = await deliver(filename, envelope)
    if (!res || res.ok !== true) {
      throw new Error('bridge 投递失败: ' + (res?.error || JSON.stringify(res)))
    }
    await markDispatched(row, 'mock_dispatched', now().toISOString())
    return filename
  }

  /** 跑一轮：返回结构化结果，便于 cron 日志与测试断言 */
  async function runOnce() {
    const rows = await listPending()
    const summary = { scanned: rows.length, delivered: [], rejected: [], failed: [] }
    for (const row of rows) {
      try {
        const filename = await dispatchOne(row)
        summary.delivered.push({ task_id: row.task_id, filename })
        log.log(`[ok] ${row.task_id} -> ${filename} (${now().toISOString()})`)
      } catch (e) {
        // 校验失败（SHA/环境/契约不符）永不投递；桥失败留 pending 下次重试
        if (e instanceof DispatchRefused) {
          summary.rejected.push({ task_id: row.task_id, code: e.code, reason: e.message })
          log.error(`[reject] ${row.task_id} ${e.code}: ${e.message}`)
        } else {
          summary.failed.push({ task_id: row.task_id, error: e.message })
          log.error(`[err] ${row.task_id}: ${e.message}`)
        }
      }
    }
    return summary
  }

  return { runOnce, dispatchOne, validateOutboxRow, buildDispatchEnvelope }
}
