// GR 导出测试：IRS 编号必须有验证证据；不按具体数字判断真伪
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveVerifiedIrsNo,
  buildGrInfoRows,
  buildGrLineRows,
  GR_LINE_COLUMNS,
} from '../web/src/lib/core/gr.js'

test('无编号 → 空 + missing', () => {
  for (const v of [null, undefined, '', '  ']) {
    const r = resolveVerifiedIrsNo({ value: v })
    assert.equal(r.value, '')
    assert.equal(r.verified, false)
    assert.equal(r.status, 'missing')
  }
})

test('有编号但无验证证据 → 一律留空（unverified）', () => {
  const r = resolveVerifiedIrsNo({ value: '5' })
  assert.equal(r.value, '')
  assert.equal(r.status, 'unverified')
  assert.match(r.reason, /verified_at/)
})

test('只有 verified_at 没有 verified_by → 留空', () => {
  const r = resolveVerifiedIrsNo({ value: 'GRN-777', verifiedAt: '2026-11-12T01:00:00Z' })
  assert.equal(r.value, '')
  assert.equal(r.status, 'unverified')
})

test('证据齐全才导出，且编号内容原样保留（"5" 不是无效值）', () => {
  const r = resolveVerifiedIrsNo({
    value: '5',
    verifiedAt: '2026-11-12T01:00:00Z',
    verifiedBy: 'Ah Huat',
  })
  assert.equal(r.verified, true)
  assert.equal(r.value, '5')
  assert.equal(r.status, 'verified')
})

test('verified_at 非法时间同样视为未验证', () => {
  const r = resolveVerifiedIrsNo({
    value: 'PO-IRS-1',
    verifiedAt: 'not-a-time',
    verifiedBy: 'Ah Huat',
  })
  assert.equal(r.value, '')
  assert.equal(r.status, 'unverified')
})

test('GR_Info 保留原 16 个字段顺序并追加验证状态与网站日期', () => {
  const rows = buildGrInfoRows({
    po_id: 'PO-000003',
    po_type: 'combined',
    po_revision: 2,
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
    frozen: true,
    erp_status: 'none',
    irs_po_no: '5',
    irs_grn_no: '5',
    website_po_date: '2026-11-12',
  })
  const map = new Map(rows)
  assert.equal(rows[0][0], 'receipt_event_id')
  assert.equal(rows[13][0], 'erp_status')
  assert.equal(rows[14][0], 'irs_po_no')
  assert.equal(rows[15][0], 'irs_grn_no')
  // 库里是 5 但没有验证证据 → 导出空
  assert.equal(map.get('irs_po_no'), '')
  assert.equal(map.get('irs_grn_no'), '')
  assert.equal(map.get('irs_po_no_status'), 'unverified')
  assert.equal(map.get('irs_grn_no_status'), 'unverified')
  assert.equal(map.get('website_po_date'), '2026-11-12')
  assert.match(map.get('export_purpose'), /no IRS push\/post/)
})

test('GR_Info：验证通过时输出编号与证据', () => {
  const map = new Map(
    buildGrInfoRows({
      po_id: 'PO-000003',
      irs_grn_no: '5',
      irs_grn_no_verified_at: '2026-11-12T01:00:00Z',
      irs_grn_no_verified_by: 'Ah Huat',
    }),
  )
  assert.equal(map.get('irs_grn_no'), '5')
  assert.equal(map.get('irs_grn_no_status'), 'verified')
  assert.equal(map.get('irs_grn_no_verified_by'), 'Ah Huat')
  assert.equal(map.get('irs_po_no'), '')
})

test('GR_Lines 保留订购/实收/行序/来源', () => {
  const rows = buildGrLineRows([
    { line_no: 1, item_code: '0030000000003', description: 'D3', uom: 'UNIT', qty: 4, unit_price: 2.5, original_qty: 5, accepted_qty: 4, note: '短缺 1', source_refs: [{ po_number: 'PO-000001', line_id: 'l1' }, { po_number: 'PO-000002', line_id: 'l2' }] },
    { line_no: 2, item_code: '0010001000002', description: 'D1', uom: 'PCS', qty: 3, unit_price: 1 },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ordered_qty, 5)
  assert.equal(rows[0].accepted_qty, 4)
  assert.equal(rows[0].source_pos, 'PO-000001, PO-000002')
  assert.equal(rows[1].ordered_qty, 3)
  assert.equal(rows[1].accepted_qty, 3)
  assert.equal(rows[1].source_pos, '')
  assert.equal(GR_LINE_COLUMNS.length, 10)
})

test('GR_Info 批准快照字段：v2 + 显式状态；缺版本标 legacy；普通单 not_applicable', () => {
  const verified = new Map(
    buildGrInfoRows({
      po_id: 'PO-000006',
      po_type: 'combined',
      website_po_date: '2026-11-09',
      approval_snapshot_version: 2,
      approval_snapshot_status: 'verified',
      frozen: true,
    }),
  )
  assert.equal(verified.get('approval_snapshot_version'), 2)
  assert.equal(verified.get('approval_snapshot_status'), 'verified')

  const legacy = new Map(
    buildGrInfoRows({ po_id: 'PO-000003', po_type: 'combined', frozen: true }),
  )
  assert.equal(legacy.get('approval_snapshot_version'), '')
  assert.equal(legacy.get('approval_snapshot_status'), 'legacy_unverified')

  const standard = new Map(
    buildGrInfoRows({ po_id: 'PO-000005', po_type: 'standard', source_sha256: 'x' }),
  )
  assert.equal(standard.get('approval_snapshot_status'), 'not_applicable')

  const unchecked = new Map(
    buildGrInfoRows({ po_id: 'PO-000007', po_type: 'combined', approval_snapshot_version: 2 }),
  )
  assert.equal(unchecked.get('approval_snapshot_status'), 'unchecked')
})
