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
  qty: number | string // 该来源行贡献的订购数量（Preview decimal string 原样保留）
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
  // 网站开单日期（合并单显式业务字段；缺失时不推断，导出 fail closed）
  website_po_date?: string | null
  // 批准快照版本（2 = v2 DB 摘要；旧单为 null，只允许内部 review，不冒充已校验）
  approval_snapshot_version?: number | null
  /** 导出时由 verifyApprovedSnapshot 得出的校验状态（仅展示用，不入库） */
  approval_snapshot_status?: string | null
  // IRS 编号验证证据：有证据才允许导出编号，否则留空
  irs_po_no_verified_at?: string | null
  irs_po_no_verified_by?: string | null
  irs_grn_no_verified_at?: string | null
  irs_grn_no_verified_by?: string | null
}

export interface PoWithLines extends PoHeader {
  lines: PoLine[]
}

/**
 * Preview 保存 PO 的精确输入：数量/单价是 decimal string，不经 Number。
 * 旧生产路径在 tjPoApi 内显式转换（Excel/旧表需要 number）。
 */
export interface PoLineInput {
  id?: string
  line_no: number
  item_code: string
  description: string
  uom: string | null
  qty: string
  unit_price: string
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
