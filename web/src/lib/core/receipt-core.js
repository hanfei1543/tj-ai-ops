// GR 收货纯核 —— 契约的单一真相源（前端表单校验 + Node 测试 + 本地 harness 共用）。
//
// 为什么单独一层：
//   * 数量/单价必须按“精确十进制字符串”处理，不能用 Number 往返（0.1+0.2 类误差会
//     直接污染 IRS 入账金额与批准哈希）。本模块只做字符串规范化，不做浮点运算。
//   * 事件哈希必须与数据库逐字节一致，所以规范化（键排序/转义/null/时间口径）
//     只能有一处定义；SQL 侧 tj_preview.tj_gr_event_kv() 按同一规则实现，
//     由 scripts/gr-local-smoke.mjs 做跨语言同值对照。
//   * 本模块不发请求、不读 env、无副作用；真正的权限/锁/累计余额在数据库 RPC。

export const GR_SCHEMA_VERSION = 'tj.gr.v1'
export const GR_ENVIRONMENT = 'preview'
export const GR_KIND = 'goods_receive'

/** 事件状态（与数据库 CHECK 完全一致，勿另造别名） */
export const EVENT_STATUSES = Object.freeze([
  'draft',
  'submitted',
  'approved',
  'waiting_mapping',
  'released',
  'in_progress',
  'saved_unverified',
  'verified',
  'needs_review',
  'cancelled',
])

/** 可编辑状态：只有这些状态允许 receipt_save 覆盖行/来源 */
export const EVENT_EDITABLE_STATUSES = Object.freeze(['draft', 'needs_review'])

/** 已“占用额度”的状态：累计余额校验必须把它们算进去（与 SQL 一致） */
export const EVENT_COMMITTED_STATUSES = Object.freeze([
  'approved',
  'waiting_mapping',
  'released',
  'in_progress',
  'saved_unverified',
  'verified',
  'needs_review',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DECIMAL_RE = /^-?\d+(\.\d+)?$/
const MAX_SCALE = 6

/** 契约错误：code 供 UI/测试断言，message 直接给操作员看，detail 是结构化补充 */
export class ReceiptError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ReceiptError'
    this.code = code
    this.detail = detail
  }
}

export function fail(code, message, detail = {}) {
  throw new ReceiptError(code, message, detail)
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim())
}

/** 严格 yyyy-MM-dd（不接受时间戳/本地化格式；不存在的日期返回 false） */
export function isDateOnly(value) {
  if (typeof value !== 'string') return false
  const m = DATE_ONLY_RE.exec(value.trim())
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * 十进制规范化：去尾随零、去多余前导零、无指数、-0 → 0。
 * 拒绝：空值、非数字、指数形式、负数、超过 6 位小数（绝不四舍五入）。
 * @returns {string} 规范十进制串
 */
export function normalizeDecimal(value, field = 'value') {
  if (value === null || value === undefined) {
    fail('GR_INVALID_DECIMAL', `${field} 不能为空（缺失不允许当作 0）`, { field })
  }
  let s
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('GR_INVALID_DECIMAL', `${field} 不是有限数值：${String(value)}`, { field })
    }
    s = String(value)
    if (/e/i.test(s)) {
      fail('GR_INVALID_DECIMAL', `${field} 不接受指数形式：${s}（请用十进制字符串）`, { field })
    }
  } else if (typeof value === 'string') {
    s = value.trim()
    if (!s) fail('GR_INVALID_DECIMAL', `${field} 不能为空串`, { field })
    if (/e/i.test(s)) {
      fail('GR_INVALID_DECIMAL', `${field} 不接受指数形式：${s}`, { field })
    }
  } else {
    fail('GR_INVALID_DECIMAL', `${field} 类型非法：${typeof value}`, { field })
  }

  if (!DECIMAL_RE.test(s)) {
    fail('GR_INVALID_DECIMAL', `${field} 不是十进制数：${s}`, { field })
  }

  const neg = s.startsWith('-')
  if (neg) {
    // -0 / -0.000 视为 0；其余负值（含负数量/负单价）一律拒绝
    if (Number(s) !== 0) fail('GR_INVALID_DECIMAL', `${field} 不得为负数：${s}`, { field })
    s = s.slice(1)
  }

  let [intPart, frac = ''] = s.split('.')
  if (frac.length > MAX_SCALE) {
    fail('GR_DECIMAL_SCALE', `${field} 小数位超过 ${MAX_SCALE} 位：${s}（拒绝四舍五入）`, {
      field,
      scale: frac.length,
    })
  }
  intPart = intPart.replace(/^0+(?=\d)/, '')
  frac = frac.replace(/0+$/, '')
  const out = frac ? `${intPart}.${frac}` : intPart
  return out === '' ? '0' : out
}

/** 精确比较（都先规范化；任何一边非法 → false，不抛） */
export function decimalEq(a, b) {
  try {
    return normalizeDecimal(a) === normalizeDecimal(b)
  } catch {
    return false
  }
}

/** 规范十进制 → 微单位 BigInt（1e-6），用于精确求和/比较，避免浮点误差 */
export function decimalToMicros(value) {
  const s = normalizeDecimal(value)
  const [intPart, frac = ''] = s.split('.')
  return BigInt(intPart) * 1000000n + BigInt(`${frac}000000`.slice(0, 6))
}

/** 微单位 BigInt → 规范十进制串 */
export function microsToDecimal(micros) {
  const neg = micros < 0n
  const abs = neg ? -micros : micros
  const intPart = (abs / 1000000n).toString()
  const frac = (abs % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  const out = frac ? `${intPart}.${frac}` : intPart
  return neg && out !== '0' ? `-${out}` : out
}

/** 文本值保持原样（不 trim、不改大小写）；null/undefined → null */
function textOrNull(v, field) {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') fail('GR_VALIDATION', `${field} 必须是文本`, { field })
  return v
}

function requiredText(v, field) {
  const t = textOrNull(v, field)
  if (t === null || t === '') fail('GR_VALIDATION', `${field} 必填`, { field })
  return t
}

/** 转义：反斜杠 → \\、TAB → \t、LF → \n、CR → \r（其它原样） */
export function escapeValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

/** null 的 canonical 标记（反斜杠 + N），与 SQL 侧 tj_gr_val(NULL) 一致 */
export const NULL_TOKEN = '\\N'

/** 值编码：null → \N；布尔 → true/false；其它 → 转义文本 */
export function encodeValue(v) {
  if (v === null || v === undefined) return NULL_TOKEN
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return escapeValue(v)
}

/** 时间戳 → UTC `YYYY-MM-DDTHH:MM:SSZ`（秒精度；非法时间抛错，不猜） */
export function timestampText(value, field = 'timestamp') {
  if (value === null || value === undefined || value === '') return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) {
    fail('GR_VALIDATION', `${field} 不是有效时间：${String(value)}`, { field })
  }
  return d.toISOString().slice(0, 19) + 'Z'
}

/**
 * 规范文本：`key<TAB>value` 行，按 key 字节序排序，`\n` 连接（末尾无换行）。
 * 所有值已经过 encodeValue（或本身就是规范十进制）。
 */
export function canonicalFromKeyValues(pairs) {
  const rows = pairs.map(([k, v]) => `${k}\t${encodeValue(v)}`)
  rows.sort()
  return rows.join('\n')
}

/** 行排序：line_no 升序，其次 id（与 SQL `order by line_no, id` 一致） */
export function compareLines(a, b) {
  const na = Number(a.line_no)
  const nb = Number(b.line_no)
  if (na !== nb) return na - nb
  return String(a.id).localeCompare(String(b.id))
}

/** 来源排序：po_header_id 再 po_line_id（与 SQL 一致，保证 canonical 稳定） */
export function compareSources(a, b) {
  const ka = `${a.po_header_id}|${a.po_line_id}`
  const kb = `${b.po_header_id}|${b.po_line_id}`
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

function lineSources(line) {
  const src = line?.sources ?? line?.source_allocations ?? []
  return Array.isArray(src) ? src : []
}

/**
 * 事件级规范化键值（哈希输入）。覆盖：供商、单据号、收货/发票日期、核对/审批、
 * 全部行 + 全部来源分配。任何一项变化都会改变事件哈希。
 * @returns {Array<[string, string|null]>}
 */
export function eventKeyValues(event) {
  const e = event ?? {}
  const poIds = (Array.isArray(e.po_ids) ? e.po_ids : []).map((x) => String(x)).sort()
  const pairs = [
    ['schema', GR_SCHEMA_VERSION],
    ['kind', GR_KIND],
    ['environment', GR_ENVIRONMENT],
    ['event.id', e.id ?? null],
    ['event.revision', e.revision === null || e.revision === undefined ? null : String(e.revision)],
    ['event.supplier_code', e.supplier_code ?? null],
    ['event.supplier_name', e.supplier_name ?? null],
    ['event.po_ids', poIds.join(',')],
    ['event.invoice_no', e.invoice_no ?? null],
    ['event.delivery_order_no', e.delivery_order_no ?? null],
    ['event.receive_date', e.receive_date ?? null],
    ['event.invoice_date', e.invoice_date ?? null],
    ['event.checked_by', e.checked_by ?? null],
    ['event.approved_by', e.approved_by ?? null],
    ['event.approved_at', e.approved_at ? timestampText(e.approved_at, 'event.approved_at') : null],
  ]

  const lines = (Array.isArray(e.lines) ? [...e.lines] : []).sort(compareLines)
  lines.forEach((line, i) => {
    const p = `lines.${String(i).padStart(4, '0')}`
    pairs.push([`${p}.id`, line.id ?? null])
    pairs.push([`${p}.line_no`, String(Number(line.line_no))])
    pairs.push([`${p}.item_code`, line.item_code ?? null])
    pairs.push([`${p}.description`, line.description ?? null])
    pairs.push([`${p}.uom`, line.uom ?? null])
    pairs.push([`${p}.unit_price`, normalizeDecimal(line.unit_price, 'unit_price')])
    pairs.push([`${p}.ordered_qty`, normalizeDecimal(line.ordered_qty, 'ordered_qty')])
    pairs.push([`${p}.accepted_qty`, normalizeDecimal(line.accepted_qty, 'accepted_qty')])
    pairs.push([`${p}.note`, line.note ?? null])

    const sources = lineSources(line).map((s) => ({
      ...s,
      // 来源行订购量由服务端按 tj_po_lines 快照补全；此处缺失编码为 null 标记，
      // 不猜 0（本地只做预览哈希，正式哈希以数据库返回为准）
      ordered_qty:
        s.ordered_qty === null || s.ordered_qty === undefined
          ? null
          : normalizeDecimal(s.ordered_qty, 'source.ordered_qty'),
      accepted_qty: normalizeDecimal(s.accepted_qty, 'source.accepted_qty'),
    }))
    sources.sort(compareSources)
    sources.forEach((s, j) => {
      const sp = `${p}.sources.${String(j).padStart(4, '0')}`
      pairs.push([`${sp}.po_header_id`, s.po_header_id ?? null])
      pairs.push([`${sp}.po_line_id`, s.po_line_id ?? null])
      pairs.push([`${sp}.ordered_qty`, s.ordered_qty])
      pairs.push([`${sp}.accepted_qty`, s.accepted_qty])
    })
  })

  return pairs
}

export function canonicalEventPayload(event) {
  return canonicalFromKeyValues(eventKeyValues(event))
}

/** SHA-256(text) → 64 位小写 hex（浏览器/Node 同一 WebCrypto 实现） */
export async function sha256Hex(textValue) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) fail('GR_CRYPTO_MISSING', '当前运行时缺少 WebCrypto（crypto.subtle）')
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(String(textValue)))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function eventPayloadHash(event) {
  return sha256Hex(canonicalEventPayload(event))
}

function normalizeAllocation(raw, idx, lineField) {
  if (!raw || typeof raw !== 'object') {
    fail('GR_VALIDATION', `${lineField}.source_allocations[${idx}] 必须是对象`, { field: lineField })
  }
  if (!isUuid(raw.po_header_id)) {
    fail('GR_VALIDATION', `${lineField}.source_allocations[${idx}].po_header_id 不是 uuid`, { field: lineField })
  }
  if (!isUuid(raw.po_line_id)) {
    fail('GR_VALIDATION', `${lineField}.source_allocations[${idx}].po_line_id 不是 uuid`, { field: lineField })
  }
  return {
    po_header_id: raw.po_header_id.trim(),
    po_line_id: raw.po_line_id.trim(),
    // ordered_qty 由数据库按来源行补全；UI 不必传，传了也会被覆写
    ordered_qty: raw.ordered_qty === undefined || raw.ordered_qty === null
      ? null
      : normalizeDecimal(raw.ordered_qty, `${lineField}.ordered_qty`),
    accepted_qty: normalizeDecimal(raw.accepted_qty, `${lineField}.accepted_qty`),
  }
}

/**
 * 校验并规范化 receipt_save 入参（结构 + 行内一致 + 异常分级）。
 * 数据库侧还会做：来源归属/供应商/item-uom-price 严格对应、累计余额、权限、锁。
 *
 * @returns {{event: object, warnings: string[], exceptions: object[], review_required: boolean}}
 */
export function validateReceiptInput(input) {
  const raw = input ?? {}
  if (!isUuid(raw.id)) fail('GR_VALIDATION', 'id 必须是稳定 uuid', { field: 'id' })

  const revision = Number(raw.revision)
  if (!Number.isInteger(revision) || revision < 0) {
    fail('GR_VALIDATION', 'revision 必须是 >=0 的整数', { field: 'revision' })
  }

  const poIdsRaw = Array.isArray(raw.po_ids) ? raw.po_ids : []
  if (poIdsRaw.length === 0) fail('GR_VALIDATION', 'po_ids 至少一张来源 PO', { field: 'po_ids' })
  const poIds = poIdsRaw.map((x) => {
    if (!isUuid(x)) fail('GR_VALIDATION', `po_ids 含非法 uuid：${String(x)}`, { field: 'po_ids' })
    return String(x).trim()
  })
  if (new Set(poIds).size !== poIds.length) {
    fail('GR_VALIDATION', 'po_ids 有重复', { field: 'po_ids' })
  }

  if (!isDateOnly(raw.receive_date)) {
    fail('GR_VALIDATION', 'receive_date 必须是显式 yyyy-MM-dd（不猜日期）', { field: 'receive_date' })
  }
  const invoiceDate = raw.invoice_date === null || raw.invoice_date === undefined || raw.invoice_date === ''
    ? null
    : raw.invoice_date
  if (invoiceDate !== null && !isDateOnly(invoiceDate)) {
    fail('GR_VALIDATION', 'invoice_date 只能是 yyyy-MM-dd 或 null（不猜、不用收货日期代替）', {
      field: 'invoice_date',
    })
  }

  const rawLines = Array.isArray(raw.lines) ? raw.lines : []
  if (rawLines.length === 0) fail('GR_VALIDATION', 'lines 至少一行', { field: 'lines' })

  const seenLineIds = new Set()
  const seenLineNos = new Set()
  const warnings = []
  const exceptions = []
  const lineOut = []

  rawLines.forEach((l, i) => {
    const field = `lines[${i}]`
    if (!l || typeof l !== 'object') fail('GR_VALIDATION', `${field} 必须是对象`, { field })
    if (!isUuid(l.id)) fail('GR_VALIDATION', `${field}.id 必须是稳定 uuid`, { field })
    const id = String(l.id).trim()
    if (seenLineIds.has(id)) fail('GR_VALIDATION', `line id 重复：${id}`, { field })
    seenLineIds.add(id)

    const lineNo = Number(l.line_no)
    if (!Number.isInteger(lineNo) || lineNo <= 0) {
      fail('GR_VALIDATION', `${field}.line_no 必须是正整数`, { field })
    }
    if (seenLineNos.has(lineNo)) fail('GR_VALIDATION', `line_no 重复：${lineNo}`, { field })
    seenLineNos.add(lineNo)

    const itemCode = requiredText(l.item_code, `${field}.item_code`)
    const uom = textOrNull(l.uom, `${field}.uom`)
    const description = textOrNull(l.description, `${field}.description`)

    const unitPrice = normalizeDecimal(l.unit_price, `${field}.unit_price`)
    const orderedQty = normalizeDecimal(l.ordered_qty, `${field}.ordered_qty`)
    const acceptedQty = normalizeDecimal(l.accepted_qty, `${field}.accepted_qty`)

    const srcRaw = Array.isArray(l.source_allocations) ? l.source_allocations : null
    if (srcRaw === null) {
      fail('GR_VALIDATION', `${field}.source_allocations 必须是数组（空数组=额外行，需审批确认）`, {
        field,
      })
    }
    const allocations = srcRaw.map((s, j) => normalizeAllocation(s, j, `${field}.source_allocations`))

    // 单一来源行时可直接继承行订购量（最常见的整行收货）；多来源由数据库按
    // 各 tj_po_lines 的 coalesce(original_qty, qty) 快照补全，不在这里猜分配
    if (allocations.length === 1 && allocations[0].ordered_qty === null) {
      allocations[0].ordered_qty = orderedQty
    }

    const seenSources = new Set()
    for (const a of allocations) {
      if (seenSources.has(a.po_line_id)) {
        fail('GR_VALIDATION', `${field} 同一来源行重复分配：${a.po_line_id}`, { field })
      }
      seenSources.add(a.po_line_id)
      if (!poIds.includes(a.po_header_id)) {
        fail('GR_VALIDATION', `${field} 来源 PO ${a.po_header_id} 不在 po_ids 内`, { field })
      }
    }

    // 分配必须与 accepted 严格相等（不静默补零、不许“先存着”）。
    // 无来源的额外行（exception extra_line）不走这个等式：它的 accepted 就是
    // “额外收到多少”，没有可分配来源，但审批时必须显式确认。
    if (allocations.length > 0) {
      const allocSumMicros = allocations.reduce(
        (acc, a) => acc + decimalToMicros(a.accepted_qty),
        0n,
      )
      if (allocSumMicros !== decimalToMicros(acceptedQty)) {
        fail(
          'GR_QTY_MISMATCH',
          `${field} accepted_qty=${acceptedQty} 与来源分配合计=${microsToDecimal(allocSumMicros)} 不一致`,
          { field, accepted_qty: acceptedQty, allocation_sum: microsToDecimal(allocSumMicros) },
        )
      }
    }

    const line = {
      id,
      line_no: lineNo,
      item_code: itemCode,
      description,
      uom,
      unit_price: unitPrice,
      ordered_qty: orderedQty,
      accepted_qty: acceptedQty,
      note: textOrNull(l.note, `${field}.note`),
      source_allocations: allocations,
    }

    if (allocations.length === 0) {
      exceptions.push({ code: 'extra_line', line_id: id, detail: '该行没有来源 PO 明细（额外货品）' })
    }
    const acceptedMicros = decimalToMicros(acceptedQty)
    const orderedMicros = decimalToMicros(orderedQty)
    if (acceptedMicros === 0n) {
      warnings.push('zero_receipt')
    } else if (acceptedMicros < orderedMicros) {
      warnings.push('short_receipt')
    } else if (acceptedMicros > orderedMicros) {
      exceptions.push({
        code: 'over_receipt',
        line_id: id,
        detail: `实收 ${acceptedQty} 超过订购 ${orderedQty}`,
      })
    }

    lineOut.push(line)
  })

  lineOut.sort(compareLines)

  const event = {
    id: String(raw.id).trim(),
    revision,
    po_ids: poIds,
    supplier_code: textOrNull(raw.supplier_code, 'supplier_code'),
    supplier_name: textOrNull(raw.supplier_name, 'supplier_name'),
    invoice_no: textOrNull(raw.invoice_no, 'invoice_no'),
    delivery_order_no: textOrNull(raw.delivery_order_no, 'delivery_order_no'),
    receive_date: raw.receive_date.trim(),
    invoice_date: invoiceDate,
    checked_by: textOrNull(raw.checked_by, 'checked_by'),
    note: textOrNull(raw.note, 'note'),
    approved_by: null,
    approved_at: null,
    lines: lineOut,
    warnings: [...new Set(warnings)].sort(),
    exceptions,
    review_required: exceptions.length > 0,
  }

  return {
    event,
    warnings: event.warnings,
    exceptions,
    review_required: exceptions.length > 0,
  }
}
