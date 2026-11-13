// 统一收货（GR）域类型：只描述 tj_gr_api 返回的 event / line / task 形状。
// 与 docs/gr-contract.md 对齐；金额/数量保持 decimal string，不做 Number 转换。
import type { GrSourceAllocation } from '@/lib/core/gr-form.js'

export type GrRole = 'staff' | 'approver' | 'executor' | 'admin'

export interface GrSessionInfo {
  roles: GrRole[]
  user_id?: string | null
  is_admin?: boolean
  active?: boolean
  email?: string | null
}

/** 收货行（服务端返回）：输入用 source_allocations，输出用 sources，必须显式映射 */
export interface GrReceiptLine {
  id: string
  line_no: number
  item_code: string
  description: string
  uom: string | null
  unit_price: string
  ordered_qty: string
  accepted_qty: string
  note?: string | null
  revision?: number
  /** receipt_get 输出字段 */
  sources?: GrSourceAllocation[]
  /** 兼容 UI 内部结构 */
  source_allocations?: GrSourceAllocation[]
}

/** 本机任务：永远不代表 IRS 已过账 */
export interface GrTask {
  id: string
  status: string
  po_header_id?: string | null
  irs_po_no?: string | null
  payload_sha256?: string | null
  claimed_by?: string | null
  lease_expires_at?: string | null
  save_attempted_at?: string | null
  saved_at?: string | null
  verified_at?: string | null
  bridge_ok?: boolean | null
  last_error?: string | null
  kind?: string | null
  target?: string | null
  message?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface GrWarningOrException {
  code?: string
  line_id?: string | null
  po_line_id?: string | null
  detail?: unknown
  message?: string
}

export interface GrReceiptEvent {
  id: string
  event_no?: string | null
  status: string
  revision: number
  po_ids?: string[]
  po_numbers?: string[]
  supplier_code?: string | null
  supplier_name?: string | null
  invoice_no?: string | null
  delivery_order_no?: string | null
  receive_date?: string | null
  invoice_date?: string | null
  checked_by?: string | null
  note?: string | null
  submitted_by?: string | null
  submitted_at?: string | null
  needs_review?: boolean
  allow_exceptions?: boolean
  review_note?: string | null
  approved_by?: string | null
  approved_at?: string | null
  released_at?: string | null
  payload_sha256?: string | null
  warnings?: GrWarningOrException[] | string[]
  exceptions?: GrWarningOrException[]
  exception_count?: number
  irs_po_no?: string | null
  irs_grn_no?: string | null
  created_at?: string | null
  updated_at?: string | null
  lines?: GrReceiptLine[]
  tasks?: GrTask[]
  /** 服务端真实状态原因（waiting_mapping / blocked 等） */
  status_reason?: string | null
  missing_mappings?: string[]
  remaining?: unknown
}

export type { GrSourceAllocation }
