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

/** 来源行引用（合并单追溯用） */
export interface SourceRef {
  po_id: string // 来源 PO 的 uuid id
  po_number: string // 来源 PO 的显示编号 PO-000020
  line_id: string // 来源行 uuid id
  qty: number // 该来源行贡献的订购数量
}

export interface PoLine {
  id?: string
  line_no: number
  item_code: string
  description: string
  uom: string | null
  qty: number
  unit_price: number
  // 合并单追溯字段
  source_po_id?: string | null
  source_line_id?: string | null
  source_refs?: SourceRef[] | null
  original_qty?: number | null
  accepted_qty?: number | null
  note?: string | null
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
  // 合并单 / 审批冻结 / 收货 / ERP 状态
  po_type: string
  source_po_ids?: string[] | null
  po_revision: number
  source_sha256?: string | null
  delivery_order_no?: string | null
  receipt_event_id?: string | null
  checked_by?: string | null
  approved_by?: string | null
  approved_at?: string | null
  received_at?: string | null
  frozen: boolean
  erp_status: string
  irs_po_no?: string | null
  irs_grn_no?: string | null
}

export interface PoWithLines extends PoHeader {
  lines: PoLine[]
}

/** 合并单明细输入（CombinePoPage -> API） */
export interface CombinedLineInput {
  item_code: string
  description: string
  uom: string | null
  qty: number
  unit_price: number
  original_qty: number
  accepted_qty: number
  note: string | null
  source_refs: SourceRef[]
}

export interface PoExportRecord {
  id: string
  po_id: string
  filename: string
  exported_at: string
}

/** Add New Item Master 申请（独立于「把已有商品加进 PO」） */
export interface ItemRequest {
  id: string
  item_code: string
  barcode: string | null
  description: string
  uom: string | null
  category: string | null
  supplier_code: string | null
  purchase_cost: number | null
  selling_price: number | null
  tax_rate: number | null
  sst_info: string | null
  status: string // pending | approved | exported | created | needs_review | rejected
  created_by: string | null
  approved_by: string | null
  approved_at: string | null
  erp_status: string
  erp_result: string | null
  created_at: string
}
