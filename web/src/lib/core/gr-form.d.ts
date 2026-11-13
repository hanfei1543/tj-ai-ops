// gr-form.js 的类型声明（TS 侧只需类型，不重复实现逻辑）

export const DRAFT_STORAGE_PREFIX: string
export const RECEIPT_ROLES: readonly string[]

export interface DecimalOk {
  ok: true
  value: string
}
export interface DecimalErr {
  ok: false
  error: string
}
export type DecimalResult = DecimalOk | DecimalErr

export interface GrSourceAllocation {
  po_header_id: string
  po_line_id: string
  accepted_qty: string
}

export interface GrFormLine {
  id: string
  line_no: number
  item_code: string
  description: string
  uom: string | null
  unit_price: string
  ordered_qty: string
  accepted_qty: string
  note: string
  source_allocations: GrSourceAllocation[]
}

export interface GrFormHeader {
  invoice_no: string
  delivery_order_no: string
  receive_date: string
  invoice_date: string | null
  checked_by: string
  note: string
}

export interface GrValidation {
  ok: boolean
  errors: Array<{ path: string; message: string }>
  exceptions: Array<{ code: string; message: string; line_no?: number }>
  canSaveDraft: boolean
  canSubmit: boolean
  requires_exception_approval: boolean
  submit_blocked_reason: string
}

export interface GrCapabilities {
  roles: string[]
  isStaff: boolean
  canSubmit: boolean
  canApprove: boolean
  canRelease: boolean
  canTaskResult: boolean
  isAdmin: boolean
}

export interface ReceiptSavePayload {
  id: string
  revision: number
  po_ids: string[]
  invoice_no: string
  delivery_order_no: string
  receive_date: string
  invoice_date: string | null
  checked_by: string
  note: string
  lines: GrFormLine[]
}

export function isValidDateOnly(value: unknown): boolean
export function parseDecimalString(
  raw: unknown,
  opts?: { field?: string; allowZero?: boolean },
): DecimalResult
export function addDecimalStrings(values: unknown[]): string
export function compareDecimalStrings(a: unknown, b: unknown): 1 | 0 | -1
export function normalizeRoles(raw: unknown): string[]
export function capabilities(identity: { roles?: unknown } | null | undefined): GrCapabilities
export function receiptStatusBadge(status: unknown): {
  label: string
  cls: string
  raw: string
  known: boolean
}
export function taskStatusBadge(status: unknown): {
  label: string
  raw: string
  irs_confirmed: false
}
export function validateReceiptForm(input: {
  header: Partial<GrFormHeader>
  lines: Array<Partial<GrFormLine>>
  identity?: { roles?: unknown } | null
}): GrValidation
export function buildReceiptSavePayload(input: {
  receiptId: string
  revision: number
  selectedPoIds?: string[]
  header: Partial<GrFormHeader>
  lines: Array<Partial<GrFormLine>>
}): ReceiptSavePayload
export function draftIdentityKey(poIds: string[]): string

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ReceiptDraftSession {
  key: string
  readonly receiptId: string
  readonly revision: number
  readonly submitted: boolean
  isBusy(): boolean
  begin(op: 'save' | 'submit'): boolean
  end(): void
  saveResult(event: { id?: string; revision?: number } | null | undefined): void
  submitResult(event: { status?: string; revision?: number } | null | undefined): void
}

export function createReceiptDraftSession(input: {
  storage: DraftStorage
  poIds: string[]
  newId?: () => string
  now?: () => Date
  seed?: { receipt_id: string; revision?: number } | null
}): ReceiptDraftSession
