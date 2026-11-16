// Windows GR Worker 核心测试：五阶段区分 / 重复阻断 / PAD 未接入不 claim / SHA 拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker, validateEnvelope, WorkerError } from '../scripts/windows/gr-worker/worker-core.mjs'
import { buildTaskPayload, TASK_ID, PO_ID, EVENT_ID, LINE_ID } from './helpers/gr-task-fixture.mjs'

function makeEnvelope(overrides = {}) {
  const { payload, payloadSha256 } = buildTaskPayload(overrides)
  return {
    schema: 'tj.gr.dispatch.v1',
    mode: 'mock',
    dispatched_at: '2026-11-16T00:00:00Z',
    task: {
      task_id: TASK_ID,
      request_id: `gr:${TASK_ID}`,
      receipt_event_id: EVENT_ID,
      po_header_id: PO_ID,
      payload_sha256: payloadSha256,
      status: 'ready',
      payload,
    },
  }
}

function makeMocks({ connected = true } = {}) {
  const calls = { claim: [], result: [], saveEntry: [], readBack: [], ledger: [] }
  const rpc = {
    claim: async (taskId) => { calls.claim.push(taskId); return { status: 'claimed', rejected: false } },
    result: async (args) => { calls.result.push(args); return { task: { status: 'ok' }, rejected: false } },
  }
  const pad = {
    isConnected: () => connected,
    saveEntry: async () => { calls.saveEntry.push(1); return { ok: true } },
    readBack: async () => {
      calls.readBack.push(1)
      // 真实回查证据（逐行）——只有 readBack 实现后才有；此处是测试替身
      return {
        bridge_ok: true,
        irs_po_no: 'IRS-PO-1001',
        irs_grn_no: 'GRN-MOCK-1',
        irs_invoice_no: 'INV-MOCK-1001',
        supplier_code: '4000/A01',
        invoice_no: 'INV-MOCK-1001',
        delivery_order_no: 'DO-MOCK-1001',
        receive_date: '2026-11-13',
        invoice_date: '2026-11-10',
        saved_at: '2026-11-13T02:00:00Z',
        evidence_ref: 'IRS GRN screenshot mock',
        lines: [{ line_id: LINE_ID, line_no: 1, item_code: '00101', uom: 'UNIT', qty: '5', unit_price: '2.5', sources: [{ po_line_id: 'a2000000-0000-4000-8000-000000000001', accepted_qty: '5' }] }],
      }
    },
  }
  const seen = new Set()
  const ledger = {
    seen: (id) => seen.has(id),
    record: async (e) => { calls.ledger.push(e); seen.add(e.task_id) },
  }
  const worker = createWorker({ rpc, pad, ledger, log: { log() {}, error() {} } })
  return { calls, worker, ledger, seen }
}

test('validateEnvelope：schema 非 dispatch.v1 拒绝', () => {
  const env = makeEnvelope()
  env.schema = 'tj.gr.dispatch.v2'
  assert.throws(() => validateEnvelope(env), (e) => e.code === 'GR_WORKER_SCHEMA')
})

test('validateEnvelope：mode 非 mock 拒绝（真实出队未授权）', () => {
  const env = makeEnvelope()
  env.mode = 'real'
  assert.throws(() => validateEnvelope(env), (e) => e.code === 'GR_WORKER_MODE')
})

test('validateEnvelope：environment 非 preview 拒绝', () => {
  const env = makeEnvelope({ task: { environment: 'production' } })
  assert.throws(() => validateEnvelope(env), (e) => e.code === 'GR_WORKER_ENV')
})

test('validateEnvelope：payload_sha256 不符拒绝', () => {
  const env = makeEnvelope()
  env.task.payload_sha256 = '0'.repeat(64)
  assert.throws(() => validateEnvelope(env), (e) => e.code === 'GR_WORKER_HASH_MISMATCH')
})

test('五阶段顺序：delivery→claim→save_attempt→saved→verified（收到任务≠已入库）', async () => {
  const { worker, calls } = makeMocks({ connected: true })
  const env = makeEnvelope()
  const r = await worker.processTask(env)
  assert.equal(r.status, 'verified')
  assert.equal(calls.claim.length, 1)
  // result 顺序必须严格：save_attempted → saved → verified（不能收到就 verified）
  assert.deepEqual(calls.result.map((a) => a.event_type), ['save_attempted', 'saved', 'verified'])
  assert.equal(calls.saveEntry.length, 1)
  assert.equal(calls.readBack.length, 1)
  // 账本五阶段齐全
  assert.deepEqual(calls.ledger.map((e) => e.phase), ['delivery', 'claim', 'save_attempt', 'saved', 'verified'])
})

test('PAD 未接入：不 claim、不 save、不 result，账本记 waiting_pad', async () => {
  const { worker, calls } = makeMocks({ connected: false })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'waiting_pad')
  assert.equal(calls.claim.length, 0)
  assert.equal(calls.result.length, 0)
  assert.equal(calls.saveEntry.length, 0)
  assert.deepEqual(calls.ledger.map((e) => e.status), ['received', 'waiting_pad'])
})

test('重复阻断：同一 task_id 已处理 → duplicate_skipped，不重复 claim', async () => {
  const { worker, calls, seen } = makeMocks({ connected: true })
  const env = makeEnvelope()
  await worker.processTask(env) // 第一次完整流程
  seen.add(TASK_ID) // 模拟账本已有
  const r = await worker.processTask(makeEnvelope()) // 第二次同一任务
  assert.equal(r.status, 'duplicate_skipped')
  assert.equal(calls.claim.length, 1) // 只 claim 过一次
})

test('claim 被服务端拒绝（lease 冲突）→ 不 save、不 result', async () => {
  const { worker, calls } = makeMocks({ connected: true })
  calls.claim = []
  const rpc = {
    claim: async () => { calls.claim.push(1); return { rejected: true, code: 'GR_TASK_LEASED' } },
    result: async () => { calls.result.push(1); return { ok: true } },
  }
  const seen = new Set()
  const ledger = { seen: (id) => seen.has(id), record: async (e) => { seen.add(e.task_id) } }
  const w = createWorker({ rpc, pad: { isConnected: () => true, saveEntry: async () => {}, readBack: async () => ({}) }, ledger })
  const r = await w.processTask(makeEnvelope())
  assert.equal(r.status, 'claim_rejected')
  assert.equal(r.code, 'GR_TASK_LEASED')
  assert.equal(calls.result.length, 0)
})

test('PAD saveEntry 失败 → 回报 failed，不走到 saved/verified', async () => {
  const calls = { result: [] }
  const rpc = {
    claim: async () => ({ rejected: false }),
    result: async (args) => { calls.result.push(args); return { rejected: false } },
  }
  const pad = {
    isConnected: () => true,
    saveEntry: async () => { throw new Error('PAD flow error') },
    readBack: async () => ({}),
  }
  const seen = new Set()
  const ledger = { seen: (id) => seen.has(id), record: async (e) => { seen.add(e.task_id) } }
  const w = createWorker({ rpc, pad, ledger })
  const r = await w.processTask(makeEnvelope())
  assert.equal(r.status, 'save_failed')
  assert.equal(calls.result[0].event_type, 'failed')
  assert.deepEqual(calls.result.map((a) => a.event_type), ['failed'])
})

test('readBack 未实现（PAD 待接入回查）→ 停在 saved，绝不伪造 verified', async () => {
  const calls = { result: [] }
  const rpc = {
    claim: async () => ({ rejected: false }),
    result: async (args) => { calls.result.push(args); return { rejected: false } },
  }
  const pad = {
    isConnected: () => true,
    saveEntry: async () => ({}),
    readBack: async () => { throw new Error('PAD_NOT_CONNECTED: readBack 未实现') },
  }
  const seen = new Set()
  const ledger = { seen: (id) => seen.has(id), record: async (e) => { seen.add(e.task_id) } }
  const w = createWorker({ rpc, pad, ledger })
  const r = await w.processTask(makeEnvelope())
  assert.equal(r.status, 'readback_unavailable')
  // 没有 verified 回报
  assert.equal(calls.result.some((a) => a.event_type === 'verified'), false)
  assert.deepEqual(calls.result.map((a) => a.event_type), ['save_attempted', 'saved'])
})
