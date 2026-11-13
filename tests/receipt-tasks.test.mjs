// GR 任务状态机 / 回调幂等 / 证据严格比对（红→绿）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_STATUSES,
  TASK_RANK,
  nextTaskStatus,
  callbackOutcome,
  verifyEvidence,
  contentFingerprint,
  canonicalTaskPayload,
} from '../web/src/lib/core/receipt-tasks.js'

const L1 = '33333333-3333-4333-8333-333333333333'
const P1 = '55555555-5555-4555-8555-555555555555'

function task() {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    task_type: 'GOODS_RECEIVE',
    schema: 'tj.gr.v1',
    environment: 'preview',
    po_header_id: P1,
    irs_po_no: '5',
    event_payload_sha256: 'a'.repeat(64),
    payload: {
      event: {
        id: '11111111-1111-4111-8111-111111111111',
        supplier_code: '4000/A01',
        supplier_name: 'AMFIX',
        invoice_no: 'INV-1',
        delivery_order_no: 'DO-1',
        receive_date: '2026-11-13',
        invoice_date: null,
        checked_by: 'Ah Huat',
        approved_by: 'approver',
        approved_at: '2026-11-13T01:02:03Z',
      },
      scope: {
        lines: [
          {
            line_id: L1,
            item_code: '00101',
            uom: 'UNIT',
            unit_price: '2.5',
            accepted_qty: '4',
          },
        ],
      },
    },
  }
}

function evidence(over = {}) {
  return {
    bridge_ok: true,
    irs_po_no: '5',
    irs_grn_no: '7',
    supplier_code: '4000/A01',
    invoice_no: 'INV-1',
    delivery_order_no: 'DO-1',
    saved_at: '2026-11-13T01:03:00Z',
    lines: [{ line_id: L1, item_code: '00101', uom: 'UNIT', qty: '4', unit_price: '2.5' }],
    ...over,
  }
}

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

test('回调幂等：同 id 同内容 replay，同 id 不同内容冲突', () => {
  const body = { taskId: 't1', eventType: 'saved', evidence: evidence(), error: null }
  const fp = contentFingerprint(body)
  assert.equal(callbackOutcome({ existing: null }), 'new')
  assert.equal(callbackOutcome({ existing: { contentSha256: fp } , fingerprint: fp }), 'replay')
  assert.equal(
    callbackOutcome({ existing: { contentSha256: fp }, fingerprint: contentFingerprint({ ...body, eventType: 'verified' }) }),
    'conflict',
  )
})

test('证据严格比对：逐行数量/单价/UOM/编码，不得只给布尔', () => {
  const t = task()
  assert.deepEqual(verifyEvidence({ task: t, evidence: evidence() }), { ok: true, mismatches: [] })

  const wrongQty = verifyEvidence({ task: t, evidence: evidence({ lines: [{ ...evidence().lines[0], qty: '5' }] }) })
  assert.equal(wrongQty.ok, false)
  assert.equal(wrongQty.mismatches[0].field, 'qty')

  const wrongUom = verifyEvidence({ task: t, evidence: evidence({ lines: [{ ...evidence().lines[0], uom: 'BOX' }] }) })
  assert.equal(wrongUom.ok, false)

  const missingLine = verifyEvidence({ task: t, evidence: evidence({ lines: [] }) })
  assert.equal(missingLine.ok, false)
  assert.ok(missingLine.mismatches.some((m) => m.kind === 'line_missing'))

  const extraLine = verifyEvidence({
    task: t,
    evidence: evidence({ lines: [...evidence().lines, { line_id: 'x', item_code: '9', uom: 'U', qty: '1', unit_price: '1' }] }),
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

test('任务规范化：事件哈希与映射任意变化都改变任务哈希输入', async () => {
  const t = task()
  const mapping = { po_header_id: P1, irs_po_no: '5', evidence_sha256: 'b'.repeat(64) }
  const a = canonicalTaskPayload({ event: t.payload.event, scope: t.payload.scope, task: t, mapping })
  const b = canonicalTaskPayload({ event: t.payload.event, scope: t.payload.scope, task: t, mapping: { ...mapping, irs_po_no: '6' } })
  const c = canonicalTaskPayload({
    event: t.payload.event,
    scope: t.payload.scope,
    task: { ...t, event_payload_sha256: 'c'.repeat(64) },
    mapping,
  })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^mapping\.irs_po_no\t5$/m)
  assert.match(a, /^scope\.lines\.0000\.accepted_qty\t4$/m)
})
