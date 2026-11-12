// 合并规则测试：不同 UOM / 不同价格不合并，顺序稳定，accepted 默认值
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCombinedLines, combineLineKey } from '../web/src/lib/core/combine.js'

const po1 = {
  id: 'uuid-1',
  po_id: 'PO-000001',
  lines: [
    { id: 'l1', item_code: 'A', description: 'ITEM A', uom: 'UNIT', qty: 5, unit_price: 1.5 },
    { id: 'l2', item_code: 'B', description: 'ITEM B', uom: 'PCS', qty: 2, unit_price: 3 },
    { id: 'l3', item_code: 'A', description: 'ITEM A', uom: 'UNIT', qty: 1, unit_price: 1.5 },
  ],
}
const po2 = {
  id: 'uuid-2',
  po_id: 'PO-000002',
  lines: [
    { id: 'm1', item_code: 'A', description: 'ITEM A', uom: 'UNIT', qty: 4, unit_price: 1.5 },
    { id: 'm2', item_code: 'A', description: 'ITEM A', uom: 'BOX', qty: 3, unit_price: 1.5 },
    { id: 'm3', item_code: 'A', description: 'ITEM A', uom: 'UNIT', qty: 2, unit_price: 1.6 },
    { id: 'm4', item_code: 'B', description: 'ITEM B', uom: 'PCS', qty: 6, unit_price: 3 },
  ],
}

test('相同 item_code + uom + 单价跨单合并数量，accepted 默认等于累计订购', () => {
  const out = buildCombinedLines([po1, po2])
  const a = out.filter((l) => l.item_code === 'A' && l.uom === 'UNIT' && l.unit_price === 1.5)
  assert.equal(a.length, 1)
  assert.equal(a[0].ordered_qty, 10) // 5 + 1 + 4
  assert.equal(a[0].accepted_qty, 10)
  assert.equal(a[0].source_refs.length, 3)
  assert.deepEqual(
    a[0].source_refs.map((r) => `${r.po_number}:${r.line_id}:${r.qty}`),
    ['PO-000001:l1:5', 'PO-000001:l3:1', 'PO-000002:m1:4'],
  )
})

test('不同 UOM / 不同单价 / 不同 item 都不合并', () => {
  const out = buildCombinedLines([po1, po2])
  assert.equal(out.length, 4) // A/UNIT/1.5, B/PCS/3, A/BOX/1.5, A/UNIT/1.6
  const keys = out.map(combineLineKey)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(
    out.map((l) => `${l.item_code}|${l.uom}|${l.unit_price}`),
    ['A|UNIT|1.5', 'B|PCS|3', 'A|BOX|1.5', 'A|UNIT|1.6'],
  )
})

test('组顺序 = 首次出现顺序，不按 code 重排', () => {
  const out = buildCombinedLines([po1, po2])
  assert.deepEqual(out.map((l) => l.item_code), ['A', 'B', 'A', 'A'])
  // B 在来源单里数量被合并但仍保持其在首次出现后的位置
  assert.equal(out[1].ordered_qty, 8)
})

test('description / 单价取首次出现行，不做智能取舍', () => {
  const out = buildCombinedLines([
    { id: 'p1', po_id: 'PO-000010', lines: [{ id: 'x', item_code: 'Z', description: 'FIRST', uom: 'UNIT', qty: 1, unit_price: 9 }] },
    { id: 'p2', po_id: 'PO-000011', lines: [{ id: 'y', item_code: 'Z', description: 'SECOND', uom: 'UNIT', qty: 2, unit_price: 9 }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].description, 'FIRST')
  assert.equal(out[0].unit_price, 9)
  assert.equal(out[0].ordered_qty, 3)
})

test('uom 为 null 与空串视为同组，但不与带单位组混同', () => {
  const out = buildCombinedLines([
    { id: 'p1', po_id: 'PO-000020', lines: [{ id: 'a', item_code: 'Q', description: 'Q', uom: null, qty: 1, unit_price: 1 }] },
    { id: 'p2', po_id: 'PO-000021', lines: [{ id: 'b', item_code: 'Q', description: 'Q', uom: '', qty: 2, unit_price: 1 }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].ordered_qty, 3)
})

test('空输入安全', () => {
  assert.deepEqual(buildCombinedLines([]), [])
  assert.deepEqual(buildCombinedLines(undefined), [])
})
