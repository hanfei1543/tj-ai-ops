// PO_Lines 列/日期/Qty 口径测试（普通单兼容 + 合并单 fail closed）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PO_LINE_BASE_COLUMNS,
  buildPoLineRows,
  formatWebsitePoDate,
  PoExportError,
} from '../web/src/lib/core/po-lines.js'

const HEADER_STD = {
  po_id: 'PO-000005',
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX TRADING SDN BHD',
  created_at: '2026-11-01T03:04:05.000Z',
  received_at: '2026-11-02T03:04:05.000Z',
  approved_at: '2026-11-03T03:04:05.000Z',
}

const HEADER_COMBINED = { ...HEADER_STD, po_id: 'PO-000003', po_type: 'combined', frozen: true }

const LINES = [
  { item_code: '0030000000003', description: 'SCREW 3', uom: 'UNIT', qty: 10, unit_price: 2.5 },
  { item_code: '0010001000002', description: 'HINGE 1', uom: 'UNIT', qty: 5, unit_price: 1.25, accepted_qty: 4 },
  { item_code: '0020002000002', description: 'PLATE 2', uom: 'PCS', qty: 7, unit_price: 0.9 },
]

test('普通单固定 7 列，与原 PAD 列顺序完全一致且不追加日期列', () => {
  const out = buildPoLineRows(HEADER_STD, LINES, { mode: 'standard' })
  assert.deepEqual(
    out.columns.map((c) => c.header),
    ['Supplier Code', 'Supplier Name', 'Item Code', 'Description', 'UOM', 'Qty', 'Unit Price (RM)'],
  )
  assert.equal(out.columns.length, 7)
  assert.deepEqual(
    out.columns.map((c) => c.header),
    PO_LINE_BASE_COLUMNS.map((c) => c.header),
  )
  for (const row of out.rows) assert.equal('website_po_date' in row, false)
})

test('普通单行序 / code / uom / price 忠实保留，不排序不换算', () => {
  const out = buildPoLineRows(HEADER_STD, LINES, { mode: 'standard' })
  assert.deepEqual(out.rows.map((r) => r.item_code), [
    '0030000000003',
    '0010001000002',
    '0020002000002',
  ])
  assert.deepEqual(out.rows.map((r) => r.uom), ['UNIT', 'UNIT', 'PCS'])
  assert.deepEqual(out.rows.map((r) => r.unit_price), [2.5, 1.25, 0.9])
  assert.deepEqual(out.rows.map((r) => r.qty), [10, 4, 7])
})

test('Qty = accepted_qty ?? qty：0 是有效实收值，不被回退成订购量', () => {
  const out = buildPoLineRows(
    HEADER_STD,
    [{ item_code: 'X1', description: 'D', uom: null, qty: 9, unit_price: 1, accepted_qty: 0 }],
    { mode: 'standard' },
  )
  assert.equal(out.rows[0].qty, 0)
  assert.equal(out.rows[0].uom, '')
})

test('合并单第 8 列为 Website PO Date (yyyy-MM-dd)', () => {
  const out = buildPoLineRows({ ...HEADER_COMBINED, website_po_date: '2026-11-12' }, LINES, {
    mode: 'combined',
  })
  assert.equal(out.columns.length, 8)
  assert.equal(out.columns[7].header, 'Website PO Date')
  assert.equal(out.columns[7].key, 'website_po_date')
  assert.equal(out.websitePoDate, '2026-11-12')
  assert.deepEqual(out.rows.map((r) => r.website_po_date), [
    '2026-11-12',
    '2026-11-12',
    '2026-11-12',
  ])
})

test('合并单缺日期 fail closed：不用 created/received/approved 时间顶替', () => {
  assert.throws(
    () => buildPoLineRows(HEADER_COMBINED, LINES, { mode: 'combined' }),
    (e) => e instanceof PoExportError && e.code === 'MISSING_WEBSITE_PO_DATE',
  )
})

test('合并单空字符串/纯空白日期同样视为缺失', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.throws(
      () => buildPoLineRows({ ...HEADER_COMBINED, website_po_date: v }, LINES, { mode: 'combined' }),
      (e) => e.code === 'MISSING_WEBSITE_PO_DATE',
      `value=${JSON.stringify(v)}`,
    )
  }
})

test('日期格式严格：非 yyyy-MM-dd 或不存在日期都拒绝（不猜时区）', () => {
  assert.equal(formatWebsitePoDate('2026-11-12'), '2026-11-12')
  for (const bad of ['12/11/2026', '2026-11-12T00:00:00Z', '20261112', '2026-2-3', '2026-02-30', 'x']) {
    assert.throws(
      () => formatWebsitePoDate(bad),
      (e) => e.code === 'INVALID_WEBSITE_PO_DATE',
      `bad=${bad}`,
    )
  }
})

test('审阅模式（review）：8 列 + 空日期 + 告警，仅内部样本', () => {
  const out = buildPoLineRows(HEADER_COMBINED, LINES, { mode: 'review' })
  assert.equal(out.columns.length, 8)
  assert.deepEqual(out.warnings, ['MISSING_WEBSITE_PO_DATE'])
  assert.deepEqual(out.rows.map((r) => r.website_po_date), [null, null, null])
})

test('数量/单价非数值时拒绝，不写 NaN 进 PAD 文件', () => {
  assert.throws(
    () => buildPoLineRows(HEADER_STD, [{ item_code: 'X', description: 'D', qty: 'abc', unit_price: 1 }]),
    (e) => e.code === 'INVALID_LINE_QTY',
  )
  assert.throws(
    () => buildPoLineRows(HEADER_STD, [{ item_code: 'X', description: 'D', qty: 1, unit_price: null }]),
    (e) => e.code === 'INVALID_LINE_PRICE',
  )
})

test('未知模式拒绝', () => {
  assert.throws(() => buildPoLineRows(HEADER_STD, LINES, { mode: 'combined2' }), (e) => e.code === 'INVALID_EXPORT_MODE')
})
