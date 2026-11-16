export const PREVIEW_REQUEST_STATES: {
  readonly REQUESTED: 'requested'
  readonly DISPATCH_STARTED: 'dispatch_started'
  readonly DELIVERED: 'delivered'
  readonly DELIVERY_UNCERTAIN: 'delivery_uncertain'
}

export type PreviewRequestState =
  | 'requested'
  | 'dispatch_started'
  | 'delivered'
  | 'delivery_uncertain'

export interface PreviewPushStateInfo {
  label: string
  cls: string
  hint: string
  raw: string
  known: boolean
}

export interface PreviewPushRequest {
  id: string
  poId: string
  state: PreviewRequestState | string
  requestId: string | null
}

export function previewPushStateInfo(state: string): PreviewPushStateInfo

export function parsePreviewPushResponse(
  row: unknown,
  opts?: { expectedPoId?: string },
): PreviewPushRequest

export class PreviewPushError extends Error {
  code: string
}
