// normalizeDecimal 精度安全测试：大数 / 6 位小数不得经 Number 舍入。
// 背景：numeric(20,6) 由 PostgREST 以字符串返回，若用 Number→String 归一，
// 会丢精度，导致两个不同的大数被误判为同一内容摘要（同 sha）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDecimal, computePushContentSha256 } from '../scripts/lib/po-push-core.mjs'

test('大数整数：不经过 Number，逐位保留（> 2^53）', () => {
  // 9007199254740993 = 2^53 + 1，经 Number 会舍入成 ...992
  assert.equal(normalizeDecimal('9007199254740993'), '9007199254740993')
})

test('6 位小数长数：逐位保留，不丢尾数', () => {
  assert.equal(normalizeDecimal('123456789012345678.123456'), '123456789012345678.123456')
  assert.equal(normalizeDecimal('0.000001'), '0.000001')
  assert.equal(normalizeDecimal('99999999999999.999999'), '99999999999999.999999')
})

test('尾随零与整数前导零归一（但不改变数值）', () => {
  assert.equal(normalizeDecimal('12.500000'), '12.5')
  assert.equal(normalizeDecimal('0.100000'), '0.1')
  assert.equal(normalizeDecimal('007.50'), '7.5')
  assert.equal(normalizeDecimal('0000'), '0')
  assert.equal(normalizeDecimal('000.000'), '0')
})

test('number 与等价 string 归一结果一致', () => {
  assert.equal(normalizeDecimal(12.5), '12.5')
  assert.equal(normalizeDecimal('12.5'), '12.5')
  assert.equal(normalizeDecimal('12.50'), normalizeDecimal(12.5))
  assert.equal(normalizeDecimal('0.1'), normalizeDecimal(0.1))
})

test('负数与正号', () => {
  assert.equal(normalizeDecimal('-12.50'), '-12.5')
  assert.equal(normalizeDecimal('+12.5'), '12.5')
  assert.equal(normalizeDecimal('-0.000'), '0')
})

test('指数记法展开', () => {
  assert.equal(normalizeDecimal('1e3'), '1000')
  assert.equal(normalizeDecimal('1.5e-3'), '0.0015')
  assert.equal(normalizeDecimal('123e-2'), '1.23')
})

test('非法值返回 null（NaN/Infinity/空/非十进制）', () => {
  assert.equal(normalizeDecimal('NaN'), null)
  assert.equal(normalizeDecimal('Infinity'), null)
  assert.equal(normalizeDecimal('-Infinity'), null)
  assert.equal(normalizeDecimal(''), null)
  assert.equal(normalizeDecimal('   '), null)
  assert.equal(normalizeDecimal('abc'), null)
  assert.equal(normalizeDecimal(null), null)
  assert.equal(normalizeDecimal(undefined), null)
  assert.equal(normalizeDecimal(Number.NaN), null)
  assert.equal(normalizeDecimal(Number.POSITIVE_INFINITY), null)
})

test('内容摘要：大数不同值绝不因 Number 舍入而同 sha', () => {
  // 两个数值不同的大数（仅末位差 1），绝不能被 Number 舍入后得到相同 sha
  const hdr = { po_type: 'standard', supplier_code: 'A', supplier_name: 'B', website_po_date: '2026-11-14' }
  const linesA = [{ item_code: 'X', description: 'D', uom: 'U', qty: '9007199254740993', unit_price: '1.000000' }]
  const linesB = [{ item_code: 'X', description: 'D', uom: 'U', qty: '9007199254740992', unit_price: '1.000000' }]
  assert.notEqual(computePushContentSha256(hdr, linesA), computePushContentSha256(hdr, linesB))
})

test('内容摘要：等价数值（string 尾随零 vs number）得到相同 sha', () => {
  const hdr = { po_type: 'standard', supplier_code: 'A', supplier_name: 'B' }
  const linesString = [{ item_code: 'X', description: 'D', uom: 'U', qty: '12.500000', unit_price: '2.50' }]
  const linesNumber = [{ item_code: 'X', description: 'D', uom: 'U', qty: 12.5, unit_price: 2.5 }]
  assert.equal(computePushContentSha256(hdr, linesString), computePushContentSha256(hdr, linesNumber))
})
