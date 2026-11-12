// 类型声明（实现见 push-policy.js）
export interface PushHeader {
  id?: string
  po_id: string
  po_type?: string
  status?: string
  frozen?: boolean
  source_po_ids?: string[] | null
}

export type PushRejectCode = 'COMBINED_PUSH_FROZEN' | 'SOURCE_OF_COMBINED' | 'GR_PUSH_DISABLED' | 'INVALID_HEADER'

export declare const PUSH_REJECT_CODES: Readonly<{
  COMBINED_FROZEN: 'COMBINED_PUSH_FROZEN'
  SOURCE_OF_COMBINED: 'SOURCE_OF_COMBINED'
  GR_PUSH_DISABLED: 'GR_PUSH_DISABLED'
}>
export declare const GR_PUSH_ENABLED: false

export declare function isSourceOfCombined(
  poNumber: string | null | undefined,
  combinedHeaders: readonly PushHeader[]
): boolean

export declare function evaluatePushEligibility(args: {
  header: PushHeader
  combinedHeaders?: readonly PushHeader[]
}): {
  allowed: boolean
  code?: string
  reason?: string
  matchingCombined?: string
}

export declare function assertGrPushDisabled(): never
