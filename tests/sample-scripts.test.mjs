// 旧模拟样本脚本必须停用（不再产出"冒充已批准"的样本）
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('gen_sample.mjs 直接执行即拒绝（退出码 2，指向真实数据脚本）', () => {
  const r = spawnSync(process.execPath, ['scripts/gen_sample.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /已停用/)
  assert.match(r.stderr, /gen_po_excel\.mjs/)
  assert.equal(r.stdout.trim(), '')
})

test('gen_sample.mjs 带任何参数也拒绝执行', () => {
  const r = spawnSync(process.execPath, ['scripts/gen_sample.mjs', '--po', 'PO-000003'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(r.status, 2)
})

test('gen_po_excel.mjs 参数校验：未知参数 / 非法 mode 直接失败', () => {
  const bad = spawnSync(process.execPath, ['scripts/gen_po_excel.mjs', '--nope'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /未知参数/)

  const badMode = spawnSync(process.execPath, ['scripts/gen_po_excel.mjs', '--mode', 'approved'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(badMode.status, 1)
  assert.match(badMode.stderr, /--mode 只允许 review 或 formal/)
})
