import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { createPusher } from '../scripts/lib/po-push-core.mjs'
import { computeApprovalSnapshotHash } from '../web/src/lib/core/approved-snapshot.js'

const lines = [
  { line_no: 1, item_code: '00101', description: 'UNIT', uom: 'UNIT', qty: 4, original_qty: 5, accepted_qty: 4, unit_price: 2.5 },
  { line_no: 2, item_code: '00101', description: 'BOX', uom: 'BOX', qty: 1, original_qty: 1, accepted_qty: 1, unit_price: 25 },
]

test('后台 Combined PAD 生成器保留原7列并追加业务日期，但 Push 仍零桥调用', async () => {
  let bridgeCalls = 0
  const p = createPusher({ sbFetch: async () => { throw new Error('unexpected database call') }, bridgeCall: async () => { bridgeCalls++; return { ok: true } } })
  const h = { po_id: 'PO-TEST', po_type: 'combined', website_po_date: '2026-11-09', supplier_code: '001', supplier_name: 'TEST', frozen: true, approval_snapshot_version: 2 }
  h.source_sha256 = await computeApprovalSnapshotHash(h, lines)
  const bytes = await p.buildXlsx(h, lines)
  const w = new ExcelJS.Workbook()
  await w.xlsx.load(bytes)
  const s = w.getWorksheet('PO_Lines')
  assert.deepEqual(s.getRow(1).values.slice(1), ['Supplier Code', 'Supplier Name', 'Item Code', 'Description', 'UOM', 'Qty', 'Unit Price (RM)', 'Website PO Date'])
  assert.deepEqual(s.getRow(2).values.slice(1), ['001', 'TEST', '00101', 'UNIT', 'UNIT', 5, 2.5, '2026-11-09'])
  assert.equal(s.getRow(3).getCell(5).value, 'BOX')
  await assert.rejects(p.pushOne(h), /冻结/)
  assert.equal(bridgeCalls, 0)
})

test('后台 Combined 生成器拒绝缺日期或被篡改的批准快照', async () => {
  const p = createPusher({ sbFetch: async () => [], bridgeCall: async () => { throw new Error('must never write') } })
  const h = { po_id: 'PO-TEST', po_type: 'combined', website_po_date: '2026-11-09', frozen: true, approval_snapshot_version: 2 }
  h.source_sha256 = await computeApprovalSnapshotHash(h, lines)
  await assert.rejects(p.buildXlsx({ ...h, website_po_date: null }, lines), /校验/)
  await assert.rejects(p.buildXlsx(h, [{ ...lines[0], accepted_qty: 99 }, lines[1]]), /校验/)
})
