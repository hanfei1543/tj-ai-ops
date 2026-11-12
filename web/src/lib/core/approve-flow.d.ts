// 类型声明（实现见 approve-flow.js）
export interface ApproveFlowIo {
  readHeader: (id: string) => Promise<Record<string, any>>
  readLines: (id: string) => Promise<Array<Record<string, any>>>
  updateHeaderConditional: (args: {
    id: string
    expectStatus: string
    expectFrozen: boolean
    patch: Record<string, unknown>
  }) => Promise<Record<string, any> | null>
  updateSourceStatuses: (args: {
    poNumbers: string[]
    status: string
    onlyFrom: string[]
  }) => Promise<{ updated: number }>
}

export declare function submitCombinedForApprovalFlow(args?: {
  io: ApproveFlowIo
  id: string
  checkedBy: string
  deliveryOrderNo?: string | null
  now?: () => Date
  newReceiptEventId?: () => string
}): Promise<Record<string, any>>

export declare function approveCombinedPoFlow(args?: {
  io: ApproveFlowIo
  id: string
  approvedBy: string
  now?: () => Date
}): Promise<{ hash: string; version: number }>
