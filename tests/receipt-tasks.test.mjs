// GR 任务状态机 / 回调幂等 / 证据严格比对 / 可离线复算 payload（红→绿）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_STATUSES,
  TASK_RANK,
  nextTaskStatus,
  callbackOutcome,
  verifyEvidence,
  contentFingerprint,
  taskPayloadKeyValues,
  canonicalTaskPayloadFromPayload,
  taskPayloadHash,
} from '../web/src/lib/core/receipt-tasks.js'
import { eventPayloadHash } from '../web/src/lib/core/receipt-core.js'

const TASK = '77777777-7777-4777-8777-777777777777'
const EV = '11111111-1111-4111-8111-111111111111'
const L1 = '33333333-3333-4333-8333-333333333333'
const L2 = '44444444-4444-4444-8444-444444444444'
const P1 = '55555555-5555-4555-8555-555555555555'
const PL1 = '66666666-6666-4666-8666-666666666666'
const PL2 = '88888888-8888-4888-8888-888888888888'
const EVHASH = 'a'.repeat(64)

/** 与 SQL tj_gr_task_payload 同形的完整 payload（自带全部事件行，可离线复算） */
function payload(over = {}) {
  const snapshot = {
    id: EV,
    event_no: 'GR-TEST-1',
    revision: 3,
    status: 'approved',
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
    po_ids: [P1],
    invoice_no: 'INV-1',
    delivery_order_no: 'DO-1',
    receive_date: '2026-11-13',
    invoice_date: '2026-11-10',
    checked_by: 'Ah Huat',
    approved_by: 'a0000000-0000-4000-8000-000000000001',
    approved_at: '2026-11-13T01:02:03Z',
    allow_exceptions: false,
    review_note: null,
    note: 'ok',
    payload_sha256: EVHASH,
    lines: [
      {
        id: L1,
        line_no: 1,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.5',
        ordered_qty: '5',
        accepted_qty: '4',
        note: '短收 1',
        sources: [{ po_header_id: P1, po_line_id: PL1, ordered_qty: '5', accepted_qty: '4' }],
      },
      {
        id: L2,
        line_no: 2,
        item_code: '00102',
        description: 'BOX',
        uom: 'BOX',
        unit_price: '10',
        ordered_qty: '1',
        accepted_qty: '1',
        note: null,
        sources: [{ po_header_id: P1, po_line_id: PL2, ordered_qty: '1', accepted_qty: '1' }],
      },
    ],
  }
  const scopeLines = [
    {
      line_id: L1,
      line_no: 1,
      item_code: '00101',
      description: 'HINGE',
      uom: 'UNIT',
      unit_price: '2.5',
      ordered_qty: '5',
      accepted_qty: '4',
      note: '短收 1',
      sources: [{ po_header_id: P1, po_id: 'PO-000001', po_line_id: PL1, ordered_qty: '5', accepted_qty: '4' }],
    },
    {
      line_id: L2,
      line_no: 2,
      item_code: '00102',
      description: 'BOX',
      uom: 'BOX',
      unit_price: '10',
      ordered_qty: '1',
      accepted_qty: '1',
      note: null,
      sources: [{ po_header_id: P1, po_id: 'PO-000001', po_line_id: PL2, ordered_qty: '1', accepted_qty: '1' }],
    },
  ]
  const p = {
    task: {
      id: TASK,
      type: 'GOODS_RECEIVE',
      schema: 'tj.gr.v1',
      environment: 'preview',
      mock_only: true,
      event_revision: 3,
      po_header_id: P1,
      po_id: 'PO-000001',
      irs_po_no: '5',
    },
    mapping: {
      po_header_id: P1,
      po_id: 'PO-000001',
      irs_po_no: '5',
      irs_invoice_no: 'INV-1',
      evidence_sha256: 'b'.repeat(64),
    },
    event_payload_sha256: EVHASH,
    approved_event_snapshot: snapshot,
    scope: { po_header_id: P1, po_id: 'PO-000001', lines: scopeLines },
    source_refs: [
      {
        receipt_line_id: L1,
        line_no: 1,
        po_header_id: P1,
        po_id: 'PO-000001',
        po_line_id: PL1,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.5',
        ordered_qty: '5',
        accepted_qty: '4',
      },
      {
        receipt_line_id: L2,
        line_no: 2,
        po_header_id: P1,
        po_id: 'PO-000001',
        po_line_id: PL2,
        item_code: '00102',
        description: 'BOX',
        uom: 'BOX',
        unit_price: '10',
        ordered_qty: '1',
        accepted_qty: '1',
      },
    ],
  }
  return { ...p, ...over }
}

function task(over = {}) {
  const p = payload()
  return {
    id: TASK,
    task_type: 'GOODS_RECEIVE',
    schema: 'tj.gr.v1',
    environment: 'preview',
    mock_only: true,
    po_header_id: P1,
    irs_po_no: '5',
    event_payload_sha256: EVHASH,
    payload: p,
    ...over,
  }
}

function evLine(over = {}) {
  return {
    line_id: L1,
    line_no: 1,
    item_code: '00101',
    uom: 'UNIT',
    qty: '4',
    unit_price: '2.5',
    sources: [{ po_line_id: PL1, accepted_qty: '4' }],
    ...over,
  }
}

function evidence(over = {}) {
  return {
    bridge_ok: true,
    irs_po_no: '5',
    irs_grn_no: '7',
    irs_invoice_no: 'INV-1',
    evidence_ref: 'IRS GRN screenshot 2026-11-13',
    supplier_code: '4000/A01',
    invoice_no: 'INV-1',
    delivery_order_no: 'DO-1',
    receive_date: '2026-11-13',
    invoice_date: '2026-11-10',
    saved_at: '2026-11-13T01:03:00Z',
    lines: [evLine(), evLine({ line_id: L2, line_no: 2, item_code: '00102', uom: 'BOX', qty: '1', unit_price: '10', sources: [{ po_line_id: PL2, accepted_qty: '1' }] })],
    ...over,
  }
}

test('可选 Invoice Date 未提供时保持 null，核验不得强迫猜日期', () => {
  const t = task()
  t.payload.approved_event_snapshot.invoice_date = null
  assert.equal(verifyEvidence({ task: t, evidence: evidence({ invoice_date: null }) }).ok, true)
  assert.equal(verifyEvidence({ task: t, evidence: evidence({ invoice_date: '2026-11-13' }) }).ok, false)
})

test('任务状态集合与 rank 单调', () => {
  assert.deepEqual(TASK_STATUSES, [
    'ready',
    'claimed',
    'save_attempted',
    'saved_unverified',
    'verified',
    'failed_unsaved',
    'needs_review',
    'cancelled',
  ])
  assert.deepEqual(
    ['ready', 'claimed', 'save_attempted', 'saved_unverified', 'verified'].map((s) => TASK_RANK[s]),
    [0, 1, 2, 3, 4],
  )
})

test('状态迁移：正常链路 + bridge ok=false 视为失败', () => {
  assert.deepEqual(nextTaskStatus({ status: 'claimed', eventType: 'save_attempted' }), {
    status: 'save_attempted',
    ok: true,
  })
  assert.equal(
    nextTaskStatus({ status: 'save_attempted', eventType: 'saved', bridgeOk: true }).status,
    'saved_unverified',
  )
  assert.equal(
    nextTaskStatus({ status: 'saved_unverified', eventType: 'verified', bridgeOk: true }).status,
    'verified',
  )
  assert.deepEqual(nextTaskStatus({ status: 'save_attempted', eventType: 'saved', bridgeOk: false }), {
    status: 'needs_review',
    ok: false,
    code: 'GR_BRIDGE_NOT_OK',
  })
  assert.equal(
    nextTaskStatus({ status: 'claimed', eventType: 'failed', bridgeOk: false }).status,
    'failed_unsaved',
  )
  // 已开始保存后失败 → 不允许自动重做
  assert.equal(
    nextTaskStatus({ status: 'save_attempted', eventType: 'failed', saveAttempted: true }).status,
    'needs_review',
  )
})

test('状态迁移：乱序/倒退被拒（saved 前必须 save_attempted；verified 终态）', () => {
  assert.deepEqual(nextTaskStatus({ status: 'claimed', eventType: 'saved', bridgeOk: true }), {
    status: 'claimed',
    ok: false,
    code: 'GR_CALLBACK_OUT_OF_ORDER',
  })
  assert.deepEqual(nextTaskStatus({ status: 'save_attempted', eventType: 'verified' }), {
    status: 'save_attempted',
    ok: false,
    code: 'GR_CALLBACK_OUT_OF_ORDER',
  })
  assert.deepEqual(nextTaskStatus({ status: 'verified', eventType: 'verified' }), {
    status: 'verified',
    ok: false,
    code: 'GR_CALLBACK_OUT_OF_ORDER',
  })
})

test('verified 是终态：needs_review/failed 等任何新回调都不得降级', () => {
  for (const eventType of ['save_attempted', 'saved', 'verified', 'failed', 'needs_review']) {
    const r = nextTaskStatus({ status: 'verified', eventType, bridgeOk: true, saveAttempted: true })
    assert.equal(r.status, 'verified', `${eventType} 不得把 verified 降级`)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'GR_CALLBACK_OUT_OF_ORDER')
  }
})

test('needs_review 不因迟到回调自动恢复（只能人工处理）', () => {
  for (const eventType of ['save_attempted', 'saved', 'verified', 'failed']) {
    const r = nextTaskStatus({ status: 'needs_review', eventType, bridgeOk: true, saveAttempted: true })
    assert.equal(r.status, 'needs_review')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'GR_CALLBACK_OUT_OF_ORDER')
  }
})

test('回调幂等：同 id 同内容 replay；同 id 不同内容（含首次已被拒）一律冲突', () => {
  const body = { taskId: 't1', eventType: 'saved', evidence: evidence(), error: null }
  const fp = contentFingerprint(body)
  assert.equal(callbackOutcome({ existing: null }), 'new')
  assert.equal(callbackOutcome({ existing: { contentSha256: fp }, fingerprint: fp }), 'replay')
  assert.equal(
    callbackOutcome({ existing: { contentSha256: fp }, fingerprint: contentFingerprint({ ...body, eventType: 'verified' }) }),
    'conflict',
  )
  // 第一次被拒绝（accepted=false）也必须登记，不能被当作“新回调”再走一遍
  assert.equal(callbackOutcome({ existing: { contentSha256: fp, accepted: false }, fingerprint: fp }), 'replay')
  assert.equal(
    callbackOutcome({ existing: { contentSha256: 'c'.repeat(64), accepted: false }, fingerprint: fp }),
    'conflict',
  )
})

test('证据严格比对：逐行数量/单价/UOM/编码，不得只给布尔', () => {
  const t = task()
  assert.deepEqual(verifyEvidence({ task: t, evidence: evidence() }), { ok: true, mismatches: [] })

  const wrongQty = verifyEvidence({ task: t, evidence: evidence({ lines: [evLine({ qty: '5' }), evidence().lines[1]] }) })
  assert.equal(wrongQty.ok, false)
  assert.ok(wrongQty.mismatches.some((m) => m.field === 'qty'))

  const wrongUom = verifyEvidence({ task: t, evidence: evidence({ lines: [evLine({ uom: 'BOX' }), evidence().lines[1]] }) })
  assert.equal(wrongUom.ok, false)

  const missingLine = verifyEvidence({ task: t, evidence: evidence({ lines: [] }) })
  assert.equal(missingLine.ok, false)
  assert.ok(missingLine.mismatches.some((m) => m.kind === 'line_missing'))

  const extraLine = verifyEvidence({
    task: t,
    evidence: evidence({
      lines: [...evidence().lines, { line_id: '99999999-9999-4999-8999-999999999999', line_no: 9, item_code: '9', uom: 'U', qty: '1', unit_price: '1', sources: [] }],
    }),
  })
  assert.equal(extraLine.ok, false)
  assert.ok(extraLine.mismatches.some((m) => m.kind === 'line_unexpected'))

  assert.equal(verifyEvidence({ task: t, evidence: evidence({ bridge_ok: false }) }).ok, false)
  assert.equal(verifyEvidence({ task: t, evidence: evidence({ irs_po_no: '6' }) }).ok, false)
  assert.equal(verifyEvidence({ task: t, evidence: evidence({ supplier_code: 'X' }) }).ok, false)
  assert.equal(verifyEvidence({ task: t, evidence: evidence({ invoice_no: 'INV-X' }) }).ok, false)
  assert.equal(verifyEvidence({ task: t, evidence: evidence({ saved_at: 'not-a-time' }) }).ok, false)
  assert.equal(verifyEvidence({ task: t, evidence: { bridge_ok: true } }).ok, false)
})

test('证据严格比对：GRN/证据来源/收货日期/发票日期/IRS 发票号必填', () => {
  const t = task()
  for (const [field, value] of [
    ['irs_grn_no', ''],
    ['irs_grn_no', null],
    ['evidence_ref', ''],
    ['saved_at', null],
    ['receive_date', null],
    ['receive_date', '2026-11-14'],
    ['invoice_date', null],
    ['invoice_date', '2026-11-11'],
    ['irs_invoice_no', ''],
    ['irs_invoice_no', 'INV-9'],
  ]) {
    const r = verifyEvidence({ task: t, evidence: evidence({ [field]: value }) })
    assert.equal(r.ok, false, `${field}=${value} 必须拒绝`)
    assert.ok(r.mismatches.some((m) => m.field === field), `${field} 应有 mismatch`)
  }
  // evidence.source 也可作为证据来源
  assert.equal(
    verifyEvidence({ task: t, evidence: evidence({ evidence_ref: null, source: 'screenshot-1.png' }) }).ok,
    true,
  )
})

test('证据严格比对：bridge_ok 必须是 JSON boolean true（"yes" 不算）', () => {
  const t = task()
  for (const bad of ['yes', 'true', 1, '1']) {
    const r = verifyEvidence({ task: t, evidence: evidence({ bridge_ok: bad }) })
    assert.equal(r.ok, false, `bridge_ok=${JSON.stringify(bad)} 必须拒绝`)
    assert.ok(r.mismatches.some((m) => m.field === 'bridge_ok'))
  }
})

test('证据严格比对：line_id 不得重复，source_allocations 必须逐条匹配', () => {
  const t = task()
  const dup = verifyEvidence({
    task: t,
    evidence: evidence({ lines: [evLine(), evLine({ qty: '3' }), evidence().lines[1]] }),
  })
  assert.equal(dup.ok, false)
  assert.ok(dup.mismatches.some((m) => m.kind === 'line_duplicate'))

  const wrongSource = verifyEvidence({
    task: t,
    evidence: evidence({
      lines: [evLine({ sources: [{ po_line_id: PL2, accepted_qty: '4' }] }), evidence().lines[1]],
    }),
  })
  assert.equal(wrongSource.ok, false)
  assert.ok(wrongSource.mismatches.some((m) => m.field === 'source_allocations'))

  const missingSource = verifyEvidence({
    task: t,
    evidence: evidence({ lines: [evLine({ sources: undefined }), evidence().lines[1]] }),
  })
  assert.equal(missingSource.ok, false)
  assert.ok(missingSource.mismatches.some((m) => m.field === 'source_allocations'))

  const wrongSourceQty = verifyEvidence({
    task: t,
    evidence: evidence({
      lines: [evLine({ sources: [{ po_line_id: PL1, accepted_qty: '3' }] }), evidence().lines[1]],
    }),
  })
  assert.equal(wrongSourceQty.ok, false)
})

test('任务规范化 payload 自带全部事件行（可离线复算，不依赖数据库）', async () => {
  const p = payload()
  const text = canonicalTaskPayloadFromPayload(p)
  assert.match(text, /^event\.id\t/m)
  assert.match(text, /^event_payload_sha256\ta{64}$/m)
  assert.match(text, /^task\.po_id\tPO-000001$/m)
  assert.match(text, /^mapping\.irs_invoice_no\tINV-1$/m)
  // 两条事件行与来源都在 canonical 里（旧实现只放 scope 部分行 → 无法复算）
  assert.match(text, /^lines\.0000\.id\t/m)
  assert.match(text, /^lines\.0001\.id\t/m)
  assert.match(text, /^lines\.0000\.sources\.0000\.po_line_id\t/m)
  assert.match(text, /^scope\.lines\.0001\.sources\.0000\.accepted_qty\t1$/m)

  const keys = text.split('\n').map((l) => l.split('\t')[0])
  assert.deepEqual(keys, [...keys].sort(), '键必须按字节序排序')

  const hash = await taskPayloadHash(p)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash, await taskPayloadHash(payload()))
})

test('任务规范化：事件行/来源/映射/scope 任一变化都改变 payload hash', async () => {
  const base = await taskPayloadHash(payload())
  const deep = (mutate) => {
    const p = structuredClone(payload())
    mutate(p)
    return taskPayloadHash(p)
  }
  assert.notEqual(base, await deep((p) => { p.approved_event_snapshot.lines[1].accepted_qty = '2' }))
  assert.notEqual(base, await deep((p) => { p.approved_event_snapshot.lines[0].sources[0].accepted_qty = '3' }))
  assert.notEqual(base, await deep((p) => { p.mapping.irs_po_no = '6' }))
  assert.notEqual(base, await deep((p) => { p.scope.lines[0].accepted_qty = '3' }))
  assert.notEqual(base, await deep((p) => { p.task.po_id = 'PO-000002' }))
})

test('payload 内事件快照能独立重算 event hash（dispatcher 离线校验用）', async () => {
  const p = payload()
  const h = await eventPayloadHash(p.approved_event_snapshot)
  assert.match(h, /^[0-9a-f]{64}$/)
  const p2 = payload({ event_payload_sha256: h })
  p2.approved_event_snapshot.payload_sha256 = h
  const text = canonicalTaskPayloadFromPayload(p2)
  assert.ok(text.includes(`event_payload_sha256\t${h}`))
})

test('taskPayloadKeyValues 不再读取旧 payload.event（必须是完整快照）', () => {
  const p = payload()
  delete p.event
  assert.doesNotThrow(() => canonicalTaskPayloadFromPayload(p))
  const keys = taskPayloadKeyValues(p).map(([k]) => k)
  assert.ok(keys.includes('event.id'))
  assert.ok(keys.includes('lines.0000.id'))
})
