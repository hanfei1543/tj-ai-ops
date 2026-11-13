// po-input.js 的类型声明（TS 侧只需类型）
export interface PoLineInput {
  id?: string
  line_no: number
  item_code: string
  description: string
  uom: string | null
  qty: string
  unit_price: string
}

export interface EditablePoRow {
  id?: string | null
  lineId?: string | null
  item_code?: string | null
  description?: string | null
  uom?: string | null
  qty?: string | null
  unit_price?: string | null
}

export interface GrFormAllocationInput {
  po_header_id: string
  po_line_id: string
  accepted_qty: string
}

export function toPoLineInputs(rows: readonly EditablePoRow[]): PoLineInput[]
export function buildReceiptAllocations(
  po: { id: string; po_type?: string | null },
  line: {
    id?: string
    qty?: unknown
    original_qty?: unknown
    source_refs?: ReadonlyArray<{
      po_id?: string | null
      line_id?: string | null
      qty?: unknown
    }> | null
  },
  options?: { defaultAccepted?: boolean },
): GrFormAllocationInput[]
export function sumAllocationQty(allocations: readonly { accepted_qty?: string }[]): string
export function assertOriginalSourcePoIds(
  poIds: readonly string[],
  targets: readonly { id?: string | null; po_type?: string | null }[],
): true
