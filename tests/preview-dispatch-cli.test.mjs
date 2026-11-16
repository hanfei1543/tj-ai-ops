// Preview 投递 CLI 装配回归：只允许显式 --request-id 单次运行，不启常驻/轮询，
// 不复用生产 startPusher，只走 Management API db/query（PostgREST service_role 对
// tj_preview 无权限）。依赖注入，测试不触网、不读真实 .env。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createManagementDbQuery,
  main,
  parseArgs,
  resolveConfig,
} from '../scripts/preview-po-dispatch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'scripts/preview-po-dispatch.mjs')

test('参数：必须显式 --request-id；拒绝 runall/poll/once/schema', () => {
  assert.deepEqual(parseArgs(['--request-id', 'req-12345678']), { requestId: 'req-12345678' })
  assert.throws(() => parseArgs([]), (e) => e.code === 'REQUEST_ID_REQUIRED')
  assert.throws(() => parseArgs(['--request-id']), (e) => e.code === 'REQUEST_ID_REQUIRED')
  for (const bad of [['--all'], ['--poll'], ['--once'], ['--loop'], ['--schema', 'public'], ['--request-id', 'x', '--all']]) {
    assert.throws(
      () => parseArgs(bad),
      (e) => e.code === 'UNKNOWN_ARG' || e.code === 'INVALID_REQUEST_ID',
      `必须拒绝：${bad.join(' ')}`,
    )
  }
  assert.throws(() => parseArgs(['--request-id', 'req-12345678', '--target-dir', '/tmp/other']), (e) =>
    e.code === 'INVALID_TARGET_DIR',
  )
})

test('配置：PAT / project ref 缺失直接失败，错误信息不含凭据', () => {
  assert.throws(() => resolveConfig({}), (e) => e.code === 'MISSING_PAT')
  assert.throws(() => resolveConfig({ SUPABASE_PAT: 'sbp_secret' }), (e) => e.code === 'MISSING_PROJECT_REF')
  const c = resolveConfig({
    SUPABASE_PAT: 'sbp_secret',
    SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  })
  assert.equal(c.projectRef, 'abcdefghijklmnop')
  assert.equal(c.pat, 'sbp_secret')
  try {
    resolveConfig({})
  } catch (e) {
    assert.equal(e.message.includes('sbp_'), false)
  }
})

test('Management API：只 POST database/query，带 Bearer，拒绝 public，错误不泄露 PAT', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (String(url).includes('boom')) {
      return { ok: false, status: 500, text: async () => 'internal error' }
    }
    return { ok: true, status: 201, text: async () => JSON.stringify([{ ok: 1 }]) }
  }
  const dbQuery = createManagementDbQuery({ projectRef: 'abcdefghijklmnop', pat: 'sbp_secret', fetchImpl })
  const rows = await dbQuery('select 1 from tj_preview.tj_po_headers')
  assert.deepEqual(rows, [{ ok: 1 }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.supabase.com/v1/projects/abcdefghijklmnop/database/query')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sbp_secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'select 1 from tj_preview.tj_po_headers' })

  await assert.rejects(dbQuery('select * from public.tj_po_headers'), (e) => e.code === 'PUBLIC_SCHEMA_FORBIDDEN')

  const failing = createManagementDbQuery({
    projectRef: 'abcdefghijklmnop',
    pat: 'sbp_secret',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  })
  await assert.rejects(failing('select 1 from tj_preview.x'), (e) => {
    assert.equal(e.message.includes('sbp_secret'), false, '错误信息不得包含 PAT')
    return e.code === 'MGMT_QUERY_FAILED'
  })
})

test('CLI 源码：不启常驻/轮询、不 import 生产 startPusher、无默认 runall', () => {
  const src = fs.readFileSync(SRC, 'utf8')
  assert.equal(/startPusher/.test(src), false, '不得复用生产推送器入口')
  assert.equal(/POLL_SEC|setInterval|for \(;;\)/.test(src), false, '不得常驻/轮询')
  assert.match(src, /--request-id/)
  assert.match(src, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/)
  assert.match(src, /loadEnvFile/)
})

test('main：成功返回 0；uncertain 返回 2；配置缺失返回 1（stdout 仅结构化摘要）', async () => {
  const out = []
  const log = {
    log: (m) => out.push(m),
    error: (m) => out.push(`ERR ${m}`),
  }
  const artifacts = { prepare: async () => ({ path: '/tmp/x', sha256: 'a', byteCount: 1 }), read: async () => Buffer.from('') }
  const okDeps = {
    env: { SUPABASE_PAT: 'sbp_test_value', SUPABASE_PROJECT_REF: 'abcdefgh' },
    dbQuery: async () => [],
    bridge: async () => ({ ok: true }),
    artifacts,
    log,
  }
  const okCode = await main(['--request-id', 'req-12345678'], {
    ...okDeps,
    runPreviewDispatch: async () => ({
      ok: true,
      requestId: 'req-12345678',
      poId: 'PO-000101',
      state: 'delivered',
      xlsxSha256: 'a'.repeat(64),
      byteCount: 12,
      artifactPath: '/p/x.xlsx',
      evidence: { serverPrepared: true, windowsReceived: true },
    }),
  })
  assert.equal(okCode, 0)
  const summary = JSON.parse(out.at(-1))
  assert.equal(summary.outcome, 'delivered')
  assert.equal(summary.requestId, 'req-12345678')

  const uncertainCode = await main(['--request-id', 'req-12345678'], {
    ...okDeps,
    runPreviewDispatch: async () => {
      const e = new Error('bridge failed after write')
      e.code = 'BRIDGE_WRITE_FAILED'
      e.uncertain = true
      throw e
    },
  })
  assert.equal(uncertainCode, 2)
  const uncertain = JSON.parse(out.at(-1))
  assert.equal(uncertain.outcome, 'delivery_uncertain')
  assert.equal(uncertain.code, 'BRIDGE_WRITE_FAILED')

  const badCode = await main(['--request-id', 'req-12345678'], {
    ...okDeps,
    env: {},
  })
  assert.equal(badCode, 1)
  assert.equal(JSON.parse(out.at(-1)).outcome, 'error')
  assert.equal(/sbp_|Bearer\s+\S{8,}/.test(out.join('\n')), false, '不得打印凭据')
})
