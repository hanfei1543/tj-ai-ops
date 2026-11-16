// GR Dispatcher 核心测试：幂等 / SHA / 环境契约 / 恢复（投递失败不标已投）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, DispatchRefused, buildDispatchEnvelope } from '../scripts/gr-dispatch-core.mjs'
import { buildOutboxRow } from './helpers/gr-task-fixture.mjs'

function makeDeps({ deliver = async () => ({ ok: true }) } = {}) {
  const calls = { deliver: [], mark: [] }
  const listPending = async () => calls.rows ?? []
  const markDispatched = async (row, status, at) => calls.mark.push({ id: row.id, status, at })
  const dispatcher = createDispatcher({ listPending, markDispatched, deliver, log: { log() {}, error() {} } })
  return { calls, dispatcher, listPending, markDispatched }
}

test('合法 outbox 行 → 投递一次并标 mock_dispatched', async () => {
  const row = buildOutboxRow()
  const delivered = []
  const { dispatcher, calls, listPending } = makeDeps({
    deliver: async (filename, envelope) => { delivered.push({ filename, envelope }); return { ok: true } },
  })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.scanned, 1)
  assert.equal(s.delivered.length, 1)
  assert.equal(s.failed.length, 0)
  assert.equal(s.rejected.length, 0)
  assert.equal(delivered[0].filename, `task-${row.task_id}.json`)
  assert.equal(delivered[0].envelope.schema, 'tj.gr.dispatch.v1')
  assert.equal(delivered[0].envelope.mode, 'mock')
  assert.equal(calls.mark.length, 1)
  assert.equal(calls.mark[0].id, row.id)
  assert.equal(calls.mark[0].status, 'mock_dispatched')
})

test('payload_sha256 不符 → 拒绝（deliver/mark 零调用）', async () => {
  const row = buildOutboxRow({ row: { payload_sha256: '0'.repeat(64) } })
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: true }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.rejected.length, 1)
  assert.equal(s.rejected[0].code, 'GR_DISPATCH_HASH_MISMATCH')
  assert.equal(calls.mark.length, 0)
})

test('event_payload_sha256 不符 → 拒绝', async () => {
  const { createHash } = await import('node:crypto')
  const { canonicalTaskPayloadFromPayload } = await import('../web/src/lib/core/receipt-tasks.js')
  const row = buildOutboxRow()
  // 篡改事件哈希，并同步重算 payload_sha256（否则会先命中 payload hash 检查）
  row.payload.event_payload_sha256 = '1'.repeat(64)
  row.payload_sha256 = createHash('sha256').update(canonicalTaskPayloadFromPayload(row.payload)).digest('hex')
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: true }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.rejected.length, 1)
  assert.equal(s.rejected[0].code, 'GR_DISPATCH_EVENT_HASH_MISMATCH')
  assert.equal(calls.mark.length, 0)
})

test('environment 非 preview → 拒绝', async () => {
  const row = buildOutboxRow({ task: { environment: 'production' } })
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: true }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.rejected.length, 1)
  assert.equal(s.rejected[0].code, 'GR_DISPATCH_ENV')
  assert.equal(calls.mark.length, 0)
})

test('mock_only=false → 拒绝', async () => {
  const row = buildOutboxRow({ task: { mock_only: false }, row: { mock_only: false } })
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: true }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.rejected.length, 1)
  assert.equal(s.rejected[0].code, 'GR_DISPATCH_MOCK_ONLY')
  assert.equal(calls.mark.length, 0)
})

test('payload 内出现 http/bridge 地址 → 拒绝（防真实出队线索）', async () => {
  const row = buildOutboxRow({ snapshot: { note: 'POST http://evil/bridge' } })
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: true }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.rejected.length, 1)
  assert.equal(s.rejected[0].code, 'GR_DISPATCH_REAL_BRIDGE')
  assert.equal(calls.mark.length, 0)
})

test('投递失败（bridge 不可达）→ failed，不标已投，留 pending 下次重试', async () => {
  const row = buildOutboxRow()
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: false, error: 'bridge down' }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.failed.length, 1)
  assert.equal(s.failed[0].task_id, row.task_id)
  assert.equal(calls.mark.length, 0) // 未标已投 → 可重试
})

test('source_refs 覆盖不完整 → 拒绝', async () => {
  const row = buildOutboxRow()
  row.payload.source_refs = []
  const { dispatcher, calls, listPending } = makeDeps({ deliver: async () => ({ ok: true }) })
  calls.rows = [row]
  const s = await dispatcher.runOnce()
  assert.equal(s.rejected.length, 1)
  assert.equal(s.rejected[0].code, 'GR_DISPATCH_PAYLOAD_INCOMPLETE')
  assert.equal(calls.mark.length, 0)
})

test('buildDispatchEnvelope 稳定结构（task 字段齐全）', () => {
  const row = buildOutboxRow()
  const item = { task_id: row.task_id, request_id: row.request_id, receipt_event_id: row.receipt_event_id, po_header_id: row.po_header_id, payload_sha256: row.payload_sha256, status: 'pending', payload: row.payload }
  const env = buildDispatchEnvelope(item, { now: () => new Date('2026-11-16T00:00:00Z') })
  assert.equal(env.schema, 'tj.gr.dispatch.v1')
  assert.equal(env.mode, 'mock')
  assert.equal(env.dispatched_at, '2026-11-16T00:00:00.000Z')
  assert.equal(env.task.task_id, row.task_id)
  assert.equal(env.task.payload_sha256, row.payload_sha256)
  assert.equal(env.task.payload.task.irs_po_no, 'IRS-PO-1001')
})
