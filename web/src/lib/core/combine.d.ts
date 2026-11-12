// 类型声明（实现见 combine.js）
export interface CombineSourceLine {
  id?: string
  item_code: string
  description: string
  uom?: string | null
  qty: number
  unit_price: number
}

export interface CombineSourcePo {
  id: string
  po_id: string
  lines: readonly CombineSourceLine[]
}

export interface CombinedLine {
  item_code: string
  description: string
  uom: string | null
  unit_price: number
  ordered_qty: number
  accepted_qty: number
  note: string
  source_refs: Array<{ po_id: string; po_number: string; line_id: string; qty: number }>
}

export declare function combineLineKey(line: CombineSourceLine): string
export declare function buildCombinedLines(sourcePos: readonly CombineSourcePo[]): CombinedLine[]
