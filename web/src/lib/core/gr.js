// GR（收货）导出规则 —— 单一真相源（前端 CombinePoPage / 真实样本脚本共用）。
//
// IRS 编号口径（业务冻结）：
//   * irs_po_no / irs_grn_no 只有在「有明确验证证据」时才允许出现在导出里。
//     证据 = 该编号自身的 verified_at + verified_by 元数据均非空。
//   * 没有证据 → 一律输出空字符串，并在 GR_Info 里写明 irs_verification_status，
//     让操作员看到"未验证"而不是看到一个来路不明的编号。
//   * 不按数值/长度/前缀判断编号是否"看起来有效"——任何具体数字（例如 5）都不是规则，
//     编号真假只由验证元数据决定。
//   * GR 正式 push/post 不启用，只有内部 Excel。
//   * 已冻结整行（含 IRS 编号列）在 DB 层不可改：本轮刻意不开放「后补 IRS 编号」白名单。
//     将来若业务授权补录真实已核实编号，必须走专门的元数据写路径（同时写 verified_at/
//     verified_by 并留审计），不能放宽普通 update —— 否则冻结整行保护会被绕过。

import { assertGrPushDisabled } from './push-policy.js'

/** 空值判定：null / undefined / 纯空白 / 空串 都算没有编号 */
function blank(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

/**
 * @param {{value?: string|null, verifiedAt?: string|null, verifiedBy?: string|null, field?: string}} input
 * @returns {{value: string, verified: boolean, status: 'verified'|'unverified'|'missing', reason: string}}
 */
export function resolveVerifiedIrsNo({ value, verifiedAt, verifiedBy, field = 'irs_no' }) {
  if (blank(value)) {
    return { value: '', verified: false, status: 'missing', reason: `${field} 无值` }
  }
  if (blank(verifiedAt)) {
    return {
      value: '',
      verified: false,
      status: 'unverified',
      reason: `${field} 缺少 verified_at 证据，导出留空`,
    }
  }
  if (blank(verifiedBy)) {
    return {
      value: '',
      verified: false,
      status: 'unverified',
      reason: `${field} 缺少 verified_by 证据，导出留空`,
    }
  }
  const t = new Date(String(verifiedAt))
  if (Number.isNaN(t.getTime())) {
    return {
      value: '',
      verified: false,
      status: 'unverified',
      reason: `${field} verified_at 不是有效时间，导出留空`,
    }
  }
  return {
    value: String(value).trim(),
    verified: true,
    status: 'verified',
    reason: '',
  }
}

/**
 * 批准快照状态展示值：优先用调用方传入的 verifyApprovedSnapshot 结果；
 * 未传时按版本推断（v2=unchecked，缺版本=legacy_unverified，普通单=not_applicable）。
 * 这里不做哈希 —— 本函数是同步的，哈希校验由 approved-snapshot.js 完成。
 */
function snapshotStatus(h) {
  if (h.approval_snapshot_status) return String(h.approval_snapshot_status)
  if (h.po_type !== 'combined') return 'not_applicable'
  return Number(h.approval_snapshot_version) === 2 ? 'unchecked' : 'legacy_unverified'
}

/** GR_Info 纵表（字段/值）。前 16 行与既有导出保持一致，新字段追加在末尾。 */
export function buildGrInfoRows(header) {
  const h = header ?? {}
  const poNo = resolveVerifiedIrsNo({
    value: h.irs_po_no,
    verifiedAt: h.irs_po_no_verified_at,
    verifiedBy: h.irs_po_no_verified_by,
    field: 'irs_po_no',
  })
  const grnNo = resolveVerifiedIrsNo({
    value: h.irs_grn_no,
    verifiedAt: h.irs_grn_no_verified_at,
    verifiedBy: h.irs_grn_no_verified_by,
    field: 'irs_grn_no',
  })
  return [
    ['receipt_event_id', h.receipt_event_id ?? ''],
    ['delivery_order_no', h.delivery_order_no ?? ''],
    ['po_id', h.po_id ?? ''],
    ['po_type', h.po_type ?? ''],
    ['po_revision', String(h.po_revision ?? '')],
    ['supplier_code', h.supplier_code ?? ''],
    ['supplier_name', h.supplier_name ?? ''],
    ['received_at', h.received_at ?? ''],
    ['checked_by', h.checked_by ?? ''],
    ['approved_by', h.approved_by ?? ''],
    ['approved_at', h.approved_at ?? ''],
    ['source_sha256', h.source_sha256 ?? ''],
    ['frozen', h.frozen ? 'true' : 'false'],
    ['erp_status', h.erp_status ?? ''],
    // 验证过的编号才输出值；未验证留空
    ['irs_po_no', poNo.value],
    ['irs_grn_no', grnNo.value],
    // 追加：验证证据与状态，避免空编号被误读为"IRS 里没有"
    ['irs_po_no_verified_at', poNo.verified ? String(h.irs_po_no_verified_at) : ''],
    ['irs_po_no_verified_by', poNo.verified ? String(h.irs_po_no_verified_by) : ''],
    ['irs_po_no_status', poNo.status],
    ['irs_grn_no_verified_at', grnNo.verified ? String(h.irs_grn_no_verified_at) : ''],
    ['irs_grn_no_verified_by', grnNo.verified ? String(h.irs_grn_no_verified_by) : ''],
    ['irs_grn_no_status', grnNo.status],
    ['website_po_date', h.website_po_date ?? ''],
    ['export_purpose', 'INTERNAL GR EXCEL (no IRS push/post)'],
    // 追加：批准快照版本与校验状态（正式导出必须 verified；缺版本旧单只允许内部 review）
    ['approval_snapshot_version', h.approval_snapshot_version ?? ''],
    ['approval_snapshot_status', snapshotStatus(h)],
  ]
}

/** GR_Lines 行：订购 vs 实收分开保留，行序与来源行一致 */
export function buildGrLineRows(lines) {
  return (lines ?? []).map((l) => {
    const refs = l.source_refs ?? []
    return {
      line_no: Number(l.line_no),
      item_code: l.item_code,
      description: l.description,
      uom: l.uom ?? '',
      ordered_qty: Number(l.original_qty ?? l.qty),
      accepted_qty: Number(l.accepted_qty ?? l.qty),
      unit_price: Number(l.unit_price),
      source_pos: refs.map((r) => r.po_number).join(', '),
      source_line_ids: refs.map((r) => r.line_id).join(', '),
      note: l.note ?? '',
    }
  })
}

export const GR_LINE_COLUMNS = Object.freeze([
  { header: 'Line No', key: 'line_no', width: 8 },
  { header: 'Item Code', key: 'item_code', width: 16 },
  { header: 'Description', key: 'description', width: 46 },
  { header: 'UOM', key: 'uom', width: 10 },
  { header: 'Ordered Qty', key: 'ordered_qty', width: 12 },
  { header: 'Accepted Qty', key: 'accepted_qty', width: 12 },
  { header: 'Unit Price (RM)', key: 'unit_price', width: 16 },
  { header: 'Source PO', key: 'source_pos', width: 22 },
  { header: 'Source Line IDs', key: 'source_line_ids', width: 30 },
  { header: 'Note', key: 'note', width: 26 },
])

export const GR_INFO_COLUMNS = Object.freeze([
  { header: 'Field', key: 'field', width: 24 },
  { header: 'Value', key: 'value', width: 60 },
])

export { assertGrPushDisabled }
