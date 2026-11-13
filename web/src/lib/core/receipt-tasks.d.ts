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
  /** 完整已批准事件快照（header + 全部行 + 全部来源）；离线复算依赖它 */
  approved_event_snapshot?: Record<string, unknown>
  task?: Record<string, unknown>
  mapping?: Record<string, unknown>
  event_payload_sha256?: string
  scope?: { po_header_id?: string; po_id?: string; lines: Array<Record<string, unknown>> }
  source_refs?: Array<Record<string, unknown>>
  /** 旧字段（仅兼容本地对照；新 payload 不再使用） */
  event?: Record<string, unknown>
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
  existing?: { contentSha256?: string; accepted?: boolean } | null
  fingerprint?: string
}): 'new' | 'replay' | 'conflict'

export declare function stableJson(value: unknown): string
export declare function contentFingerprint(args: {
  taskId?: string
  receiptEventId?: string
  payloadSha256?: string
  eventType?: string
  evidence?: unknown
  error?: unknown
}): string
export declare function verifyEvidence(args: {
  task: GrTask
  evidence: TaskEvidence
}): { ok: boolean; mismatches: EvidenceMismatch[] }
export declare function taskPayloadKeyValues(payload: TaskPayload & Record<string, unknown>): Array<[string, unknown]>
export declare function canonicalTaskPayloadFromPayload(payload: TaskPayload & Record<string, unknown>): string
export declare function taskPayloadHash(payload: TaskPayload & Record<string, unknown>): Promise<string>
export declare function taskKeyValues(args: {
  event: Record<string, unknown>
  scope?: { lines: Array<Record<string, unknown>> }
  task: GrTask
  mapping?: { po_header_id?: string; irs_po_no?: string; evidence_sha256?: string }
}): Array<[string, unknown]>
export declare function canonicalTaskPayload(args: Partial<Parameters<typeof taskKeyValues>[0]> & { payload?: Record<string, unknown> }): string
export declare function assertTaskIdentity(args: {
  task: GrTask
  mapping?: { irs_po_no?: string }
}): true
