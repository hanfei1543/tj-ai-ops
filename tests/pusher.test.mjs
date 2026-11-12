// 推送器测试：mock Supabase + mock bridge，证明拒绝路径 bridge 零调用、普通单正常调用。
// 不触碰真实库、真实 bridge、真实 cron。
import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import {
  createSupabaseRest,
  createBridgeCall,
  createPusher,
  PUBLIC_SCHEMA,
} from '../scripts/lib/po-push-core.mjs'

const HDR_COMBINED = {
  id: 'uuid-3',
  po_id: 'PO-000003',
  po_type: 'combined',
  status: 'pending_push',
  frozen: true,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
  source_po_ids: ['PO-000001', 'PO-000002'],
}
const HDR_SOURCE = {
  id: 'uuid-1',
  po_id: 'PO-000001',
  po_type: 'standard',
  status: 'pending_push',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
}
const HDR_STANDARD = {
  id: 'uuid-5',
  po_id: 'PO-000005',
  po_type: 'standard',
  status: 'pending_push',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
}
const LINES_STANDARD = [
  { id: 'l1', line_no: 1, item_code: '0010001000002', description: 'HINGE', uom: 'UNIT', qty: 5, unit_price: 1.25 },
  { id: 'l2', line_no: 2, item_code: '0020002000002', description: 'PLATE', uom: 'PCS', qty: 2, unit_price: 0.9 },
]

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
  }
}

function makeSupabaseMock({ pending, combined, headersById = null, linesByHeaderId = {}, exportPostStatus = 201 }) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const pq = `${u.pathname.replace('/rest/v1/', '')}${u.search}`
    calls.push({ method, pathAndQuery: pq, headers: init.headers, body: init.body })
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=*&status=eq.pending_push')) {
      return json(pending)
    }
    // pushOne 读最新 header 事实
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=*&id=eq.')) {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(pq)?.[1] ?? '')
      const row = headersById?.[id] ?? pending.find((h) => h.id === id)
      return json(row ? [row] : [])
    }
    // 来源关系：只允许服务端 array contains + limit 1（不得全量拉取合并单）
    if (method === 'GET' && pq.startsWith('tj_po_headers?select=po_id,po_type,source_po_ids')) {
      const filter = u.searchParams.get('source_po_ids') ?? ''
      if (!filter.startsWith('cs.')) throw new Error(`禁止全量合并单查询：${pq}`)
      if (u.searchParams.get('limit') !== '1') throw new Error(`来源查询必须 limit=1：${pq}`)
      // filter='cs.{"PO-000001"}' → 取引号内的 PO 编号（Postgres 数组字面量，不是 JSON）
      const poNumber = filter.slice(5, -2)
      const hit = (combined ?? []).find((c) => (c.source_po_ids ?? []).includes(poNumber))
      return json(hit ? [hit] : [])
    }
    if (method === 'GET' && pq.startsWith('tj_po_lines?')) {
      const m = /po_header_id=eq\.([^&]+)/.exec(pq)
      return json(linesByHeaderId[m?.[1]] ?? [])
    }
    if (method === 'POST' && pq.startsWith('tj_po_exports')) return json(null, exportPostStatus)
    if (method === 'PATCH' && pq.startsWith('tj_po_headers?id=eq.')) return json(null, 204)
    throw new Error(`unexpected request ${method} ${pq}`)
  }
  return { fetchImpl, calls }
}

function makeBridgeMock({ ok = true } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok }) }
  }
  return { fetchImpl, calls }
}

function buildPusher(fixtures, bridgeResult) {
  const sb = makeSupabaseMock(fixtures)
  const br = makeBridgeMock(bridgeResult)
  const sbFetch = createSupabaseRest({
    url: 'https://sb.test',
    serviceKey: 'test-service-key',
    fetchImpl: sb.fetchImpl,
  })
  const bridgeCall = createBridgeCall({ bridgeUrl: 'http://127.0.0.1:9000', fetchImpl: br.fetchImpl })
  const logs = []
  const pusher = createPusher({
    sbFetch,
    bridgeCall,
    now: () => new Date('2026-11-12T02:00:00.000Z'),
    log: { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
    targetDir: 'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Pending',
  })
  return { pusher, sb, br, logs }
}

test('拒绝路径 bridge 零调用，普通单正常走 bridge（同一次 runOnce）', async () => {
  const { pusher, sb, br, logs } = buildPusher({
    pending: [HDR_COMBINED, HDR_SOURCE, HDR_STANDARD],
    combined: [{ po_id: 'PO-000003', po_type: 'combined', source_po_ids: ['PO-000001', 'PO-000002'] }],
    linesByHeaderId: { 'uuid-5': LINES_STANDARD },
  }, { ok: true })

  const summary = await pusher.runOnce()

  assert.equal(summary.scanned, 3)
  assert.deepEqual(summary.rejected.map((r) => r.po_id).sort(), ['PO-000001', 'PO-000003'])
  assert.deepEqual(
    summary.rejected.map((r) => r.code).sort(),
    ['COMBINED_PUSH_FROZEN', 'SOURCE_OF_COMBINED'],
  )
  assert.deepEqual(summary.pushed, [{ po_id: 'PO-000005', filename: 'PO-000005.xlsx' }])
  assert.equal(summary.failed.length, 0)

  // bridge 只被普通单调用一次
  assert.equal(br.calls.length, 1)
  assert.equal(br.calls[0].method, 'POST')
  assert.equal(
    br.calls[0].body.write.path,
    'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Pending\\PO-000005.xlsx',
  )

  // 没有为被拒单据抓明细行
  const lineFetches = sb.calls.filter((c) => c.pathAndQuery.startsWith('tj_po_lines?'))
  assert.equal(lineFetches.length, 1)
  assert.match(lineFetches[0].pathAndQuery, /po_header_id=eq\.uuid-5/)

  // 只为普通单写导出记录 + 标 exported
  const posts = sb.calls.filter((c) => c.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(JSON.parse(posts[0].body).po_id, 'PO-000005')
  const patches = sb.calls.filter((c) => c.method === 'PATCH')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].pathAndQuery, 'tj_po_headers?id=eq.uuid-5')
  assert.equal(JSON.parse(patches[0].body).status, 'exported')

  assert.ok(logs.some((l) => l.includes('[reject] PO-000003')))
  assert.ok(logs.some((l) => l.includes('[reject] PO-000001')))
  assert.ok(logs.some((l) => l.includes('[ok] PO-000005')))
})

test('所有 Supabase 请求都显式指定 public schema', async () => {
  const { pusher, sb } = buildPusher({
    pending: [HDR_STANDARD],
    combined: [],
    linesByHeaderId: { 'uuid-5': LINES_STANDARD },
  }, { ok: true })
  await pusher.runOnce()
  assert.ok(sb.calls.length >= 4)
  for (const c of sb.calls) {
    assert.equal(c.headers['Accept-Profile'], PUBLIC_SCHEMA, `${c.method} ${c.pathAndQuery}`)
    if (c.method !== 'GET') {
      assert.equal(c.headers['Content-Profile'], PUBLIC_SCHEMA, `${c.method} ${c.pathAndQuery}`)
    }
  }
})

test('普通单 PO_Lines 仍是原 7 列（不含 Website PO Date）', async () => {
  const { pusher, br } = buildPusher({
    pending: [HDR_STANDARD],
    combined: [],
    linesByHeaderId: { 'uuid-5': LINES_STANDARD },
  }, { ok: true })
  await pusher.runOnce()
  const raw = Buffer.from(br.calls[0].body.write.b64, 'base64')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(raw)
  const ws = wb.getWorksheet('PO_Lines')
  assert.ok(ws, 'sheet 名必须为 PO_Lines')
  const header = ws.getRow(1).values.slice(1)
  assert.deepEqual(header, [
    'Supplier Code',
    'Supplier Name',
    'Item Code',
    'Description',
    'UOM',
    'Qty',
    'Unit Price (RM)',
  ])
  const r2 = ws.getRow(2).values.slice(1)
  assert.equal(r2[2], '0010001000002') // 前导零保留
  assert.equal(r2[5], 5)
  assert.equal(r2[6], 1.25)
  assert.equal(ws.rowCount, 3)
})

test('bridge 失败：记为 failed，不写导出记录、不改状态', async () => {
  const { pusher, sb, br } = buildPusher({
    pending: [HDR_STANDARD],
    combined: [],
    linesByHeaderId: { 'uuid-5': LINES_STANDARD },
  }, { ok: false })
  const summary = await pusher.runOnce()
  assert.equal(br.calls.length, 1)
  assert.equal(summary.pushed.length, 0)
  assert.equal(summary.failed.length, 1)
  assert.match(summary.failed[0].error, /bridge write 失败/)
  assert.equal(sb.calls.filter((c) => c.method === 'POST').length, 0)
  assert.equal(sb.calls.filter((c) => c.method === 'PATCH').length, 0)
})

test('pushOne 自身也拒绝合并单（深度防御）', async () => {
  const { pusher, br } = buildPusher({ pending: [], combined: [] }, { ok: true })
  await assert.rejects(() => pusher.pushOne(HDR_COMBINED), /合并单永久冻结推送/)
  assert.equal(br.calls.length, 0)
})

test('pushOne 被直接调用时自行查来源关系：来源单拒绝且 bridge 零调用', async () => {
  const { pusher, br, sb } = buildPusher({
    pending: [],
    headersById: { 'uuid-1': HDR_SOURCE },
    combined: [{ po_id: 'PO-000003', po_type: 'combined', source_po_ids: ['PO-000001'] }],
  }, { ok: true })

  await assert.rejects(() => pusher.pushOne(HDR_SOURCE), /SOURCE_OF_COMBINED/)

  assert.equal(br.calls.length, 0, '来源单不得写 bridge')
  assert.ok(
    sb.calls.some((c) => c.pathAndQuery.includes('po_type=eq.combined')),
    'pushOne 必须自己查询合并单来源关系',
  )
  assert.equal(
    sb.calls.filter((c) => c.pathAndQuery.startsWith('tj_po_lines?')).length,
    0,
    '被拒绝的单据不得抓明细',
  )
})

test('推送器装配拒绝 tj_preview schema（不能注入预览库再写桥）', () => {
  assert.throws(
    () =>
      createSupabaseRest({
        url: 'https://sb.test',
        serviceKey: 'test-service-key',
        fetchImpl: async () => {
          throw new Error('不应发请求')
        },
        schema: 'tj_preview',
      }),
    /推送器只允许 public schema/,
  )
})

test('pending 为空时不调用 bridge（cron 无噪声）', async () => {
  const { pusher, br } = buildPusher({ pending: [], combined: [] }, { ok: true })
  const summary = await pusher.runOnce()
  assert.deepEqual(summary, { scanned: 0, pushed: [], rejected: [], failed: [] })
  assert.equal(br.calls.length, 0)
})
