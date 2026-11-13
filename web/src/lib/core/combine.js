// 合并规则 —— 单一真相源（前端合并画面 + 真实样本脚本共用）。
//
// 冻结口径：
//   * 分组键 = item_code + uom + unit_price（三者任一不同就分开，绝不合并）。
//   * 组顺序 = 首次出现顺序（来源 PO 顺序 + 行 line_no 顺序），不按 code 重排。
//   * 合并时 ordered_qty 累加，accepted_qty 默认等于累计订购量（审批前可人工下调）。
//   * description / unit_price / uom 取首次出现那一行的值，不做"智能"选择。
//   * source_refs 保留每条来源行的 po_id / po_number / line_id / qty（qty 原文 decimal string，
//     不经 Number 改写），供收货时展开成原始 PO 行分配；来源缺 id/编号一律 fail closed。
import { addDecimalStrings } from './gr-form.js'

/** 分组键：商品编号 + 单位 + 单价。缺 uom 视为空串（不与其他单位混同）。 */
export function combineLineKey(line) {
  return [line.item_code, line.uom ?? '', Number(line.unit_price)].join('|')
}

function sourceRef(po, line) {
  if (!po || typeof po.id !== 'string' || !po.id || typeof po.po_id !== 'string' || !po.po_id) {
    throw new Error('合并来源 PO 缺少 id/编号：拒绝合并（来源无法追溯）')
  }
  if (!line || typeof line.id !== 'string' || !line.id) {
    throw new Error(`来源 PO ${po.po_id} 存在缺少行 UUID 的明细：拒绝合并（来源无法追溯）`)
  }
  return {
    po_id: po.id,
    po_number: po.po_id,
    line_id: line.id,
    // 原样保留来源行订购量（decimal string / number 都按原文），不四舍五入、不改写
    qty: typeof line.qty === 'string' ? line.qty : String(line.qty ?? ''),
  }
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
      const ref = sourceRef(po, l)
      const existing = groups.get(key)
      if (existing) {
        existing.source_refs.push(ref)
        // 用 decimal string 累加，避免 0.1+0.2 的浮点残差
        existing.ordered_qty = Number(
          addDecimalStrings(existing.source_refs.map((r) => r.qty)),
        )
        existing.accepted_qty = existing.ordered_qty
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
