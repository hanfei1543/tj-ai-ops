// Preview ACK 迁移声明测试（无 IO，锁定 schema 隔离与预览专属适配）。
// 验证 20261116_po_done_ack_preview.sql：
//   1) 只操作 tj_preview，不含任何 public.* 可执行语句、不碰 tj_gr_*。
//   2) 声明 push_intents(xlsx_sha256) / ack_workers / ack_receipts / ack_audit / ingest RPC。
//   3) 权限：ingest 仅 authenticated 可执行，helper 撤销 PUBLIC。
//   4) 预览专属适配：accepted 分支写 irs_po_no_verified_at / irs_po_no_verified_by
//      （tj_preview 有 trg_tj_po_irs_guard，写 irs_po_no 必须带验证证据）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sql = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/20261116_po_done_ack_preview.sql'), 'utf8')

// 去掉注释行后，不得出现 public.* / tj_gr_ 可执行语句（schema 隔离）
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

test('预览 ACK 迁移：只操作 tj_preview，不碰 public / GR', () => {
  assert.doesNotMatch(code, /public\./)
  assert.doesNotMatch(code, /tj_gr_/)
  assert.doesNotMatch(code, /tj_gr_task_result/)
})

test('预览 ACK 迁移：声明 push_intents + xlsx_sha256 + ACK 三表 + ingest RPC', () => {
  assert.match(sql, /create table if not exists tj_preview\.tj_po_push_intents/)
  assert.match(sql, /xlsx_sha256 text/)
  assert.match(sql, /create table if not exists tj_preview\.tj_po_ack_workers/)
  assert.match(sql, /create table if not exists tj_preview\.tj_po_ack_receipts/)
  assert.match(sql, /create table if not exists tj_preview\.tj_po_ack_audit/)
  assert.match(sql, /create or replace function tj_preview\.tj_po_ack_ingest\(p_payload jsonb\)/)
  assert.match(sql, /create unique index if not exists uq_tj_po_ack_receipts_event_id\s+on tj_preview\.tj_po_ack_receipts \(event_id\)/)
})

test('预览 ACK 迁移：权限 ingest 仅 authenticated，helper 撤销 PUBLIC', () => {
  assert.match(sql, /revoke all on function tj_preview\.tj_po_ack_ingest\(jsonb\) from public/)
  assert.match(sql, /grant execute on function tj_preview\.tj_po_ack_ingest\(jsonb\) to authenticated/)
  assert.match(sql, /revoke all on function tj_preview\.tj_po_ack_require_worker\(\) from public/)
  assert.match(sql, /security definer/)
  assert.match(sql, /auth\.uid\(\)/)
})

test('预览 ACK 迁移：accepted 分支写 irs_po_no 验证证据（适配 tj_preview 的 irs_guard）', () => {
  // 隔离预览专属：写 irs_po_no 必须同时写 verified_at + verified_by，否则 trg_tj_po_irs_guard 拒绝
  assert.match(sql, /irs_po_no_verified_at = now\(\)/)
  assert.match(sql, /irs_po_no_verified_by = 'po-ack:'/)
  assert.match(sql, /erp_status = 'saved_verified_queue_done'/)
})

test('预览 ACK 迁移：投递意图 state 约束含 delivered（ACK 的 Push Delivery 依据）', () => {
  assert.match(sql, /state in \('dispatch_started', 'delivered', 'delivery_uncertain', 'needs_review'\)/)
})
