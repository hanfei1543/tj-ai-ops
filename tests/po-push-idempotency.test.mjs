// PO Push 投递幂等测试：不确定投递窗口的离线异常回归（mock Supabase + mock bridge）。
// 覆盖用户明确的 5 条规则：
//   1) bridge 之前持久化 dispatch_started
//   2) bridge 已调用但 delivered 未可靠记录 → delivery_uncertain / 不自动重发
//   3) 同 PO 即使 content_sha256 不同也不得凭新键重投（查任何历史意图）
//   4) 不得因 Pending 文件不存在就重投
//   5) 防 Processing 后再生成 Pending（意图表是真相源，一次投递）
// 不触真实库 / 真实 bridge / 真实 Queue。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computePushContentSha256,
  createPusher,
  createSupabaseRest,
  PUSH_INTENT_STATES,
} from '../scripts/lib/po-push-core.mjs'

const HDR = {
  id: 'uuid-5',
  po_id: 'PO-000005',
  po_type: 'standard',
  status: 'pending_push',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
  website_po_date: '2026-11-13',
}
const LINES = [
  { id: 'l1', line_no: 1, item_code: '0010001000002', description: 'HINGE', uom: 'UNIT', qty: 5, unit_price: 1.25 },
  { id: 'l2', line_no: 2, item_code: '0020002000002', description: 'PLATE', uom: 'PCS', qty: 2, unit_price: 0.9 },
]

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)) }
}

/**
 * 内存 mock：intentStore 模拟 tj_po_push_intents（含 UNIQUE(po_header_id)）。
 * events 记录 sbFetch 与 bridge 的全局时序，用于断言 dispatch_started 先于 bridge。
 */
function makeServer({
  pending = [HDR],
  combined = [],
  headersById = {},
  linesByHeaderId = { 'uuid-5': LINES },
  intents = [],           // 预置历史意图 [{po_header_id, content_sha256, state, filename?}]
  bridge = { ok: true },  // { ok } 或 { throw: '...' }
  exportThrows = false,
}) {
  const calls = []
  const events = []
  const intentStore = new Map()
  for (const it of intents) intentStore.set(it.po_header_id, { id: `intent-${it.po_header_id}`, ...it })

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const pq = `${u.pathname.replace('/rest/v1/', '')}${u.search}`
    calls.push({ method, pathAndQuery: pq, body: init.body ? JSON.parse(init.body) : undefined })
    events.push(`sb:${method}:${pq}`)

    if (method === 'GET' && pq.startsWith('tj_po_headers?select=*&status=eq.pending_push')) return json(pending)
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=*&id=eq.')) {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(pq)?.[1] ?? '')
      const row = headersById[id] ?? pending.find((h) => h.id === id)
      return json(row ? [row] : [])
    }
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=po_id,po_type,source_po_ids')) {
      const sp = new URLSearchParams(u.search)
      const filter = sp.get('source_po_ids') ?? ''
      const poNumber = filter.slice(5, -2)
      const hit = combined.find((c) => (c.source_po_ids ?? []).includes(poNumber))
      return json(hit ? [hit] : [])
    }
    if (method === 'GET' && pq.startsWith('tj_po_lines?')) {
      const m = /po_header_id=eq\.([^&]+)/.exec(pq)
      return json(linesByHeaderId[m?.[1]] ?? [])
    }
    if (method === 'GET' && pq.startsWith('tj_po_push_intents?')) {
      const id = decodeURIComponent(/po_header_id=eq\.([^&]+)/.exec(pq)?.[1] ?? '')
      const row = intentStore.get(id)
      return json(row ? [row] : [])
    }
    if (method === 'POST' && pq.startsWith('tj_po_push_intents')) {
      const body = JSON.parse(init.body)
      if (intentStore.has(body.po_header_id)) {
        // 模拟 UNIQUE(po_header_id) 冲突
        return { ok: false, status: 409, text: async () => JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' }) }
      }
      intentStore.set(body.po_header_id, { id: `intent-${body.po_header_id}`, created_at: '2026-11-14T00:00:00Z', ...body })
      return json(null, 201)
    }
    if (method === 'PATCH' && pq.startsWith('tj_po_push_intents?')) {
      const id = decodeURIComponent(/po_header_id=eq\.([^&]+)/.exec(pq)?.[1] ?? '')
      const body = JSON.parse(init.body)
      const row = intentStore.get(id)
      if (row) Object.assign(row, body)
      return json(null, 204)
    }
    if (method === 'POST' && pq.startsWith('tj_po_exports')) {
      if (exportThrows) return { ok: false, status: 500, text: async () => 'boom' }
      return json(null, 201)
    }
    if (method === 'PATCH' && pq.startsWith('tj_po_headers?id=eq.')) return json(null, 204)
    throw new Error(`unexpected request ${method} ${pq}`)
  }

  const bridgeCalls = []
  const bridgeCall = async (payload) => {
    bridgeCalls.push(payload)
    events.push('bridge:call')
    if (bridge.throw) throw new Error(bridge.throw)
    return { ok: bridge.ok }
  }

  return { fetchImpl, calls, events, intentStore, bridgeCalls, bridgeCall }
}

function build(opts) {
  const server = makeServer(opts)
  const sbFetch = createSupabaseRest({ url: 'https://sb.test', serviceKey: 'k', fetchImpl: server.fetchImpl })
  // 直接注入原生 bridgeCall（可控制 ok/throw），不经 fetch 包装
  const logs = []
  const pusher = createPusher({
    sbFetch,
    bridgeCall: server.bridgeCall,
    log: { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
    now: () => new Date('2026-11-14T02:00:00.000Z'),
  })
  return { pusher, server, logs }
}

test('规则1：dispatch_started 在 bridge 之前持久化（全局时序）', async () => {
  const { pusher, server } = build({})
  const summary = await pusher.runOnce()
  assert.equal(summary.pushed.length, 1)
  assert.equal(server.bridgeCalls.length, 1)

  const intentPostIdx = server.events.findIndex((e) => e.startsWith('sb:POST:tj_po_push_intents'))
  const bridgeIdx = server.events.indexOf('bridge:call')
  assert.ok(intentPostIdx >= 0 && bridgeIdx >= 0)
  assert.ok(intentPostIdx < bridgeIdx, `dispatch_started 必须早于 bridge：intent@${intentPostIdx} bridge@${bridgeIdx}`)

  // 终态：delivered + exported
  assert.equal(server.intentStore.get('uuid-5').state, PUSH_INTENT_STATES.DELIVERED)
  const exportedPatch = server.calls.find(
    (c) => c.method === 'PATCH' && c.pathAndQuery.startsWith('tj_po_headers?id=eq.') && c.body.status === 'exported',
  )
  assert.ok(exportedPatch)
})

test('规则2：bridge 抛错 → delivery_uncertain + 停止轮询，绝不再自动发送', async () => {
  const { pusher, server } = build({ bridge: { throw: 'ECONNREFUSED' } })
  const s1 = await pusher.runOnce()
  assert.equal(s1.pushed.length, 0)
  assert.equal(s1.failed.length, 1)
  assert.match(s1.failed[0].error, /delivery_uncertain/)
  assert.equal(server.bridgeCalls.length, 1, 'bridge 只被调用一次')

  const intent = server.intentStore.get('uuid-5')
  assert.equal(intent.state, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN)
  // 停止轮询：header 拉回 confirmed，不留在 pending_push
  const confirmedPatch = server.calls.find(
    (c) => c.method === 'PATCH' && c.pathAndQuery.startsWith('tj_po_headers?id=eq.') && c.body.status === 'confirmed',
  )
  assert.ok(confirmedPatch, '不确定投递必须停止轮询（拉回 confirmed）')
  // 没有 exported、没有 tj_po_exports 审计
  assert.equal(server.calls.filter((c) => c.method === 'POST' && c.pathAndQuery.startsWith('tj_po_exports')).length, 0)

  // 第二轮：即使 header 又被置回 pending_push，也不得重投（意图表阻断）
  const s2 = await pusher.runOnce()
  assert.equal(server.bridgeCalls.length, 1, '第二轮不得再调 bridge')
  assert.equal(s2.pushed.length, 0)
  assert.match(s2.failed[0].error, /delivery_uncertain|已有投递意图/)
})

test('规则2：bridge 返回 ok:false → delivery_uncertain，不写导出、不改 exported', async () => {
  const { pusher, server } = build({ bridge: { ok: false } })
  const s1 = await pusher.runOnce()
  assert.equal(server.bridgeCalls.length, 1)
  assert.equal(s1.failed.length, 1)
  assert.equal(server.intentStore.get('uuid-5').state, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN)
  assert.equal(server.calls.filter((c) => c.method === 'POST' && c.pathAndQuery.startsWith('tj_po_exports')).length, 0)
  assert.equal(
    server.calls.filter((c) => c.method === 'PATCH' && c.pathAndQuery.startsWith('tj_po_headers?id=eq.') && c.body.status === 'exported').length,
    0,
  )
})

test('bridge 成功、审计 tj_po_exports 写失败 → delivered 已是真相，仍 exported，不重投', async () => {
  const { pusher, server } = build({ exportThrows: true })
  const summary = await pusher.runOnce()
  assert.equal(summary.pushed.length, 1)
  assert.equal(server.bridgeCalls.length, 1)
  assert.equal(server.intentStore.get('uuid-5').state, PUSH_INTENT_STATES.DELIVERED)
  const exportedPatch = server.calls.find(
    (c) => c.method === 'PATCH' && c.pathAndQuery.startsWith('tj_po_headers?id=eq.') && c.body.status === 'exported',
  )
  assert.ok(exportedPatch, '审计失败不阻断状态推进')

  // 重跑：delivered + 同 sha → 幂等重放，bridge 零调用
  const s2 = await pusher.runOnce()
  assert.equal(server.bridgeCalls.length, 1, '重跑不得再 bridge')
  assert.equal(s2.pushed.length, 1, '重放视为已处理')
})

test('规则3：同 PO 同 sha 重放 → 只补状态，bridge 零调用', async () => {
  const sha = computePushContentSha256(HDR, LINES)
  const { pusher, server } = build({
    pending: [HDR],
    intents: [{ po_header_id: 'uuid-5', po_id: 'PO-000005', content_sha256: sha, state: PUSH_INTENT_STATES.DELIVERED, filename: 'PO-000005.xlsx' }],
  })
  // header 仍 pending_push（模拟上次 status PATCH 没落到库）
  const summary = await pusher.runOnce()
  assert.equal(summary.pushed.length, 1)
  assert.equal(server.bridgeCalls.length, 0, '同内容已 delivered 不得再 bridge')
  const exportedPatch = server.calls.find(
    (c) => c.method === 'PATCH' && c.pathAndQuery.startsWith('tj_po_headers?id=eq.') && c.body.status === 'exported',
  )
  assert.ok(exportedPatch, '重放必须补齐状态 exported')
})

test('规则3：同 PO 不同 sha → 拒绝重投（即使内容被改，也不得凭新键再发）', async () => {
  const otherSha = '0'.repeat(64)
  const { pusher, server } = build({
    pending: [HDR],
    intents: [{ po_header_id: 'uuid-5', po_id: 'PO-000005', content_sha256: otherSha, state: PUSH_INTENT_STATES.DELIVERED }],
  })
  const s1 = await pusher.runOnce()
  assert.equal(s1.pushed.length, 0)
  assert.equal(server.bridgeCalls.length, 0, '内容不同也不得重投')
  assert.match(s1.failed[0].error, /内容 sha 不同/)
})

test('规则5：dispatch_started 残留（进程崩溃）→ 升级 delivery_uncertain，不重投', async () => {
  const sha = computePushContentSha256(HDR, LINES)
  const { pusher, server } = build({
    pending: [HDR],
    intents: [{ po_header_id: 'uuid-5', po_id: 'PO-000005', content_sha256: sha, state: PUSH_INTENT_STATES.DISPATCH_STARTED }],
  })
  const s1 = await pusher.runOnce()
  assert.equal(s1.pushed.length, 0)
  assert.equal(server.bridgeCalls.length, 0, '残留 dispatch_started 不得再 bridge')
  assert.equal(server.intentStore.get('uuid-5').state, PUSH_INTENT_STATES.DELIVERY_UNCERTAIN)
})

test('规则4/5：已有 delivery_uncertain 意图 → 无论 Pending 是否存在都不重投', async () => {
  const sha = computePushContentSha256(HDR, LINES)
  const { pusher, server } = build({
    pending: [HDR],
    intents: [{ po_header_id: 'uuid-5', po_id: 'PO-000005', content_sha256: sha, state: PUSH_INTENT_STATES.DELIVERY_UNCERTAIN, error: '上次结果不确定' }],
  })
  const s1 = await pusher.runOnce()
  assert.equal(s1.pushed.length, 0)
  assert.equal(server.bridgeCalls.length, 0)
  assert.match(s1.failed[0].error, /delivery_uncertain|已有投递意图/)
})

test('并发兜底：INSERT intent 撞 UNIQUE(po_header_id) → 重读已有意图并拒绝，不重投', async () => {
  // 场景：第一次 findIntent 返回空（无意图），但 INSERT 时另一进程已抢先插入 →
  // POST 409；catch 里重读应命中该意图并拒绝，而不是把 409 原样抛给 cron。
  const sha = computePushContentSha256(HDR, LINES)
  const server = makeServer({ intents: [] })
  const origFetch = server.fetchImpl
  const wrapped = async (url, init = {}) => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const pq = `${u.pathname.replace('/rest/v1/', '')}${u.search}`
    if (method === 'POST' && pq.startsWith('tj_po_push_intents')) {
      // 模拟另一进程已插入（撞 UNIQUE），随后重读能看到它
      server.intentStore.set('uuid-5', {
        id: 'intent-uuid-5',
        po_header_id: 'uuid-5',
        po_id: 'PO-000005',
        content_sha256: sha,
        state: PUSH_INTENT_STATES.DELIVERED,
      })
      return { ok: false, status: 409, text: async () => JSON.stringify({ code: '23505', message: 'duplicate key' }) }
    }
    return origFetch(url, init)
  }
  const sbFetch = createSupabaseRest({ url: 'https://sb.test', serviceKey: 'k', fetchImpl: wrapped })
  const pusher = createPusher({
    sbFetch,
    bridgeCall: server.bridgeCall,
    log: { log: () => {}, error: () => {} },
    now: () => new Date('2026-11-14T02:00:00.000Z'),
  })
  const s1 = await pusher.runOnce()
  assert.equal(s1.pushed.length, 0)
  assert.equal(server.bridgeCalls.length, 0, 'INSERT 冲突后不得再 bridge')
  assert.match(s1.failed[0].error, /并发保护/)
})
