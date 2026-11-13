// GR 任务/回调纯核类型（与 receipt-tasks.js 一一对应）
export type TaskStatus =
  | 'ready'
  | 'claimed'
  | 'save_attempted'
  | 'saved_unverified'
  | 'verified'
  | 'failed_unsaved'
  | 'needs_review'
  | 'cancelled'

export type CallbackEventType = 'save_attempted' | 'saved' | 'verified' | 'failed' | 'needs_review'

export interface TaskEvidenceLine {
  line_id: string
  item_code: string
  uom?: string | null
  qty: string
  unit_price: string
}

export interface TaskEvidence {
  bridge_ok: boolean
  irs_po_no?: string
  irs_grn_no?: string
  supplier_code?: string
  invoice_no?: string | null
  delivery_order_no?: string | null
  saved_at?: string
  lines?: TaskEvidenceLine[]
}

export interface EvidenceMismatch {
  kind: string
  field: string
  expected: unknown
  actual: unknown
  line_id?: string
}

export interface TaskPayload {
  event: Record<string, unknown>
  scope: { lines: Array<Record<string, unknown>> }
  mapping?: { po_header_id: string; irs_po_no: string; evidence_sha256?: string }
}

export interface GrTask {
  id: string
  task_type?: 'GOODS_RECEIVE'
  schema?: 'tj.gr.v1'
  environment?: 'preview'
  mock_only?: boolean
  po_header_id: string
  irs_po_no?: string
  event_payload_sha256?: string
  payload?: TaskPayload
}

export declare const TASK_STATUSES: readonly TaskStatus[]
export declare const TASK_RANK: Readonly<Record<'ready' | 'claimed' | 'save_attempted' | 'saved_unverified' | 'verified', number>>

export declare function nextTaskStatus(args: {
  status: TaskStatus
  eventType: CallbackEventType | string
  bridgeOk?: boolean
  saveAttempted?: boolean
}): { status: TaskStatus; ok: boolean; code?: string }

export declare function callbackOutcome(args: {
  existing?: { contentSha256?: string } | null
  fingerprint?: string
}): 'new' | 'replay' | 'conflict'

export declare function stableJson(value: unknown): string
export declare function contentFingerprint(args: {
  taskId?: string
  eventType?: string
  evidence?: unknown
  error?: unknown
}): string
export declare function verifyEvidence(args: {
  task: GrTask
  evidence: TaskEvidence
}): { ok: boolean; mismatches: EvidenceMismatch[] }
export declare function taskKeyValues(args: {
  event: Record<string, unknown>
  scope?: { lines: Array<Record<string, unknown>> }
  task: GrTask
  mapping?: { po_header_id?: string; irs_po_no?: string; evidence_sha256?: string }
}): Array<[string, unknown]>
export declare function canonicalTaskPayload(args: Parameters<typeof taskKeyValues>[0]): string
export declare function assertTaskIdentity(args: {
  task: GrTask
  mapping?: { irs_po_no?: string }
}): true
