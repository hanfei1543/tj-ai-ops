// 类型声明（实现见 approved-snapshot.js）
export declare const APPROVAL_SNAPSHOT_VERSION: 2

export interface SnapshotHeaderInput {
  po_id?: string | null
  po_type?: string | null
  website_po_date?: string | null
  frozen?: boolean
  approval_snapshot_version?: number | null
  source_sha256?: string | null
}

export interface SnapshotLineInput {
  line_no: number
  item_code?: string | null
  description?: string | null
  uom?: string | null
  qty?: number | null
  original_qty?: number | null
  accepted_qty?: number | null
  unit_price?: number | null
  note?: string | null
  source_refs?: Array<{
    po_id?: string | null
    po_number?: string | null
    line_id?: string | null
    qty?: number | null
  }> | null
}

export type SnapshotStatus =
  | 'verified'
  | 'not_combined'
  | 'legacy_missing_version'
  | 'unsupported_version'
  | 'not_frozen'
  | 'invalid_hash'
  | 'hash_mismatch'
  | 'invalid_data'

export interface SnapshotVerification {
  ok: boolean
  status: SnapshotStatus
  reason: string
  version: number | null
  expectedHash: string | null
  actualHash: string | null
}

export declare function canonicalApprovedSnapshot(
  header: SnapshotHeaderInput | null | undefined,
  lines: readonly SnapshotLineInput[] | null | undefined,
): string
export declare function sha256Hex(text: string): Promise<string>
export declare function computeApprovalSnapshotHash(
  header: SnapshotHeaderInput | null | undefined,
  lines: readonly SnapshotLineInput[] | null | undefined,
): Promise<string>
export declare function normalizeSnapshotHash(value: string | null | undefined): string | null
export declare function verifyApprovedSnapshot(args?: {
  header?: SnapshotHeaderInput | null
  lines?: readonly SnapshotLineInput[] | null
}): Promise<SnapshotVerification>
export declare function assertVerifiedApprovedSnapshot(
  header: SnapshotHeaderInput | null | undefined,
  lines: readonly SnapshotLineInput[] | null | undefined,
): Promise<SnapshotVerification>
