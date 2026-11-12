// PO_Lines 导出规格 —— 单一真相源。
// 前端（web/src/lib/tjPoExcel.ts）、真实样本脚本（scripts/gen_po_excel.mjs）、
// VPS 推送器（scripts/tj-po-push.mjs）都从这里取列定义与行生成规则，
// 不允许在别处复制一份列顺序/日期/Qty 规则，否则各处导出会漂移。
//
// 冻结口径（来自业务验收，不要"优化"）：
//   * 行序 = 传入 lines 的顺序（拖曳/审批后的 line_no 顺序），不排序、不合并。
//   * Qty = original_qty ?? qty（PO 的「订购数量」；普通单回退 qty）。
//     合并单的 PO_Lines 是采购单：Qty 必须是订购数量，与 GR_Lines 的 Ordered Qty
//     一致；不能用 accepted_qty（实收数量）顶替——实收属于 GR，不属于 PO。
//     （2026-11-12 PAD 数据合约核对修正：此前误用 accepted_qty，导致 PO Qty=实收、
//       GR Ordered Qty=订购 两个口径不一致。）
//   * Item Code / Supplier Code 保持原字符串（前导零安全），不 trim、不改大小写。
//   * UOM / Unit Price 原样输出，不做单位换算、不做价格重算。
//   * 普通单（standard）固定 7 列，与 PAD 现有导入完全一致，不追加日期列。
//   * 合并单（combined）固定 8 列，第 8 列 Website PO Date (yyyy-MM-dd)。
//     合并单没有既定业务日期，绝不从 created_at/received_at/approved_at 推断；
//     缺失即 fail closed（抛 PoExportError），由人工补录。

/** 普通单 / PAD 兼容的 7 列（顺序即列顺序，勿动） */
export const PO_LINE_BASE_COLUMNS = Object.freeze([
  { header: 'Supplier Code', key: 'supplier_code', width: 16 },
  { header: 'Supplier Name', key: 'supplier_name', width: 38 },
  { header: 'Item Code', key: 'item_code', width: 16 },
  { header: 'Description', key: 'description', width: 46 },
  { header: 'UOM', key: 'uom', width: 10 },
  { header: 'Qty', key: 'qty', width: 10 },
  { header: 'Unit Price (RM)', key: 'unit_price', width: 16 },
])

export const WEBSITE_PO_DATE_HEADER = 'Website PO Date'

/** 合并单 8 列：7 列原样 + Website PO Date */
export const PO_LINE_COLUMNS_WITH_DATE = Object.freeze([
  ...PO_LINE_BASE_COLUMNS,
  { header: WEBSITE_PO_DATE_HEADER, key: 'website_po_date', width: 14 },
])

/** standard: 7 列，绝不追加日期列（保普通 push 不变） */
export const EXPORT_MODE_STANDARD = 'standard'
/** combined: 8 列，日期必填，缺失 fail closed */
export const EXPORT_MODE_COMBINED = 'combined'
/** review: 8 列，日期可空，仅供内部审阅样本（必须带 INTERNAL NOT FOR PAD 标识） */
export const EXPORT_MODE_REVIEW = 'review'

export const EXPORT_MODES = Object.freeze([
  EXPORT_MODE_STANDARD,
  EXPORT_MODE_COMBINED,
  EXPORT_MODE_REVIEW,
])

/** 导出规则错误：code 供调用方/测试断言，message 直接给操作员看 */
export class PoExportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PoExportError'
    this.code = code
  }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 严格解析 Website PO Date：只接受 yyyy-MM-dd（Postgres date 列的原生返回格式）。
 * 不做时区换算、不接受 ISO 时间戳、不接受本地化格式——猜日期比没有日期更危险。
 * @returns {string|null} 规范化后的 yyyy-MM-dd，空值返回 null
 */
export function formatWebsitePoDate(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  if (!s) return null
  const m = DATE_ONLY.exec(s)
  if (!m) {
    throw new PoExportError(
      'INVALID_WEBSITE_PO_DATE',
      `Website PO Date 必须是 yyyy-MM-dd（收到 "${s}"）。不推断日期或时区，请人工补录。`,
    )
  }
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new PoExportError(
      'INVALID_WEBSITE_PO_DATE',
      `Website PO Date 不是真实存在的日期："${s}"`,
    )
  }
  return s
}

/** 按导出模式返回列定义（返回副本，避免调用方改到冻结常量） */
export function poLineColumns(mode = EXPORT_MODE_STANDARD) {
  if (mode === EXPORT_MODE_STANDARD) return PO_LINE_BASE_COLUMNS.map((c) => ({ ...c }))
  if (mode === EXPORT_MODE_COMBINED || mode === EXPORT_MODE_REVIEW) {
    return PO_LINE_COLUMNS_WITH_DATE.map((c) => ({ ...c }))
  }
  throw new PoExportError('INVALID_EXPORT_MODE', `未知导出模式：${mode}`)
}

/**
 * 生成 PO_Lines 行。
 *
 * @param {object} header  tj_po_headers 行（需 supplier_code / supplier_name / website_po_date）
 * @param {object[]} lines tj_po_lines 行（按 line_no 排好序；本函数不再排序）
 * @param {{mode?: string}} [options]
 * @returns {{mode: string, columns: object[], rows: object[], websitePoDate: string|null, warnings: string[]}}
 */
export function buildPoLineRows(header, lines, options = {}) {
  const mode = options.mode ?? EXPORT_MODE_STANDARD
  if (!EXPORT_MODES.includes(mode)) {
    throw new PoExportError('INVALID_EXPORT_MODE', `未知导出模式：${mode}`)
  }
  const withDate = mode !== EXPORT_MODE_STANDARD
  const h = header ?? {}
  const websitePoDate = withDate ? formatWebsitePoDate(h.website_po_date) : null

  // 合并单：日期是显式业务字段，缺失时拒绝导出（绝不回退 created_at / received_at / approved_at）
  if (mode === EXPORT_MODE_COMBINED && !websitePoDate) {
    throw new PoExportError(
      'MISSING_WEBSITE_PO_DATE',
      `合并单 ${h.po_id ?? '(unknown)'} 缺少 Website PO Date（website_po_date 为空），拒绝导出。请先补录日期，系统不会用创建/收货/审批时间代替。`,
    )
  }

  const warnings = []
  if (withDate && !websitePoDate) warnings.push('MISSING_WEBSITE_PO_DATE')

  const list = Array.isArray(lines) ? lines : []
  const rows = list.map((l, i) => {
    const rawQty = l.original_qty ?? l.qty
    // 空值不允许静默变成 0（Number(null) === 0），否则会把缺数量写成零收
    if (rawQty === null || rawQty === undefined || rawQty === '') {
      throw new PoExportError(
        'INVALID_LINE_QTY',
        `第 ${i + 1} 行（${l.item_code ?? '?'}）缺少数量（qty/original_qty 均为空）`,
      )
    }
    if (l.unit_price === null || l.unit_price === undefined || l.unit_price === '') {
      throw new PoExportError(
        'INVALID_LINE_PRICE',
        `第 ${i + 1} 行（${l.item_code ?? '?'}）缺少单价`,
      )
    }
    const qty = Number(rawQty)
    const unitPrice = Number(l.unit_price)
    if (!Number.isFinite(qty)) {
      throw new PoExportError(
        'INVALID_LINE_QTY',
        `第 ${i + 1} 行（${l.item_code ?? '?'}）数量非数值：${String(rawQty)}`,
      )
    }
    if (!Number.isFinite(unitPrice)) {
      throw new PoExportError(
        'INVALID_LINE_PRICE',
        `第 ${i + 1} 行（${l.item_code ?? '?'}）单价非数值：${String(l.unit_price)}`,
      )
    }
    const row = {
      supplier_code: h.supplier_code,
      supplier_name: h.supplier_name,
      item_code: l.item_code,
      description: l.description,
      uom: l.uom ?? '',
      qty,
      unit_price: unitPrice,
    }
    // 缺日期时写 null（真正空单元格），不写空串，避免被下游当成已填值
    if (withDate) row.website_po_date = websitePoDate ?? null
    return row
  })

  return { mode, columns: poLineColumns(mode), rows, websitePoDate, warnings }
}
