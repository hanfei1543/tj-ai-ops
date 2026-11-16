// Windows GR Worker 核心测试：七步状态机 / 重复与 SHA 阻断 / PAD 未就绪不 claim / Save Intent 顺序 /
// 保存超时转 needs_review / readBack 失败转 needs_review / 处理中断重试 / 正式路径 allowReal。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker, validateEnvelope, reconcileDraft, WorkerError } from '../scripts/windows/gr-worker/worker-core.mjs'
import { createLedger } from '../scripts/windows/gr-worker/ledger.mjs'
import { buildTaskPayload, TASK_ID } from './helpers/gr-task-fixture.mjs'

function makeEnvelope(overrides = {}) {
  const { payload, payloadSha256 } = buildTaskPayload(overrides)
  return {
    schema: 'tj.gr.dispatch.v1',
    mode: 'mock',
    dispatched_at: '2026-11-16T00:00:00Z',
    task: {
      task_id: TASK_ID,
      request_id: `gr:${TASK_ID}`,
      receipt_event_id: payload.approved_event_snapshot.id,
      po_header_id: payload.task.po_header_id,
      payload_sha256: payloadSha256,
      status: 'ready',
      payload,
    },
  }
}

/** 从 scope.lines 构造一个「未保存录入」草稿镜像（与实际录入一致） */
function draftFromPayload(payload, mutate) {
  const lines = (payload.scope?.lines ?? []).map((l) => ({
    line_id: l.line_id,
    item_code: l.item_code,
    uom: l.uom,
    unit_price: l.unit_price,
    qty: l.accepted_qty,
    sources: (l.sources ?? []).map((s) => ({ po_line_id: s.po_line_id, accepted_qty: s.accepted_qty })),
  }))
  return { draft_id: 'draft-1', lines: mutate ? mutate(lines) : lines }
}

function makeMocks({ ready = true, rpc, pad } = {}) {
  const calls = { claim: [], result: [], saveEntry: [], commitSave: [], readBack: [] }
  const defaultRpc = {
    claim: async (taskId) => { calls.claim.push(taskId); return { status: 'claimed', rejected: false } },
    result: async (args) => { calls.result.push(args); return { task: { status: 'ok' }, rejected: false } },
  }
  const defaultPad = {
    isReady: () => ready,
    isConnected: () => true,
    saveEntry: async (payload) => { calls.saveEntry.push(1); return draftFromPayload(payload) },
    commitSave: async () => { calls.commitSave.push(1); return { saved: true, irs_grn_no: 'GRN-MOCK-1', saved_at: '2026-11-13T02:00:00Z' } },
    readBack: async () => { calls.readBack.push(1); return { bridge_ok: true, irs_grn_no: 'GRN-MOCK-1' } },
  }
  const ledger = createLedger({})
  const ledgerCalls = []
  const wrappedLedger = {
    get: (id) => ledger.get(id),
    record: (e) => { ledgerCalls.push(e); return ledger.record(e) },
  }
  const worker = createWorker({ rpc: rpc || defaultRpc, pad: pad || defaultPad, ledger: wrappedLedger, log: { log() {}, error() {} } })
  return { calls, worker, ledger, ledgerCalls }
}

test('validateEnvelope：schema 非 dispatch.v1 拒绝', () => {
  const env = makeEnvelope()
  env.schema = 'tj.gr.dispatch.v2'
  assert.throws(() => validateEnvelope(env), (e) => e.code === 'GR_WORKER_SCHEMA')
})

test('validateEnvelope：mode=real 默认拒绝（真实出队未授权）', () => {
  const env = makeEnvelope({ task: { mock_only: false } })
  env.mode = 'real'
  assert.throws(() => validateEnvelope(env), (e) => e.code === 'GR_WORKER_MODE')
})

test('validateEnvelope：mode=real + allowReal=true 放行（mock_only=false 正式路径）', () => {
  const env = makeEnvelope({ task: { mock_only: false } })
  env.mode = 'real'
  const item = validateEnvelope(env, 0, { allowReal: true })
  assert.equal(item.task_id, TASK_ID)
})

test('validateEnvelope：mode=real 但 mock_only=true → 拒绝（矛盾）', () => {
  const env = makeEnvelope()
  env.mode = 'real'
  assert.throws(() => validateEnvelope(env, 0, { allowReal: true }), (e) => e.code === 'GR_WORKER_MOCK')
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

test('七步顺序：delivery→claim→draft→save_intent→commit→saved→verified（收到≠入库≠核对）', async () => {
  const { worker, calls, ledgerCalls } = makeMocks({ ready: true })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'verified')
  assert.equal(r.terminal, true)
  assert.equal(calls.claim.length, 1)
  // 实际 Save 一次、回查一次；result 顺序严格 save_attempted → saved → verified
  assert.equal(calls.saveEntry.length, 1)
  assert.equal(calls.commitSave.length, 1)
  assert.equal(calls.readBack.length, 1)
  assert.deepEqual(calls.result.map((a) => a.event_type), ['save_attempted', 'saved', 'verified'])
  // 账本七阶段齐全（received → claimed → draft_entered → save_attempted → committed → saved_unverified → verified）
  assert.deepEqual(
    ledgerCalls.map((e) => e.status),
    ['received', 'claimed', 'draft_entered', 'save_attempted', 'committed', 'saved_unverified', 'verified'],
  )
})

test('PAD 未就绪：不 claim、不 save、不 result，账本记 waiting_pad（非终态）', async () => {
  const { worker, calls, ledgerCalls } = makeMocks({ ready: false })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'waiting_pad')
  assert.equal(r.terminal, false)
  assert.equal(calls.claim.length, 0)
  assert.equal(calls.result.length, 0)
  assert.equal(calls.saveEntry.length, 0)
  assert.equal(calls.commitSave.length, 0)
  assert.deepEqual(ledgerCalls.map((e) => e.status), ['received', 'waiting_pad'])
})

test('PAD 已配置但未就绪（isConnected=true / isReady=false）：仍不 claim', async () => {
  const { worker, calls } = makeMocks({ ready: false })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'waiting_pad')
  assert.equal(calls.claim.length, 0)
})

test('PAD 未就绪连续扫描两次：两次都是 waiting_pad，绝不当 Done/duplicate', async () => {
  const { worker, calls } = makeMocks({ ready: false })
  const r1 = await worker.processTask(makeEnvelope())
  const r2 = await worker.processTask(makeEnvelope())
  assert.equal(r1.status, 'waiting_pad')
  assert.equal(r1.terminal, false)
  assert.equal(r2.status, 'waiting_pad') // 第二次仍是 waiting_pad，不是 duplicate_skipped
  assert.equal(r2.terminal, false)
  assert.equal(calls.claim.length, 0) // 两次都没 claim
})

test('重复阻断：同 task_id 同 SHA 已终态 → duplicate_skipped，不重复 claim', async () => {
  const { worker, calls } = makeMocks({ ready: true })
  await worker.processTask(makeEnvelope()) // verified 终态
  const r = await worker.processTask(makeEnvelope()) // 同 SHA 再来
  assert.equal(r.status, 'duplicate_skipped')
  assert.equal(r.terminal, true)
  assert.equal(calls.claim.length, 1) // 只 claim 一次
})

test('不同 SHA 冲突：同 task_id 换 SHA → sha_conflict 阻断（不当重复跳过）', async () => {
  const { worker, calls } = makeMocks({ ready: true })
  await worker.processTask(makeEnvelope()) // 完整流程，账本记 SHA A
  const env2 = makeEnvelope({ snapshot: { receive_date: '2026-11-14' } }) // 同 task_id，不同 SHA B（内部自洽）
  const r = await worker.processTask(env2)
  assert.equal(r.status, 'sha_conflict')
  assert.equal(r.terminal, true)
  assert.equal(calls.claim.length, 1) // 阻断发生在 claim 之前，不重复处理
})

test('处理中断/重启：账本非终态(claimed) → 重新领取而非当作 Done', async () => {
  const { worker, calls, ledger } = makeMocks({ ready: true })
  const env = makeEnvelope()
  // 模拟上次运行 crash：账本已记 claimed（非终态），但没保存完
  ledger.record({ task_id: TASK_ID, payload_sha256: env.task.payload_sha256, phase: 'claim', status: 'claimed', terminal: false })
  const r = await worker.processTask(env)
  assert.equal(r.status, 'verified') // 重新走完整流程，不是 duplicate_skipped
  assert.equal(calls.claim.length, 1)
})

test('claim 被拒 GR_TASK_LEASED（lease 被占）→ claim_leased 非终态（等 lease 过期重试）', async () => {
  const { worker } = makeMocks({
    rpc: {
      claim: async () => ({ rejected: true, code: 'GR_TASK_LEASED' }),
      result: async () => ({ rejected: false }),
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'claim_leased')
  assert.equal(r.terminal, false)
})

test('claim 被拒 GR_TASK_STALE_REVIEW（已尝试保存）→ needs_review 终态', async () => {
  const { worker } = makeMocks({
    rpc: {
      claim: async () => ({ rejected: true, code: 'GR_TASK_STALE_REVIEW' }),
      result: async () => ({ rejected: false }),
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'needs_review')
  assert.equal(r.terminal, true)
})

test('saveEntry（未保存录入）失败 → draft_failed 非终态，不碰 DB（可安全重试）', async () => {
  const calls = { result: [] }
  const { worker } = makeMocks({
    pad: {
      isReady: () => true,
      saveEntry: async () => { throw new Error('PAD draft error') },
      commitSave: async () => ({ saved: true }),
      readBack: async () => ({}),
    },
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => { calls.result.push(a); return { rejected: false } },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'draft_failed')
  assert.equal(r.terminal, false)
  assert.equal(calls.result.length, 0) // 未开始 Save Intent
})

test('完整核对失败（草稿与 scope 不符）→ reconcile_failed 非终态，不 Save Intent', async () => {
  const calls = { result: [] }
  const { worker } = makeMocks({
    pad: {
      isReady: () => true,
      saveEntry: async (p) => draftFromPayload(p, (lines) => lines.map((l) => ({ ...l, qty: '999' }))),
      commitSave: async () => ({ saved: true }),
      readBack: async () => ({}),
    },
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => { calls.result.push(a); return { rejected: false } },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'reconcile_failed')
  assert.equal(r.terminal, false)
  assert.equal(calls.result.some((a) => a.event_type === 'save_attempted'), false)
})

test('reconcileDraft：一致返回 ok，不一致返回具体 mismatches', () => {
  const { payload } = buildTaskPayload()
  const good = draftFromPayload(payload)
  assert.equal(reconcileDraft(payload, good).ok, true)
  const bad = draftFromPayload(payload, (lines) => lines.map((l) => ({ ...l, unit_price: '999' })))
  const res = reconcileDraft(payload, bad)
  assert.equal(res.ok, false)
  assert.ok(res.mismatches.some((m) => m.field === 'unit_price'))
})

test('commitSave 明确失败(saved:false) → needs_review，不回报 saved/verified', async () => {
  const calls = { result: [] }
  const { worker } = makeMocks({
    pad: {
      isReady: () => true,
      saveEntry: async (p) => draftFromPayload(p),
      commitSave: async () => ({ saved: false, error: 'IRS 拒绝：单据已存在' }),
      readBack: async () => ({}),
    },
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => { calls.result.push(a); return { rejected: false } },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'needs_review')
  assert.equal(r.terminal, true)
  assert.deepEqual(calls.result.map((a) => a.event_type), ['save_attempted', 'needs_review'])
})

test('commitSave 超时/断线（抛错）→ needs_review，绝不重试', async () => {
  const calls = { result: [] }
  const { worker } = makeMocks({
    pad: {
      isReady: () => true,
      saveEntry: async (p) => draftFromPayload(p),
      commitSave: async () => { throw new Error('PAD 保存超时，结果不明') },
      readBack: async () => ({}),
    },
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => { calls.result.push(a); return { rejected: false } },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'needs_review')
  assert.equal(r.terminal, true)
  assert.deepEqual(calls.result.map((a) => a.event_type), ['save_attempted', 'needs_review'])
})

test('readBack 失败 → needs_review（非 Failed），绝不伪造 verified', async () => {
  const calls = { result: [] }
  const { worker } = makeMocks({
    pad: {
      isReady: () => true,
      saveEntry: async (p) => draftFromPayload(p),
      commitSave: async () => ({ saved: true }),
      readBack: async () => { throw new Error('PAD_NOT_CONNECTED: readBack 未实现') },
    },
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => { calls.result.push(a); return { rejected: false } },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'needs_review')
  assert.equal(r.terminal, true)
  assert.deepEqual(calls.result.map((a) => a.event_type), ['save_attempted', 'saved', 'needs_review'])
  assert.equal(calls.result.some((a) => a.event_type === 'verified'), false)
})

test('verified 被服务端拒绝（证据比对不通过）→ needs_review', async () => {
  const { worker } = makeMocks({
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => a.event_type === 'verified'
        ? { rejected: true, code: 'GR_EVIDENCE_MISMATCH', mismatches: [{ field: 'irs_grn_no' }] }
        : { rejected: false },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'needs_review')
  assert.equal(r.terminal, true)
  assert.equal(r.code, 'GR_EVIDENCE_MISMATCH')
})

test('save_attempted RPC 超时 → needs_review（不确定意图是否已持久化，不冒进保存）', async () => {
  const { worker } = makeMocks({
    rpc: {
      claim: async () => ({ rejected: false }),
      result: async (a) => {
        if (a.event_type === 'save_attempted') throw new WorkerError('GR_RPC_TIMEOUT', 'save_attempted 超时')
        return { rejected: false }
      },
    },
  })
  const r = await worker.processTask(makeEnvelope())
  assert.equal(r.status, 'needs_review')
  assert.equal(r.terminal, true)
})
