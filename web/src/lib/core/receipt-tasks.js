// GR 任务/回调纯核 —— 与数据库 tj_gr_task_* 逻辑同源的状态机、证据比对与规范化。
//
// 设计要点（都是踩过的真实的坑）：
//   * 状态只能单调前进：ready < claimed < save_attempted < saved_unverified < verified。
//     迟到/乱序回调不得把状态改回去，也不得跳过“已尝试保存”直接 verified。
//     verified 是终态：needs_review/failed/save_attempted 等任何新回调都不得降级。
//     needs_review 只能人工处理，迟到的 saved/verified 不得自动“恢复”。
//   * save_attempted 一旦写下，就**永远不自动重做**：后续失败只能 needs_review，
//     因为可能已在 IRS 里落了一半，盲目重发就是重复入账。
//   * Bridge 返回 ok=false 一律视为失败（不能因为“有回调”就当成功）；bridge_ok 必须
//     是 JSON boolean true，"yes"/"true" 字符串不算。
//   * verified 必须是逐行证据比对（供应商/单据号/GRN/日期/IRS 编号/每行编码/UOM/数量/
//     单价/来源分配），不接受单个布尔标志。任何不一致 → needs_review + mismatch 清单。
//   * callback 幂等按 (task_id, callback_id, content_sha256)：
//     同 id 同内容 = replay（含首次已被拒绝的 id）；同 id 不同内容 = 冲突审计拒绝。
//   * 任务 payload 自带完整 approved_event_snapshot（全部行+来源）与 source_refs，
//     因此可以**脱离数据库**重算 payload_sha256 / event_payload_sha256（dispatcher 用）。

import {
  GR_SCHEMA_VERSION,
  GR_ENVIRONMENT,
  GR_KIND,
  canonicalFromKeyValues,
  eventKeyValues,
  normalizeDecimal,
  decimalEq,
  timestampText,
  resolveIrsInvoiceNo,
  sha256Hex,
  isUuid,
  fail,
} from './receipt-core.js'

export const TASK_STATUSES = Object.freeze([
  'ready',
  'claimed',
  'save_attempted',
  'saved_unverified',
  'verified',
  'failed_unsaved',
  'needs_review',
  'cancelled',
])

/** 单调 rank：只用于判断乱序/倒退（终态/旁路状态不在 rank 内） */
export const TASK_RANK = Object.freeze({
  ready: 0,
  claimed: 1,
  save_attempted: 2,
  saved_unverified: 3,
  verified: 4,
})

const CALLBACK_EVENT_TYPES = Object.freeze([
  'save_attempted',
  'saved',
  'verified',
  'failed',
  'needs_review',
])

/**
 * 状态迁移判定（纯函数；数据库同规则，见 tj_gr_task_result）。
 * @param {{status: string, eventType: string, bridgeOk?: boolean, saveAttempted?: boolean}} args
 * @returns {{status: string, ok: boolean, code?: string}}
 */
export function nextTaskStatus({ status, eventType, bridgeOk, saveAttempted } = {}) {
  if (!CALLBACK_EVENT_TYPES.includes(eventType)) {
    return { status, ok: false, code: 'GR_VALIDATION' }
  }

  // verified / cancelled 是终态：任何新回调都不许改（包括 needs_review）
  if (status === 'verified' || status === 'cancelled') {
    return { status, ok: false, code: 'GR_CALLBACK_OUT_OF_ORDER' }
  }

  // 人工挂起：只接受重复的 needs_review（幂等），迟到的 saved/verified 不自动恢复
  if (status === 'needs_review') {
    if (eventType === 'needs_review') return { status, ok: true }
    return { status, ok: false, code: 'GR_CALLBACK_OUT_OF_ORDER' }
  }

  const current = TASK_RANK[status]
  if (current === undefined) {
    // failed_unsaved 等旁路：只允许升级为 needs_review
    if (eventType === 'needs_review') return { status: 'needs_review', ok: true }
    return { status, ok: false, code: 'GR_CALLBACK_OUT_OF_ORDER' }
  }

  // save_attempted：可在 ready/claimed 上开始；重复 save_attempted 视为幂等
  if (eventType === 'save_attempted') {
    if (status === 'save_attempted') return { status, ok: true }
    if (status === 'ready' || status === 'claimed') return { status: 'save_attempted', ok: true }
    return { status, ok: false, code: 'GR_CALLBACK_OUT_OF_ORDER' }
  }

  if (eventType === 'saved' || eventType === 'verified') {
    const required = eventType === 'saved' ? 'save_attempted' : 'saved_unverified'
    if (status !== required) {
      return { status, ok: false, code: 'GR_CALLBACK_OUT_OF_ORDER' }
    }
    if (bridgeOk !== true) {
      // 已开始保存但 bridge 不 ok：人工核对，绝不自动重发
      return { status: 'needs_review', ok: false, code: 'GR_BRIDGE_NOT_OK' }
    }
    return { status: eventType === 'saved' ? 'saved_unverified' : 'verified', ok: true }
  }

  if (eventType === 'failed') {
    if (status === 'verified') return { status, ok: false, code: 'GR_CALLBACK_OUT_OF_ORDER' }
    const started = saveAttempted === true || status === 'save_attempted'
    return {
      status: started ? 'needs_review' : 'failed_unsaved',
      ok: false,
      code: started ? 'GR_SAVE_MAYBE_APPLIED' : 'GR_TASK_FAILED',
    }
  }

  // needs_review：人工挂起，任何未验证状态都可以进入
  return { status: 'needs_review', ok: true }
}

/**
 * callback 幂等判定。
 * 同 id 同内容 → replay（即使首次被拒过也不重新处理）；同 id 不同内容 → conflict。
 * @param {{existing?: {contentSha256?: string, accepted?: boolean}|null, fingerprint?: string}} args
 * @returns {'new'|'replay'|'conflict'}
 */
export function callbackOutcome({ existing, fingerprint } = {}) {
  if (!existing) return 'new'
  if (fingerprint && existing.contentSha256 && existing.contentSha256 === fingerprint) return 'replay'
  return 'conflict'
}

/** 稳定 JSON（键递归排序、无空白），用于回调内容指纹；与 SQL jsonb::text 口径一致 */
export function stableJson(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) fail('GR_VALIDATION', '指纹含非有限数值')
  return JSON.stringify(value)
}

/**
 * 回调内容指纹输入串：task|receipt_event|payload_sha256|event_type|evidence|error。
 * 关键校验值（事件 id / 任务哈希）必须进入指纹，避免同 callback id 换 body 绕过冲突检测。
 */
export function contentFingerprint({ taskId, receiptEventId, payloadSha256, eventType, evidence, error } = {}) {
  return [
    String(taskId ?? ''),
    String(receiptEventId ?? ''),
    String(payloadSha256 ?? ''),
    String(eventType ?? ''),
    stableJson(evidence ?? null),
    error ? stableJson(error) : 'null',
  ].join('|')
}

function mismatch(kind, field, expected, actual, lineId) {
  return { kind, field, expected, actual, ...(lineId ? { line_id: lineId } : {}) }
}

function normText(v) {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s.trim() === '' ? null : s
}

function nonBlank(v) {
  const s = normText(v)
  return s === null ? null : s
}

/**
 * verified 证据严格比对（逐行，不是布尔）。
 * @param {{task: object, evidence: object}} args
 * @returns {{ok: boolean, mismatches: object[]}}
 */
export function verifyEvidence({ task, evidence } = {}) {
  const t = task ?? {}
  const ev = evidence ?? {}
  const payload = t.payload ?? {}
  const event = payload.approved_event_snapshot ?? payload.event ?? {}
  const scopeLines = payload.scope?.lines ?? []
  const mismatches = []
  const push = (...args) => mismatches.push(mismatch(...args))

  // bridge_ok 必须是 JSON boolean true（"yes"/"true"/1 一律不算）
  if (ev.bridge_ok !== true) push('bridge', 'bridge_ok', true, ev.bridge_ok)
  if (t.environment !== GR_ENVIRONMENT) {
    push('environment', 'environment', GR_ENVIRONMENT, t.environment)
  }
  if ((t.schema ?? t.schema_version) !== GR_SCHEMA_VERSION) {
    push('schema', 'schema', GR_SCHEMA_VERSION, t.schema ?? t.schema_version)
  }

  const expectedIrs = t.irs_po_no ?? payload.mapping?.irs_po_no ?? null
  if (!expectedIrs || ev.irs_po_no !== expectedIrs) {
    push('mapping', 'irs_po_no', expectedIrs, ev.irs_po_no)
  }

  // IRS GRN 编号必须有值（不能只藏在 evidence 里当备注）
  if (!nonBlank(ev.irs_grn_no)) {
    push('mapping', 'irs_grn_no', 'nonblank', ev.irs_grn_no)
  }

  // 核对证据本身（截图/来源说明 + 保存时间）
  if (!nonBlank(ev.evidence_ref) && !nonBlank(ev.source)) {
    push('evidence', 'evidence_ref', 'nonblank', ev.evidence_ref ?? ev.source)
  }
  try {
    if (!timestampText(ev.saved_at, 'saved_at')) {
      push('header', 'saved_at', 'timestamp', ev.saved_at)
    }
  } catch {
    push('header', 'saved_at', 'timestamp', ev.saved_at)
  }

  // 收货日期必填；发票日期是可选可信字段，未提供时不得猜日期。
  if (!nonBlank(ev.receive_date) || normText(ev.receive_date) !== normText(event.receive_date)) {
    push('header', 'receive_date', event.receive_date, ev.receive_date)
  }
  if (normText(ev.invoice_date) !== normText(event.invoice_date)) {
    push('header', 'invoice_date', event.invoice_date, ev.invoice_date)
  }

  // IRS 发票号：有发票号用发票号，否则用 DO 原字符串（B8 的 selected 值）
  const expectedIrsInvoice = payload.mapping?.irs_invoice_no ?? resolveIrsInvoiceNo(event)
  if (!expectedIrsInvoice || normText(ev.irs_invoice_no) !== normText(expectedIrsInvoice)) {
    push('mapping', 'irs_invoice_no', expectedIrsInvoice, ev.irs_invoice_no)
  }

  if (normText(event.supplier_code) !== null && normText(ev.supplier_code) !== normText(event.supplier_code)) {
    push('header', 'supplier_code', event.supplier_code, ev.supplier_code)
  }
  if (normText(ev.invoice_no) !== normText(event.invoice_no)) {
    push('header', 'invoice_no', event.invoice_no, ev.invoice_no)
  }
  if (normText(ev.delivery_order_no) !== normText(event.delivery_order_no)) {
    push('header', 'delivery_order_no', event.delivery_order_no, ev.delivery_order_no)
  }

  const evLines = Array.isArray(ev.lines) ? ev.lines : []
  if (!Array.isArray(ev.lines)) {
    push('lines', 'lines', 'array', typeof ev.lines)
  }
  if (evLines.length === 0) push('lines', 'lines', scopeLines.length, 0)

  const byId = new Map()
  for (const l of evLines) {
    const id = l?.line_id
    if (!id || !isUuid(id)) {
      push('line_missing_id', 'line_id', 'uuid', id)
      continue
    }
    if (byId.has(id)) push('line_duplicate', 'line_id', id, id, id)
    byId.set(id, l)
  }

  for (const expected of scopeLines) {
    const id = expected.line_id
    const got = byId.get(id)
    if (!got) {
      push('line_missing', 'line', id, null, id)
      continue
    }
    if (Number(got.line_no) !== Number(expected.line_no)) {
      push('line', 'line_no', expected.line_no, got.line_no, id)
    }
    if (got.item_code !== expected.item_code) {
      push('line', 'item_code', expected.item_code, got.item_code, id)
    }
    if (normText(got.uom) !== normText(expected.uom)) {
      push('line', 'uom', expected.uom ?? null, got.uom ?? null, id)
    }
    if (!decimalEq(got.qty, expected.accepted_qty)) {
      push('line', 'qty', expected.accepted_qty, got.qty, id)
    }
    if (!decimalEq(got.unit_price, expected.unit_price)) {
      push('line', 'unit_price', expected.unit_price, got.unit_price, id)
    }

    // 来源分配必须逐条匹配（po_line_id + 数量），不能只给行合计
    const gotSources = got.sources ?? got.source_allocations
    const expSources = expected.sources ?? []
    if (!Array.isArray(gotSources)) {
      push('line', 'source_allocations', expSources.length, null, id)
    } else {
      const exp = new Map(expSources.map((s) => [String(s.po_line_id), s]))
      const seen = new Set()
      let sourcesOk = gotSources.length === expSources.length
      for (const gs of gotSources) {
        const key = String(gs?.po_line_id ?? '')
        const e = exp.get(key)
        if (!e || seen.has(key) || !decimalEq(gs.accepted_qty, e.accepted_qty)) {
          sourcesOk = false
          continue
        }
        seen.add(key)
      }
      if (!sourcesOk || seen.size !== expSources.length) {
        push(
          'line',
          'source_allocations',
          expSources.map((s) => `${s.po_line_id}=${s.accepted_qty}`).join(','),
          Array.isArray(gotSources)
            ? gotSources.map((s) => `${s?.po_line_id}=${s?.accepted_qty}`).join(',')
            : null,
          id,
        )
      }
    }
  }

  const expectedIds = new Set(scopeLines.map((l) => l.line_id))
  for (const id of byId.keys()) {
    if (!expectedIds.has(id)) {
      push('line_unexpected', 'line_id', null, id, id)
    }
  }

  return { ok: mismatches.length === 0, mismatches }
}

function dec(v, field) {
  return v === null || v === undefined ? null : normalizeDecimal(v, field)
}

function booleanText(v) {
  if (v === null || v === undefined) return null
  return v === true ? 'true' : v === false ? 'false' : String(v)
}

/**
 * 任务 payload canonical 键值（**只从 payload 自身计算**，不读数据库）。
 * 覆盖：完整事件快照（header + 全部行 + 全部来源）、task、mapping、scope、source_refs
 * 的关键字段。SQL 侧 tj_preview.tj_gr_task_canonical(jsonb) 逐字节同规则。
 * @returns {Array<[string, string|null]>}
 */
export function taskPayloadKeyValues(payload) {
  const p = payload ?? {}
  const snap = p.approved_event_snapshot ?? {}
  const t = p.task ?? {}
  const m = p.mapping ?? {}
  const scope = p.scope ?? {}

  const poIds = (Array.isArray(snap.po_ids) ? snap.po_ids : []).map((x) => String(x)).sort()
  const pairs = [
    ['schema', GR_SCHEMA_VERSION],
    ['kind', GR_KIND],
    ['environment', GR_ENVIRONMENT],
    ['event.id', snap.id ?? null],
    ['event.event_no', snap.event_no ?? null],
    ['event.revision', snap.revision === null || snap.revision === undefined ? null : String(Number(snap.revision))],
    ['event.supplier_code', snap.supplier_code ?? null],
    ['event.supplier_name', snap.supplier_name ?? null],
    ['event.po_ids', poIds.join(',')],
    ['event.invoice_no', snap.invoice_no ?? null],
    ['event.delivery_order_no', snap.delivery_order_no ?? null],
    ['event.receive_date', snap.receive_date ?? null],
    ['event.invoice_date', snap.invoice_date ?? null],
    ['event.checked_by', snap.checked_by ?? null],
    ['event.approved_by', snap.approved_by ?? null],
    ['event.approved_at', snap.approved_at ? timestampText(snap.approved_at, 'event.approved_at') : null],
    ['event.allow_exceptions', booleanText(snap.allow_exceptions)],
    ['event.review_note', snap.review_note ?? null],
    ['event.note', snap.note ?? null],
    ['event.payload_sha256', snap.payload_sha256 ?? null],
  ]

  const lines = (Array.isArray(snap.lines) ? [...snap.lines] : []).sort((a, b) => {
    const na = Number(a?.line_no)
    const nb = Number(b?.line_no)
    if (na !== nb) return na - nb
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  })
  lines.forEach((line, i) => {
    const key = `lines.${String(i).padStart(4, '0')}`
    pairs.push([`${key}.id`, line.id ?? null])
    pairs.push([`${key}.line_no`, String(Number(line.line_no))])
    pairs.push([`${key}.item_code`, line.item_code ?? null])
    pairs.push([`${key}.description`, line.description ?? null])
    pairs.push([`${key}.uom`, line.uom ?? null])
    pairs.push([`${key}.unit_price`, dec(line.unit_price, 'unit_price')])
    pairs.push([`${key}.ordered_qty`, dec(line.ordered_qty, 'ordered_qty')])
    pairs.push([`${key}.accepted_qty`, dec(line.accepted_qty, 'accepted_qty')])
    pairs.push([`${key}.note`, line.note ?? null])
    const sources = (Array.isArray(line.sources) ? [...line.sources] : []).sort((a, b) => {
      const ka = `${a?.po_header_id}|${a?.po_line_id}`
      const kb = `${b?.po_header_id}|${b?.po_line_id}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    sources.forEach((s, j) => {
      const sp = `${key}.sources.${String(j).padStart(4, '0')}`
      pairs.push([`${sp}.po_header_id`, s.po_header_id ?? null])
      pairs.push([`${sp}.po_line_id`, s.po_line_id ?? null])
      pairs.push([`${sp}.ordered_qty`, dec(s.ordered_qty, 'source.ordered_qty')])
      pairs.push([`${sp}.accepted_qty`, dec(s.accepted_qty, 'source.accepted_qty')])
    })
  })

  pairs.push(['event_payload_sha256', p.event_payload_sha256 ?? null])
  pairs.push(['task.id', t.id ?? null])
  pairs.push(['task.type', t.type ?? t.task_type ?? 'GOODS_RECEIVE'])
  pairs.push(['task.schema', t.schema ?? t.schema_version ?? GR_SCHEMA_VERSION])
  pairs.push(['task.environment', t.environment ?? GR_ENVIRONMENT])
  pairs.push(['task.mock_only', booleanText(t.mock_only)])
  pairs.push([
    'task.event_revision',
    t.event_revision === null || t.event_revision === undefined ? null : String(Number(t.event_revision)),
  ])
  pairs.push(['task.po_header_id', t.po_header_id ?? null])
  pairs.push(['task.po_id', t.po_id ?? null])
  pairs.push(['task.irs_po_no', t.irs_po_no ?? null])

  pairs.push(['mapping.po_header_id', m.po_header_id ?? null])
  pairs.push(['mapping.po_id', m.po_id ?? null])
  pairs.push(['mapping.irs_po_no', m.irs_po_no ?? null])
  pairs.push(['mapping.irs_invoice_no', m.irs_invoice_no ?? null])
  pairs.push(['mapping.evidence_sha256', m.evidence_sha256 ?? null])

  pairs.push(['scope.po_header_id', scope.po_header_id ?? null])
  pairs.push(['scope.po_id', scope.po_id ?? null])
  const scopeLines = (Array.isArray(scope.lines) ? [...scope.lines] : []).sort((a, b) => {
    const na = Number(a?.line_no)
    const nb = Number(b?.line_no)
    if (na !== nb) return na - nb
    return String(a?.line_id ?? '').localeCompare(String(b?.line_id ?? ''))
  })
  scopeLines.forEach((line, i) => {
    const key = `scope.lines.${String(i).padStart(4, '0')}`
    pairs.push([`${key}.line_id`, line.line_id ?? null])
    pairs.push([`${key}.line_no`, String(Number(line.line_no))])
    pairs.push([`${key}.item_code`, line.item_code ?? null])
    pairs.push([`${key}.description`, line.description ?? null])
    pairs.push([`${key}.uom`, line.uom ?? null])
    pairs.push([`${key}.unit_price`, dec(line.unit_price, 'scope.unit_price')])
    pairs.push([`${key}.ordered_qty`, dec(line.ordered_qty, 'scope.ordered_qty')])
    pairs.push([`${key}.accepted_qty`, dec(line.accepted_qty, 'scope.accepted_qty')])
    pairs.push([`${key}.note`, line.note ?? null])
    const sources = (Array.isArray(line.sources) ? [...line.sources] : []).sort((a, b) => {
      const ka = `${a?.po_header_id}|${a?.po_line_id}`
      const kb = `${b?.po_header_id}|${b?.po_line_id}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    sources.forEach((s, j) => {
      const sp = `${key}.sources.${String(j).padStart(4, '0')}`
      pairs.push([`${sp}.po_header_id`, s.po_header_id ?? null])
      pairs.push([`${sp}.po_id`, s.po_id ?? null])
      pairs.push([`${sp}.po_line_id`, s.po_line_id ?? null])
      pairs.push([`${sp}.ordered_qty`, dec(s.ordered_qty, 'scope.source.ordered_qty')])
      pairs.push([`${sp}.accepted_qty`, dec(s.accepted_qty, 'scope.source.accepted_qty')])
    })
  })

  return pairs
}

export function canonicalTaskPayloadFromPayload(payload) {
  return canonicalFromKeyValues(taskPayloadKeyValues(payload))
}

/** 任务 payload SHA-256（浏览器/Node 共用 WebCrypto） */
export async function taskPayloadHash(payload) {
  return sha256Hex(canonicalTaskPayloadFromPayload(payload))
}

/**
 * 兼容旧调用：{payload} 或 {event, scope, task, mapping}。
 * 新代码必须传完整 payload（含 approved_event_snapshot）。
 */
export function canonicalTaskPayload(args) {
  const a = args ?? {}
  if (a.payload) return canonicalTaskPayloadFromPayload(a.payload)
  return canonicalTaskPayloadFromPayload({
    task: a.task,
    mapping: a.mapping,
    scope: a.scope,
    event_payload_sha256: a.task?.event_payload_sha256,
    approved_event_snapshot: a.event,
  })
}

/** 旧 API：事件键 + 任务/映射/切片键（保留给本地对照脚本；不含完整快照） */
export function taskKeyValues({ event, scope, task, mapping } = {}) {
  return taskPayloadKeyValues({
    task,
    mapping,
    scope,
    event_payload_sha256: task?.event_payload_sha256,
    approved_event_snapshot: event,
  })
}

/** 任务参数自检（创建任务前用；数据库同规则） */
export function assertTaskIdentity({ task, mapping } = {}) {
  const t = task ?? {}
  if (!isUuid(t.id)) fail('GR_VALIDATION', 'task.id 必须是 uuid', { field: 'task.id' })
  if (!isUuid(t.po_header_id)) fail('GR_VALIDATION', 'task.po_header_id 必须是 uuid', { field: 'task.po_header_id' })
  if ((t.task_type ?? t.type ?? 'GOODS_RECEIVE') !== 'GOODS_RECEIVE') {
    fail('GR_VALIDATION', 'task_type 只能是 GOODS_RECEIVE', { field: 'task_type' })
  }
  if ((t.environment ?? GR_ENVIRONMENT) !== GR_ENVIRONMENT) {
    fail('GR_VALIDATION', 'GR 任务只在 preview 环境（真实出队硬禁）', { field: 'environment' })
  }
  if (t.mock_only !== true) fail('GR_VALIDATION', 'GR 任务必须 mock_only=true', { field: 'mock_only' })
  if (!mapping?.irs_po_no) fail('GR_MAPPING_REQUIRED', '缺少已验证 IRS PO 映射', { field: 'irs_po_no' })
  return true
}

// 供 dispatcher 复算事件哈希：snapshot 与 eventKeyValues 同形状
export { eventKeyValues }
