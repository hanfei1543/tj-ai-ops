// 推送器入口装配测试：import 入口不得启动 main / 不连网；依赖可注入。
// 注意：绝不在这里调用不带 env 注入的 main()/startPusher()，那会连真实库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startPusher, main, loadEnvFile } from '../scripts/tj-po-push.mjs'

const HDR_STANDARD = {
  id: 'uuid-5',
  po_id: 'PO-000005',
  po_type: 'standard',
  status: 'pending_push',
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
}

function makeSbFetch({ pending, combined = [], headersById = null, lines }) {
  const calls = []
  const fn = async (pathname, opts = {}) => {
    calls.push({ pathname, method: (opts.method ?? 'GET').toUpperCase() })
    if (pathname.startsWith('tj_po_headers?select=*&status=eq.pending_push')) return pending
    if (pathname.startsWith('tj_po_headers?select=*&id=eq.')) {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(pathname)?.[1] ?? '')
      const row = headersById?.[id] ?? pending.find((h) => h.id === id)
      return row ? [row] : []
    }
    if (pathname.startsWith('tj_po_headers?select=po_id,po_type,source_po_ids')) {
      const filter = new URLSearchParams(pathname.split('?')[1]).get('source_po_ids')
      if (!filter?.startsWith('cs.')) throw new Error('不得全量拉取合并单')
      // filter='cs.{"PO-000001"}' → 取引号内的 PO 编号（Postgres 数组字面量，不是 JSON）
      const poNumber = filter.slice(5, -2)
      const hit = combined.find((c) => (c.source_po_ids ?? []).includes(poNumber))
      return hit ? [hit] : []
    }
    if (pathname.startsWith('tj_po_lines?')) return lines
    if (pathname.startsWith('tj_po_exports')) return null
    if (pathname.startsWith('tj_po_headers?id=eq.')) return null
    throw new Error(`unexpected ${pathname}`)
  }
  return { fn, calls }
}

test('import 入口无副作用：只导出装配函数，不触发推送', () => {
  assert.equal(typeof startPusher, 'function')
  assert.equal(typeof main, 'function')
  assert.equal(typeof loadEnvFile, 'function')
})

test('缺凭据时 startPusher 明确报错（不发请求）', async () => {
  await assert.rejects(() => startPusher({ env: {}, once: true }), /缺 Supabase 凭据/)
})

test('main 在缺凭据时返回 1（不退出进程、不推送）', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    assert.equal(await main([], { env: {} }), 1)
  } finally {
    console.error = originalError
  }
})

test('--once 装配后只跑一轮，依赖注入的 mock 被调用', async () => {
  const sb = makeSbFetch({
    pending: [HDR_STANDARD],
    combined: [],
    lines: [{ id: 'l1', line_no: 1, item_code: 'X1', description: 'D', uom: 'UNIT', qty: 1, unit_price: 2 }],
  })
  const bridgeCalls = []
  const bridgeCall = async (payload) => {
    bridgeCalls.push(payload)
    return { ok: true }
  }
  const summary = await startPusher({
    argv: ['--once'],
    env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
    sbFetch: sb.fn,
    bridgeCall,
    log: { log: () => {}, error: () => {} },
  })
  assert.equal(summary.scanned, 1)
  assert.equal(summary.pushed.length, 1)
  assert.equal(bridgeCalls.length, 1)
  assert.match(bridgeCalls[0].write.path, /PO-000005\.xlsx$/)
})
