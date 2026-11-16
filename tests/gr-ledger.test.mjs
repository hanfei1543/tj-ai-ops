// JSONL 账本持久化状态机测试：latest-wins / 非终态不当作已处理 / 跨重启重载 / SHA 绑定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLedger } from '../scripts/windows/gr-worker/ledger.mjs'

const TID = 'a5000000-0000-4000-8000-000000000001'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

test('latest-wins：同一 task_id 多条记录，get 返回最后一条', () => {
  const l = createLedger({})
  l.record({ task_id: TID, payload_sha256: SHA_A, status: 'received', terminal: false })
  l.record({ task_id: TID, payload_sha256: SHA_A, status: 'waiting_pad', terminal: false })
  l.record({ task_id: TID, payload_sha256: SHA_A, status: 'verified', terminal: true })
  const e = l.get(TID)
  assert.equal(e.status, 'verified')
  assert.equal(e.terminal, true)
  assert.equal(e.payload_sha256, SHA_A)
})

test('非终态(waiting_pad)不会把任务当作已处理（terminal=false）', () => {
  const l = createLedger({})
  l.record({ task_id: TID, payload_sha256: SHA_A, status: 'waiting_pad', terminal: false })
  const e = l.get(TID)
  assert.equal(e.terminal, false)
  assert.equal(e.status, 'waiting_pad')
})

test('跨重启重载：写入文件 → 新建 ledger 重载 → get 返回持久化状态', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gr-ledger-'))
  const file = path.join(dir, 'ledger.jsonl')
  try {
    const l1 = createLedger({ file })
    l1.record({ task_id: TID, payload_sha256: SHA_A, status: 'received', terminal: false })
    l1.record({ task_id: TID, payload_sha256: SHA_A, status: 'verified', terminal: true })

    // 模拟 Worker 重启：新建 ledger 从同一文件加载
    const l2 = createLedger({ file })
    const e = l2.get(TID)
    assert.equal(e.status, 'verified')
    assert.equal(e.terminal, true)
    assert.equal(e.payload_sha256, SHA_A)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('跨重启重载：非终态记录重载后仍是 terminal=false（不丢失“未完成”状态）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gr-ledger-'))
  const file = path.join(dir, 'ledger.jsonl')
  try {
    const l1 = createLedger({ file })
    l1.record({ task_id: TID, payload_sha256: SHA_A, status: 'claimed', terminal: false })
    const l2 = createLedger({ file })
    const e = l2.get(TID)
    assert.equal(e.status, 'claimed')
    assert.equal(e.terminal, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('get 未知 task_id 返回 null', () => {
  const l = createLedger({})
  assert.equal(l.get('ffffffff-0000-4000-8000-000000000000'), null)
})

test('record 缺 task_id 抛错', () => {
  const l = createLedger({})
  assert.throws(() => l.record({ status: 'received', terminal: false }))
})
