// 来源关系判定必须走「服务端 array contains + limit 1」定向查询：
// 不拉全量合并单、不分页、不受第一页影响；任何拒绝都发生在 bridge 之前。
// 用 mock 模拟 PostgREST 过滤（5000 个合并单，owner 在末尾也能命中）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOwnerLookupPath,
  createBridgeCall,
  createPusher,
  createSupabaseRest,
  postgresArrayLiteral,
} from '../scripts/lib/po-push-core.mjs'

const STD = {
  id: 'uuid-5',
  po_id: 'PO-000005',
  po_type: 'standard',
  status: 'pending_push',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
}
const SRC = {
  id: 'uuid-1',
  po_id: 'PO-900001',
  po_type: 'standard',
  status: 'pending_push',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
}
const LINES = [
  { id: 'l1', line_no: 1, item_code: '0030000000003', description: 'SCREW', uom: 'UNIT', qty: 5, unit_price: 2.5 },
]

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

/**
 * 模拟 5000 个合并单，其中很多来源单 —— 只允许通过 cs. 过滤查询；
 * 若代码试图全量拉取（没有 cs./limit=1）直接抛错，测试即失败。
 */
function makeServer({ pending, combined, headersById }) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const pq = `${u.pathname.replace('/rest/v1/', '')}${u.search}`
    calls.push({ method, pathAndQuery: pq, url: u })
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=*&status=eq.pending_push')) {
      return json(pending)
    }
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=*&id=eq.')) {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(pq)?.[1] ?? '')
      const row = headersById[id]
      return json(row ? [row] : [])
    }
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=po_id,po_type,source_po_ids')) {
      const sp = new URLSearchParams(u.search)
      const filter = sp.get('source_po_ids') ?? ''
      if (!filter.startsWith('cs.')) {
        throw new Error(`禁止全量拉取合并单：${pq}`)
      }
      if (sp.get('limit') !== '1') {
        throw new Error(`来源查询必须 limit=1：${pq}`)
      }
      // filter='cs.{"PO-000001"}' → 取引号内的 PO 编号（Postgres 数组字面量，不是 JSON）
      const poNumber = filter.slice(5, -2)
      const hit = combined.find((c) => (c.source_po_ids ?? []).includes(poNumber))
      return json(hit ? [hit] : [])
    }
    if (method === 'GET' && pq.startsWith('tj_po_lines?')) return json(LINES)
    if (method === 'POST' && pq.startsWith('tj_po_exports')) return json(null, 201)
    if (method === 'PATCH' && pq.startsWith('tj_po_headers?id=eq.')) return json(null, 204)
    throw new Error(`unexpected request ${method} ${pq}`)
  }
  return { fetchImpl, calls }
}

function build(fixtures) {
  const server = makeServer(fixtures)
  const bridgeCalls = []
  const bridgeCall = createBridgeCall({
    bridgeUrl: 'http://127.0.0.1:9000',
    fetchImpl: async (url, init = {}) => {
      bridgeCalls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    },
  })
  const sbFetch = createSupabaseRest({
    url: 'https://sb.test',
    serviceKey: 'k',
    fetchImpl: server.fetchImpl,
  })
  const pusher = createPusher({
    sbFetch,
    bridgeCall,
    log: { log: () => {}, error: () => {} },
    now: () => new Date('2026-11-12T02:00:00.000Z'),
  })
  return { pusher, server, bridgeCalls }
}

/** 5000 个合并单：owner 在最后（等价于「不在第一页」） */
function bigCombined() {
  const list = []
  for (let i = 0; i < 5000; i += 1) list.push({ po_id: `PO-8${String(i).padStart(5, '0')}`, po_type: 'combined', source_po_ids: [`PO-7${String(i).padStart(5, '0')}`] })
  list.push({ po_id: 'PO-100003', po_type: 'combined', source_po_ids: [SRC.po_id] })
  return list
}

test('array contains 过滤表达式：URL 编码正确且带 limit=1', () => {
  const path = buildOwnerLookupPath('PO-000001')
  assert.match(path, /^tj_po_headers\?/)
  assert.match(path, /po_type=eq\.combined/)
  assert.match(path, /source_po_ids=cs\.%7B%22PO-000001%22%7D/)
  assert.match(path, /limit=1/)
  assert.equal(new URLSearchParams(path.split('?')[1]).get('source_po_ids'), 'cs.{"PO-000001"}')
})

test('数组字面量转义：引号/反斜杠不会破坏过滤表达式（防筛选注入）', () => {
  assert.equal(postgresArrayLiteral(['A"B']), '{"A\\"B"}')
  assert.equal(postgresArrayLiteral(['C\\D']), '{"C\\\\D"}')
  const tricky = 'PO-1"},'
  assert.equal(postgresArrayLiteral([tricky]), '{"PO-1\\"},"}')
  const filter = new URLSearchParams(buildOwnerLookupPath(tricky).split('?')[1]).get(
    'source_po_ids',
  )
  assert.equal(filter, `cs.${postgresArrayLiteral([tricky])}`)
})

test('5000 个合并单、owner 不在第一页：runOnce 仍拒绝，bridge 零调用', async () => {
  const combined = bigCombined()
  const { pusher, server, bridgeCalls } = build({
    pending: [SRC, STD],
    combined,
    headersById: { [SRC.id]: SRC, [STD.id]: STD },
  })

  const summary = await pusher.runOnce()

  assert.deepEqual(summary.rejected.map((r) => r.po_id), [SRC.po_id])
  assert.deepEqual(summary.rejected.map((r) => r.code), ['SOURCE_OF_COMBINED'])
  assert.deepEqual(summary.pushed.map((p) => p.po_id), [STD.po_id])
  assert.equal(bridgeCalls.length, 1, '只有普通单可以写 bridge')

  const ownerQueries = server.calls.filter((c) =>
    c.pathAndQuery.startsWith('tj_po_headers?select=po_id,po_type,source_po_ids'),
  )
  assert.equal(ownerQueries.length, 3, '每个非合并候选一条定向查询（runOnce 2 + pushOne 复检 1）')
  for (const q of ownerQueries) {
    assert.equal(q.url.searchParams.get('limit'), '1')
    assert.match(q.url.searchParams.get('source_po_ids'), /^cs\./)
  }
  assert.equal(
    server.calls.some((c) => c.pathAndQuery === 'tj_po_headers?select=po_id,po_type,source_po_ids&po_type=eq.combined'),
    false,
    '不得再有全量合并单查询',
  )
})

test('直接调用 pushOne：来源单拒绝、bridge 零调用、只查定向 owner（>1000 合并单）', async () => {
  const { pusher, server, bridgeCalls } = build({
    pending: [],
    combined: bigCombined(),
    headersById: { [SRC.id]: SRC },
  })

  await assert.rejects(() => pusher.pushOne(SRC), /SOURCE_OF_COMBINED/)

  assert.equal(bridgeCalls.length, 0)
  const ownerQueries = server.calls.filter((c) =>
    c.pathAndQuery.startsWith('tj_po_headers?select=po_id,po_type,source_po_ids'),
  )
  assert.equal(ownerQueries.length, 1)
  assert.match(ownerQueries[0].url.searchParams.get('source_po_ids'), /^cs\./)
  assert.equal(
    server.calls.filter((c) => c.pathAndQuery.startsWith('tj_po_lines?')).length,
    0,
    '被拒绝的单据不得抓明细',
  )
})

test('pushOne 读库内最新事实：调用方旧行说 standard，库里已是 combined → 拒绝', async () => {
  const stale = { ...STD, po_type: 'standard' }
  const combinedNow = { ...STD, po_type: 'combined', status: 'pending_push', frozen: true }
  const { pusher, bridgeCalls } = build({
    pending: [],
    combined: [],
    headersById: { [STD.id]: combinedNow },
  })
  await assert.rejects(() => pusher.pushOne(stale), /合并单永久冻结推送/)
  assert.equal(bridgeCalls.length, 0)
})

test('pushOne 找不到 header（已被删/不可见）→ 失败，bridge 零调用', async () => {
  const { pusher, bridgeCalls } = build({ pending: [], combined: [], headersById: {} })
  await assert.rejects(() => pusher.pushOne(STD), /找不到待推送的采购单/)
  assert.equal(bridgeCalls.length, 0)
})

test('owner 查询失败 → fail closed（不推送、记 failed、bridge 零调用）', async () => {
  const server = makeServer({ pending: [STD], combined: [], headersById: { [STD.id]: STD } })
  const failing = async (url, init) => {
    if (String(url).includes('source_po_ids=cs.')) {
      return { ok: false, status: 500, text: async () => 'boom' }
    }
    return server.fetchImpl(url, init)
  }
  const bridgeCalls = []
  const pusher = createPusher({
    sbFetch: createSupabaseRest({ url: 'https://sb.test', serviceKey: 'k', fetchImpl: failing }),
    bridgeCall: async (payload) => {
      bridgeCalls.push(payload)
      return { ok: true }
    },
    log: { log: () => {}, error: () => {} },
  })

  const summary = await pusher.runOnce()
  assert.equal(summary.pushed.length, 0)
  assert.match(summary.failed[0].error, /来源关系查询失败/)
  assert.equal(bridgeCalls.length, 0)
})
