// Windows GR Worker 核心 —— 纯逻辑、依赖注入、import 无副作用、可在仓库内直接单测。
//
// 七步严格区分（收到任务 ≠ 已入库；已领取 ≠ 已保存；已保存 ≠ 已核对）：
//   1. delivery      收到投递文件（dispatcher 经 bridge 写入 GR Queue Pending）
//   2. claim         经 tj_gr_api('task_claim') 原子领取（lease 5 分钟）
//   3. draft         未保存录入（pad.saveEntry）+ 完整核对（reconcileDraft）
//   4. save_intent   持久化不可逆 Save Intent（回报 save_attempted）—— 必须先于实际保存
//   5. commit        实际 Save 一次（pad.commitSave，只能一次）
//   6. saved         回报 saved（saved_unverified）
//   7. verified      独立回查（pad.readBack）+ 回报 verified（终态）
//
// PAD 未就绪时：pad.isReady() === false → 不领取（不污染数据库），账本记 waiting_pad，
// 文件留在 Pending 等 PAD 接入；连续扫描不会把 waiting_pad 当作 Done。
//
// 安全边界：
//   * claim 前离线复算 payload_sha256 / event_payload_sha256（JS==SQL），不符即拒绝。
//   * 同一 task_id 不同 payload_sha256 → sha_conflict（阻断，不当作重复跳过）。
//   * environment/schema 硬校验；非 mock 任务默认拒绝（allowReal 显式开启才放行）。
//   * 实际 Save 前必须已回报 save_attempted；保存超时/断线/结果不明 → needs_review（绝不重试）。
//   * 没有真实保存证据不得回报 saved；没有真实 GRN 独立回查证据不得回报 verified。
import { createHash } from 'node:crypto'
import {
  GR_SCHEMA_VERSION,
  GR_ENVIRONMENT,
  canonicalEventPayload,
} from '../../../web/src/lib/core/receipt-core.js'
import { canonicalTaskPayloadFromPayload } from '../../../web/src/lib/core/receipt-tasks.js'

export const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex')

// 七阶段（只用于账本/日志标记；数据库状态由 tj_gr_task_* 权威维护）
export const PHASE = Object.freeze({
  DELIVERY: 'delivery',
  CLAIM: 'claim',
  DRAFT: 'draft',
  SAVE_INTENT: 'save_intent',
  COMMIT: 'commit',
  SAVED: 'saved',
  VERIFIED: 'verified',
})

// 终态（关闭后不再自动重试）。waiting_pad / claim_leased / claim_rpc_error / draft_failed /
// reconcile_failed 都是非终态（可安全重试，因为尚未开始实际保存）。
export const TERMINAL_STATUS = new Set([
  'verified', 'needs_review', 'duplicate_skipped', 'sha_conflict', 'claim_rejected',
])

export class WorkerError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 校验投递信封（tj.gr.dispatch.v1 / mode=mock|real）。返回规范化条目或抛 WorkerError。
 * @param {object} envelope
 * @param {number} index 用于错误信息定位
 * @param {{ allowReal?: boolean }} opts  allowReal=true 才接受 mode=real / mock_only=false（正式路径）
 */
export function validateEnvelope(envelope, index = 0, opts = {}) {
  const allowReal = opts.allowReal === true
  if (!envelope || typeof envelope !== 'object') throw new WorkerError('GR_WORKER_INVALID', `第 ${index} 项不是对象`)
  if (envelope.schema !== 'tj.gr.dispatch.v1') {
    throw new WorkerError('GR_WORKER_SCHEMA', `信封 schema=${envelope.schema} 非 tj.gr.dispatch.v1`)
  }
  if (envelope.mode === 'mock') {
    // mock 出队：允许（下方校验 mock_only===true）
  } else if (envelope.mode === 'real') {
    if (!allowReal) throw new WorkerError('GR_WORKER_MODE', 'mode=real（真实出队）未授权：allowReal=false')
  } else {
    throw new WorkerError('GR_WORKER_MODE', `信封 mode=${envelope.mode} 非 mock/real`)
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
  if (envelope.mode === 'mock' && task.mock_only !== true) {
    throw new WorkerError('GR_WORKER_MOCK', 'mode=mock 但 task.mock_only!=true（矛盾）')
  }
  if (envelope.mode === 'real' && task.mock_only !== false) {
    throw new WorkerError('GR_WORKER_MOCK', 'mode=real 但 task.mock_only!=false（真实任务必须显式 mock_only=false）')
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
 * 完整核对：比较 PAD 未保存录入的 draft 与 task.scope 的逐行镜像
 * （item_code / uom / qty / unit_price / 来源分配）。任何一行不一致 → 绝不进入 Save Intent。
 */
export function reconcileDraft(payload, draft) {
  const scopeLines = payload?.scope?.lines ?? []
  const draftLines = draft?.lines ?? []
  const mismatches = []
  if (!Array.isArray(draftLines) || draftLines.length !== scopeLines.length) {
    return { ok: false, mismatches: [{ reason: `draft 行数 ${draftLines.length} != scope 行数 ${scopeLines.length}` }] }
  }
  const byId = new Map(draftLines.map((l) => [String(l?.line_id ?? ''), l]))
  for (const s of scopeLines) {
    const sid = String(s?.line_id ?? '')
    const d = byId.get(sid)
    if (!d) { mismatches.push({ line_id: sid, field: 'line', reason: 'draft 缺少该行' }); continue }
    if (String(d.item_code ?? '') !== String(s.item_code ?? '')) mismatches.push({ line_id: sid, field: 'item_code' })
    if (String(d.uom ?? '') !== String(s.uom ?? '')) mismatches.push({ line_id: sid, field: 'uom' })
    if (String(d.unit_price ?? '') !== String(s.unit_price ?? '')) mismatches.push({ line_id: sid, field: 'unit_price' })
    if (String(d.qty ?? '') !== String(s.accepted_qty ?? '')) mismatches.push({ line_id: sid, field: 'qty' })
    const sSrc = (s.sources ?? []).map((x) => `${x.po_line_id}|${x.accepted_qty}`).sort()
    const dSrc = (d.sources ?? []).map((x) => `${x.po_line_id}|${x.accepted_qty}`).sort()
    if (JSON.stringify(sSrc) !== JSON.stringify(dSrc)) mismatches.push({ line_id: sid, field: 'sources' })
  }
  return { ok: mismatches.length === 0, mismatches }
}

/**
 * 创建 worker。依赖全部注入，测试用 mock 即可证明七步顺序、重复/SHA 阻断、PAD 未就绪不 claim。
 * @param {{
 *   rpc: { claim: (taskId) => Promise<object>, result: (args) => Promise<object> },
 *   pad: { isReady: () => boolean, saveEntry: (task) => Promise<object>, commitSave: (task, draft) => Promise<object>, readBack: (task) => Promise<object> },
 *   ledger: { get: (taskId) => object|null, record: (entry) => void|Promise<void> },
 *   allowReal?: boolean,
 *   log?: object,
 *   now?: () => Date,
 * }} deps
 */
export function createWorker({ rpc, pad, ledger, allowReal = false, log = console, now = () => new Date() } = {}) {
  if (typeof rpc?.claim !== 'function' || typeof rpc?.result !== 'function') {
    throw new Error('createWorker 需要 rpc.claim / rpc.result')
  }
  if (!pad || typeof pad.isReady !== 'function') throw new Error('createWorker 需要 pad.isReady')
  if (typeof pad.saveEntry !== 'function' || typeof pad.commitSave !== 'function' || typeof pad.readBack !== 'function') {
    throw new Error('createWorker 需要 pad.saveEntry / pad.commitSave / pad.readBack')
  }
  if (typeof ledger?.get !== 'function' || typeof ledger?.record !== 'function') {
    throw new Error('createWorker 需要 ledger.get / ledger.record')
  }

  function record(item, phase, status, terminal, extra = {}) {
    return ledger.record({
      task_id: item.task_id,
      payload_sha256: item.payload_sha256,
      phase,
      status,
      terminal,
      at: now().toISOString(),
      ...extra,
    })
  }
  function resultPayload(item, eventType, callbackId, evidence, error) {
    return {
      task_id: item.task_id,
      receipt_event_id: item.receipt_event_id,
      payload_sha256: item.payload_sha256,
      callback_id: callbackId,
      event_type: eventType,
      evidence,
      ...(error !== undefined && error !== null ? { error } : {}),
    }
  }

  /** best-effort 回报 needs_review（网络可能已断，忽略失败；DB 终态由 claim 时 GR_TASK_STALE_REVIEW 兜底） */
  async function reportNeedsReview(item, error) {
    try {
      await rpc.result(resultPayload(item, 'needs_review', `cb-review-${item.task_id}`, { bridge_ok: false }, error || 'worker 转入人工核对'))
    } catch (e) {
      if (log?.error) log.error(`[needs_review] 回报失败（忽略）: ${e?.message}`)
    }
  }

  /**
   * 处理单个投递信封（七步）。返回结构化结果（含 terminal 标志）供测试断言与账本/队列路由。
   */
  async function processTask(envelope) {
    const item = validateEnvelope(envelope, 0, { allowReal })

    // —— 重复 / SHA 冲突阻断（账本持久化状态机）——
    const existing = ledger.get(item.task_id)
    if (existing) {
      if (existing.payload_sha256 != null && existing.payload_sha256 !== item.payload_sha256) {
        // 同一 task_id 换了一个不同的 SHA → 阻断（不当作重复跳过，防止被替换文件静默处理）
        await record(item, PHASE.DELIVERY, 'sha_conflict', true, {
          error: `payload_sha256 与已处理不一致（账本 ${existing.payload_sha256}，本次 ${item.payload_sha256}）`,
        })
        return { task_id: item.task_id, phase: PHASE.DELIVERY, status: 'sha_conflict', terminal: true, ok: false }
      }
      if (existing.terminal) {
        return { task_id: item.task_id, phase: PHASE.DELIVERY, status: 'duplicate_skipped', terminal: true, ok: true }
      }
      // 非终态（waiting_pad/claimed/…）→ 落空继续重试
    } else {
      await record(item, PHASE.DELIVERY, 'received', false)
    }

    // —— 1) PAD 就绪检查：未就绪不领取（claim 意味着即将保存）——
    if (!pad.isReady()) {
      await record(item, PHASE.DELIVERY, 'waiting_pad', false, { ready: false })
      return { task_id: item.task_id, phase: PHASE.DELIVERY, status: 'waiting_pad', terminal: false, ok: true }
    }

    // —— 2) claim（原子领取，lease 5 分钟）——
    let claim
    try {
      claim = await rpc.claim(item.task_id)
    } catch (e) {
      const code = e?.code || 'GR_RPC_ERROR'
      if (code === 'GR_RPC_TIMEOUT' || code === 'GR_RPC_AUTH') {
        await record(item, PHASE.CLAIM, 'claim_rpc_error', false, { code, error: e?.message })
        return { task_id: item.task_id, phase: PHASE.CLAIM, status: 'claim_rpc_error', terminal: false, ok: false, code, error: e?.message }
      }
      // DB 抛业务错误（GR_STATE/GR_NOT_FOUND/GR_FORBIDDEN…）→ 终态 claim_rejected
      await record(item, PHASE.CLAIM, 'claim_rejected', true, { code, error: e?.message })
      return { task_id: item.task_id, phase: PHASE.CLAIM, status: 'claim_rejected', terminal: true, ok: false, code }
    }
    if (claim?.rejected) {
      const code = claim.code
      if (code === 'GR_TASK_LEASED') {
        await record(item, PHASE.CLAIM, 'claim_leased', false, { code })
        return { task_id: item.task_id, phase: PHASE.CLAIM, status: 'claim_leased', terminal: false, ok: false, code }
      }
      if (code === 'GR_TASK_STALE_REVIEW') {
        await record(item, PHASE.CLAIM, 'needs_review', true, { code })
        return { task_id: item.task_id, phase: PHASE.CLAIM, status: 'needs_review', terminal: true, ok: false, code }
      }
      await record(item, PHASE.CLAIM, 'claim_rejected', true, { code })
      return { task_id: item.task_id, phase: PHASE.CLAIM, status: 'claim_rejected', terminal: true, ok: false, code }
    }
    await record(item, PHASE.CLAIM, 'claimed', false)

    // —— 3) draft：未保存录入 + 完整核对（本地 PAD，未碰 DB；失败可安全重试）——
    let draft
    try {
      draft = await pad.saveEntry(item.payload)
    } catch (e) {
      await record(item, PHASE.DRAFT, 'draft_failed', false, { error: e?.message })
      return { task_id: item.task_id, phase: PHASE.DRAFT, status: 'draft_failed', terminal: false, ok: false, error: e?.message }
    }
    const reconcile = reconcileDraft(item.payload, draft)
    if (!reconcile.ok) {
      await record(item, PHASE.DRAFT, 'reconcile_failed', false, { mismatches: reconcile.mismatches })
      return { task_id: item.task_id, phase: PHASE.DRAFT, status: 'reconcile_failed', terminal: false, ok: false, mismatches: reconcile.mismatches }
    }
    await record(item, PHASE.DRAFT, 'draft_entered', false)

    // —— 4) save_intent：持久化不可逆 Save Intent（必须先于实际保存）——
    let saveAttempted
    try {
      saveAttempted = await rpc.result(resultPayload(item, 'save_attempted', `cb-save-${item.task_id}`, { bridge_ok: true }))
    } catch (e) {
      await reportNeedsReview(item, `save_attempted 回报失败：${e?.message}`)
      await record(item, PHASE.SAVE_INTENT, 'needs_review', true, { code: e?.code, error: e?.message })
      return { task_id: item.task_id, phase: PHASE.SAVE_INTENT, status: 'needs_review', terminal: true, ok: false, code: e?.code, error: e?.message }
    }
    if (saveAttempted?.rejected) {
      await record(item, PHASE.SAVE_INTENT, 'needs_review', true, { code: saveAttempted.code })
      return { task_id: item.task_id, phase: PHASE.SAVE_INTENT, status: 'needs_review', terminal: true, ok: false, code: saveAttempted.code }
    }
    await record(item, PHASE.SAVE_INTENT, 'save_attempted', false)

    // —— 5) commit：实际 Save 一次（只能一次；超时/断线/结果不明 → needs_review，绝不重试）——
    let saveResult
    try {
      saveResult = await pad.commitSave(item.payload, draft)
    } catch (e) {
      await reportNeedsReview(item, `实际保存结果不明（超时/断线）：${e?.message}`)
      await record(item, PHASE.COMMIT, 'needs_review', true, { error: e?.message })
      return { task_id: item.task_id, phase: PHASE.COMMIT, status: 'needs_review', terminal: true, ok: false, error: e?.message }
    }
    if (saveResult?.saved !== true) {
      await reportNeedsReview(item, saveResult?.error || '实际保存未成功（无真实保存证据）')
      await record(item, PHASE.COMMIT, 'needs_review', true, { error: saveResult?.error })
      return { task_id: item.task_id, phase: PHASE.COMMIT, status: 'needs_review', terminal: true, ok: false, error: saveResult?.error }
    }
    await record(item, PHASE.COMMIT, 'committed', false)

    // —— 6) saved：回报保存成功状态（saved_unverified）——
    let saved
    try {
      saved = await rpc.result(resultPayload(item, 'saved', `cb-saved-${item.task_id}`, { bridge_ok: true }))
    } catch (e) {
      await reportNeedsReview(item, `saved 回报失败：${e?.message}`)
      await record(item, PHASE.SAVED, 'needs_review', true, { error: e?.message })
      return { task_id: item.task_id, phase: PHASE.SAVED, status: 'needs_review', terminal: true, ok: false, error: e?.message }
    }
    if (saved?.rejected) {
      await reportNeedsReview(item, `saved 被拒：${saved.code}`)
      await record(item, PHASE.SAVED, 'needs_review', true, { code: saved.code })
      return { task_id: item.task_id, phase: PHASE.SAVED, status: 'needs_review', terminal: true, ok: false, code: saved.code }
    }
    await record(item, PHASE.SAVED, 'saved_unverified', false)

    // —— 7) verified：独立回查 + 回报 verified（终态）——
    let readback
    try {
      readback = await pad.readBack(item.payload)
    } catch (e) {
      await reportNeedsReview(item, `独立回查失败：${e?.message}`)
      await record(item, PHASE.VERIFIED, 'needs_review', true, { error: e?.message })
      return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'needs_review', terminal: true, ok: false, error: e?.message }
    }
    let verified
    try {
      verified = await rpc.result(resultPayload(item, 'verified', `cb-verified-${item.task_id}`, readback))
    } catch (e) {
      await reportNeedsReview(item, `verified 回报失败：${e?.message}`)
      await record(item, PHASE.VERIFIED, 'needs_review', true, { error: e?.message })
      return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'needs_review', terminal: true, ok: false, error: e?.message }
    }
    if (verified?.rejected) {
      await record(item, PHASE.VERIFIED, 'needs_review', true, { code: verified.code, mismatches: verified.mismatches })
      return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'needs_review', terminal: true, ok: false, code: verified.code, mismatches: verified.mismatches }
    }
    await record(item, PHASE.VERIFIED, 'verified', true)
    return { task_id: item.task_id, phase: PHASE.VERIFIED, status: 'verified', terminal: true, ok: true }
  }

  return {
    processTask,
    validateEnvelope: (env, i = 0) => validateEnvelope(env, i, { allowReal }),
    reconcileDraft,
  }
}
