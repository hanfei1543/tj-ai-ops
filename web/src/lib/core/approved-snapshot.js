// 批准快照（Approved Snapshot v2）—— 单一真相源（前端批准/导出、真实样本脚本共用）。
//
// 为什么不能信调用方：
//   * v1 是浏览器拿页面里的 lines 组串后 sha256，直接写库。页面数据可能和库不一致
//     （未保存的拖曳/数量），也可能被本地篡改；而且旧实现按 item_code 排序，
//     把「批准时的 line_no 顺序」丢掉了 —— 顺序本身是业务事实。
//   * v2 一律由「数据库读回的 header + lines」计算：Website PO Date + 行序(line_no) +
//     code/description/uom/ordered qty/accepted qty/unit price/source refs/note。
//     调用方只能传 header/lines，不能传 hash。
//   * 正式导出（Combined PO / GR / 真实样本 formal）重新计算并与 source_sha256 比对；
//     没有 approval_snapshot_version 的旧单只是「旧摘要」，不冒充已校验批准快照。
//
// 复杂度约束：纯 JS + WebCrypto（浏览器 / Node 同一实现），不发请求、不读 env、无副作用。
import { formatWebsitePoDate, PoExportError } from './po-lines.js'

/** 当前批准快照版本。v1 为无版本号的旧摘要（仅内部 review，不参与正式导出）。 */
export const APPROVAL_SNAPSHOT_VERSION = 2

const HEX64 = /^[0-9a-f]{64}$/

function text(v) {
  return v === null || v === undefined ? '' : String(v)
}

/** 数量/单价：缺失不静默变 0，非数值直接失败（与导出口径一致：导出也会拒绝） */
function num(v, field, index) {
  if (v === null || v === undefined || v === '') {
    throw new Error(`批准快照第 ${index + 1} 行缺少 ${field}，拒绝计算摘要`)
  }
  const n = Number(v)
  if (!Number.isFinite(n)) {
    throw new Error(`批准快照第 ${index + 1} 行 ${field} 不是数值：${String(v)}`)
  }
  return n
}

function lineNo(v, index) {
  const n = Number(v)
  if (!Number.isInteger(n)) {
    throw new Error(`批准快照第 ${index + 1} 行 line_no 不是整数：${String(v)}`)
  }
  return n
}

/**
 * 规范化 source_refs：固定字段顺序（jsonb 不保证对象键顺序，但保证数组顺序）。
 * 数组顺序本身就是数据（多来源 PO 的排列），不做排序。
 */
function normRefs(refs, index) {
  const list = Array.isArray(refs) ? refs : []
  return list.map((r) => ({
    po_id: text(r?.po_id),
    po_number: text(r?.po_number),
    line_id: text(r?.line_id),
    qty: num(r?.qty, 'source_refs.qty', index),
  }))
}

/**
 * 生成 canonical JSON 字符串（确定性：字段顺序固定、无空白、不排序）。
 * 行序 = 传入 lines 的顺序（DB 按 line_no 取出），不按 code 排序、不合并。
 * ordered/accepted 的口径与导出同源：original_qty ?? qty / accepted_qty ?? qty。
 * @param {object} header tj_po_headers 行（po_id / po_type / website_po_date）
 * @param {object[]} lines tj_po_lines 行（按 line_no 顺序）
 * @returns {string}
 */
export function canonicalApprovedSnapshot(header, lines) {
  const h = header ?? {}
  const date = formatWebsitePoDate(h.website_po_date)
  if (!date) {
    throw new Error(
      `批准快照缺少 Website PO Date（po_id=${text(h.po_id) || '(unknown)'}）：必须先有正式业务日期才能生成摘要`,
    )
  }
  const list = Array.isArray(lines) ? lines : []
  if (list.length === 0) {
    throw new Error(`批准快照没有明细行（po_id=${text(h.po_id) || '(unknown)'}），拒绝计算摘要`)
  }
  const payload = {
    snapshot_version: APPROVAL_SNAPSHOT_VERSION,
    po_id: text(h.po_id),
    po_type: text(h.po_type),
    website_po_date: date,
    lines: list.map((l, i) => ({
      line_no: lineNo(l?.line_no, i),
      item_code: text(l?.item_code),
      description: text(l?.description),
      uom: text(l?.uom),
      ordered_qty: num(l?.original_qty ?? l?.qty, 'ordered_qty', i),
      accepted_qty: num(l?.accepted_qty ?? l?.qty, 'accepted_qty', i),
      unit_price: num(l?.unit_price, 'unit_price', i),
      note: text(l?.note),
      source_refs: normRefs(l?.source_refs, i),
    })),
  }
  return JSON.stringify(payload)
}

/** SHA-256(text) -> 64 位小写十六进制（无前缀，与 source_sha256 列口径一致） */
export async function sha256Hex(textValue) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('当前运行时缺少 WebCrypto（crypto.subtle），无法计算批准快照摘要')
  }
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(String(textValue)))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 由 DB 读回的 header + lines 计算批准快照摘要（批准时写库、导出时复算都用它）。
 * @returns {Promise<string>} 64 位小写 hex
 */
export async function computeApprovalSnapshotHash(header, lines) {
  return sha256Hex(canonicalApprovedSnapshot(header, lines))
}

/** 校验 source_sha256 格式：只接受 64 位 hex，不接受 "sha256:" 之类前缀 */
export function normalizeSnapshotHash(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim().toLowerCase()
  return HEX64.test(s) ? s : null
}

/**
 * 重算并校验批准快照。
 * status:
 *   verified               —— 版本 2 + 冻结 + 摘要一致（唯一允许正式导出的状态）
 *   not_combined           —— 普通单没有批准快照
 *   legacy_missing_version —— 旧单（无 approval_snapshot_version，v1 摘要），只能内部 review
 *   unsupported_version    —— 未知版本
 *   not_frozen             —— 未冻结，不能算已批准
 *   invalid_hash           —— source_sha256 缺失/不是 64 位 hex
 *   hash_mismatch          —— 数据与摘要不一致（日期/行序/数量/UOM/单价/来源/备注被改）
 *   invalid_data           —— 明细缺字段等导致无法计算
 *
 * @param {{header?: object, lines?: object[]}} args
 * @returns {Promise<{ok: boolean, status: string, reason: string, version: number|null,
 *   expectedHash: string|null, actualHash: string|null}>}
 */
export async function verifyApprovedSnapshot({ header, lines } = {}) {
  const h = header ?? {}
  const version =
    h.approval_snapshot_version === null || h.approval_snapshot_version === undefined
      ? null
      : Number(h.approval_snapshot_version)
  const expectedHash = normalizeSnapshotHash(h.source_sha256)
  const base = {
    version,
    expectedHash,
    actualHash: null,
  }

  if (h.po_type !== 'combined') {
    return { ...base, ok: false, status: 'not_combined', reason: '普通采购单没有批准快照（保持原 7 列流程）' }
  }
  if (version === null) {
    return {
      ...base,
      ok: false,
      status: 'legacy_missing_version',
      reason:
        '旧单没有 approval_snapshot_version（v1 浏览器摘要），不能视为已校验批准快照；' +
        '只允许明确标注的内部 review 样本，不得作为正式导出',
    }
  }
  if (version !== APPROVAL_SNAPSHOT_VERSION) {
    return {
      ...base,
      ok: false,
      status: 'unsupported_version',
      reason: `未知批准快照版本 ${version}（当前只支持 v${APPROVAL_SNAPSHOT_VERSION}）`,
    }
  }
  if (h.frozen !== true) {
    return { ...base, ok: false, status: 'not_frozen', reason: '单据未冻结，不能算作已校验的批准快照' }
  }
  if (!expectedHash) {
    return {
      ...base,
      ok: false,
      status: 'invalid_hash',
      reason: 'source_sha256 缺失或不是 64 位十六进制，无法校验批准快照',
    }
  }
  let actualHash
  try {
    actualHash = await computeApprovalSnapshotHash(h, lines)
  } catch (e) {
    return { ...base, ok: false, status: 'invalid_data', reason: e.message }
  }
  if (actualHash !== expectedHash) {
    return {
      ...base,
      ok: false,
      status: 'hash_mismatch',
      actualHash,
      reason:
        '重算摘要与 source_sha256 不一致：批准后的 Website PO Date / 行序 / 数量 / UOM / ' +
        '单价 / 来源引用 / 备注与冻结时不同，拒绝导出',
    }
  }
  return { ...base, ok: true, status: 'verified', actualHash, reason: '' }
}

/**
 * 正式导出前的硬门禁：非 verified 一律抛 PoExportError（缺版本旧单只允许内部 review）。
 * @returns {Promise<{ok: true, status: 'verified', version: number, expectedHash: string, actualHash: string}>}
 */
export async function assertVerifiedApprovedSnapshot(header, lines) {
  const h = header ?? {}
  const v = await verifyApprovedSnapshot({ header: h, lines })
  if (v.ok) return v
  const label = h.po_id ?? h.id ?? '(unknown)'
  const legacyHint =
    v.status === 'legacy_missing_version'
      ? '该单是旧摘要（无 approval_snapshot_version）：只能出明确标注 INTERNAL 的审阅样本，不能作为正式导出。'
      : ''
  throw new PoExportError(
    'APPROVAL_SNAPSHOT_UNVERIFIED',
    `合并单 ${label} 批准快照未通过校验（${v.status}）：${v.reason}。${legacyHint}`,
  )
}
