// 类型声明（实现见 po-lines.js）。刻意使用结构化最小接口，
// 避免 .d.ts 依赖前端 path alias（Node 侧也引用同一份 js）。
export interface PoLineColumn {
  header: string
  key: string
  width: number
}

export type PoExportMode = 'standard' | 'combined' | 'review' | 'legacy-standard'

export interface PoLineHeaderInput {
  po_id?: string | null
  supplier_code: string
  supplier_name: string
  /** 显式业务日期 yyyy-MM-dd；standard/combined 必填，不接受时间戳或推断值 */
  website_po_date?: string | null
}

export interface PoLineRowInput {
  item_code: string
  description: string
  uom?: string | null
  qty: number
  unit_price: number
  /** 订购数量；Qty = original_qty ?? qty（0 是有效值） */
  original_qty?: number | null
  /** GR 实收数量，仅收货口径使用；PO 导出绝不用它顶替 Qty */
  accepted_qty?: number | null
}

export declare const PO_LINE_BASE_COLUMNS: readonly PoLineColumn[]
export declare const PO_LINE_COLUMNS_WITH_DATE: readonly PoLineColumn[]
export declare const WEBSITE_PO_DATE_HEADER: string
export declare const EXPORT_MODE_STANDARD: 'standard'
export declare const EXPORT_MODE_COMBINED: 'combined'
export declare const EXPORT_MODE_REVIEW: 'review'
/** 旧 7 列：只允许显式用于非 PAD 历史兼容，禁止自动回退 */
export declare const EXPORT_MODE_LEGACY_STANDARD: 'legacy-standard'
export declare const EXPORT_MODES: readonly PoExportMode[]

export declare class PoExportError extends Error {
  readonly code: string
  constructor(code: string, message: string)
}

export declare function formatWebsitePoDate(value: unknown): string | null
export declare function poLineColumns(mode?: PoExportMode): PoLineColumn[]

export declare function buildPoLineRows(
  header: PoLineHeaderInput,
  lines: readonly PoLineRowInput[],
  options?: { mode?: PoExportMode }
): {
  mode: PoExportMode
  columns: PoLineColumn[]
  rows: Array<Record<string, unknown>>
  websitePoDate: string | null
  warnings: string[]
}
