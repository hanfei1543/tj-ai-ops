// 类型声明（实现见 po-lines.js）。刻意使用结构化最小接口，
// 避免 .d.ts 依赖前端 path alias（Node 侧也引用同一份 js）。
export interface PoLineColumn {
  header: string
  key: string
  width: number
}

export type PoExportMode = 'standard' | 'combined' | 'review'

export interface PoLineHeaderInput {
  po_id?: string | null
  supplier_code: string
  supplier_name: string
  website_po_date?: string | null
}

export interface PoLineRowInput {
  item_code: string
  description: string
  uom?: string | null
  qty: number
  unit_price: number
  accepted_qty?: number | null
}

export declare const PO_LINE_BASE_COLUMNS: readonly PoLineColumn[]
export declare const PO_LINE_COLUMNS_WITH_DATE: readonly PoLineColumn[]
export declare const WEBSITE_PO_DATE_HEADER: string
export declare const EXPORT_MODE_STANDARD: 'standard'
export declare const EXPORT_MODE_COMBINED: 'combined'
export declare const EXPORT_MODE_REVIEW: 'review'
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
