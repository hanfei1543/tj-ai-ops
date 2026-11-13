// public PREPARED 迁移的「构建一致性」守卫（文件级，不是数据库集成测试）：
//   * 与 tj_preview 版本同步（由 scripts/gr-gen-public-prepared.mjs 生成）
//   * 文件名没有版本号前缀 → 迁移工具不会自动套用
//   * 内含 SQL 手工门禁（set_config + raise）
//   * 不包含预览专属收紧块
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, SRC, OUT } from '../scripts/gr-gen-public-prepared.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('public PREPARED 与预览版逐字节同步（防止手改漂移）', async () => {
  const src = await readFile(SRC, 'utf8')
  const expected = generate(src)
  const actual = await readFile(OUT, 'utf8')
  assert.equal(actual, expected, '请运行 node scripts/gr-gen-public-prepared.mjs 重新生成')
})

test('public 文件名无版本前缀（迁移工具不会自动套用）', () => {
  const base = path.basename(OUT)
  assert.ok(!/^\d{8,}/.test(base), `文件名不应以时间戳版本开头：${base}`)
  assert.match(base, /prepared/)
})

test('public 版带 SQL 手工门禁，且门禁在第一条 DDL 之前', async () => {
  const text = await readFile(OUT, 'utf8')
  const gateIdx = text.indexOf("current_setting('tj.gr.apply_public'")
  const firstDdlIdx = text.indexOf('create table if not exists public.tj_gr_memberships')
  assert.ok(gateIdx > 0, '缺少 set_config 门禁')
  assert.ok(firstDdlIdx > gateIdx, '门禁必须在 DDL 之前')
  assert.match(text, /AUTHORIZED_MANUAL/)
})

test('public 版不含预览专属块，也不含 tj_preview 限定符', async () => {
  const text = await readFile(OUT, 'utf8')
  const body = text.slice(text.indexOf('-- 0) 前置检查'))
  assert.ok(!body.includes('PREVIEW_ONLY_LEGACY_HARDENING'), '不应包含预览专属收紧块')
  assert.ok(!body.includes('tj_preview'), 'public 版正文不应引用 tj_preview')
  assert.ok(body.includes('tj_preview') === false)
})

test('public 版保留既有护栏（不关闭 freeze/push/IRS guard）', async () => {
  const text = await readFile(OUT, 'utf8')
  for (const needed of [
    'tj_po_header_frozen_guard',
    'tj_po_irs_guard',
    'uq_tj_po_headers_receipt_event_id',
    'tj_po_combined_requires_date',
  ]) {
    assert.ok(text.includes(needed) || !text.includes(`drop ${needed}`), `public 版不应删除 ${needed}`)
  }
  assert.ok(!/drop\s+trigger[^;]*trg_tj_po_header_frozen_guard/i.test(text), '不得 drop 既有 freeze guard')
})

test('public 版不得把「service_role 禁入 public」整块带过去（B9）', async () => {
  const text = await readFile(OUT, 'utf8')
  // 预览库才允许整体撤 service_role；public 里 DYT / 推送器 / 全局默认权限必须保留
  assert.ok(!/revoke\s+all\s+on\s+schema\s+public\s+from\s+service_role/i.test(text), '不得撤 public schema USAGE')
  assert.ok(
    !/revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+service_role/i.test(text),
    '不得批量撤 public 表的 service_role 权限（会打穿 DYT）',
  )
  assert.ok(
    !/revoke\s+all\s+on\s+all\s+functions\s+in\s+schema\s+public\s+from\s+service_role/i.test(text),
    '不得批量撤 public 函数的 service_role 权限',
  )
  assert.ok(
    !/revoke\s+all\s+on\s+all\s+sequences\s+in\s+schema\s+public\s+from\s+service_role/i.test(text),
    '不得批量撤 public 序列的 service_role 权限',
  )
  assert.ok(!text.includes('PREVIEW_ONLY_SERVICE_ROLE_LOCKOUT'), '预览专属块必须被剥离')
  // 读回期望写清楚：public 的 service_role USAGE 仍是 true（原有权限）
  assert.match(text, /has_schema_privilege\('service_role',\s*'public',\s*'USAGE'\);\s*--\s*期望 true/)
})

test('public 版明确声明旧 anon 宽权限是生产阻塞（不得声称已生产安全）', async () => {
  const text = await readFile(OUT, 'utf8')
  assert.match(text, /生产阻塞/)
  assert.match(text, /anon/)
  assert.match(text, /PREPARED/)
})

