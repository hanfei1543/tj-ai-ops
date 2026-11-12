// 类型声明（实现见 gr.js）
export interface GrHeaderInput {
  po_id?: string
  po_type?: string
  po_revision?: number | string
  supplier_code?: string
  supplier_name?: string
  receipt_event_id?: string | null
  delivery_order_no?: string | null
  received_at?: string | null
  checked_by?: string | null
  approved_by?: string | null
  approved_at?: string | null
  source_sha256?: string | null
  frozen?: boolean
  erp_status?: string
  irs_po_no?: string | null
  irs_grn_no?: string | null
  irs_po_no_verified_at?: string | null
  irs_po_no_verified_by?: string | null
  irs_grn_no_verified_at?: string | null
  irs_grn_no_verified_by?: string | null
  website_po_date?: string | null
  approval_snapshot_version?: number | null
  approval_snapshot_status?: string | null
}

export interface GrLineInput {
  line_no: number
  item_code: string
  description: string
  uom?: string | null
  qty: number
  unit_price: number
  original_qty?: number | null
  accepted_qty?: number | null
  note?: string | null
  source_refs?: Array<{ po_number: string; line_id: string }> | null
}

export declare function resolveVerifiedIrsNo(input: {
  value?: string | null
  verifiedAt?: string | null
  verifiedBy?: string | null
  field?: string
}): {
  value: string
  verified: boolean
  status: 'verified' | 'unverified' | 'missing'
  reason: string
}

export declare function buildGrInfoRows(header: GrHeaderInput): Array<[string, string]>
export declare function buildGrLineRows(lines: readonly GrLineInput[]): Array<Record<string, unknown>>
export declare const GR_LINE_COLUMNS: readonly Array<{ header: string; key: string; width: number }>
export declare const GR_INFO_COLUMNS: readonly Array<{ header: string; key: string; width: number }>
export declare function assertGrPushDisabled(): never
