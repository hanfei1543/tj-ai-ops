// 合并单提交/批准门禁 —— 单一真相源（前端 API 与 Node 测试共用）。
//
// A 已批准口径：Website PO Date 是「开单/核对人显式选择」的正式采购业务日期。
//   * 不是创建日期、不是收货日期、不是审批日期，也绝不默认当天。
//   * 建单并提交最终审批前必须有合法日期；缺失即 fail closed，直接拒绝，不允许
//     「先跳过日期继续审批、以后再补」。
//   * 批准时再次校验（双校验）；批准后日期与明细一起冻结，由 DB 触发器兜底。
//
// 这里只做纯判定，不碰网络、不写库，便于真实运行测试。
import { formatWebsitePoDate } from './po-lines.js'

function label(header) {
  return header?.po_id ?? header?.id ?? '(unknown)'
}

/**
 * 读取并校验 Website PO Date。缺失返回 null? 不——缺失直接抛错（fail closed）。
 * @param {object} header tj_po_headers 行（需 po_id / website_po_date）
 * @returns {string} 规范化 yyyy-MM-dd
 */
export function requireCombinedWebsitePoDate(header) {
  const date = formatWebsitePoDate(header?.website_po_date)
  if (!date) {
    throw new Error(
      `合并单 ${label(header)} 缺少 Website PO Date：必须由开单/核对人显式选择后才能提交审批。` +
        '系统不会默认当天，也不会用创建/收货/审批时间代替。',
    )
  }
  return date
}

/**
 * 提交最终审批（draft -> pending_approval）前置校验。
 * @param {object} header
 * @returns {string} Website PO Date
 */
export function assertCombinedSubmittable(header) {
  if (!header || header.po_type !== 'combined') {
    throw new Error('提交审批校验仅适用于合并单（po_type=combined）')
  }
  if (header.frozen === true) {
    throw new Error(`合并单 ${label(header)} 已批准冻结，不能再次提交审批`)
  }
  if (header.status !== 'draft') {
    throw new Error(
      `合并单 ${label(header)} 当前状态为 ${header.status ?? '未知'}，只有 draft 才能提交审批`,
    )
  }
  return requireCombinedWebsitePoDate(header)
}

/**
 * 批准（pending_approval -> confirmed/frozen）前置校验：日期双校验 + 状态校验。
 * @param {object} header
 * @returns {string} Website PO Date
 */
export function assertCombinedApprovable(header) {
  if (!header || header.po_type !== 'combined') {
    throw new Error('批准校验仅适用于合并单（po_type=combined）')
  }
  // 先校验日期：缺日期时连状态判断都不放行，错误信息直接指向日期
  const date = requireCombinedWebsitePoDate(header)
  if (header.frozen === true) {
    throw new Error(`合并单 ${label(header)} 已批准冻结，不能重复批准`)
  }
  if (header.status !== 'pending_approval') {
    throw new Error(
      `合并单 ${label(header)} 当前状态为 ${header.status ?? '未知'}，不能批准（必须先提交审批）`,
    )
  }
  return date
}
