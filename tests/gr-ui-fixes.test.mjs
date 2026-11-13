// 一轮接线修复的行为回归（真实调用 core 逻辑，不是只查页面字符串）：
//   * Invoice-only / DO-only 都能提交；两号全空只能存草稿；号码原样保存（trim 只判空）
//   * 已放行/已建任务/verified 的事件不可重做（approve/submit/release/edit）
//   * 合并来源 = standard + confirmed + frozen=false；receipt 来源必须是原始 PO 行
//   * Preview PO 保存全程 decimal string（不 parseFloat）；po_get 为唯一读入口
//   * 映射证据必须可核查 + 显式确认，不能只写「页面登记」+ 时间
//   * 非首批默认不预填满额；草稿会话可从服务端恢复 id/revision
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMappingEvidence,
  buildReceiptSavePayload,
  createReceiptDraftSession,
  documentNumbersPresent,
  isCombinableSource,
  isReceivablePoStatus,
  receiptRedoLock,
  validateReceiptForm,
} from '../web/src/lib/core/gr-form.js'
import {
  buildReceiptAllocations,
  sumAllocationQty,
  toPoLineInputs,
} from '../web/src/lib/core/po-input.js'
import { buildCombinedLines } from '../web/src/lib/core/combine.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const UUID3 = '33333333-3333-4333-8333-333333333333'

function header(over = {}) {
  return {
    invoice_no: '',
    delivery_order_no: '',
    receive_date: '2026-11-13',
    invoice_date: null,
    checked_by: 'Ms Toh',
    note: '',
    ...over,
  }
}

function line(over = {}) {
  return {
    id: UUID,
    line_no: 1,
    item_code: '0030000000003',
    description: 'D3',
    uom: 'UNIT',
    unit_price: '2.50',
    ordered_qty: '5',
    accepted_qty: '4',
    note: '',
    source_allocations: [{ po_header_id: UUID2, po_line_id: UUID3, accepted_qty: '4' }],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 2. Invoice-only / DO-only
// ---------------------------------------------------------------------------

test('发票或送货单任一项即可提交；两项全空只能保存草稿', () => {
  const invoiceOnly = validateReceiptForm({ header: header({ invoice_no: 'INV-9' }), lines: [line()] })
  assert.equal(invoiceOnly.ok, true)
  assert.equal(invoiceOnly.canSubmit, true)
  assert.equal(invoiceOnly.has_document_number, true)

  const doOnly = validateReceiptForm({ header: header({ delivery_order_no: 'D-1' }), lines: [line()] })
  assert.equal(doOnly.ok, true)
  assert.equal(doOnly.canSubmit, true)

  const neither = validateReceiptForm({ header: header(), lines: [line()] })
  assert.equal(neither.ok, true, '两号全空不是结构错误')
  assert.equal(neither.canSaveDraft, true, '两号全空仍可保存草稿')
  assert.equal(neither.canSubmit, false)
  assert.match(neither.submit_blocked_reason, /至少填写一项/)

  // 只有空白字符等于空
  assert.equal(documentNumbersPresent(header({ invoice_no: '   ', delivery_order_no: '  ' })), false)
})

test('发票/送货单号原样保存：trim 只用于判空，不改写号码', () => {
  const payload = buildReceiptSavePayload({
    receiptId: UUID,
    revision: 0,
    header: header({ invoice_no: '  INV-0007 ', delivery_order_no: ' D-021660 ' }),
    lines: [line()],
  })
  assert.equal(payload.invoice_no, '  INV-0007 ')
  assert.equal(payload.delivery_order_no, ' D-021660 ')
})

// ---------------------------------------------------------------------------
// 4. 已放行/verified 不可重做
// ---------------------------------------------------------------------------

test('已放行（released_at）或已建任务的事件锁定，verified 为终态', () => {
  assert.equal(receiptRedoLock({ status: 'draft', released_at: null, tasks: [] }), null)
  assert.equal(receiptRedoLock({ status: 'submitted' }), null)
  assert.equal(receiptRedoLock(null), null)

  const released = receiptRedoLock({ status: 'approved', released_at: '2026-11-13T01:00:00Z' })
  assert.equal(released.code, 'RELEASED_LOCKED')
  assert.match(released.message, /人工核对/)

  const withTasks = receiptRedoLock({ status: 'needs_review', released_at: null, tasks: [{ id: 't1' }] })
  assert.equal(withTasks.code, 'RELEASED_LOCKED', 'needs_review 但已建任务也不能重做')

  const verified = receiptRedoLock({ status: 'verified', released_at: null, tasks: [{ id: 't1' }] })
  assert.equal(verified.code, 'VERIFIED_TERMINAL')
  assert.equal(verified.terminal, true)
})

// ---------------------------------------------------------------------------
// 6. 合并来源 / 收货来源
// ---------------------------------------------------------------------------

test('合并来源只接受 standard + confirmed + frozen=false', () => {
  assert.equal(isCombinableSource({ po_type: 'standard', status: 'confirmed', frozen: false }), true)
  assert.equal(isCombinableSource({ po_type: 'standard', status: 'confirmed', frozen: true }), false)
  assert.equal(isCombinableSource({ po_type: 'combined', status: 'confirmed', frozen: true }), false)
  assert.equal(isCombinableSource({ po_type: 'standard', status: 'exported', frozen: false }), false)
  assert.equal(isCombinableSource({ po_type: 'standard', status: 'combining', frozen: false }), false)
  assert.equal(isCombinableSource(null), false)
})

test('可收货状态包含 combined 原标准单与生产 exported 普通单', () => {
  for (const st of ['confirmed', 'combined', 'exported']) {
    assert.equal(isReceivablePoStatus(st), true, st)
  }
  for (const st of ['pending_approval', 'combining', 'draft', 'pending_push']) {
    assert.equal(isReceivablePoStatus(st), false, st)
  }
})

test('合并单收货必须展开原始 source_refs，不把合并行 id 当来源', () => {
  const po = { id: UUID, po_type: 'combined' }
  const combinedLine = {
    id: UUID2,
    qty: '8',
    source_refs: [
      { po_id: UUID2, po_line_id: 'ignored', line_id: UUID2, po_number: 'PO-1', qty: '5' },
      { po_id: UUID3, po_line_id: 'ignored', line_id: UUID3, po_number: 'PO-2', qty: '3' },
    ],
  }
  const allocs = buildReceiptAllocations(po, combinedLine)
  assert.deepEqual(allocs, [
    { po_header_id: UUID2, po_line_id: UUID2, accepted_qty: '5' },
    { po_header_id: UUID3, po_line_id: UUID3, accepted_qty: '3' },
  ])
  assert.equal(sumAllocationQty(allocs), '8')

  // 来源缺失（额外行）fail closed：绝不回退成合并单自身 id / 合成行 id
  assert.deepEqual(buildReceiptAllocations(po, { id: UUID2, qty: '8', source_refs: [] }), [])
  assert.deepEqual(
    buildReceiptAllocations(po, {
      id: UUID2,
      qty: '8',
      source_refs: [{ po_id: '', line_id: UUID3, qty: '1' }],
    }),
    [],
  )

  // 非首批：不预填满额
  const blank = buildReceiptAllocations(po, combinedLine, { defaultAccepted: false })
  assert.deepEqual(blank.map((a) => a.accepted_qty), ['', ''])
  assert.equal(sumAllocationQty(blank), '')
})

test('普通单来源 = 该 PO 行；零实收不会被静默改成满额', () => {
  const po = { id: UUID, po_type: 'standard' }
  const l = { id: UUID2, qty: '5', original_qty: '5' }
  assert.deepEqual(buildReceiptAllocations(po, l), [
    { po_header_id: UUID, po_line_id: UUID2, accepted_qty: '5' },
  ])
  const zero = buildReceiptAllocations(po, l, { defaultAccepted: true })
  zero[0].accepted_qty = '0'
  assert.equal(sumAllocationQty(zero), '0')
})

// ---------------------------------------------------------------------------
// 5. PO 精度 / po_get 接线
// ---------------------------------------------------------------------------

test('PO 保存输入保持 decimal string：0.100000 / 1.234567 不被 Number 改写', () => {
  const out = toPoLineInputs([
    { id: UUID, item_code: 'A', description: 'A', uom: 'UNIT', qty: '0.100000', unit_price: '1.234567' },
    { item_code: 'B', description: 'B', uom: null, qty: '2', unit_price: '0' },
  ])
  assert.equal(out[0].qty, '0.100000')
  assert.equal(out[0].unit_price, '1.234567')
  assert.equal(out[1].line_no, 2)
  assert.equal('id' in out[1], false, '新行不带 id')

  assert.throws(() => toPoLineInputs([{ item_code: 'A', qty: '0', unit_price: '1' }]), /必须大于 0/)
  assert.throws(() => toPoLineInputs([{ item_code: 'A', qty: '2', unit_price: '-1' }]), /不能为负数/)
  assert.throws(() => toPoLineInputs([{ item_code: 'A', qty: '1e3', unit_price: '1' }]), /不是有效数字/)
  assert.throws(() => toPoLineInputs([]), /至少加入一个商品/)
})

test('Preview getPo 走 po_get；生产旧读取仍在；旧路径显式转 number', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /poGet\(id\)/)
  assert.match(api, /if \(IS_PREVIEW_SCHEMA\) \{[\s\S]{0,200}poGet/)
  assert.match(api, /po_get 未返回 lines 数组/)
  // 旧生产路径（旧表/Excel）仍显式转 number，而不是隐式 parseFloat
  assert.match(api, /legacyNumber\(l\.qty, '数量'\)/)
  assert.match(api, /legacyNumber\(l\.unit_price, '单价'\)/)
  assert.equal(/parseFloat\(l\.unitPrice\)/.test(read('web/src/pages/TjPoSystemPage.tsx')), false)
  assert.match(read('web/src/pages/TjPoSystemPage.tsx'), /toPoLineInputs/)
})

// ---------------------------------------------------------------------------
// 8. 映射证据
// ---------------------------------------------------------------------------

test('映射证据必须可核查 + 明确确认；自动时间不能单独当证据', () => {
  const now = () => new Date('2026-11-13T02:03:04Z')
  assert.throws(
    () => buildMappingEvidence({ checkedBy: 'Ah Huat', evidenceRef: '', method: 'IRS 查询', confirmed: true, now }),
    /可核查证据/,
  )
  assert.throws(
    () => buildMappingEvidence({ checkedBy: 'Ah Huat', evidenceRef: 'shot-1', method: '', confirmed: true, now }),
    /核验方式/,
  )
  assert.throws(
    () => buildMappingEvidence({ checkedBy: 'Ah Huat', evidenceRef: 'shot-1', method: 'IRS 查询', confirmed: false, now }),
    /勾选/,
  )
  const ev = buildMappingEvidence({
    checkedBy: 'Ah Huat',
    evidenceRef: 'IRS 截图 20261113-01',
    method: 'IRS 系统查询',
    confirmed: true,
    now,
  })
  assert.deepEqual(ev, {
    checked_by: 'Ah Huat',
    checked_at: '2026-11-13T02:03:04.000Z',
    evidence_ref: 'IRS 截图 20261113-01',
    method: 'IRS 系统查询',
    confirmed: true,
  })
  assert.equal(JSON.stringify(ev).includes('页面登记'), false)
})

// ---------------------------------------------------------------------------
// 6. 合并 source_refs 完整/精确
// ---------------------------------------------------------------------------

test('合并保留全部来源 refs 且 qty 原文；缺来源 id fail closed', () => {
  const out = buildCombinedLines([
    {
      id: UUID,
      po_id: 'PO-000001',
      lines: [
        { id: UUID, item_code: 'A', description: 'A', uom: 'UNIT', qty: '0.1', unit_price: '1.5' },
        { id: UUID2, item_code: 'A', description: 'A', uom: 'UNIT', qty: '0.2', unit_price: '1.5' },
      ],
    },
    {
      id: UUID2,
      po_id: 'PO-000002',
      lines: [{ id: UUID3, item_code: 'A', description: 'A', uom: 'UNIT', qty: '3', unit_price: '1.5' }],
    },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].source_refs.length, 3, '所有来源行都要保留')
  assert.deepEqual(out[0].source_refs.map((r) => r.qty), ['0.1', '0.2', '3'])
  assert.deepEqual(out[0].source_refs.map((r) => `${r.po_number}:${r.line_id}`), [
    `PO-000001:${UUID}`,
    `PO-000001:${UUID2}`,
    `PO-000002:${UUID3}`,
  ])
  assert.equal(out[0].ordered_qty, 3.3, 'decimal 累加避免浮点残差')
})

test('合并来源缺 PO/行 id 直接失败（来源无法追溯）', () => {
  assert.throws(
    () => buildCombinedLines([{ id: '', po_id: 'PO-1', lines: [{ id: UUID, item_code: 'A', qty: 1, unit_price: 1 }] }]),
    /来源无法追溯/,
  )
  assert.throws(
    () => buildCombinedLines([{ id: UUID, po_id: 'PO-1', lines: [{ id: '', item_code: 'A', qty: 1, unit_price: 1 }] }]),
    /来源无法追溯/,
  )
})

// ---------------------------------------------------------------------------
// 9. 草稿会话恢复
// ---------------------------------------------------------------------------

test('草稿会话可采纳服务端已有草稿 id/revision 后继续保存', () => {
  const map = new Map()
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  const s = createReceiptDraftSession({ storage, poIds: [UUID], newId: () => 'local-draft' })
  assert.equal(s.receiptId, 'local-draft')
  s.adoptDraft({ receipt_id: 'server-draft', revision: 4 })
  assert.equal(s.receiptId, 'server-draft')
  assert.equal(s.revision, 4)
  const saved = JSON.parse(storage.getItem(s.key))
  assert.equal(saved.receipt_id, 'server-draft')
  assert.equal(saved.revision, 4)
})

// ---------------------------------------------------------------------------
// 1/3/7. 页面接线守卫（补充行为测试）
// ---------------------------------------------------------------------------

test('Preview 普通 PO 路由全部套 PreviewAuthGate；生产仍直接渲染', () => {
  const app = read('web/src/App.tsx')
  for (const route of ['/tj-po-system', '/tj-po-system/new', '/tj-po-system/combine', '/tj-po-system/items', '/tj-po-system/:poId']) {
    const pattern = new RegExp(`path="${route.replace(/[/:]/g, (m) => (m === ':' ? ':' : '/'))}"[\\s\\S]{0,160}PreviewAuthGate`)
    assert.match(app, pattern, `${route} 需要 PreviewAuthGate`)
  }
  const gate = read('web/src/components/GrAuthGate.tsx')
  assert.match(gate, /export function PreviewAuthGate/)
  assert.match(gate, /if \(!IS_PREVIEW_SCHEMA\) return <>\{children\}<\/>/, '生产直接渲染 children，不能被 GR gate 禁用')
})

test('页面不读不存在的服务端字段；IRS 编号来自 tasks 回报', () => {
  for (const rel of [
    'web/src/pages/ReceiptListPage.tsx',
    'web/src/pages/ReceiptDetailPage.tsx',
    'web/src/pages/ReceiptFormPage.tsx',
  ]) {
    const src = read(rel)
    assert.equal(/\.needs_review\b/.test(src), false, `${rel} 不应读 needs_review`)
    assert.equal(/\.status_reason\b/.test(src), false, `${rel} 不应读 status_reason`)
    assert.equal(/po_numbers/.test(src), false, `${rel} 不应读 po_numbers`)
  }
  const detail = read('web/src/pages/ReceiptDetailPage.tsx')
  assert.match(detail, /review_required/)
  assert.match(detail, /t\.irs_po_no/)
  assert.match(detail, /t\.irs_grn_no/)
  assert.equal(/event\.irs_po_no/.test(detail), false)

  const form = read('web/src/pages/ReceiptFormPage.tsx')
  assert.equal(/status === 'blocked'/.test(form), false)
  assert.match(form, /listReceipts\(\{ po_id: id \}\)/, '非首批判定按服务端事件')
  assert.match(form, /buildReceiptAllocations/)
  assert.match(form, /adoptDraft/)
  assert.match(form, /GR_EXTRA_ASSIGNMENT_REQUIRED/)
})
