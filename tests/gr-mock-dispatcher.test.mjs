// GR 模拟 dispatcher：只写本地 scratch，硬拒绝真实出队线索。
// 注意：这是文件级守卫测试，不是数据库集成测试（DB 部分由 SQL 集成脚本覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildDispatchPlan,
  writeDispatchPlan,
  validateDispatchRow,
  assertLocalPosixPath,
  DispatchRefused,
  DISPATCH_SCHEMA,
} from '../scripts/gr-mock-dispatcher.mjs'

const TASK = '77777777-7777-4777-8777-777777777777'

function row(over = {}) {
  return {
    task_id: TASK,
    request_id: `gr:${TASK}`,
    receipt_event_id: '11111111-1111-4111-8111-111111111111',
    po_header_id: '55555555-5555-4555-8555-555555555555',
    environment: 'preview',
    mock_only: true,
    task_type: 'GOODS_RECEIVE',
    schema: 'tj.gr.v1',
    status: 'pending',
    payload_sha256: 'a'.repeat(64),
    payload: {
      task: { id: TASK, type: 'GOODS_RECEIVE', schema: 'tj.gr.v1', environment: 'preview' },
      event_payload_sha256: 'b'.repeat(64),
      scope: { lines: [{ line_id: 'x', accepted_qty: '4' }] },
    },
    ...over,
  }
}

async function scratchDir() {
  const root = process.env.HERMES_SCRATCH || os.tmpdir()
  return fs.mkdtemp(path.join(root, 'gr-disp-test-'))
}

function refusal(fn, code) {
  assert.throws(fn, (e) => e instanceof DispatchRefused && e.code === code)
}

async function refusalAsync(promise, code) {
  await assert.rejects(promise, (e) => e instanceof DispatchRefused && e.code === code)
}

test('合法预览任务 → 生成计划与文件（manifest 计数一致）', async () => {
  const plan = buildDispatchPlan({ rows: [row()] })
  assert.equal(plan.schema, DISPATCH_SCHEMA)
  assert.equal(plan.mode, 'mock')
  assert.equal(plan.count, 1)
  assert.match(plan.files[0].content, /"mode": "mock"/)

  const dir = await scratchDir()
  const out = await writeDispatchPlan(plan, { outdir: path.join(dir, 'out'), root: dir })
  assert.equal(out.count, 1)
  const files = await fs.readdir(path.join(dir, 'out'))
  assert.deepEqual(files.sort(), [`task-${TASK}.json`, 'manifest.json'].sort())
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'out', 'manifest.json'), 'utf8'))
  assert.equal(manifest.count, 1)
  assert.equal(manifest.tasks[0].payload_sha256, 'a'.repeat(64))
  await fs.rm(dir, { recursive: true, force: true })
})

test('拒绝非 preview / 非 mock_only / 错误 type / 错误 schema', () => {
  refusal(() => validateDispatchRow(row({ environment: 'public' })), 'GR_DISPATCH_ENV')
  refusal(() => validateDispatchRow(row({ mock_only: false })), 'GR_DISPATCH_MOCK_ONLY')
  refusal(() => validateDispatchRow(row({ task_type: 'PO_PUSH' })), 'GR_DISPATCH_TASK_TYPE')
  refusal(() => validateDispatchRow(row({ schema: 'tj.gr.v2' })), 'GR_DISPATCH_SCHEMA')
  refusal(() => validateDispatchRow(row({ payload_sha256: 'nope' })), 'GR_DISPATCH_HASH')
  refusal(() => validateDispatchRow(row({ task_id: 'not-a-uuid' })), 'GR_DISPATCH_TASK_ID')
})

test('拒绝 payload 里的真实出队线索（http / bridge / Windows 路径）', () => {
  refusal(
    () => validateDispatchRow(row({ payload: { ...row().payload, bridge_url: 'http://127.0.0.1:9000/write' } })),
    'GR_DISPATCH_REAL_BRIDGE',
  )
  refusal(
    () => validateDispatchRow(row({ payload: { ...row().payload, target: 'C:\\Users\\Administrator\\Desktop\\PO_Queue\\Pending' } })),
    'GR_DISPATCH_REAL_BRIDGE',
  )
})

test('拒绝 Windows 输出路径与 root 之外的目录；dry-run 不落盘', async () => {
  refusal(() => assertLocalPosixPath('C:\\temp\\out', 'outdir'), 'GR_DISPATCH_WINDOWS_PATH')
  refusal(() => assertLocalPosixPath('\\\\server\\share', 'outdir'), 'GR_DISPATCH_WINDOWS_PATH')

  const plan = buildDispatchPlan({ rows: [row()] })
  const dir = await scratchDir()
  // 兄弟目录（不含 ..，确保命中「不在 root 之内」而不是路径规范化检查）
  const sibling = path.join(path.dirname(dir), `gr-escape-${Date.now()}`)
  await refusalAsync(
    writeDispatchPlan(plan, { outdir: sibling, root: dir }),
    'GR_DISPATCH_OUTSIDE_ROOT',
  )
  await refusalAsync(
    // 不经过 path.join 归一化，保留 .. 以命中路径检查
    writeDispatchPlan(plan, { outdir: `${dir}/../escape`, root: dir }),
    'GR_DISPATCH_PATH',
  )

  const dry = await writeDispatchPlan(plan, { outdir: path.join(dir, 'out'), root: dir, dryRun: true })
  assert.equal(dry.dry_run, true)
  await assert.rejects(fs.readdir(path.join(dir, 'out')))
  await fs.rm(dir, { recursive: true, force: true })
})

test('空批次 / 重复 request_id 被拒（不允许静默重复出队）', () => {
  refusal(() => buildDispatchPlan({ rows: [] }), 'GR_DISPATCH_EMPTY')
  refusal(() => buildDispatchPlan({ rows: [row(), row()] }), 'GR_DISPATCH_DUPLICATE')
})
