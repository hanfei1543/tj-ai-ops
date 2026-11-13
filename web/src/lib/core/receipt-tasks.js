// GR 任务/回调纯核 —— 与数据库 tj_gr_task_* 逻辑同源的状态机与证据比对。
//
// 设计要点（都是踩过的真实的坑）：
//   * 状态只能单调前进：ready < claimed < save_attempted < saved_unverified < verified。
//     迟到/乱序回调不得把状态改回去，也不得跳过“已尝试保存”直接 verified。
//   * save_attempted 一旦写下，就**永远不自动重做**：后续失败只能 needs_review，
//     因为可能已在 IRS 里落了一半，盲目重发就是重复入账。
//   * Bridge 返回 ok=false 一律视为失败（不能因为“有回调”就当成功）。
//   * verified 必须是逐行证据比对（供应商/单据号/IRS 编号/每行编码/UOM/数量/单价），
//     不接受单个布尔标志。任何不一致 → needs_review，并返回 mismatch 清单。
//   * callback 幂等按 (task_id, callback_id, content_sha256)：
//     同 id 同内容 = replay（返回既有结果，不重复写状态）；同 id 不同内容 = 冲突审计拒绝。

import {
  GR_SCHEMA_VERSION,
  GR_ENVIRONMENT,
  canonicalFromKeyValues,
  eventKeyValues,
  normalizeDecimal,
  decimalEq,
  timestampText,
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
  const current = TASK_RANK[status]
  if (current === undefined) {
    // 终态或旁路：不允许任何回调再改
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
    return { status: started ? 'needs_review' : 'failed_unsaved', ok: false, code: started ? 'GR_SAVE_MAYBE_APPLIED' : 'GR_TASK_FAILED' }
  }

  // needs_review：人工挂起，任何未验证状态都可以进入
  return { status: 'needs_review', ok: true }
}

/**
 * callback 幂等判定。
 * @param {{existing?: {contentSha256?: string}|null, fingerprint?: string}} args
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

/** 回调内容指纹输入串：task|event_type|evidence|error（数据库对同一串做 sha256） */
export function contentFingerprint({ taskId, eventType, evidence, error } = {}) {
  return [String(taskId ?? ''), String(eventType ?? ''), stableJson(evidence ?? null), error ? stableJson(error) : 'null'].join('|')
}

function mismatch(kind, field, expected, actual, lineId) {
  return { kind, field, expected, actual, ...(lineId ? { line_id: lineId } : {}) }
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
  const event = payload.event ?? {}
  const scopeLines = payload.scope?.lines ?? []
  const mismatches = []

  if (ev.bridge_ok !== true) mismatches.push(mismatch('bridge', 'bridge_ok', true, ev.bridge_ok))
  if (t.environment !== GR_ENVIRONMENT) {
    mismatches.push(mismatch('environment', 'environment', GR_ENVIRONMENT, t.environment))
  }
  if (t.schema !== GR_SCHEMA_VERSION) {
    mismatches.push(mismatch('schema', 'schema', GR_SCHEMA_VERSION, t.schema))
  }

  const expectedIrs = t.irs_po_no ?? payload.mapping?.irs_po_no ?? null
  if (!expectedIrs || ev.irs_po_no !== expectedIrs) {
    mismatches.push(mismatch('mapping', 'irs_po_no', expectedIrs, ev.irs_po_no))
  }

  if (event.supplier_code !== undefined && ev.supplier_code !== event.supplier_code) {
    mismatches.push(mismatch('header', 'supplier_code', event.supplier_code, ev.supplier_code))
  }
  if (event.invoice_no && ev.invoice_no !== event.invoice_no) {
    mismatches.push(mismatch('header', 'invoice_no', event.invoice_no, ev.invoice_no))
  }
  if (event.delivery_order_no && ev.delivery_order_no !== event.delivery_order_no) {
    mismatches.push(mismatch('header', 'delivery_order_no', event.delivery_order_no, ev.delivery_order_no))
  }
  try {
    if (!timestampText(ev.saved_at, 'saved_at')) {
      mismatches.push(mismatch('header', 'saved_at', 'timestamp', ev.saved_at))
    }
  } catch (e) {
    mismatches.push(mismatch('header', 'saved_at', 'timestamp', ev.saved_at))
  }

  const evLines = Array.isArray(ev.lines) ? ev.lines : []
  if (evLines.length === 0) {
    mismatches.push(mismatch('lines', 'lines', scopeLines.length, 0))
  }
  const byId = new Map()
  for (const l of evLines) {
    const id = l?.line_id
    if (!id) {
      mismatches.push(mismatch('line_missing_id', 'line_id', 'uuid', id))
      continue
    }
    if (byId.has(id)) mismatches.push(mismatch('line_duplicate', 'line_id', id, id, id))
    byId.set(id, l)
  }

  for (const expected of scopeLines) {
    const id = expected.line_id
    const got = byId.get(id)
    if (!got) {
      mismatches.push(mismatch('line_missing', 'line', id, null, id))
      continue
    }
    if (got.item_code !== expected.item_code) {
      mismatches.push(mismatch('line', 'item_code', expected.item_code, got.item_code, id))
    }
    if ((got.uom ?? null) !== (expected.uom ?? null)) {
      mismatches.push(mismatch('line', 'uom', expected.uom ?? null, got.uom ?? null, id))
    }
    if (!decimalEq(got.qty, expected.accepted_qty)) {
      mismatches.push(mismatch('line', 'qty', expected.accepted_qty, got.qty, id))
    }
    if (!decimalEq(got.unit_price, expected.unit_price)) {
      mismatches.push(mismatch('line', 'unit_price', expected.unit_price, got.unit_price, id))
    }
  }

  const expectedIds = new Set(scopeLines.map((l) => l.line_id))
  for (const id of byId.keys()) {
    if (!expectedIds.has(id)) {
      mismatches.push(mismatch('line_unexpected', 'line_id', null, id, id))
    }
  }

  return { ok: mismatches.length === 0, mismatches }
}

/**
 * 任务规范化键值 = 事件全部键 + 任务/映射/切片。事件哈希已覆盖全部行与来源，
 * 任务键再把映射证据与切片绑进来，因此任一变化都会改变任务哈希。
 */
export function taskKeyValues({ event, scope, task, mapping } = {}) {
  const t = task ?? {}
  const pairs = [...eventKeyValues(event)]
  pairs.push(['event_payload_sha256', t.event_payload_sha256 ?? null])
  pairs.push(['task.id', t.id ?? null])
  pairs.push(['task.type', t.task_type ?? 'GOODS_RECEIVE'])
  pairs.push(['task.schema', t.schema ?? GR_SCHEMA_VERSION])
  pairs.push(['task.environment', t.environment ?? GR_ENVIRONMENT])
  pairs.push(['task.po_header_id', t.po_header_id ?? null])
  pairs.push(['mapping.po_header_id', mapping?.po_header_id ?? t.po_header_id ?? null])
  pairs.push(['mapping.irs_po_no', mapping?.irs_po_no ?? null])
  pairs.push(['mapping.evidence_sha256', mapping?.evidence_sha256 ?? null])

  const lines = (scope?.lines ?? []).slice().sort((a, b) => {
    const ka = `${a.line_no ?? ''}|${a.line_id ?? ''}`
    const kb = `${b.line_no ?? ''}|${b.line_no ?? ''}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  lines.forEach((line, i) => {
    const p = `scope.lines.${String(i).padStart(4, '0')}`
    pairs.push([`${p}.line_id`, line.line_id ?? null])
    pairs.push([`${p}.line_no`, line.line_no === undefined ? null : String(Number(line.line_no))])
    pairs.push([`${p}.item_code`, line.item_code ?? null])
    pairs.push([`${p}.uom`, line.uom ?? null])
    pairs.push([`${p}.unit_price`, normalizeDecimal(line.unit_price, 'scope.unit_price')])
    pairs.push([`${p}.accepted_qty`, normalizeDecimal(line.accepted_qty, 'scope.accepted_qty')])
    const sources = (line.sources ?? []).slice().sort((a, b) => {
      const ka = `${a.po_line_id}`
      const kb = `${b.po_line_id}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    sources.forEach((s, j) => {
      const sp = `${p}.sources.${String(j).padStart(4, '0')}`
      pairs.push([`${sp}.po_line_id`, s.po_line_id ?? null])
      pairs.push([`${sp}.ordered_qty`, normalizeDecimal(s.ordered_qty, 'scope.source.ordered_qty')])
      pairs.push([`${sp}.accepted_qty`, normalizeDecimal(s.accepted_qty, 'scope.source.accepted_qty')])
    })
  })
  return pairs
}

export function canonicalTaskPayload(args) {
  return canonicalFromKeyValues(taskKeyValues(args))
}

/** 任务参数自检（创建任务前用；数据库同规则） */
export function assertTaskIdentity({ task, mapping } = {}) {
  const t = task ?? {}
  if (!isUuid(t.id)) fail('GR_VALIDATION', 'task.id 必须是 uuid', { field: 'task.id' })
  if (!isUuid(t.po_header_id)) fail('GR_VALIDATION', 'task.po_header_id 必须是 uuid', { field: 'task.po_header_id' })
  if ((t.task_type ?? 'GOODS_RECEIVE') !== 'GOODS_RECEIVE') {
    fail('GR_VALIDATION', 'task_type 只能是 GOODS_RECEIVE', { field: 'task_type' })
  }
  if ((t.environment ?? GR_ENVIRONMENT) !== GR_ENVIRONMENT) {
    fail('GR_VALIDATION', 'GR 任务只在 preview 环境（真实出队硬禁）', { field: 'environment' })
  }
  if (t.mock_only !== true) fail('GR_VALIDATION', 'GR 任务必须 mock_only=true', { field: 'mock_only' })
  if (!mapping?.irs_po_no) fail('GR_MAPPING_REQUIRED', '缺少已验证 IRS PO 映射', { field: 'irs_po_no' })
  return true
}
