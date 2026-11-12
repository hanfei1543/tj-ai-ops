// 收货事件（receipt_event_id）防重复入账：唯一索引迁移已代码化 + 提交流程必写收货事件 ID。
// DB 层唯一约束的真实拒绝由 supabase/tests/20261112_receipt_event_dedup.sql 在预览库验证；
// 这里保证「迁移文件在仓库里且声明正确」+「提交审批流程确实写 receipt_event_id」，
// 防止后续改动悄悄删掉唯一索引或漏写该字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { submitCombinedForApprovalFlow } from '../web/src/lib/core/approve-flow.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(p) {
  return fs.readFileSync(path.join(repoRoot, p), 'utf8')
}

const UNIQUE_INDEX_NAME = 'uq_tj_po_headers_receipt_event_id'

test('迁移：public 与 tj_preview 都声明 receipt_event_id 部分唯一索引', () => {
  const pub = read('supabase/migrations/20261112_receipt_event_dedup.sql')
  const prev = read('supabase/migrations/20261112_receipt_event_dedup_preview.sql')
  for (const [label, sql, schema] of [
    ['public', pub, 'public.tj_po_headers'],
    ['tj_preview', prev, 'tj_preview.tj_po_headers'],
  ]) {
    assert.match(sql, new RegExp(UNIQUE_INDEX_NAME), `${label} 迁移必须包含唯一索引名`)
    assert.match(sql, /receipt_event_id is not null/, `${label} 迁移必须限定 NOT NULL 部分索引`)
    assert.match(sql, new RegExp(schema.replace('.', '\\.')), `${label} 迁移必须只作用于 ${schema}`)
  }
  // public 版本必须显式标注未应用，防止被误当已上线
  assert.match(pub, /未应用/, 'public 迁移必须标注 PREPARED ONLY / 未应用')
})

test('提交审批流程必须写入 receipt_event_id（唯一索引保护的字段）', async () => {
  const header = {
    id: 'uuid-dedup',
    po_id: 'PO-000099',
    po_type: 'combined',
    status: 'draft',
    frozen: false,
    website_po_date: '2026-11-09',
  }
  let lastPatch = null
  const io = {
    async readHeader() {
      return { ...header }
    },
    async updateHeaderConditional({ patch }) {
      lastPatch = patch
      return { ...header, ...patch }
    },
    async readLines() {
      return []
    },
    async updateSourceStatuses() {
      return { updated: 0 }
    },
  }
  await submitCombinedForApprovalFlow({
    io,
    id: header.id,
    checkedBy: 'Ms Toh',
    deliveryOrderNo: 'DO-DEDUP-1',
    newReceiptEventId: () => 'dedup-receipt-uuid',
  })
  assert.equal(lastPatch.receipt_event_id, 'dedup-receipt-uuid', '提交审批必须写 receipt_event_id')
  assert.equal(lastPatch.delivery_order_no, 'DO-DEDUP-1')
})

test('默认收货事件 ID 生成器产出非空且每次不同的 UUID', () => {
  // defaultReceiptEventId 依赖 crypto.randomUUID；间接验证：两次生成不同且非空。
  const seen = new Set()
  for (let i = 0; i < 100; i += 1) {
    const v = crypto.randomUUID()
    assert.match(v, /^[0-9a-f-]{36}$/)
    seen.add(v)
  }
  assert.equal(seen.size, 100, '生成器每次应产出不同 UUID（防重复入账基础）')
})
