// PO Push 人工恢复只读原型测试：dry-run 决策矩阵 + 只读保证。
// 不触真实库 / 真实 bridge / 真实 Queue。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  recoveryDecision,
  createRecoveryInspector,
  PUSH_INTENT_STATES,
} from '../scripts/lib/po-push-recovery.mjs'

const HDR = {
  id: 'uuid-5',
  po_id: 'PO-000005',
  po_type: 'standard',
  status: 'pending_push',
  website_po_date: '2026-11-13',
}

function intent(state, extra = {}) {
  return { po_header_id: 'uuid-5', po_id: 'PO-000005', content_sha256: 'a'.repeat(64), state, ...extra }
}

// ---------------------------------------------------------------------------
// recoveryDecision 纯函数决策矩阵
// ---------------------------------------------------------------------------

test('无意图 + pending_push → 等待推送，不要求恢复', () => {
  const d = recoveryDecision({ intent: null, header: HDR, exports: [] })
  assert.equal(d.verdict, 'no_intent_pending')
  assert.equal(d.requiresAuthorization.length, 0)
})

test('无意图 + confirmed → 无需恢复', () => {
  const d = recoveryDecision({ intent: null, header: { ...HDR, status: 'confirmed' } })
  assert.equal(d.verdict, 'no_intent')
})

test('delivered + exported → 正常终态，无操作', () => {
  const d = recoveryDecision({
    intent: intent(PUSH_INTENT_STATES.DELIVERED),
    header: { ...HDR, status: 'exported' },
  })
  assert.equal(d.verdict, 'ok_delivered')
  assert.equal(d.mustNot.length, 0)
})

test('delivered + pending_push → 只补状态 exported，绝不重投', () => {
  const d = recoveryDecision({
    intent: intent(PUSH_INTENT_STATES.DELIVERED),
    header: { ...HDR, status: 'pending_push' },
  })
  assert.equal(d.verdict, 'sync_status')
  assert.ok(d.mustNot.includes('不重投'))
  assert.ok(d.mustNot.includes('不删除 intent'))
  assert.ok(d.requiresAuthorization.some((a) => a.includes('exported')))
})

test('delivery_uncertain → 人工核对 Windows Queue，绝不自动重投', () => {
  const d = recoveryDecision({
    intent: intent(PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, { error: 'bridge 调用异常：ECONNREFUSED' }),
    header: { ...HDR, status: 'confirmed' },
  })
  assert.equal(d.verdict, 'manual_verify_queue')
  assert.ok(d.mustNot.includes('不自动重投'))
  assert.ok(d.mustNot.includes('不凭 Windows Pending 文件不存在就重发'))
  assert.ok(d.requiresAuthorization.some((a) => a.includes('记录 delivered')))
  assert.ok(d.steps.some((s) => s.includes('Windows Queue')))
})

test('dispatch_started 残留 → 人工核对，不自动重投', () => {
  const d = recoveryDecision({
    intent: intent(PUSH_INTENT_STATES.DISPATCH_STARTED),
    header: { ...HDR, status: 'pending_push' },
  })
  assert.equal(d.verdict, 'manual_verify_stalled')
  assert.ok(d.mustNot.includes('不自动重投'))
})

test('needs_review → 人工复核，不自动解除', () => {
  const d = recoveryDecision({
    intent: intent(PUSH_INTENT_STATES.NEEDS_REVIEW, { error: '需复核' }),
    header: { ...HDR, status: 'confirmed' },
  })
  assert.equal(d.verdict, 'manual_review')
  assert.ok(d.mustNot.includes('不自动解除 needs_review'))
  assert.ok(d.mustNot.includes('不自动重投'))
})

test('未知状态 → 如实报告，不自动处理', () => {
  const d = recoveryDecision({ intent: intent('weird_state'), header: HDR })
  assert.equal(d.verdict, 'unknown_state')
  assert.ok(d.mustNot.includes('不自动处理'))
})

// ---------------------------------------------------------------------------
// createRecoveryInspector 只读保证 + 解析正确性
// ---------------------------------------------------------------------------

function makeReadOnlyServer({ header = HDR, intentRow = null, exports = [] } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const pq = `${u.pathname.replace('/rest/v1/', '')}${u.search}`
    calls.push({ method, pq })
    // 关键：只读原型绝不接受任何写方法
    if (method !== 'GET') {
      throw new Error(`越权写调用被拒绝：${method} ${pq}`)
    }
    const json = (body, status = 200) => ({ ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) })

    if (pq.startsWith('tj_po_headers?select=*&id=eq.')) {
      return json(header ? [header] : [])
    }
    if (pq.startsWith('tj_po_headers?select=*&po_id=eq.')) {
      return json(header ? [header] : [])
    }
    if (pq.startsWith('tj_po_push_intents?')) {
      return json(intentRow ? [intentRow] : [])
    }
    if (pq.startsWith('tj_po_exports?')) {
      return json(exports)
    }
    throw new Error(`unexpected request ${method} ${pq}`)
  }
  return { fetchImpl, calls }
}

test('inspect 全程只读（无任何非 GET 调用）', async () => {
  const server = makeReadOnlyServer({
    intentRow: intent(PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, { error: 'x' }),
  })
  const sbFetch = async (path, opts = {}) => {
    const res = await server.fetchImpl('https://sb.test/rest/v1/' + path, opts)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text().then((t) => (t ? JSON.parse(t) : null))
  }
  const inspector = createRecoveryInspector(sbFetch)
  const r = await inspector.inspect({ poId: 'PO-000005' })
  assert.equal(r.found, true)
  assert.equal(r.header.po_id, 'PO-000005')
  assert.equal(r.intent.state, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN)
  assert.equal(r.decision.verdict, 'manual_verify_queue')
  // 只读保证：所有调用都是 GET
  assert.ok(server.calls.length > 0)
  assert.ok(server.calls.every((c) => c.method === 'GET'), `存在非 GET 调用：${JSON.stringify(server.calls)}`)
})

test('inspect 按 po_header_id 解析', async () => {
  const server = makeReadOnlyServer({ intentRow: intent(PUSH_INTENT_STATES.DELIVERED) })
  const sbFetch = async (path, opts = {}) => {
    const res = await server.fetchImpl('https://sb.test/rest/v1/' + path, opts)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text().then((t) => (t ? JSON.parse(t) : null))
  }
  const inspector = createRecoveryInspector(sbFetch)
  const r = await inspector.inspect({ poHeaderId: 'uuid-5' })
  assert.equal(r.found, true)
  assert.equal(r.ref.poHeaderId, 'uuid-5')
  assert.equal(r.decision.verdict, 'sync_status') // delivered + pending_push
})

test('inspect 找不到 → found:false，不抛错', async () => {
  const server = makeReadOnlyServer({ header: null })
  const sbFetch = async (path, opts = {}) => {
    const res = await server.fetchImpl('https://sb.test/rest/v1/' + path, opts)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text().then((t) => (t ? JSON.parse(t) : null))
  }
  const inspector = createRecoveryInspector(sbFetch)
  const r = await inspector.inspect({ poId: 'PO-NOPE' })
  assert.equal(r.found, false)
})
