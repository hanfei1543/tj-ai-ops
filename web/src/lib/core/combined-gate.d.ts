// 类型声明（实现见 combined-gate.js）。结构化最小接口，Node 侧可直接引用 js。
export interface CombinedGateHeader {
  id?: string | null
  po_id?: string | null
  po_type?: string | null
  status?: string | null
  frozen?: boolean | null
  website_po_date?: string | null
}

export declare function requireCombinedWebsitePoDate(header: CombinedGateHeader): string
export declare function assertCombinedSubmittable(header: CombinedGateHeader): string
export declare function assertCombinedApprovable(header: CombinedGateHeader): string
