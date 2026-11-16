// PO Done ACK 语义 —— 单一真相源（Windows worker 回执判定，纯函数，无 IO / 无副作用）。
//
// 为什么与 GR task_result 分开：
//   * tj_gr_task_result(task_id, receipt_event_id, payload_sha256, ...) 是「GR 收货事件」回调，
//     处理收货事件 + 逐行实收比对，输入是 GR task payload。
//   * 本模块是「PO Save/Queue Done ACK」：处理 Website→Windows Push 的 XLSX 保存回执，
//     输入是 Stage23 的 TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1，事件键是确定性 event_id。
//   两者对象不同（PO vs 收货事件），绝不互相包装。
//
// 关键口径（Stage24 已核对）：
//   * po_push_intents.content_sha256 = 业务 JSON 摘要（computePushContentSha256），
//     **不是** XLSX 二进制哈希。因此 ACK 的 source_sha256（XLSX 精确字节 sha256）绝不能
//     与 content_sha256 直接比较。
//   * 真实 XLSX sha256 记录在 tj_po_push_intents.xlsx_sha256（Push 时由推送器算好落库），
//     ACK 只与它比较。两者算法相同（sha256 over exact file bytes）才可比较。
//
// 本模块不读 env、不发请求、不写库。数据库 RPC public.tj_po_ack_ingest 镜像同一判定。

export const PO_ACK_SCHEMA = 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1'

export const PO_ACK_EVENT_ID_PREFIX = 'tj.po.queue.done.v1.'

export const PO_ACK_STATES = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  NEEDS_REVIEW: 'needs_review',
})

export const PO_ACK_CODES = Object.freeze({
  // 硬校验（DB raise，非 2xx）
  AUTH_REQUIRED: 'PO_ACK_AUTH_REQUIRED',
  FORBIDDEN: 'PO_ACK_FORBIDDEN',
  INVALID_SCHEMA: 'PO_ACK_INVALID_SCHEMA',
  INVALID_EVENT_ID: 'PO_ACK_INVALID_EVENT_ID',
  // 幂等 / 冲突（HTTP 200 + rejected / replayed，审计已落库）
  REPLAY: 'PO_ACK_REPLAY',
  CONFLICT: 'PO_ACK_CONFLICT',
  // 业务拒绝 → needs_review（HTTP 200 + rejected，审计已落库）
  DONE_ACK_MISSING: 'PO_ACK_DONE_ACK_MISSING',
  PO_NOT_FOUND: 'PO_ACK_PO_NOT_FOUND',
  NO_PUSH_DELIVERY: 'PO_ACK_NO_PUSH_DELIVERY',
  SHA_MISMATCH: 'PO_ACK_SHA_MISMATCH',
  IRS_NUMBER_CONFLICT: 'PO_ACK_IRS_NUMBER_CONFLICT',
})

/** 规则错误：code 供调用方/测试断言，message 给操作员看 */
export class PoAckError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PoAckError'
    this.code = code
  }
}

const EVENT_ID_RE = /^tj\.po\.queue\.done\.v1\.[0-9a-f]{8,}$/i

function isBoolTrue(v) {
  return typeof v === 'boolean' && v === true
}

function text(v) {
  return v === null || v === undefined ? null : String(v)
}

/**
 * 校验并归一化 Stage23 ACK 负载。只做纯校验，不碰库。
 * 非关键字段（queue_done_verified_at / transport / warning / callback_state）可忽略，
 * 不进入判定。
 * @param {unknown} payload 原始 JSON
 * @returns {{eventId:string, businessPoId:string|null, poId:string|null,
 *   sourceSha256:string|null, queueDoneSha256:string|null, irsPoNumber:string|null,
 *   verification:string|null, queueDoneAck:boolean, queueFolder:string|null,
 *   ledgerState:string|null}}
 */
export function normalizeAckPayload(payload) {
  const p = payload ?? {}
  if (typeof p !== 'object') {
    throw new PoAckError(PO_ACK_CODES.INVALID_SCHEMA, 'ACK 负载必须是 JSON 对象')
  }
  if (p.schema !== PO_ACK_SCHEMA) {
    throw new PoAckError(
      PO_ACK_CODES.INVALID_SCHEMA,
      `schema 必须是 ${PO_ACK_SCHEMA}，收到 "${p.schema ?? '(空)'}"`,
    )
  }
  const eventId = text(p.event_id)
  if (!eventId || !EVENT_ID_RE.test(eventId)) {
    throw new PoAckError(
      PO_ACK_CODES.INVALID_EVENT_ID,
      `event_id 必须是 ${PO_ACK_EVENT_ID_PREFIX}<hex> 形式（确定性幂等 ID，不是鉴权签名）`,
    )
  }
  const queueDoneAck = isBoolTrue(p.queue_done_ack)
  return {
    eventId,
    businessPoId: text(p.business_po_id),
    poId: text(p.po_id),
    sourceSha256: text(p.source_sha256),
    queueDoneSha256: text(p.queue_done_sha256),
    irsPoNumber: text(p.irs_po_number),
    verification: text(p.verification),
    queueDoneAck,
    queueFolder: text(p.queue_folder),
    ledgerState: text(p.ledger_state),
  }
}

/**
 * 幂等指纹源：语义字段按固定顺序 `|` 连接。同一 event_id 下，这些字段任一变化
 * → 指纹不同 → 判定为冲突（不是 replay）。transport / callback_state / warning /
 * queue_done_verified_at 等易变字段**不**参与，避免重试被误判冲突。
 * JS 与 SQL（tj_po_ack_ingest 内）必须用同一算法同一字节。
 * @param {object} n 已归一化负载（normalizeAckPayload 结果）
 * @returns {string}
 */
export function ackFingerprintSource(n) {
  return [
    n.businessPoId ?? '',
    n.poId ?? '',
    n.sourceSha256 ?? '',
    n.queueDoneSha256 ?? '',
    n.irsPoNumber ?? '',
    n.verification ?? '',
    n.queueDoneAck ? '1' : '0',
    n.queueFolder ?? '',
    n.ledgerState ?? '',
  ].join('|')
}

/** SHA-256(text) -> 64 位小写十六进制（与 DB 的 encode(digest(...),'hex') 同口径） */
export async function computeAckFingerprint(payload) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new PoAckError('PO_ACK_NO_CRYPTO', '运行时缺少 WebCrypto，无法计算 ACK 指纹')
  }
  const n = normalizeAckPayload(payload)
  const src = ackFingerprintSource(n)
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(src))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const SHA256_RE = /^[0-9a-f]{64}$/i

/**
 * 纯判定（无 IO）。DB RPC 镜像同一逻辑；本函数供单测与前端只读展示。
 *
 * @param {{
 *   payload: object,                 // normalizeAckPayload 结果
 *   fingerprint: string,             // computeAckFingerprint 结果（sha256 hex）
 *   receipt: object|null,            // 该 event_id 已存在的回执行（或 null）
 *   po: object|null,                 // tj_po_headers 行（按 business_po_id/po_id 解析，或 null）
 *   pushIntent: object|null,         // 该 PO 的 delivered 投递意图行（或 null）
 *   existingIrsOwner: object|null,   // 已占用 irs_po_number 的另一张 PO（或 null）
 * }} facts
 * @returns {{state:string, code:string|null, replayed:boolean, rejected:boolean,
 *   mustNot:string[], steps:string[]}}
 */
export function decideAck({ payload, fingerprint, receipt, po, pushIntent, existingIrsOwner }) {
  const mustNot = [
    '绝不自动重建已清理的 PO（PO_NOT_FOUND 只转 needs_review，不建单）',
    '绝不因 Windows Pending 文件不存在而重投',
    '绝不把 content_sha256（业务 JSON）当作 XLSX sha256 比较',
    '绝不再次创建 IRS PO 或写回 synthetic 来源（如 PO-878329→PO26000783）',
  ]
  const steps = []
  const verdict = (state, code, extra = {}) => ({
    state,
    code,
    replayed: false,
    rejected: false,
    mustNot,
    steps,
    ...extra,
  })

  // 1) 幂等：同一 event_id 已存在回执
  if (receipt) {
    if (receipt.content_sha256 === fingerprint) {
      return {
        ...verdict(receipt.state, PO_ACK_CODES.REPLAY, { replayed: true }),
        rejected: false,
      }
    }
    return verdict(PO_ACK_STATES.REJECTED, PO_ACK_CODES.CONFLICT, { rejected: true })
  }

  // 2) Done ACK 必须为 JSON boolean true
  if (!payload.queueDoneAck) {
    return verdict(PO_ACK_STATES.NEEDS_REVIEW, PO_ACK_CODES.DONE_ACK_MISSING, { rejected: true })
  }

  // 3) 必须找到 Website 同一 PO 记录（已清理 → needs_review，绝不重建）
  if (!po) {
    steps.push('人工核对：该 Website PO 是否已被清理；确认后按恢复流程处理，不自动重建')
    return verdict(PO_ACK_STATES.NEEDS_REVIEW, PO_ACK_CODES.PO_NOT_FOUND, { rejected: true })
  }

  // 4) 必须有该 PO 的 delivered 投递意图（未见可信 Push 交付 → 拒绝）
  if (!pushIntent || pushIntent.state !== 'delivered') {
    steps.push('人工核对 Windows Queue 实况，确认该 PO 确实已投递；缺失投递意图不得接受 ACK')
    return verdict(PO_ACK_STATES.NEEDS_REVIEW, PO_ACK_CODES.NO_PUSH_DELIVERY, { rejected: true })
  }

  // 5) XLSX 文件哈希对齐：source_sha256 必须等于投递清单记录的 xlsx_sha256
  const xlsxSha = text(pushIntent.xlsx_sha256)
  const srcSha = payload.sourceSha256
  const qdSha = payload.queueDoneSha256
  const sourceShaValid = SHA256_RE.test(srcSha ?? '')
  if (!sourceShaValid || !xlsxSha || srcSha.toLowerCase() !== xlsxSha.toLowerCase()) {
    steps.push('人工核对：导出 XLSX 的精确字节 sha256 与 ACK source_sha256 是否一致')
    return verdict(PO_ACK_STATES.NEEDS_REVIEW, PO_ACK_CODES.SHA_MISMATCH, { rejected: true })
  }
  if (qdSha && qdSha.toLowerCase() !== srcSha.toLowerCase()) {
    steps.push('人工核对：queue_done_sha256 与 source_sha256 不一致（应指同一份导出文件）')
    return verdict(PO_ACK_STATES.NEEDS_REVIEW, PO_ACK_CODES.SHA_MISMATCH, { rejected: true })
  }

  // 6) ERP 号唯一性：irs_po_number 不能被另一张 PO 占用
  if (existingIrsOwner && existingIrsOwner.id !== po.id) {
    steps.push('人工核对：该 IRS PO 号已映射到另一张 Website PO，不得复用')
    return verdict(PO_ACK_STATES.NEEDS_REVIEW, PO_ACK_CODES.IRS_NUMBER_CONFLICT, { rejected: true })
  }

  return verdict(PO_ACK_STATES.ACCEPTED, null)
}

/** 只读展示文案（前端最小状态，不重写页面） */
export function describeAckState(state, code) {
  switch (state) {
    case PO_ACK_STATES.ACCEPTED:
      return '已保存并核对（Queue Done）'
    case PO_ACK_STATES.NEEDS_REVIEW:
      return `待人工核对（${code ?? 'unknown'}）`
    case PO_ACK_STATES.REJECTED:
      return `已拒绝（${code ?? 'unknown'}）`
    default:
      return state ?? '未知'
  }
}
