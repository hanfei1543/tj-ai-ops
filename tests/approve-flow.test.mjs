// 合并单提交/批准多步写入：0 行更新不得假成功；批准必须在「更新成功 + 读回校验通过」后才改来源状态。
// 用假 IO，不连库、不发请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  approveCombinedPoFlow,
  submitCombinedForApprovalFlow,
} from '../web/src/lib/core/approve-flow.js'
import { computeApprovalSnapshotHash } from '../web/src/lib/core/approved-snapshot.js'

const DATE = '2026-11-09'

const PENDING = {
  id: 'uuid-6',
  po_id: 'PO-000006',
  po_type: 'combined',
  status: 'pending_approval',
  frozen: false,
  website_po_date: DATE,
  source_po_ids: ['PO-000001', 'PO-000002'],
}

const LINES = [
  {
    line_no: 1,
    item_code: '0030000000003',
    description: 'SCREW',
    uom: 'UNIT',
    qty: 4,
    original_qty: 5,
    accepted_qty: 4,
    unit_price: 2.5,
    note: '短缺 1',
    source_refs: [{ po_id: 'p1', po_number: 'PO-000001', line_id: 'l1', qty: 3 }],
  },
  {
    line_no: 2,
    item_code: '0010001000002',
    description: 'HINGE',
    uom: 'PCS',
    qty: 1,
    original_qty: 1,
    accepted_qty: 1,
    unit_price: 1.25,
    note: null,
    source_refs: [{ po_id: 'p2', po_number: 'PO-000002', line_id: 'l2', qty: 1 }],
  },
]

/**
 * 假 IO：updateHeaderConditional 命中就改内存 header 并返回它（模拟 .select().single()），
 * updateReturnsNull 模拟「条件不匹配、0 行受影响」。
 */
function makeIo({
  start = PENDING,
  lines = LINES,
  updateReturnsNull = false,
  readBackLines = null,
  failSecondHeaderRead = false,
  sourceUpdated = undefined,
  updateStatusOverride = null,
} = {}) {
  const ops = []
  let header = { ...start }
  let headerReads = 0
  let lineReads = 0
  const io = {
    ops,
    lastPatch: null,
    async readHeader(id) {
      ops.push('readHeader')
      headerReads += 1
      if (failSecondHeaderRead && headerReads > 1) {
        throw new Error('read-back 读取失败（模拟网络/权限错误）')
      }
      return { ...header }
    },
    async readLines() {
      ops.push('readLines')
      lineReads += 1
      if (readBackLines && lineReads > 1) return readBackLines
      return lines
    },
    async updateHeaderConditional({ id, expectStatus, expectFrozen, patch }) {
      ops.push('updateHeaderConditional')
      assert.equal(expectStatus, header.status, '条件更新必须带当前状态')
      assert.equal(expectFrozen, false, '条件更新必须带 frozen=false')
      if (updateReturnsNull) return null
      io.lastPatch = patch
      header = { ...header, ...patch }
      if (updateStatusOverride) header.status = updateStatusOverride
      return { ...header }
    },
    async updateSourceStatuses({ poNumbers, status, onlyFrom }) {
      ops.push('updateSourceStatuses')
      assert.equal(status, 'combined')
      assert.deepEqual(onlyFrom, ['combining'])
      return {
        updated: sourceUpdated === undefined ? poNumbers.length : sourceUpdated,
      }
    },
  }
  return io
}

test('批准成功：更新 → 读回重算校验 → 才改来源状态；摘要与版本 2 写入', async () => {
  const io = makeIo()
  const out = await approveCombinedPoFlow({
    io,
    id: PENDING.id,
    approvedBy: 'Ah Huat',
    now: () => new Date('2026-11-12T02:00:00.000Z'),
  })

  assert.deepEqual(io.ops, [
    'readHeader',
    'readLines',
    'updateHeaderConditional',
    'readHeader',
    'readLines',
    'updateSourceStatuses',
  ])
  assert.equal(io.lastPatch.approval_snapshot_version, 2)
  assert.match(io.lastPatch.source_sha256, /^[0-9a-f]{64}$/)
  assert.equal(io.lastPatch.status, 'confirmed')
  assert.equal(io.lastPatch.frozen, true)
  assert.equal(io.lastPatch.approved_by, 'Ah Huat')
  assert.equal(out.hash, io.lastPatch.source_sha256)
  assert.equal(out.version, 2)
  // 摘要确实由 DB 读回的数据算出（不是调用方传入）
  assert.equal(out.hash, await computeApprovalSnapshotHash(PENDING, LINES))
})

test('批准 0 行（状态已被改）→ 报错，来源状态不动', async () => {
  const io = makeIo({ updateReturnsNull: true })
  await assert.rejects(
    () => approveCombinedPoFlow({ io, id: PENDING.id, approvedBy: 'Ah Huat' }),
    /批准更新 0 行/,
  )
  assert.equal(io.ops.includes('updateSourceStatuses'), false)
})

test('批准更新成功但读回摘要不符（冻结后数据被改）→ 拒绝，来源状态不动', async () => {
  const tampered = JSON.parse(JSON.stringify(LINES))
  tampered[0].accepted_qty = 3
  const io = makeIo({ readBackLines: tampered })
  await assert.rejects(
    () => approveCombinedPoFlow({ io, id: PENDING.id, approvedBy: 'Ah Huat' }),
    /读回快照校验失败/,
  )
  assert.equal(io.ops.includes('updateSourceStatuses'), false)
})

test('批准后读回失败 → 拒绝，来源状态不动', async () => {
  const io = makeIo({ failSecondHeaderRead: true })
  await assert.rejects(
    () => approveCombinedPoFlow({ io, id: PENDING.id, approvedBy: 'Ah Huat' }),
    /read-back 读取失败/,
  )
  assert.equal(io.ops.includes('updateSourceStatuses'), false)
})

test('来源单状态更新行数不足 → 报错（不静默成功）', async () => {
  const io = makeIo({ sourceUpdated: 1 })
  await assert.rejects(
    () => approveCombinedPoFlow({ io, id: PENDING.id, approvedBy: 'Ah Huat' }),
    /来源单状态更新 1\/2 行/,
  )
  assert.ok(io.ops.includes('updateSourceStatuses'))
})

test('提交审批成功：draft 条件更新命中；返回 DB 行', async () => {
  const io = makeIo({ start: { ...PENDING, status: 'draft', receipt_event_id: null } })
  const updated = await submitCombinedForApprovalFlow({
    io,
    id: PENDING.id,
    checkedBy: 'Ms Toh',
    deliveryOrderNo: 'D-1',
    now: () => new Date('2026-11-12T01:00:00.000Z'),
    newReceiptEventId: () => 'receipt-uuid',
  })
  assert.equal(updated.status, 'pending_approval')
  assert.equal(updated.checked_by, 'Ms Toh')
  assert.equal(updated.delivery_order_no, 'D-1')
  assert.equal(updated.receipt_event_id, 'receipt-uuid')
  assert.deepEqual(io.ops, ['readHeader', 'updateHeaderConditional'])
})

test('提交审批 0 行 → 报错（不假成功）', async () => {
  const io = makeIo({ start: { ...PENDING, status: 'draft' }, updateReturnsNull: true })
  await assert.rejects(
    () => submitCombinedForApprovalFlow({ io, id: PENDING.id, checkedBy: 'Ms Toh' }),
    /提交审批更新 0 行/,
  )
})

test('提交审批返回的状态不是 pending_approval → 报错', async () => {
  const io = makeIo({
    start: { ...PENDING, status: 'draft' },
    updateStatusOverride: 'draft',
  })
  await assert.rejects(
    () => submitCombinedForApprovalFlow({ io, id: PENDING.id, checkedBy: 'Ms Toh' }),
    /不是 pending_approval/,
  )
})

test('缺日期/状态不对在写库前就被拒绝（读 header 之后 0 次 update）', async () => {
  const noDate = makeIo({ start: { ...PENDING, website_po_date: null } })
  await assert.rejects(
    () => approveCombinedPoFlow({ io: noDate, id: PENDING.id, approvedBy: 'x' }),
    /缺少 Website PO Date/,
  )
  assert.deepEqual(noDate.ops, ['readHeader'])

  const draft = makeIo({ start: { ...PENDING, status: 'draft' } })
  await assert.rejects(
    () => approveCombinedPoFlow({ io: draft, id: PENDING.id, approvedBy: 'x' }),
    /不能批准/,
  )
  assert.deepEqual(draft.ops, ['readHeader'])
})

test('没有明细行不能批准', async () => {
  const io = makeIo({ lines: [] })
  await assert.rejects(
    () => approveCombinedPoFlow({ io, id: PENDING.id, approvedBy: 'x' }),
    /没有明细行/,
  )
  assert.equal(io.ops.includes('updateHeaderConditional'), false)
})
