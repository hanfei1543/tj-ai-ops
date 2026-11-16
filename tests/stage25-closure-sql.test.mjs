// Stage25 Preview 修复包 —— 迁移静态隔离检查 + 真实 SQL 集成测试入口。
//
// 两个部分：
//   1) 静态：20261116_stage25_preview_closure.sql 只操作 tj_preview，不含 public.* 语句，
//      不改既有 GR 对象，且四块契约（请求表 / 证据链 / 人工对账 / ACK wrapper）都在。
//   2) 真实 SQL：scripts/stage25-local-smoke.mjs 在 PGlite(内嵌 Postgres) 里按真实部署
//      顺序执行 fixture → ACK v1 → 本包迁移（跑两次证明可重入）→
//      supabase/tests/20261116_stage25_closure_integration.sql 的全部断言。
//      没有 @electric-sql/pglite 时**跳过**（不伪装通过）：
//        npm i --prefix /tmp/stage25-pg @electric-sql/pglite
//        STAGE25_PGLITE_ENTRY=/tmp/stage25-pg/node_modules/@electric-sql/pglite/dist/index.js npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runStage25Harness, checkEventIdFormula, SQL_FILES } from '../scripts/stage25-local-smoke.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migration = fs.readFileSync(path.join(repoRoot, SQL_FILES.closure), 'utf8')

// 去掉注释行后只留可执行语句
const code = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

test('Stage25 迁移：只操作 tj_preview，不含 public.* 可执行语句', () => {
  assert.doesNotMatch(code, /\bpublic\./i)
  assert.doesNotMatch(code, /create\s+(or\s+replace\s+)?(table|function|policy)\s+(public|auth|extensions)\./i)
  assert.doesNotMatch(code, /grant\s+.*\s+on\s+.*\s+in\s+schema\s+public/i)
})

test('Stage25 迁移：不改动既有 GR / ACK v1 对象定义（只读 + 改名 + wrapper）', () => {
  // 不允许改 tj_gr_* 的对象
  assert.doesNotMatch(code, /alter\s+table\s+tj_preview\.tj_gr_/i)
  assert.doesNotMatch(code, /drop\s+(table|function|trigger)\s+(if\s+exists\s+)?tj_preview\.tj_gr_/i)
  // ACK v1 主体只允许改名，不允许重建
  assert.match(code, /rename\s+to\s+tj_po_ack_ingest_v1_internal/i)
  assert.doesNotMatch(code, /create\s+(or\s+replace\s+)?function\s+tj_preview\.tj_po_ack_ingest_v1_internal/i)
})

test('Stage25 迁移：四块契约对象齐备', () => {
  assert.match(code, /create table if not exists tj_preview\.tj_po_preview_push_requests/i)
  assert.match(code, /create or replace function tj_preview\.tj_po_preview_request_push\(p_po_header_id uuid, p_request_id text\)/i)
  assert.match(code, /add column if not exists delivery_channel text not null default 'legacy_local_unverified'/i)
  assert.match(code, /create table if not exists tj_preview\.tj_po_push_delivery_evidence/i)
  assert.match(code, /create table if not exists tj_preview\.tj_po_manual_reconciliations/i)
  assert.match(code, /create or replace function tj_preview\.tj_po_manual_reconcile\(p_payload jsonb\)/i)
  assert.match(code, /create or replace function tj_preview\.tj_po_ack_ingest\(p_payload jsonb\)/i)
  assert.match(code, /create or replace function tj_preview\.tj_po_ack_event_id\(/i)
})

test('Stage25 迁移：权限模型（手动通道 postgres-only，helper 撤权）', () => {
  for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
    assert.match(
      code,
      new RegExp(`revoke all on function tj_preview\\.tj_po_manual_reconcile\\(jsonb\\) from ${role}`, 'i'),
    )
    assert.match(
      code,
      new RegExp(`revoke all on function tj_preview\\.tj_po_ack_pending\\([^)]*\\) from ${role}`, 'i'),
      `时序 pending helper 必须撤销 ${role} EXECUTE`,
    )
  }
  assert.match(code, /revoke all on function tj_preview\.tj_po_ack_ingest_v1_internal\(jsonb\) from authenticated/i)
  assert.match(code, /grant execute on function tj_preview\.tj_po_ack_ingest\(jsonb\) to authenticated/i)
  assert.match(code, /grant execute on function tj_preview\.tj_po_preview_request_push\(uuid, text\) to authenticated/i)
  // 新表必须显式撤销 service_role（不扩大任何表权限）
  for (const table of ['tj_po_preview_push_requests', 'tj_po_push_delivery_evidence']) {
    assert.match(
      code,
      new RegExp(`revoke all on table tj_preview\\.${table} from service_role`, 'i'),
      `${table} 必须显式 revoke service_role`,
    )
  }
})

test('Stage25 迁移：人工对账与证据表是追加式（禁止 UPDATE/DELETE/TRUNCATE）', () => {
  assert.match(code, /trg_tj_po_manual_reconciliations_append_only[\s\S]{0,200}before update or delete/i)
  assert.match(code, /trg_tj_po_push_delivery_evidence_append_only[\s\S]{0,200}before update or delete/i)
  assert.match(code, /before truncate on tj_preview\.tj_po_manual_reconciliations/i)
  assert.match(code, /before truncate on tj_preview\.tj_po_push_delivery_evidence/i)
})

test('Stage25 真实 SQL：迁移 + 集成断言（PGlite）', async (t) => {
  const out = await runStage25Harness()
  if (out.skipped) {
    t.skip(`缺少 @electric-sql/pglite：${out.reason}`)
    return
  }
  assert.equal(out.failed, 0, `断言语义失败 ${out.failed} 条`)
  assert.equal(out.passed, out.assertions)
  // 断言数量下限：低于这个数说明测试被削弱了
  assert.ok(out.assertions >= 130, `断言数只有 ${out.assertions}，低于契约要求的下限 130`)
})

test('Stage25 真实 SQL：确定性 event_id 与客户端算法逐字节一致', async (t) => {
  const out = await checkEventIdFormula().catch((err) => {
    if (err.code === 'PGLITE_MISSING') return { skipped: true, reason: err.message }
    throw err
  })
  if (out.skipped) {
    t.skip(`缺少 @electric-sql/pglite：${out.reason}`)
    return
  }
  assert.equal(out.sqlEventId, out.jsEventId)
  assert.match(out.sqlEventId, /^tj\.po\.queue\.done\.v1\.[0-9a-f]{64}$/)
})
