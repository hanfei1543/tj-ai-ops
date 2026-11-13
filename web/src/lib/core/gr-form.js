// 统一收货（GR）表单规则 —— 纯逻辑，无 IO、无 React。
//
// 冻结口径：
//   * 数量/单价一律用 decimal string 传递，不用 JS Number 做精确计算（避免 0.1+0.2 类误差）。
//   * 空白 / 负数 / 非数字一律拒绝并给出中文原因，绝不静默当 0。
//   * 收货日期必须由人显式选择（yyyy-MM-dd），不用提交时间戳代替。
//   * 一行可以有多个来源分配（合并单来源 PO/行），分配合计必须等于该行实收。
//   * 超收 / 额外行属于例外：可以提交，但必须走审批复核（requires_exception_approval）。
//   * 零行允许保存草稿，但不形成正式 GR，不能提交。
//   * Invoice No. 与 Delivery Order No. 至少一项（可只开发票或只开送货单）；
//     两者都空只能存草稿。编号文本原样保存，trim 只用于判空，不改写号码。
//   * 草稿身份按「已选 PO 集合」持久在 sessionStorage/localStorage：同一批未提交草稿复用
//     同一 UUID；一旦提交/放行，绑定立即销毁，同一 PO 的下一批收货必须换新 UUID。
//   * 状态/任务文案只说服务端真实返回的状态：waiting_mapping / needs_review /
//     review_required 明确展示，不虚构 blocked 等不存在的状态；
//     任务永远不等于 IRS 成功/已过账。

export const DRAFT_STORAGE_PREFIX = 'tj_gr_draft:'

export const RECEIPT_ROLES = Object.freeze(['staff', 'approver', 'executor', 'admin'])

/** 可登记收货的 PO 状态：普通已确认、合并单已批准、合并后的原标准单、生产已导出普通单 */
export const RECEIVABLE_PO_STATUSES = Object.freeze(['confirmed', 'combined', 'exported'])

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DECIMAL = /^\+?\d+(\.\d+)?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim())
}

/** 收货入口是否接受该 PO 状态（服务端仍会再校验） */
export function isReceivablePoStatus(status) {
  return RECEIVABLE_PO_STATUSES.includes(String(status ?? '').trim())
}

/**
 * 合并来源资格：标准单、confirmed、未冻结（frozen=false）。
 * 合并单自身、已冻结、合并中/已合并、已导出/推送中的单都不能再当来源。
 */
export function isCombinableSource(po) {
  return (
    !!po &&
    String(po.po_type ?? 'standard') !== 'combined' &&
    String(po.status ?? '') === 'confirmed' &&
    po.frozen !== true
  )
}

/** Invoice/DO 是否至少有一个非空（trim 只用于判空，不改写原字符串） */
export function documentNumbersPresent(header) {
  const invoice = String(header?.invoice_no ?? '').trim()
  const deliveryOrder = String(header?.delivery_order_no ?? '').trim()
  return invoice !== '' || deliveryOrder !== ''
}

/** 只接受真实存在的 yyyy-MM-dd（不接受 ISO 时间戳/本地化格式） */
export function isValidDateOnly(value) {
  if (isBlank(value)) return false
  const m = DATE_ONLY.exec(String(value).trim())
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * 校验一个 decimal string（不转 Number）。
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function parseDecimalString(raw, { field = '数量', allowZero = true } = {}) {
  if (isBlank(raw)) {
    return { ok: false, error: `${field}不能为空（0 也必须明确填写）` }
  }
  const s = String(raw).trim()
  const normalized = s.replace(/^[−–—]/, '-')
  if (normalized.startsWith('-')) {
    return { ok: false, error: `${field}不能为负数：${s}` }
  }
  if (!DECIMAL.test(normalized)) {
    return { ok: false, error: `${field}不是有效数字：${s}` }
  }
  const value = normalized.startsWith('+') ? normalized.slice(1) : normalized
  if (!allowZero && /^0+(\.0+)?$/.test(value)) {
    return { ok: false, error: `${field}必须大于 0` }
  }
  return { ok: true, value }
}

function decimalParts(value) {
  const [int, frac = ''] = value.split('.')
  return { int, frac }
}

/** 精确 decimal string 相加（BigInt 定点），非法输入抛错 */
export function addDecimalStrings(values) {
  const list = (values ?? []).map((v) => {
    const r = parseDecimalString(v)
    if (!r.ok) throw new Error(`不是有效数字：${String(v)}`)
    return r.value
  })
  if (list.length === 0) return '0'
  const maxFrac = Math.max(...list.map((v) => decimalParts(v).frac.length))
  let sum = 0n
  for (const v of list) {
    const { int, frac } = decimalParts(v)
    sum += BigInt(int + frac.padEnd(maxFrac, '0'))
  }
  const scale = 10n ** BigInt(maxFrac)
  const whole = sum / scale
  let frac = (sum % scale).toString().padStart(maxFrac, '0')
  frac = frac.replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** 比较两个 decimal string：1 大于 / 0 相等 / -1 小于 */
export function compareDecimalStrings(a, b) {
  const ra = parseDecimalString(a)
  const rb = parseDecimalString(b)
  if (!ra.ok) throw new Error(ra.error)
  if (!rb.ok) throw new Error(rb.error)
  const maxFrac = Math.max(decimalParts(ra.value).frac.length, decimalParts(rb.value).frac.length)
  const scale = (v) => {
    const { int, frac } = decimalParts(v)
    return BigInt(int + frac.padEnd(maxFrac, '0'))
  }
  const va = scale(ra.value)
  const vb = scale(rb.value)
  return va > vb ? 1 : va < vb ? -1 : 0
}

/** 角色白名单归一：未知角色丢弃，重复去重 */
export function normalizeRoles(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw) {
    const v = String(r ?? '').trim().toLowerCase()
    if (RECEIPT_ROLES.includes(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * 角色能力（镜像 docs/gr-contract.md §2；真正权限由服务器强制）。
 * receipt_save/submit：staff/approver/admin；approve/release/mapping：approver/admin；
 * task_claim/task_result：executor/admin（本 UI 不暴露 executor 执行按钮）。
 * @returns {{roles: string[], isStaff: boolean, canSubmit: boolean, canApprove: boolean, canRelease: boolean, canTaskResult: boolean, isAdmin: boolean}}
 */
export function capabilities(identity) {
  const roles = normalizeRoles(identity?.roles)
  const isApprover = roles.includes('approver') || roles.includes('admin')
  return {
    roles,
    isStaff: roles.length > 0,
    canSubmit:
      roles.includes('staff') || roles.includes('approver') || roles.includes('admin'),
    canApprove: isApprover,
    // 合同：receipt_release 只允许 approver/admin；executor 只做 task_result
    canRelease: isApprover,
    canTaskResult: roles.includes('executor') || roles.includes('admin'),
    isAdmin: roles.includes('admin'),
  }
}

/** 收货事件状态徽章：未知状态如实显示，不冒充成功 */
export function receiptStatusBadge(status) {
  const raw = String(status ?? '').trim()
  const map = {
    draft: ['草稿', 'bg-slate-100 text-slate-600'],
    saved: ['草稿已保存', 'bg-slate-100 text-slate-600'],
    submitted: ['已提交（待审批）', 'bg-amber-100 text-amber-700'],
    pending_approval: ['待审批', 'bg-amber-100 text-amber-700'],
    approved: ['已批准（待放行）', 'bg-emerald-100 text-emerald-700'],
    waiting_mapping: ['等待映射（waiting_mapping）', 'bg-amber-100 text-amber-700'],
    released: ['已放行（未推送 IRS）', 'bg-emerald-100 text-emerald-700'],
    in_progress: ['本机处理中（未验证）', 'bg-blue-100 text-blue-700'],
    saved_unverified: ['本机已保存（未核对）', 'bg-blue-100 text-blue-700'],
    verified: ['证据核对通过（未推送 IRS）', 'bg-emerald-100 text-emerald-700'],
    needs_review: ['需复核（needs_review）', 'bg-red-100 text-red-700'],
    failed_unsaved: ['保存失败（未写入）', 'bg-red-100 text-red-700'],
    rejected: ['已拒绝', 'bg-slate-200 text-slate-600'],
    cancelled: ['已取消', 'bg-slate-200 text-slate-600'],
  }
  const hit = map[raw]
  if (hit) return { label: hit[0], cls: hit[1], raw, known: true }
  return {
    label: raw ? `未知状态（${raw}），请核对服务端` : '未知状态（空）',
    cls: 'bg-slate-200 text-slate-600',
    raw,
    known: false,
  }
}

/** 任务状态徽章：任务发布永远不等于 IRS 成功 */
export function taskStatusBadge(status) {
  const raw = String(status ?? '').trim()
  const map = {
    ready: '任务已准备（未推送 IRS）',
    planned: '任务已准备（未推送 IRS）',
    queued: '任务已准备（未推送 IRS）',
    pending: '任务已准备（未推送 IRS）',
    claimed: '已领取，等待本机保存（未推送 IRS）',
    save_attempted: '本机已开始保存（结果未经确认）',
    sent: '已交本机处理（执行结果未经确认）',
    dispatched: '已交本机处理（执行结果未经确认）',
    saved_unverified: '本机回报已保存（未逐行核对）',
    verified: '本机证据核对通过（未推送 IRS）',
    done: '本机回报完成（不是 IRS 过账）',
    completed: '本机回报完成（不是 IRS 过账）',
    failed_unsaved: '保存失败（从未开始写入，需人工处理）',
    failed: '执行失败（需人工核对）',
    needs_review: '需复核（人工处理，不自动重试）',
    cancelled: '已取消',
  }
  return {
    label: map[raw] ?? `未知任务状态（${raw || '空'}），按未推送处理`,
    raw,
    // 前端永远不认定 IRS 已成功/已过账
    irs_confirmed: false,
  }
}

/**
 * 事件是否已经进入「不可重做」区：已放行（released_at 或已建任务）或 verified 终态。
 * 这类事件不能再 approve / submit / release / edit —— 重做会造成重复过账。
 * @returns {null | {code: string, terminal: boolean, message: string}}
 */
export function receiptRedoLock(event) {
  if (!event) return null
  const status = String(event.status ?? '').trim()
  if (status === 'verified') {
    return {
      code: 'VERIFIED_TERMINAL',
      terminal: true,
      message: '证据核对已通过（verified，终态）：不能再次提交/批准/放行/编辑，需人工核对本机记录。',
    }
  }
  const releasedAt = String(event.released_at ?? '').trim()
  const tasks = Array.isArray(event.tasks) ? event.tasks : []
  if (releasedAt !== '' || tasks.length > 0) {
    return {
      code: 'RELEASED_LOCKED',
      terminal: false,
      message:
        '该事件已放行并生成本机任务：不能重新提交/批准/放行或改行（避免重复过账），' +
        '请按本机回报人工核对。',
    }
  }
  return null
}

/**
 * IRS PO 映射证据：必须由审批人给出可核查的证据与核验方式，并显式确认已核对。
 * 不允许只写「页面登记」+ 当前时间就当作核验证据。
 * @returns {{checked_by: string, checked_at: string, evidence_ref: string, method: string, confirmed: true}}
 */
export function buildMappingEvidence({
  checkedBy,
  evidenceRef,
  method,
  confirmed,
  now = () => new Date(),
} = {}) {
  const by = String(checkedBy ?? '').trim()
  const ref = String(evidenceRef ?? '').trim()
  const how = String(method ?? '').trim()
  if (!by) throw new Error('核验人缺失：映射证据必须记录登录身份')
  if (!ref) {
    throw new Error('请填写可核查证据（IRS 采购单页面/截图文件名/纸单据编号），不能只写「页面登记」')
  }
  if (!how) throw new Error('请填写核验方式（例如 IRS 系统查询、纸质单据核对）')
  if (confirmed !== true) throw new Error('请先勾选「已核对 IRS 采购单编号」再登记映射')
  const at = now()
  const iso = at instanceof Date ? at.toISOString() : String(at)
  if (Number.isNaN(new Date(iso).getTime())) throw new Error('核验时间不可解析，拒绝登记映射证据')
  return { checked_by: by, checked_at: iso, evidence_ref: ref, method: how, confirmed: true }
}

function pushError(errors, path_, message) {
  errors.push({ path: path_, message })
}

function lineLabel(l, i) {
  const n = l?.line_no ?? i + 1
  return `第 ${n} 行${l?.item_code ? `（${l.item_code}）` : ''}`
}

/**
 * 收货表单校验。
 * @param {{header: object, lines: object[], identity?: object|null}} input
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{path: string, message: string}>,
 *   exceptions: Array<{code: string, message: string, line_no?: number}>,
 *   canSaveDraft: boolean,
 *   canSubmit: boolean,
 *   requires_exception_approval: boolean,
 *   submit_blocked_reason: string,
 * }}
 */
export function validateReceiptForm({ header, lines, identity = null } = {}) {
  const h = header ?? {}
  const list = Array.isArray(lines) ? lines : []
  const errors = []
  const exceptions = []

  // 身份自动来自登录（checked_by 由调用方从 session 带入，不允许空）
  if (isBlank(h.checked_by)) {
    pushError(errors, 'checked_by', '核对人缺失：请先登录（身份自动来自登录）')
  }
  if (isBlank(h.receive_date)) {
    pushError(errors, 'receive_date', '收货日期必填：必须明确选择收货日期，不能用提交时间代替')
  } else if (!isValidDateOnly(h.receive_date)) {
    pushError(errors, 'receive_date', `收货日期必须是真实存在的 yyyy-MM-dd：${String(h.receive_date)}`)
  }
  if (!isBlank(h.invoice_date) && !isValidDateOnly(h.invoice_date)) {
    pushError(errors, 'invoice_date', `发票日期必须是 yyyy-MM-dd 或留空：${String(h.invoice_date)}`)
  }
  if (String(h.note ?? '').length > 2000) {
    pushError(errors, 'note', '备注过长（最多 2000 字）')
  }

  list.forEach((l, i) => {
    const label = lineLabel(l, i)
    const path_ = `lines[${i}]`

    const ordered = parseDecimalString(l?.ordered_qty, { field: `${label} 订购数量` })
    if (!ordered.ok) pushError(errors, `${path_}.ordered_qty`, ordered.error)

    const price = parseDecimalString(l?.unit_price, { field: `${label} 单价` })
    if (!price.ok) pushError(errors, `${path_}.unit_price`, price.error)

    const accepted = parseDecimalString(l?.accepted_qty, { field: `${label} 实收数量` })
    if (!accepted.ok) {
      pushError(errors, `${path_}.accepted_qty`, accepted.error)
    } else if (ordered.ok && compareDecimalStrings(accepted.value, ordered.value) > 0) {
      exceptions.push({
        code: 'OVER_DELIVERY',
        line_no: l?.line_no ?? i + 1,
        message: `${label} 实收 ${accepted.value} 超过订购 ${ordered.value}：需审批复核`,
      })
    }

    const allocs = Array.isArray(l?.source_allocations) ? l.source_allocations : []
    if (allocs.length === 0) {
      exceptions.push({
        code: 'EXTRA_LINE',
        line_no: l?.line_no ?? i + 1,
        message:
          `${label} 没有可核实的原 PO 来源分配（额外/替代行）：可保存/提交，` +
          '但放行会被服务端阻止（GR_EXTRA_ASSIGNMENT_REQUIRED），需人工指定来源',
      })
    } else {
      const allocValues = []
      allocs.forEach((a, ai) => {
        const r = parseDecimalString(a?.accepted_qty, { field: `${label} 来源分配${ai + 1}` })
        if (!r.ok) {
          pushError(errors, `${path_}.source_allocations[${ai}].accepted_qty`, r.error)
        } else {
          allocValues.push(r.value)
        }
        if (!isUuid(a?.po_header_id)) {
          pushError(errors, `${path_}.source_allocations[${ai}].po_header_id`, `${label} 缺少来源 PO UUID`)
        }
        if (!isUuid(a?.po_line_id)) {
          pushError(errors, `${path_}.source_allocations[${ai}].po_line_id`, `${label} 缺少来源行 UUID`)
        }
      })
      if (accepted.ok && allocValues.length === allocs.length) {
        const sum = addDecimalStrings(allocValues)
        if (compareDecimalStrings(sum, accepted.value) !== 0) {
          pushError(
            errors,
            `${path_}.source_allocations`,
            `${label} 来源分配合计 ${sum} 与实收 ${accepted.value} 不一致：请核对每条来源数量`,
          )
        }
      }
    }
  })

  const ok = errors.length === 0
  const hasDocumentNumber = documentNumbersPresent(h)
  const canSubmit = ok && list.length > 0 && hasDocumentNumber
  const requiresExceptionApproval = canSubmit && exceptions.length > 0
  let submitBlockedReason = ''
  if (!ok) submitBlockedReason = '请先修正表单错误'
  else if (list.length === 0) submitBlockedReason = '没有收货行：只能保存草稿，不会形成正式 GR'
  else if (!hasDocumentNumber) {
    submitBlockedReason =
      'Invoice No. 与 Delivery Order No. 至少填写一项才能提交/放行（两者都空只能保存草稿）'
  }

  return {
    ok,
    errors,
    exceptions,
    canSaveDraft: ok,
    canSubmit,
    requires_exception_approval: requiresExceptionApproval,
    submit_blocked_reason: submitBlockedReason,
    has_document_number: hasDocumentNumber,
  }
}

function requireUuid(value, message) {
  if (!isUuid(value)) throw new Error(message)
  return value
}

/**
 * 构造 receipt_save 的 RPC 参数（p_data）。不计算金额、不改精度、不丢来源 UUID。
 *
 * po_ids：由各行来源分配汇总（普通单 = 所选 PO；合并单的来源行指向原始 PO 行）。
 * 没有任何来源分配时回退到 selectedPoIds（例如只补额外行的草稿）。
 */
export function buildReceiptSavePayload({ receiptId, revision, selectedPoIds, header, lines } = {}) {
  const id = requireUuid(receiptId, `收货单 UUID 缺失或非法：${String(receiptId)}`)
  const h = header ?? {}
  const list = Array.isArray(lines) ? lines : []

  const payloadLines = list.map((l, i) => {
    const lineId = requireUuid(l?.id, `第 ${i + 1} 行 UUID 缺失或非法（不能自动补随机 ID）`)
    const allocations = (Array.isArray(l?.source_allocations) ? l.source_allocations : []).map((a, ai) => {
      requireUuid(a?.po_header_id, `第 ${i + 1} 行来源 PO UUID 缺失或非法`)
      requireUuid(a?.po_line_id, `第 ${i + 1} 行来源行 UUID 缺失或非法`)
      const qty = parseDecimalString(a?.accepted_qty, { field: `第 ${i + 1} 行来源分配${ai + 1}` })
      if (!qty.ok) throw new Error(qty.error)
      return {
        po_header_id: a.po_header_id,
        po_line_id: a.po_line_id,
        accepted_qty: qty.value,
      }
    })
    const accepted = parseDecimalString(l?.accepted_qty, { field: `第 ${i + 1} 行实收数量` })
    if (!accepted.ok) throw new Error(accepted.error)
    const ordered = parseDecimalString(l?.ordered_qty, { field: `第 ${i + 1} 行订购数量` })
    if (!ordered.ok) throw new Error(ordered.error)
    const price = parseDecimalString(l?.unit_price, { field: `第 ${i + 1} 行单价` })
    if (!price.ok) throw new Error(price.error)

    return {
      id: lineId,
      line_no: Number(l?.line_no ?? i + 1),
      item_code: String(l?.item_code ?? ''),
      description: String(l?.description ?? ''),
      uom: l?.uom ?? null,
      unit_price: price.value,
      ordered_qty: ordered.value,
      accepted_qty: accepted.value,
      note: String(l?.note ?? ''),
      source_allocations: allocations,
    }
  })

  const allocationPoIds = []
  for (const l of payloadLines) {
    for (const a of l.source_allocations) {
      if (!allocationPoIds.includes(a.po_header_id)) allocationPoIds.push(a.po_header_id)
    }
  }
  const fallback = (Array.isArray(selectedPoIds) ? selectedPoIds : []).filter(isUuid)
  const poIds = allocationPoIds.length > 0 ? allocationPoIds : fallback

  return {
    id,
    revision: Number.isInteger(revision) ? revision : 0,
    po_ids: poIds,
    // 单号是业务文本：原样保存（前导零/大小写/空格都不改写），trim 只在判空时用
    invoice_no: String(h.invoice_no ?? ''),
    delivery_order_no: String(h.delivery_order_no ?? ''),
    receive_date: String(h.receive_date ?? '').trim(),
    invoice_date: isBlank(h.invoice_date) ? null : String(h.invoice_date).trim(),
    checked_by: String(h.checked_by ?? '').trim(),
    note: String(h.note ?? '').trim(),
    lines: payloadLines,
  }
}

/** 草稿身份 key：只按已选 PO 集合（顺序无关），不按时间/批次 */
export function draftIdentityKey(poIds) {
  const ids = (Array.isArray(poIds) ? poIds : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  const unique = Array.from(new Set(ids)).sort()
  if (unique.length === 0) throw new Error('草稿身份缺失：未选择采购单')
  return `${DRAFT_STORAGE_PREFIX}${unique.join('+')}`
}

function defaultReceiptId() {
  const c = globalThis.crypto
  if (!c?.randomUUID) throw new Error('当前运行时缺少 crypto.randomUUID，无法生成收货单 UUID')
  return c.randomUUID()
}

/**
 * 草稿会话：绑定 receipt UUID/revision 与「已选 PO 集合」，并防止双击重复提交。
 *
 * @param {{
 *   storage: {getItem(k: string): string|null, setItem(k: string, v: string): void, removeItem(k: string): void},
 *   poIds: string[],
 *   newId?: () => string,
 *   now?: () => Date,
 * }} args
 */
export function createReceiptDraftSession({
  storage,
  poIds,
  newId = defaultReceiptId,
  now = () => new Date(),
  seed = null,
} = {}) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new Error('草稿会话缺少 storage（sessionStorage/localStorage）')
  }
  const key = draftIdentityKey(poIds)
  let receiptId = null
  let revision = 0
  let submitted = false

  const raw = storage.getItem(key)
  if (raw) {
    try {
      const saved = JSON.parse(raw)
      if (saved && saved.status === 'draft' && typeof saved.receipt_id === 'string' && saved.receipt_id) {
        receiptId = saved.receipt_id
        revision = Number.isInteger(saved.revision) ? saved.revision : 0
      } else {
        storage.removeItem(key)
      }
    } catch {
      storage.removeItem(key)
    }
  }
  if (!receiptId && seed && typeof seed.receipt_id === 'string' && seed.receipt_id) {
    // 从 DB 恢复的草稿（详情页「继续编辑」）：沿用服务端 UUID/revision
    receiptId = seed.receipt_id
    revision = Number.isInteger(seed.revision) ? seed.revision : 0
  }
  if (!receiptId) receiptId = newId()

  let busy = null

  function persist(status = 'draft') {
    storage.setItem(
      key,
      JSON.stringify({
        receipt_id: receiptId,
        revision,
        status,
        po_ids: (Array.isArray(poIds) ? poIds : []).map(String),
        updated_at: now().toISOString(),
      }),
    )
  }
  // 初次保存前就持久：刷新/重开还能接着用同一个 UUID（不重复建单）
  persist('draft')

  return {
    key,
    get receiptId() {
      return receiptId
    },
    get revision() {
      return revision
    },
    get submitted() {
      return submitted
    },
    isBusy() {
      return busy !== null
    },
    /** 防双击：同一时刻只允许一个 save/submit 在飞行 */
    begin(op) {
      if (busy !== null) return false
      busy = String(op)
      return true
    },
    end() {
      busy = null
    },
    /** receipt_save 返回的 event：刷新 revision（以服务端为准） */
    saveResult(event) {
      if (!event) return
      if (typeof event.id === 'string' && event.id) receiptId = event.id
      if (Number.isInteger(event.revision)) revision = event.revision
      else if (Number.isFinite(Number(event.revision))) revision = Number(event.revision)
      else revision += 1
      persist('draft')
    },
    /**
     * 保存遇到「会话已有草稿/版本冲突」时，用服务端返回的草稿 id/revision
     * 恢复当前会话，再重试保存（不新建第二张草稿）。
     */
    adoptDraft({ receipt_id, revision: serverRevision } = {}) {
      if (typeof receipt_id === 'string' && receipt_id) receiptId = receipt_id
      if (Number.isInteger(serverRevision)) revision = serverRevision
      else if (Number.isFinite(Number(serverRevision))) revision = Number(serverRevision)
      persist('draft')
    },
    /**
     * receipt_submit 返回的 event：只要不再是 draft，就销毁绑定，
     * 保证同一 PO 的下一批收货拿到新的 UUID。
     */
    submitResult(event) {
      const status = String(event?.status ?? 'submitted')
      if (Number.isInteger(event?.revision)) revision = event.revision
      if (status === 'draft') {
        persist('draft')
        return
      }
      submitted = true
      storage.removeItem(key)
    },
  }
}
