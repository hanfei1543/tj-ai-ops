// 收货纯核契约测试（红→绿）：十进制、输入校验、异常分级、规范化哈希。
// 这些测试不碰数据库、不发请求；数据库侧同一规范由 SQL 实现，本地 harness 交叉校验。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GR_SCHEMA_VERSION,
  GR_ENVIRONMENT,
  EVENT_STATUSES,
  ReceiptError,
  normalizeDecimal,
  decimalEq,
  validateReceiptInput,
  eventKeyValues,
  canonicalFromKeyValues,
  canonicalEventPayload,
  eventPayloadHash,
} from '../web/src/lib/core/receipt-core.js'

const E1 = '11111111-1111-4111-8111-111111111111'
const E2 = '22222222-2222-4222-8222-222222222222'
const L1 = '33333333-3333-4333-8333-333333333333'
const L2 = '44444444-4444-4444-8444-444444444444'
const P1 = '55555555-5555-4555-8555-555555555555'
const P2 = '66666666-6666-4666-8666-666666666666'

function baseInput(over = {}) {
  return {
    id: E1,
    revision: 0,
    po_ids: [P1],
    invoice_no: 'INV-1',
    delivery_order_no: 'DO-1',
    receive_date: '2026-11-13',
    invoice_date: null,
    checked_by: 'Ah Huat',
    note: '',
    lines: [
      {
        id: L1,
        line_no: 1,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.50',
        ordered_qty: '5',
        accepted_qty: '4',
        note: '短收 1',
        source_allocations: [{ po_header_id: P1, po_line_id: E2, accepted_qty: '4' }],
      },
    ],
    ...over,
  }
}

test('常量：schema/environment 与状态集合固定', () => {
  assert.equal(GR_SCHEMA_VERSION, 'tj.gr.v1')
  assert.equal(GR_ENVIRONMENT, 'preview')
  assert.deepEqual(EVENT_STATUSES, [
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
})

test('十进制：精确、去尾随零、拒绝指数/负数/超 6 位小数/空值', () => {
  assert.equal(normalizeDecimal('12.500'), '12.5')
  assert.equal(normalizeDecimal('0.000'), '0')
  assert.equal(normalizeDecimal('0.125'), '0.125')
  assert.equal(normalizeDecimal(1000), '1000')
  assert.equal(normalizeDecimal('-0.0'), '0')
  assert.equal(normalizeDecimal(' 3 '), '3')
  assert.ok(decimalEq('4.0', '4'))
  assert.ok(!decimalEq('4.01', '4'))

  for (const bad of ['1e3', '1E3', '', '  ', 'abc', '1.2.3', '-1', '0.1234567', null, undefined, NaN, Infinity, {}]) {
    assert.throws(() => normalizeDecimal(bad, 'qty'), ReceiptError, `应拒绝 ${String(bad)}`)
  }
  try {
    normalizeDecimal('0.1234567', 'accepted_qty')
  } catch (e) {
    assert.equal(e.code, 'GR_DECIMAL_SCALE')
  }
})

test('校验：合法输入归一化，数量保持字符串精度', () => {
  const r = validateReceiptInput(baseInput())
  assert.equal(r.event.lines[0].accepted_qty, '4')
  assert.equal(r.event.lines[0].unit_price, '2.5')
  assert.equal(r.event.lines[0].ordered_qty, '5')
  assert.deepEqual(r.event.warnings, ['short_receipt'])
  assert.deepEqual(r.event.exceptions, [])
  assert.equal(r.event.review_required, false)
})

test('校验：accepted 与来源分配不等 → GR_QTY_MISMATCH（不静默补 0）', () => {
  const bad = baseInput()
  bad.lines[0].accepted_qty = '5'
  assert.throws(() => validateReceiptInput(bad), (e) => e.code === 'GR_QTY_MISMATCH')

  const zero = baseInput()
  zero.lines[0].accepted_qty = ''
  assert.throws(() => validateReceiptInput(zero), (e) => e.code === 'GR_INVALID_DECIMAL')
})

test('校验：零收/短收是 warning，超收与无来源行是 exception', () => {
  const zero = baseInput()
  zero.lines[0].accepted_qty = '0'
  zero.lines[0].source_allocations = [{ po_header_id: P1, po_line_id: E2, accepted_qty: '0' }]
  const rz = validateReceiptInput(zero)
  assert.deepEqual(rz.event.warnings, ['zero_receipt'])
  assert.deepEqual(rz.event.exceptions, [])

  const over = baseInput()
  over.lines[0].accepted_qty = '6'
  over.lines[0].source_allocations = [{ po_header_id: P1, po_line_id: E2, accepted_qty: '6' }]
  const ro = validateReceiptInput(over)
  assert.deepEqual(ro.event.exceptions.map((x) => x.code), ['over_receipt'])
  assert.equal(ro.event.review_required, true)

  const extra = baseInput()
  extra.lines[0].source_allocations = []
  // 额外行允许保存（业务上要能记录），但必须作为 exception 在审批时显式确认
  const re = validateReceiptInput(extra)
  assert.deepEqual(re.event.exceptions.map((x) => x.code), ['extra_line'])
  assert.equal(re.review_required, true)
})

test('校验：重复行 id / line_no / 同一来源行重复分配被拒', () => {
  const dupId = baseInput()
  dupId.lines.push({ ...dupId.lines[0], line_no: 2 })
  assert.throws(() => validateReceiptInput(dupId), (e) => e.code === 'GR_VALIDATION')

  const dupNo = baseInput()
  dupNo.lines.push({ ...dupNo.lines[0], id: L2 })
  assert.throws(() => validateReceiptInput(dupNo), (e) => e.code === 'GR_VALIDATION')

  const dupSrc = baseInput()
  dupSrc.lines[0].source_allocations.push({
    po_header_id: P1,
    po_line_id: E2,
    accepted_qty: '0',
  })
  assert.throws(() => validateReceiptInput(dupSrc), (e) => e.code === 'GR_VALIDATION')
})

test('校验：日期/单号/po_ids 硬要求，invoice_date 不猜', () => {
  assert.throws(() => validateReceiptInput(baseInput({ receive_date: null })), (e) => e.code === 'GR_VALIDATION')
  assert.throws(() => validateReceiptInput(baseInput({ receive_date: '13/11/2026' })), (e) => e.code === 'GR_VALIDATION')
  assert.throws(() => validateReceiptInput(baseInput({ receive_date: '2026-02-30' })), (e) => e.code === 'GR_VALIDATION')
  assert.throws(() => validateReceiptInput(baseInput({ po_ids: [] })), (e) => e.code === 'GR_VALIDATION')
  assert.throws(() => validateReceiptInput(baseInput({ po_ids: [P1, P1] })), (e) => e.code === 'GR_VALIDATION')
  assert.throws(() => validateReceiptInput(baseInput({ id: 'not-a-uuid' })), (e) => e.code === 'GR_VALIDATION')
  assert.throws(
    () => validateReceiptInput(baseInput({ revision: -1 })),
    (e) => e.code === 'GR_VALIDATION',
  )
  // invoice_date 未给出 / null 都不允许被悄悄填成收货日期
  const r = validateReceiptInput(baseInput())
  assert.equal(r.event.invoice_date, null)
})

test('规范化文本：键排序、值转义、null/十进制/时间口径', () => {
  const pairs = [
    ['b', 'x\ty'],
    ['a', null],
    ['c', 'a\\b\nc'],
    ['d', '12.500'],
  ]
  const text = canonicalFromKeyValues(pairs)
  assert.equal(text, 'a\t\\N\nb\tx\\ty\nc\ta\\\\b\\nc\nd\t12.500')
})

test('事件规范化：包含供商/单据/日期/全部行与全部来源，顺序稳定', () => {
  const r = validateReceiptInput(baseInput())
  const pairs = eventKeyValues({
    ...r.event,
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
    approved_by: null,
    approved_at: null,
  })
  const map = new Map(pairs)
  assert.equal(map.get('schema'), 'tj.gr.v1')
  assert.equal(map.get('kind'), 'goods_receive')
  assert.equal(map.get('environment'), 'preview')
  assert.equal(map.get('event.supplier_code'), '4000/A01')
  assert.equal(map.get('event.receive_date'), '2026-11-13')
  assert.equal(map.get('event.invoice_date'), null)
  assert.match(canonicalEventPayload({ ...r.event, supplier_code: '4000/A01' }), /^event\.invoice_date\t\\N$/m)
  assert.equal(map.get('lines.0000.accepted_qty'), '4')
  assert.equal(map.get('lines.0000.sources.0000.accepted_qty'), '4')
  assert.equal(map.get('lines.0000.sources.0000.po_line_id'), E2)

  const text = canonicalEventPayload({
    ...r.event,
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
  })
  const keys = text.split('\n').map((l) => l.split('\t')[0])
  assert.deepEqual(keys, [...keys].sort(), '键必须按字节序排序')
})

test('事件哈希：任何实质字段变化都改变 hash', async () => {
  const r = validateReceiptInput(baseInput())
  const ev = { ...r.event, supplier_code: '4000/A01', supplier_name: 'AMFIX' }
  const h1 = await eventPayloadHash(ev)
  assert.match(h1, /^[0-9a-f]{64}$/)

  const h2 = await eventPayloadHash({ ...ev, invoice_no: 'INV-2' })
  assert.notEqual(h1, h2)

  const h3 = await eventPayloadHash({ ...ev, receive_date: '2026-11-14' })
  assert.notEqual(h1, h3)

  const changed = structuredClone(ev)
  changed.lines[0].source_allocations[0].accepted_qty = '3'
  changed.lines[0].accepted_qty = '3'
  const h4 = await eventPayloadHash(changed)
  assert.notEqual(h1, h4)

  // 未变化必须稳定
  assert.equal(h1, await eventPayloadHash(structuredClone(ev)))
})
