// GR 收货契约纯核类型（与 receipt-core.js 一一对应）
export type EventStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'waiting_mapping'
  | 'released'
  | 'in_progress'
  | 'saved_unverified'
  | 'verified'
  | 'needs_review'
  | 'cancelled'

export type GrErrorCode =
  | 'GR_INVALID_DECIMAL'
  | 'GR_DECIMAL_SCALE'
  | 'GR_VALIDATION'
  | 'GR_QTY_MISMATCH'
  | 'GR_SOURCE_MISMATCH'
  | 'GR_QTY_EXCEEDED'
  | 'GR_EXCEPTION_NOT_ALLOWED'
  | 'GR_MAPPING_REQUIRED'
  | 'GR_REVISION_CONFLICT'
  | 'GR_STATE'
  | 'GR_FORBIDDEN'
  | 'GR_AUTH_REQUIRED'
  | 'GR_NOT_MEMBER'
  | 'GR_NOT_FOUND'
  | 'GR_PUSH_BLOCKED'
  | 'GR_TASK_STALE'
  | 'GR_CALLBACK_CONFLICT'
  | 'GR_CALLBACK_OUT_OF_ORDER'
  | 'GR_IDEMPOTENCY_CONFLICT'
  | 'GR_CRYPTO_MISSING'

export declare const GR_SCHEMA_VERSION: 'tj.gr.v1'
export declare const GR_ENVIRONMENT: 'preview'
export declare const GR_KIND: 'goods_receive'
export declare const EVENT_STATUSES: readonly EventStatus[]
export declare const EVENT_EDITABLE_STATUSES: readonly EventStatus[]
export declare const EVENT_COMMITTED_STATUSES: readonly EventStatus[]
export declare const NULL_TOKEN: '\\N'

export declare class ReceiptError extends Error {
  code: GrErrorCode | string
  detail: Record<string, unknown>
  constructor(code: string, message: string, detail?: Record<string, unknown>)
}

export interface SourceAllocation {
  po_header_id: string
  po_line_id: string
  /** 来源行订购量快照；UI 可不传，单来源时继承行 ordered_qty */
  ordered_qty?: string | null
  accepted_qty: string
}

export interface ReceiptLineInput {
  id: string
  line_no: number
  item_code: string
  description?: string | null
  uom?: string | null
  unit_price: string | number
  ordered_qty: string | number
  accepted_qty: string | number
  note?: string | null
  source_allocations: SourceAllocation[]
}

export interface ReceiptInput {
  id: string
  revision: number
  po_ids: string[]
  invoice_no?: string | null
  delivery_order_no?: string | null
  receive_date: string
  invoice_date?: string | null
  checked_by?: string | null
  note?: string | null
  lines: ReceiptLineInput[]
}

export interface NormalizedLine extends Omit<ReceiptLineInput, 'unit_price' | 'ordered_qty' | 'accepted_qty' | 'source_allocations'> {
  unit_price: string
  ordered_qty: string
  accepted_qty: string
  source_allocations: Required<SourceAllocation>[]
}

export interface NormalizedEvent {
  id: string
  revision: number
  po_ids: string[]
  supplier_code: string | null
  supplier_name: string | null
  invoice_no: string | null
  delivery_order_no: string | null
  receive_date: string
  invoice_date: string | null
  checked_by: string | null
  note: string | null
  approved_by: string | null
  approved_at: string | null
  lines: NormalizedLine[]
  warnings: string[]
  exceptions: Array<{ code: string; line_id?: string; detail?: string }>
  review_required: boolean
}

export declare function isUuid(value: unknown): boolean
export declare function isDateOnly(value: unknown): boolean
export declare function normalizeDecimal(value: unknown, field?: string): string
export declare function decimalEq(a: unknown, b: unknown): boolean
export declare function decimalToMicros(value: unknown): bigint
export declare function microsToDecimal(micros: bigint): string
export declare function escapeValue(v: unknown): string
export declare function encodeValue(v: unknown): string
export declare function resolveIrsInvoiceNo(event: {
  invoice_no?: string | null
  delivery_order_no?: string | null
}): string | null

export declare function timestampText(value: unknown, field?: string): string | null
export declare function canonicalFromKeyValues(pairs: Array<[string, unknown]>): string
export declare function eventKeyValues(event: Partial<NormalizedEvent> & Record<string, unknown>): Array<[string, unknown]>
export declare function canonicalEventPayload(event: Partial<NormalizedEvent> & Record<string, unknown>): string
export declare function sha256Hex(textValue: string): Promise<string>
export declare function eventPayloadHash(event: Partial<NormalizedEvent> & Record<string, unknown>): Promise<string>
export declare function validateReceiptInput(input: ReceiptInput): {
  event: NormalizedEvent
  warnings: string[]
  exceptions: NormalizedEvent['exceptions']
  review_required: boolean
}
export declare function compareLines(a: { line_no: number | string; id: string }, b: { line_no: number | string; id: string }): number
export declare function compareSources(a: SourceAllocation, b: SourceAllocation): number
