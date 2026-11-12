// 合并规则 —— 单一真相源（前端合并画面 + 真实样本脚本共用）。
//
// 冻结口径：
//   * 分组键 = item_code + uom + unit_price（三者任一不同就分开，绝不合并）。
//   * 组顺序 = 首次出现顺序（来源 PO 顺序 + 行 line_no 顺序），不按 code 重排。
//   * 合并时 ordered_qty 累加，accepted_qty 默认等于累计订购量（审批前可人工下调）。
//   * description / unit_price / uom 取首次出现那一行的值，不做"智能"选择。
//   * source_refs 保留每条来源行的 po_id / po_number / line_id / qty，供追溯。

/** 分组键：商品编号 + 单位 + 单价。缺 uom 视为空串（不与其他单位混同）。 */
export function combineLineKey(line) {
  return [line.item_code, line.uom ?? '', Number(line.unit_price)].join('|')
}

/**
 * @param {Array<{id: string, po_id: string, lines: object[]}>} sourcePos 来源 PO（lines 已按 line_no 排序）
 * @returns {Array<object>} 合并后的行（顺序稳定）
 */
export function buildCombinedLines(sourcePos) {
  /** @type {Map<string, any>} */
  const groups = new Map()
  for (const po of sourcePos ?? []) {
    for (const l of po.lines ?? []) {
      const key = combineLineKey(l)
      const ref = {
        po_id: po.id,
        po_number: po.po_id,
        line_id: l.id ?? '',
        qty: Number(l.qty),
      }
      const existing = groups.get(key)
      if (existing) {
        existing.ordered_qty += Number(l.qty)
        existing.accepted_qty = existing.ordered_qty
        existing.source_refs.push(ref)
      } else {
        groups.set(key, {
          item_code: l.item_code,
          description: l.description,
          uom: l.uom ?? null,
          unit_price: Number(l.unit_price),
          ordered_qty: Number(l.qty),
          accepted_qty: Number(l.qty),
          note: '',
          source_refs: [ref],
        })
      }
    }
  }
  return Array.from(groups.values())
}
