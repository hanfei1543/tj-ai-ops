// 合并单提交/批准的多步写入编排 —— 单一真相源（前端 API 调用，Node 测试用假 IO 直接跑）。
//
// 关键约束（这些 bug 曾经真实出现过）：
//   * `.update(...).eq('id')` 更新 0 行在 PostgREST 里不是错误。必须带条件
//     status/frozen + `.select().single()` 确认「确实改到了这一行」，否则会出现
//     「点了批准、界面显示已批准、库里其实没动」的假成功。
//   * 批准摘要只能由 DB 读回的 header + lines 计算；调用方不得传 hash。
//   * 冻结写入成功 + 读回校验通过之后，才允许改来源单状态。
//     读回失败或摘要不一致 → 直接拒绝（来源单保持 combining），交人工复核。
//
// 本模块不发请求、不读 env、无副作用：所有 IO 由调用方注入。
import { assertCombinedSubmittable, assertCombinedApprovable } from './combined-gate.js'
import {
  APPROVAL_SNAPSHOT_VERSION,
  computeApprovalSnapshotHash,
  verifyApprovedSnapshot,
} from './approved-snapshot.js'

function requireIo(io) {
  for (const name of [
    'readHeader',
    'readLines',
    'updateHeaderConditional',
    'updateSourceStatuses',
  ]) {
    if (typeof io?.[name] !== 'function') {
      throw new Error(`合并单流程缺少 IO.${name}`)
    }
  }
}

function defaultReceiptEventId() {
  const c = globalThis.crypto
  if (!c?.randomUUID) throw new Error('当前运行时缺少 crypto.randomUUID，无法生成收货事件 ID')
  return c.randomUUID()
}

/**
 * 提交最终审批：draft -> pending_approval。
 * 条件更新（status=draft 且 frozen=false）必须命中 1 行，否则抛错（不静默成功）。
 *
 * @param {{
 *   io: {
 *     readHeader: (id: string) => Promise<object>,
 *     updateHeaderConditional: (args: {
 *       id: string, expectStatus: string, expectFrozen: boolean, patch: object,
 *     }) => Promise<object|null>,
 *   },
 *   id: string,
 *   checkedBy: string,
 *   deliveryOrderNo?: string|null,
 *   now?: () => Date,
 *   newReceiptEventId?: () => string,
 * }} args
 * @returns {Promise<object>} 更新后的 header（由 DB 返回，非本地拼装）
 */
export async function submitCombinedForApprovalFlow({
  io,
  id,
  checkedBy,
  deliveryOrderNo = null,
  now = () => new Date(),
  newReceiptEventId = defaultReceiptEventId,
} = {}) {
  requireIo(io)
  const hdr = await io.readHeader(id)
  assertCombinedSubmittable(hdr)

  const iso = now().toISOString()
  const updated = await io.updateHeaderConditional({
    id,
    expectStatus: 'draft',
    expectFrozen: false,
    patch: {
      status: 'pending_approval',
      checked_by: checkedBy,
      delivery_order_no: deliveryOrderNo ?? null,
      receipt_event_id: newReceiptEventId(),
      received_at: iso,
      updated_at: iso,
    },
  })
  if (!updated) {
    throw new Error(
      `合并单 ${hdr.po_id ?? id} 提交审批更新 0 行：状态已被改变（可能已被他人提交/取消），请刷新后重试`,
    )
  }
  if (updated.status !== 'pending_approval') {
    throw new Error(
      `合并单 ${hdr.po_id ?? id} 提交审批后状态为 ${updated.status ?? '未知'}，不是 pending_approval，请刷新核对`,
    )
  }
  return updated
}

/**
 * 批准并冻结：pending_approval -> confirmed + frozen。
 * 顺序：读最新 header/lines → 算摘要 → 条件更新 → 读回重算校验 → 才改来源单状态。
 *
 * @param {{
 *   io: {
 *     readHeader: (id: string) => Promise<object>,
 *     readLines: (id: string) => Promise<object[]>,
 *     updateHeaderConditional: (args: {
 *       id: string, expectStatus: string, expectFrozen: boolean, patch: object,
 *     }) => Promise<object|null>,
 *     updateSourceStatuses: (args: {
 *       poNumbers: string[], status: string, onlyFrom: string[],
 *     }) => Promise<{updated: number}>,
 *   },
 *   id: string,
 *   approvedBy: string,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{hash: string, version: number}>}
 */
export async function approveCombinedPoFlow({ io, id, approvedBy, now = () => new Date() } = {}) {
  requireIo(io)
  // 1) 最新事实：不信任调用方传进来的 header
  const hdr = await io.readHeader(id)
  assertCombinedApprovable(hdr)

  const lines = await io.readLines(id)
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`合并单 ${hdr.po_id ?? id} 没有明细行，不能批准`)
  }

  // 2) 摘要只由 DB 数据计算
  const hash = await computeApprovalSnapshotHash(hdr, lines)
  const iso = now().toISOString()

  // 3) 条件更新：status 必须是 pending_approval 且尚未冻结，命中 0 行即失败
  const updated = await io.updateHeaderConditional({
    id,
    expectStatus: 'pending_approval',
    expectFrozen: false,
    patch: {
      status: 'confirmed',
      frozen: true,
      approved_by: approvedBy,
      approved_at: iso,
      source_sha256: hash,
      approval_snapshot_version: APPROVAL_SNAPSHOT_VERSION,
      updated_at: iso,
    },
  })
  if (!updated) {
    throw new Error(
      `合并单 ${hdr.po_id ?? id} 批准更新 0 行：状态已变化（可能已被他人批准/取消），请刷新后重试`,
    )
  }
  if (updated.status !== 'confirmed' || updated.frozen !== true) {
    throw new Error(
      `合并单 ${hdr.po_id ?? id} 批准后状态/冻结标记异常（status=${updated.status ?? '未知'}, frozen=${String(
        updated.frozen,
      )}），请立即人工核对`,
    )
  }

  // 4) 读回双校验：读取失败或摘要不一致 → 直接拒绝，来源单保持 combining
  const readBackHeader = await io.readHeader(id)
  const readBackLines = await io.readLines(id)
  const verification = await verifyApprovedSnapshot({ header: readBackHeader, lines: readBackLines })
  if (!verification.ok || verification.actualHash !== hash) {
    throw new Error(
      `合并单 ${hdr.po_id ?? id} 批准已写入，但读回快照校验失败（${verification.status}）：` +
        '不得视为已校验批准快照；来源单状态未变更，请立即人工复核',
    )
  }

  // 5) 只有在冻结 + 读回校验都通过后，才推进来源单状态
  const sources = Array.isArray(hdr.source_po_ids) ? hdr.source_po_ids.filter(Boolean) : []
  const res = await io.updateSourceStatuses({
    poNumbers: sources,
    status: 'combined',
    onlyFrom: ['combining'],
  })
  const updatedCount = Number(res?.updated ?? 0)
  if (updatedCount !== sources.length) {
    throw new Error(
      `合并单 ${hdr.po_id ?? id} 已批准冻结，但来源单状态更新 ${updatedCount}/${sources.length} 行：` +
        '请人工核对来源单状态（不要重复批准，记录已冻结）',
    )
  }

  return { hash, version: APPROVAL_SNAPSHOT_VERSION }
}
