// TJ 五金店 PO 系统类型定义（内部工具，独立于 DYT 中医业务数据）

export interface Supplier {
  id: string
  code: string
  name: string
}

export interface Item {
  id: string
  code: string
  description: string
  uom: string | null
  cost: number | null
  selling_price: number | null
}

export interface PoLine {
  id?: string
  line_no: number
  item_code: string
  description: string
  uom: string | null
  qty: number
  unit_price: number
}

export interface PoHeader {
  id: string
  po_id: string
  supplier_code: string
  supplier_name: string
  status: string
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  line_count?: number
}

export interface PoWithLines extends PoHeader {
  lines: PoLine[]
}

export interface PoExportRecord {
  id: string
  po_id: string
  filename: string
  exported_at: string
}
