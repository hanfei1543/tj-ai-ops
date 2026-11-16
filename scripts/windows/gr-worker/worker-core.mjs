// Windows GR Worker 核心 —— 纯逻辑、依赖注入、import 无副作用、可在仓库内直接单测。
//
// 五阶段严格区分（收到任务 ≠ 已入库）：
//   1. delivery      收到投递文件（dispatcher 经 bridge 写入 GR Queue Pending）
//   2. claim         经 tj_gr_api('task_claim') 原子领取（lease 5 分钟）
//   3. save_attempt  经 PAD 录入后回报 save_attempted
//   4. saved         PAD 确认保存后回报 saved（saved_unverified）
//   5. verified      PAD 独立回查通过后回报 verified（逐行证据比对，终态）
//
// PAD 未接入时：pad.isConnected() === false → 不领取（不污染数据库），账本记
// phase=delivery / status=waiting_pad，文件留在 Pending 等 PAD 接入。
//
// 安全边界：
//   * claim 前离线复算 payload_sha256 / event_payload_sha256（JS==SQL），不符即拒绝。
//   * environment/schema/mock_only 硬校验，非 preview/mock 绝不 claim、绝不保存。
//   * verified 必须经 pad.readBack() 真实回查；readBack 未实现 → 永远停在 saved，不伪造 verified。
import { createHash } from 'node:crypto'
import {
  GR_SCHEMA_VERSION,
  GR_ENVIRONMENT,
  canonicalEventPayload,
} from '../../../web/src/lib/core/receipt-core.js'
import { canonicalTaskPayloadFromPayload } from '../../../web/src/lib/core/receipt-tasks.js'

export const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex')

// 五阶段（只用于账本/日志标记，不是数据库状态；数据库状态由 tj_gr_task_* 权威维护）
export const PHASE = Object.freeze({
  DELIVERY: 'delivery',
  CLAIM: 'claim',
  SAVE_ATTEMPT: 'save_attempt',
  SAVED: 'saved',
  VERIFIED: 'verified',
})

export class WorkerError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 校验投递信封（tj.gr.dispatch.v1 / mode=mock）。返回规范化条目或抛 WorkerError。
 */
export function validateEnvelope(envelope, index = 0) {
  if (!envelope || typeof envelope !== 'object') throw new WorkerError('GR_WORKER_INVALID', `第 ${index} 项不是对象`)
  if (envelope.schema !== 'tj.gr.dispatch.v1') {
    throw new WorkerError('GR_WORKER_SCHEMA', `信封 schema=${envelope.schema} 非 tj.gr.dispatch.v1`)
  }
  if (envelope.mode !== 'mock') {
    throw new WorkerError('GR_WORKER_MODE', `信封 mode=${envelope.mode} 非 mock（真实出队未授权）`)
  }
  const t = envelope.task ?? {}
  const payload = t.payload ?? {}
  const task = payload.task ?? {}

  if (t.task_id && !/^[0-9a-f-]{36}$/i.test(String(t.task_id))) {
    throw new WorkerError('GR_WORKER_TASK_ID', 'task_id 非 uuid')
  }
  if ((task.environment ?? GR_ENVIRONMENT) !== GR_ENVIRONMENT) {
    throw new WorkerError('GR_WORKER_ENV', `task.environment=${task.environment} 非 preview`)
  }
  if (task.mock_only !== true) {
    throw new WorkerError('GR_WORKER_MOCK', 'task.mock_only!=true（真实任务未授权）')
  }
  if ((task.schema ?? task.schema_version ?? GR_SCHEMA_VERSION) !== GR_SCHEMA_VERSION) {
    throw new WorkerError('GR_WORKER_SCHEMA', 'task.schema 非 tj.gr.v1')
  }
  if ((task.type ?? task.task_type ?? 'GOODS_RECEIVE') !== 'GOODS_RECEIVE') {
    throw new WorkerError('GR_WORKER_TYPE', 'task.type 非 GOODS_RECEIVE')
  }

  const hash = t.payload_sha256
  if (!/^[0-9a-f]{64}$/.test(String(hash ?? ''))) {
    throw new WorkerError('GR_WORKER_HASH', 'payload_sha256 不是 64 位 hex')
  }

  // 离线复算（JS canonical，与 SQL 逐字节一致）
  const snapshot = payload.approved_event_snapshot
  if (!snapshot || !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
    throw new WorkerError('GR_WORKER_PAYLOAD', 'payload 缺少完整 approved_event_snapshot')
  }
  const calcPayload = sha256Hex(canonicalTaskPayloadFromPayload(payload))
  if (calcPayload !== String(hash)) {
    throw new WorkerError('GR_WORKER_HASH_MISMATCH', `payload_sha256 复算不符（库内 ${hash}，实算 ${calcPayload}）`)
  }
  const calcEvent = sha256Hex(canonicalEventPayload(snapshot))
  if (calcEvent !== String(payload.event_payload_sha256 ?? '')) {
    throw new WorkerError('GR_WORKER_EVENT_HASH_MISMATCH', 'event_payload_sha256 复算不符')
  }

  return {
    task_id: String(t.task_id),
    receipt_event_id: String(t.receipt_event_id ?? ''),
    po_header_id: String(t.po_header_id ?? ''),
    payload_sha256: String(hash),
    payload,
  }
}

/**
 * 创建 worker。依赖全部注入，测试用 mock 即可证明五阶段顺序、重复阻断、PAD 未接入时不 claim。
 * @param {{
 *   rpc: { claim: (taskId) => Promise<object>, result: (args) => Promise<object> },
 *   pad: { isConnected: () => boolean, saveEntry: (task) => Promise<object>, readBack: (task) => Promise<object> },
 *   ledger: { seen: (taskId) => boolean, record: (entry) => Promise<void> },
 *   log?: object,
 *   now?: () => Date,
 * }} deps
 */
export function createWorker({ rpc, pad, ledger, log = console, now = () => new Date() } = {}) {
  if (typeof rpc?.claim !== 'function' || typeof rpc?.result !== 'function') {
    throw new Error('createWorker 需要 rpc.claim / rpc.result')
  }
  if (!pad || typeof pad.isConnected !== 'function') throw new Error('createWorker 需要 pad.isConnected')
  if (typeof ledger?.seen !== 'function' || typeof ledger?.record !== 'function') {
    throw new Error('createWorker 需要 ledger.seen / ledger.record')
  }

  /**
   * 处理单个投递信封（五阶段）。返回结构化结果供测试断言与账本落盘。
   */
  async function processTask(envelope) {
    const item = validateEnvelope(envelope)

    // 重复阻断：同一 task_id 已处理过 → 跳过（幂等，不重复 claim/save）
    if (ledger.seen(item.task_id)) {
      return { task_id: item.task_id, phase: PHASE.DELIVERY, status: 'duplicate_skipped', ok: true }
    }
    await ledger.record({ task_id: item.task_id, phase: PHASE.DELIVERY, status: 'received', at: now().toISOString() })

    // PAD 未接入：不领取（claim 意味着即将保存），账本标记 waiting_pad，等接入
    if (!pad.isConnected()) {
      await ledger.record({ task_id: item.task_id, phase: PHASE.DELIVERY, status: 'waiting_pad', at: now().toISOString() })
      return { task_id: item.task_id, phase: PHASE.DELIVERY, status: 'waiting_pad', ok: true }
    }

    // 2) claim（原子领取，lease 5 分钟；重复 claim 会 GR_TASK_LEASED / GR_TASK_STALE_REVIEW）
    const claim = await rpc.claim(item.task_id)
    if (claim?.rejected) {
      await ledger.record({ task_id: item.task_id, phase: PHASE.CLAIM, status: 'claim_rejected', code: claim.code, at: now().toISOString() })
      return { task_id: item.task_id, phase: PHASE.CLAIM, status: 'claim_rejected', code: claim.code, ok: false }
    }
    await ledger.record({ task_id: item.task_id, phase: PHASE.CLAIM, status: 'claimed', at: now().toISOString() })

    // 3) save_attempt：经 PAD 录入（saveEntry），回报 save_attempted
    const savePayload = {
      task_id: item.task_id,
      receipt_event_id: item.receipt_event_id,
      payload_sha256: item.payload_sha256,
      callback_id: `cb-save-${item.task_id}`,
      event_type: 'save_attempted',
      evidence: { bridge_ok: true },
    }
    try {
      await pad.saveEntry(item.payload)
    } catch (e) {
      // PAD 录入失败 → 回报 failed（save_attempted_at 未写 → failed_unsaved，可安全重试）
      const r = await rpc.result({ ...savePayload, event_type: 'failed', callback_id: `cb-fail-${item.task_id}`, evidence: { bridge_ok: false }, error: `PAD saveEntry failed: ${e.message}` })
      await ledger.record({ task_id: item.task_id, phase: PHASE.SAVE_ATTEMPT, status: 'save_failed', error: e.message, at: now().toISOString() })
      return { task_id: item.task_id, phase: PHASE.SAVE_ATTEMPT, status: 'save_failed', error: e.message, ok: false }
    }
    const saveAttempted = await rpc.result(savePayload)
    await ledger.record({ task_id: item.task_id, phase: PHASE.SAVE_ATTEMPT, status: 'save_attempted', at: now().toISOString() })

    // 4) saved：PAD 确认保存，回报 saved（saved_unverified）
    const saved = await rpc.result({ ...savePayload, callback_id: `cb-saved-${item.task_id}`, event_type: 'saved', evidence: { bridge_ok: true } })
    await ledger.record({ task_id: item.task_id, phase: PHASE.SAVED, status: 'saved_unverified', at: now().toISOString() })

    // 5) verified：PAD 独立回查（readBack），逐行证据比对后回报 verified
    let readback
    try {
      readback = await pad.readBack(item.payload)
    } catch (e) {
      // 回查未实现/失败 → 停在 saved，绝不伪造 verified
      await ledger.record({ task_id: item.task_id, phase: PHASE.VERIFIED, status: 'readback_unavailable', error: e.message, at: now().toISOString() })
      return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'readback_unavailable', error: e.message, ok: false }
    }
    const verified = await rpc.result({
      task_id: item.task_id,
      receipt_event_id: item.receipt_event_id,
      payload_sha256: item.payload_sha256,
      callback_id: `cb-verified-${item.task_id}`,
      event_type: 'verified',
      evidence: readback,
    })
    if (verified?.rejected) {
      await ledger.record({ task_id: item.task_id, phase: PHASE.VERIFIED, status: 'needs_review', code: verified.code, mismatches: verified.mismatches, at: now().toISOString() })
      return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'needs_review', code: verified.code, ok: false }
    }
    await ledger.record({ task_id: item.task_id, phase: PHASE.VERIFIED, status: 'verified', at: now().toISOString() })
    return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'verified', ok: true }
  }

  return { processTask, validateEnvelope }
}
