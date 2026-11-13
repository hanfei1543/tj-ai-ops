// PO 编辑 / 收货来源分配的纯逻辑（无 IO、无 React）。
//
// 冻结口径：
//   * Preview 保存 PO 时数量/单价全程 decimal string：不 parseFloat、不 Number 往返，
//     `po_save` 收到的就是页面上原样的精确十进制字符串。旧生产路径（Excel/旧表写入）
//     需要 number 时由 tjPoApi 显式转换，不在这里静默改类型。
//   * 合并单收货的来源必须是合并行里记录的原始 source_refs（原始 PO 行 UUID）；
//     绝不用合并单自己的合成行 id 冒充来源。来源缺失 = 额外行，fail closed。
//   * 已有历史收货（非首批）时不预填满额：实收由人明确填写，避免"默认全收"。
import { addDecimalStrings, parseDecimalString } from './gr-form.js'

/**
 * 编辑器行 → po_save 行输入（line_no 按当前顺序 1..n 重排）。
 * 非法数量/单价直接抛错，绝不静默变 0 或丢精度。
 * @param {Array<object>} rows
 * @returns {Array<{id?: string, line_no: number, item_code: string, description: string, uom: string|null, qty: string, unit_price: string}>}
 */
export function toPoLineInputs(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) throw new Error('请至少加入一个商品')
  return list.map((r, i) => {
    const code = String(r?.item_code ?? '').trim()
    const label = `第 ${i + 1} 行${code ? `（${code}）` : ''}`
    if (!code) throw new Error(`${label}缺少商品编号`)
    const qty = parseDecimalString(r?.qty, { field: `${label} 数量`, allowZero: false })
    if (!qty.ok) throw new Error(qty.error)
    const price = parseDecimalString(r?.unit_price, { field: `${label} 单价` })
    if (!price.ok) throw new Error(price.error)
    const id = r?.id ?? r?.lineId
    return {
      ...(typeof id === 'string' && id ? { id } : {}),
      line_no: i + 1,
      item_code: code,
      description: String(r?.description ?? ''),
      uom: r?.uom ?? null,
      qty: qty.value,
      unit_price: price.value,
    }
  })
}

/**
 * 收货行的来源分配。
 * - 普通单：整行来源 = 该 PO 行的 UUID。
 * - 合并单：只展开 line.source_refs 指向的原始 PO 行；没有 refs 返回 []（额外行）。
 * - defaultAccepted=false（该 PO 已有历史收货）时 accepted_qty 留空，必须人工确认本批实收。
 * @param {{id: string, po_type?: string|null}} po
 * @param {{id?: string, qty?: unknown, original_qty?: unknown, source_refs?: Array<object>|null}} line
 * @param {{defaultAccepted?: boolean}} [options]
 * @returns {Array<{po_header_id: string, po_line_id: string, accepted_qty: string}>}
 */
export function buildReceiptAllocations(po, line, { defaultAccepted = true } = {}) {
  const isCombined = String(po?.po_type ?? 'standard') === 'combined'
  if (isCombined) {
    const refs = Array.isArray(line?.source_refs) ? line.source_refs : []
    const out = []
    for (const r of refs) {
      const headerId = String(r?.po_id ?? '').trim()
      const lineId = String(r?.line_id ?? '').trim()
      if (!headerId || !lineId) continue
      out.push({
        po_header_id: headerId,
        po_line_id: lineId,
        accepted_qty: defaultAccepted ? String(r?.qty ?? '') : '',
      })
    }
    return out
  }

  const lineId = String(line?.id ?? '').trim()
  if (!lineId) return []
  const ordered = line?.original_qty ?? line?.qty
  return [
    {
      po_header_id: String(po?.id ?? ''),
      po_line_id: lineId,
      accepted_qty: defaultAccepted ? String(ordered ?? '') : '',
    },
  ]
}

/**
 * 来源分配合计（decimal string）。任一分配为空或非法返回 ''，由表单校验拦下。
 * @param {Array<{accepted_qty?: string}>} allocations
 */
export function sumAllocationQty(allocations) {
  const list = Array.isArray(allocations) ? allocations : []
  if (list.length === 0) return ''
  const values = []
  for (const a of list) {
    const raw = String(a?.accepted_qty ?? '').trim()
    if (raw === '') return ''
    values.push(raw)
  }
  return addDecimalStrings(values)
}
