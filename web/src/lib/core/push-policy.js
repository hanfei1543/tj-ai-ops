// 推送资格判定 —— 单一真相源（前端 requestPush / 列表 UI / VPS 推送器共用）。
//
// 永久规则（业务已冻结，不要放宽）：
//   * 合并单（po_type = 'combined'）永久禁止推送，无论 status/frozen 是什么。
//   * 被任一合并单 source_po_ids 引用的来源单永久禁止推送。
//     判定必须查来源关系，不能只看 status——status 是可变字段，可被手工改回 confirmed，
//     关系才是事实。因此本模块只吃 header + combinedHeaders，不看 status 做结论。
//   * 其余（普通 public standard 单）保持原 queue/bridge 路径不变。
//   * GR 正式 push/post 不启用：只允许内部 Excel 导出。

export const PUSH_REJECT_CODES = Object.freeze({
  COMBINED_FROZEN: 'COMBINED_PUSH_FROZEN',
  SOURCE_OF_COMBINED: 'SOURCE_OF_COMBINED',
  GR_PUSH_DISABLED: 'GR_PUSH_DISABLED',
})

/** GR 正式推送到 IRS 的开关（硬编码 false，不允许运行时打开） */
export const GR_PUSH_ENABLED = false

/** po 编号是否被某个合并单引用为来源单（关系判定，不看 status） */
export function isSourceOfCombined(poNumber, combinedHeaders) {
  if (!poNumber) return false
  for (const h of combinedHeaders ?? []) {
    if (!h || h.po_type !== 'combined') continue
    const ids = Array.isArray(h.source_po_ids) ? h.source_po_ids : []
    if (ids.includes(poNumber)) return true
  }
  return false
}

/**
 * @param {{header: object, combinedHeaders?: object[]}} args
 * @returns {{allowed: boolean, code?: string, reason?: string, matchingCombined?: string}}
 */
export function evaluatePushEligibility({ header, combinedHeaders = [] }) {
  const h = header ?? {}
  if (!h.po_id && !h.id) {
    return { allowed: false, code: 'INVALID_HEADER', reason: '缺少 PO 标识，拒绝推送' }
  }
  if (h.po_type === 'combined') {
    return {
      allowed: false,
      code: PUSH_REJECT_CODES.COMBINED_FROZEN,
      reason: `合并单 ${h.po_id ?? h.id} 永久冻结推送（po_type=combined），只能留内部 Excel/审阅样本`,
    }
  }
  const sourceOf = (combinedHeaders ?? []).find(
    (c) =>
      c &&
      c.po_type === 'combined' &&
      Array.isArray(c.source_po_ids) &&
      c.source_po_ids.includes(h.po_id),
  )
  if (sourceOf) {
    return {
      allowed: false,
      code: PUSH_REJECT_CODES.SOURCE_OF_COMBINED,
      reason: `来源单 ${h.po_id} 已并入合并单 ${sourceOf.po_id ?? '(unknown)'}，禁止单独推送`,
      matchingCombined: sourceOf.po_id,
    }
  }
  return { allowed: true }
}

/** GR 正式 push/post：永远拒绝 */
export function assertGrPushDisabled() {
  throw new Error(
    'GR 正式 push/post 未启用；GR 只能内部 Excel 导出（Excel 内 IRS 编号需验证证据）。',
  )
}
