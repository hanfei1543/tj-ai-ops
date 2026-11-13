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
//   * 普通单（standard）/ 合并单（combined）固定 8 列：原 7 列顺序不变，
//     第 8 列 Website PO Date (yyyy-MM-dd)。
//     日期必须是开单/核对人显式选择的业务日期，绝不从
//     created_at/received_at/approved_at 推断，也不默认当天；
//     缺失或非法即 fail closed（抛 PoExportError），由人工补录。
//   * legacy-standard：仅显式请求时导出旧 7 列，只用于非 PAD 的历史兼容
//     （旧文件重放/内部比对）。standard/combined 永不自动回退到它。
//   * review：8 列，仅供内部审阅样本（必须带 INTERNAL NOT FOR PAD 标识），日期可空。

/** 行基础 7 列（legacy-standard 专用；standard/combined/review 在其后追加日期列） */
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

/** standard: 8 列（7 列 + Website PO Date），日期必填；PAD/推送正式口径 */
export const EXPORT_MODE_STANDARD = 'standard'
/** combined: 8 列，日期必填，缺失 fail closed */
export const EXPORT_MODE_COMBINED = 'combined'
/** review: 8 列，日期可空，仅供内部审阅样本（必须带 INTERNAL NOT FOR PAD 标识） */
export const EXPORT_MODE_REVIEW = 'review'
/**
 * legacy-standard: 旧 7 列（无日期），仅显式用于非 PAD 历史兼容。
 * 不允许作为 standard 的缺日期回退，pusher/网页导出不得使用。
 */
export const EXPORT_MODE_LEGACY_STANDARD = 'legacy-standard'

export const EXPORT_MODES = Object.freeze([
  EXPORT_MODE_STANDARD,
  EXPORT_MODE_COMBINED,
  EXPORT_MODE_REVIEW,
  EXPORT_MODE_LEGACY_STANDARD,
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
  if (mode === EXPORT_MODE_LEGACY_STANDARD) return PO_LINE_BASE_COLUMNS.map((c) => ({ ...c }))
  if (
    mode === EXPORT_MODE_STANDARD ||
    mode === EXPORT_MODE_COMBINED ||
    mode === EXPORT_MODE_REVIEW
  ) {
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
  const h = header ?? {}
  // 单据类型与导出模式必须自洽：合并单不能用 standard/legacy 7 列绕过审批流，
  // 普通单也不能冒充 combined（review 仅内部样本，允许两边）。
  const isCombinedHeader = h.po_type === 'combined'
  if (isCombinedHeader && mode !== EXPORT_MODE_COMBINED && mode !== EXPORT_MODE_REVIEW) {
    throw new PoExportError(
      'PO_TYPE_MODE_MISMATCH',
      `合并单 ${h.po_id ?? '(unknown)'} 只能按 combined（正式）或 review（内部样本）导出，拒绝模式 ${mode}。`,
    )
  }
  if (!isCombinedHeader && mode === EXPORT_MODE_COMBINED) {
    throw new PoExportError(
      'PO_TYPE_MODE_MISMATCH',
      `普通单 ${h.po_id ?? '(unknown)'} 不能按 combined 模式导出（po_type=${h.po_type ?? '(空)'}）。`,
    )
  }
  // legacy-standard 是唯一不带日期列的模式，且必须由调用方显式指定。
  const withDate = mode !== EXPORT_MODE_LEGACY_STANDARD
  const websitePoDate = withDate ? formatWebsitePoDate(h.website_po_date) : null

  // standard / combined：日期是显式业务字段，缺失时拒绝导出
  // （绝不回退 created_at / received_at / approved_at，也绝不自动改用 legacy 7 列）。
  if (withDate && !websitePoDate && mode !== EXPORT_MODE_REVIEW) {
    const label = mode === EXPORT_MODE_COMBINED ? '合并单' : '普通单'
    throw new PoExportError(
      'MISSING_WEBSITE_PO_DATE',
      `${label} ${h.po_id ?? '(unknown)'} 缺少 Website PO Date（website_po_date 为空），拒绝导出。请先补录日期，系统不会用创建/收货/审批时间代替，也不会退回旧 7 列格式。`,
    )
  }

  const warnings = []
  // legacy 7 列仅供非 PAD 历史兼容：调用方必须包 INTERNAL NOT FOR PAD 标识
  // （7 列 PO_Lines 本身不变），并且不得进入 pusher / PAD 队列。
  if (mode === EXPORT_MODE_LEGACY_STANDARD) {
    warnings.push('LEGACY_STANDARD_INTERNAL_NOT_FOR_PAD')
  }
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
