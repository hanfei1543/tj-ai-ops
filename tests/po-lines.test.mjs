// PO_Lines 列/日期/Qty 口径测试（普通单兼容 + 合并单 fail closed）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PO_LINE_BASE_COLUMNS,
  buildPoLineRows,
  formatWebsitePoDate,
  poLineColumns,
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

test('普通单固定 8 列：原 7 列顺序不变，末尾追加 Website PO Date', () => {
  const out = buildPoLineRows({ ...HEADER_STD, website_po_date: '2026-11-13' }, LINES, {
    mode: 'standard',
  })
  assert.deepEqual(
    out.columns.map((c) => c.header),
    [
      'Supplier Code',
      'Supplier Name',
      'Item Code',
      'Description',
      'UOM',
      'Qty',
      'Unit Price (RM)',
      'Website PO Date',
    ],
  )
  assert.equal(out.columns.length, 8)
  // 前 7 列与旧 PAD 口径完全一致（顺序/表头不动）
  assert.deepEqual(
    out.columns.slice(0, 7).map((c) => c.header),
    PO_LINE_BASE_COLUMNS.map((c) => c.header),
  )
  assert.deepEqual(out.rows.map((r) => r.website_po_date), [
    '2026-11-13',
    '2026-11-13',
    '2026-11-13',
  ])
})

test('普通单缺日期 fail closed：不退回 7 列，也不用 created/approved 时间顶替', () => {
  for (const v of [undefined, null, '', '   ']) {
    assert.throws(
      () => buildPoLineRows({ ...HEADER_STD, website_po_date: v }, LINES, { mode: 'standard' }),
      (e) => e instanceof PoExportError && e.code === 'MISSING_WEBSITE_PO_DATE',
      `value=${JSON.stringify(v)}`,
    )
  }
  // 显式回归：header 里明明有 created_at/received_at/approved_at，也不得拿来充数
  assert.throws(
    () =>
      buildPoLineRows(
        {
          ...HEADER_STD,
          created_at: '2026-11-01T03:04:05.000Z',
          received_at: '2026-11-02T03:04:05.000Z',
          approved_at: '2026-11-03T03:04:05.000Z',
        },
        LINES,
        { mode: 'standard' },
      ),
    (e) => e.code === 'MISSING_WEBSITE_PO_DATE',
  )
})

test('普通单非法日期 fail closed（不猜时区/格式）', () => {
  for (const bad of ['13/11/2026', '2026-11-13T00:00:00Z', '2026-02-30']) {
    assert.throws(
      () => buildPoLineRows({ ...HEADER_STD, website_po_date: bad }, LINES, { mode: 'standard' }),
      (e) => e.code === 'INVALID_WEBSITE_PO_DATE',
      `bad=${bad}`,
    )
  }
})

test('legacy-standard：仅显式请求时导出旧 7 列（非 PAD 历史兼容），缺日期也不影响', () => {
  const out = buildPoLineRows(HEADER_STD, LINES, { mode: 'legacy-standard' })
  assert.equal(out.columns.length, 7)
  assert.deepEqual(
    out.columns.map((c) => c.header),
    PO_LINE_BASE_COLUMNS.map((c) => c.header),
  )
  for (const row of out.rows) assert.equal('website_po_date' in row, false)
  assert.equal(out.websitePoDate, null)
  // 必须带内部告警，调用方据此加 INTERNAL NOT FOR PAD 包装（7 列本身不变）
  assert.deepEqual(out.warnings, ['LEGACY_STANDARD_INTERNAL_NOT_FOR_PAD'])

  // 有日期也不会混入第 8 列
  const withDate = buildPoLineRows(
    { ...HEADER_STD, website_po_date: '2026-11-13' },
    LINES,
    { mode: 'legacy-standard' },
  )
  assert.equal(withDate.columns.length, 7)
  assert.equal('website_po_date' in withDate.rows[0], false)
})

test('合并单不得用 standard / legacy 7 列绕过审批（po_type 与 mode 必须自洽）', () => {
  for (const mode of ['standard', 'legacy-standard']) {
    assert.throws(
      () =>
        buildPoLineRows(
          { ...HEADER_COMBINED, website_po_date: '2026-11-12' },
          LINES,
          { mode },
        ),
      (e) => e.code === 'PO_TYPE_MODE_MISMATCH',
      `mode=${mode}`,
    )
  }
  // review 是内部样本，允许合并单使用；正式 combined 仍正常
  const review = buildPoLineRows(
    { ...HEADER_COMBINED, website_po_date: '2026-11-12' },
    LINES,
    { mode: 'review' },
  )
  assert.equal(review.columns.length, 8)
  const combined = buildPoLineRows(
    { ...HEADER_COMBINED, website_po_date: '2026-11-12' },
    LINES,
    { mode: 'combined' },
  )
  assert.equal(combined.websitePoDate, '2026-11-12')
})

test('普通单不得冒充 combined 模式（避免绕过批准快照/合并语义）', () => {
  assert.throws(
    () => buildPoLineRows({ ...HEADER_STD, website_po_date: '2026-11-13' }, LINES, { mode: 'combined' }),
    (e) => e.code === 'PO_TYPE_MODE_MISMATCH',
  )
})

test('默认模式仍是 standard（8 列严格日期），不会静默回退 legacy', () => {
  const out = buildPoLineRows({ ...HEADER_STD, website_po_date: '2026-11-13' }, LINES)
  assert.equal(out.mode, 'standard')
  assert.equal(out.columns.length, 8)
  assert.throws(
    () => buildPoLineRows(HEADER_STD, LINES),
    (e) => e.code === 'MISSING_WEBSITE_PO_DATE',
  )
})

test('列定义：standard/combined/review 为 8 列，legacy-standard 为 7 列', () => {
  assert.equal(poLineColumns('standard').length, 8)
  assert.equal(poLineColumns('combined').length, 8)
  assert.equal(poLineColumns('review').length, 8)
  assert.equal(poLineColumns('legacy-standard').length, 7)
  assert.equal(poLineColumns().length, 8)
})

test('普通单行序 / code / uom / price 忠实保留，不排序不换算', () => {
  const out = buildPoLineRows({ ...HEADER_STD, website_po_date: '2026-11-13' }, LINES, {
    mode: 'standard',
  })
  assert.deepEqual(out.rows.map((r) => r.item_code), [
    '0030000000003',
    '0010001000002',
    '0020002000002',
  ])
  assert.deepEqual(out.rows.map((r) => r.uom), ['UNIT', 'UNIT', 'PCS'])
  assert.deepEqual(out.rows.map((r) => r.unit_price), [2.5, 1.25, 0.9])
  // Qty = original_qty ?? qty：普通单无 original_qty，回退 qty（订购数量）
  assert.deepEqual(out.rows.map((r) => r.qty), [10, 5, 7])
})

test('Qty = original_qty ?? qty：合并单取订购数量，绝不用实收数量顶替', () => {
  const out = buildPoLineRows(
    { ...HEADER_COMBINED, website_po_date: '2026-11-12' },
    [{ item_code: 'X1', description: 'D', uom: 'UNIT', qty: 4, original_qty: 5, accepted_qty: 4, unit_price: 1 }],
    { mode: 'combined' },
  )
  assert.equal(out.rows[0].qty, 5, 'PO Qty 必须是订购数量（与 GR Ordered Qty 一致），不是实收 4')
})

test('original_qty = 0 是有效订购值，不被 ?? 回退成 qty', () => {
  const out = buildPoLineRows(
    { ...HEADER_STD, website_po_date: '2026-11-13' },
    [{ item_code: 'X1', description: 'D', uom: null, qty: 9, original_qty: 0, unit_price: 1 }],
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
  const header = { ...HEADER_STD, website_po_date: '2026-11-13' }
  assert.throws(
    () => buildPoLineRows(header, [{ item_code: 'X', description: 'D', qty: 'abc', unit_price: 1 }]),
    (e) => e.code === 'INVALID_LINE_QTY',
  )
  assert.throws(
    () => buildPoLineRows(header, [{ item_code: 'X', description: 'D', qty: 1, unit_price: null }]),
    (e) => e.code === 'INVALID_LINE_PRICE',
  )
})

test('未知模式拒绝', () => {
  assert.throws(() => buildPoLineRows(HEADER_STD, LINES, { mode: 'combined2' }), (e) => e.code === 'INVALID_EXPORT_MODE')
})
