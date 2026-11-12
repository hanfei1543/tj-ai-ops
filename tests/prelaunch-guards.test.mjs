// 上线前冻结口径的静态守卫：
//   * 迁移文件命名/内容（public 与 preview 分离、冻结整行、old/new parent、预览推送总闸）
//   * Add New Item 写 API 停止、旧隐藏快捷键已移除、合并单日期必填
// 这些是防止后续改动悄悄放宽业务边界的回归线。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
// 去掉 SQL 行注释后再做 schema 交叉引用断言（注释里说明"不动 public"是允许的）
const readSql = (rel) =>
  read(rel)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')

test('迁移文件命名：旧 20261113 名称不再存在，public/preview 分离', () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, 'supabase/migrations/20261113_po_push_freeze_and_metadata.sql')),
    false,
  )
  assert.ok(fs.existsSync(path.join(ROOT, 'supabase/migrations/20261112_prelaunch_guards.sql')))
  assert.ok(fs.existsSync(path.join(ROOT, 'supabase/migrations/20261112_prelaunch_guards_preview.sql')))
})

test('public 迁移不引用 tj_preview；preview 迁移不引用 public', () => {
  const pub = readSql('supabase/migrations/20261112_prelaunch_guards.sql')
  const prev = readSql('supabase/migrations/20261112_prelaunch_guards_preview.sql')
  assert.equal(/tj_preview\./.test(pub), false, 'public 文件不得操作 tj_preview')
  assert.equal(/public\./.test(prev), false, 'preview 文件不得操作 public')
})

test('数据库层面：日期硬约束 + 冻结整行保护（OLD.frozen）', () => {
  const pub = read('supabase/migrations/20261112_prelaunch_guards.sql')
  assert.match(pub, /tj_po_combined_requires_date/)
  assert.match(pub, /status not in \('pending_approval', 'confirmed'\)/)
  assert.match(pub, /coalesce\(old\.frozen, false\) and row\(new\.\*\) is distinct from row\(old\.\*\)/)
  assert.match(pub, /tg_op = 'DELETE'/)
  assert.match(pub, /批准后 Website PO Date 已冻结/)
})

test('明细冻结保护同时检查 OLD 与 NEW parent', () => {
  const pub = read('supabase/migrations/20261112_prelaunch_guards.sql')
  assert.match(pub, /tg_op in \('UPDATE', 'DELETE'\)/)
  assert.match(pub, /tg_op in \('INSERT', 'UPDATE'\)/)
  assert.match(pub, /old\.po_header_id/)
  assert.match(pub, /new\.po_header_id/)
})

test('Preview 迁移有推送总闸：任何 pending_push / exported 一律拒绝', () => {
  const prev = read('supabase/migrations/20261112_prelaunch_guards_preview.sql')
  assert.match(prev, /new\.status in \('pending_push', 'exported'\)/)
  assert.match(prev, /所有单据一律拒绝，含普通测试单/)
  assert.match(prev, /create or replace function tj_preview\.tj_po_push_guard/)
})

test('应用层：Add New Item 写 API 全停 + 旧隐藏快捷键已移除', () => {
  const flags = read('web/src/lib/featureFlags.ts')
  assert.match(flags, /ADD_ITEM_WRITES_ENABLED = false/)
  assert.equal(flags.includes('ADD_ITEM_UNLOCK_KEY'), false)

  const list = read('web/src/pages/TjPoSystemPage.tsx')
  assert.equal(list.includes('ALT+I'), false)
  assert.equal(/altKey/.test(list), false)
  assert.equal(list.includes('ADD_ITEM_UNLOCK_KEY'), false)
  assert.equal(list.includes('onAddItem'), false)

  const api = read('web/src/lib/tjPoApi.ts')
  assert.ok((api.match(/assertAddItemWritable\(/g) ?? []).length >= 4)
  assert.match(api, /if \(!ADD_ITEM_WRITES_ENABLED\)/)
})

test('应用层：合并单日期必填 + 提交/批准双校验 + canStoreDate 失败即阻断', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /if \(!\(await probeWebsitePoDateColumn\(\)\)\)/)
  assert.match(api, /合并已阻止/)
  assert.match(api, /submitCombinedForApprovalFlow/)
  assert.match(api, /approveCombinedPoFlow/)
  assert.equal(/canStoreDate/.test(api), false, '不得再静默跳过日期保存')

  // 校验逻辑仍在 core（提交/批准门禁），由流程模块调用
  const flow = read('web/src/lib/core/approve-flow.js')
  assert.match(flow, /assertCombinedSubmittable\(hdr\)/)
  assert.match(flow, /assertCombinedApprovable\(hdr\)/)
  assert.match(flow, /verifyApprovedSnapshot/)

  const combine = read('web/src/pages/CombinePoPage.tsx')
  assert.match(combine, /if \(!date\)/)
  assert.match(combine, /Website PO Date 必填/)
})

test('应用层：提交/批准多步写入必须条件更新 + .select().single() 确认命中', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /\.update\(patch\)[\s\S]{0,200}\.eq\('id', id\)[\s\S]{0,120}\.eq\('status', expectStatus\)[\s\S]{0,120}\.eq\('frozen', expectFrozen\)[\s\S]{0,80}\.select\('\*'\)[\s\S]{0,40}\.single\(\)/)
  assert.match(api, /PGRST116/)

  const flow = read('web/src/lib/core/approve-flow.js')
  // 批准：更新成功 → 读回校验 → 才允许更新来源状态
  const approveBlock = flow.slice(flow.indexOf('export async function approveCombinedPoFlow'))
  const updateAt = approveBlock.indexOf('updateHeaderConditional')
  const readBackAt = approveBlock.indexOf('readBackHeader')
  const sourcesAt = approveBlock.indexOf('updateSourceStatuses')
  assert.ok(updateAt > 0 && readBackAt > updateAt && sourcesAt > readBackAt, '顺序必须是 更新→读回→来源状态')
  assert.match(approveBlock, /if \(!updated\)/)

  // 页面不再自算批准摘要，API 不再接受调用方 hash
  const combine = read('web/src/pages/CombinePoPage.tsx')
  assert.equal(/sha256Hex/.test(combine), false)
  assert.equal(/localeCompare/.test(combine), false, '旧实现按 code 排序，必须移除')
  assert.equal(/approveCombinedPo\([^)]*hash/.test(combine), false)
  assert.match(api, /export async function approveCombinedPo\(id: string, approvedBy: string\)/)
})

test('批准快照 v2：两份迁移都只新增 nullable 版本列，不回填旧数据', () => {
  for (const rel of [
    'supabase/migrations/20261112_prelaunch_guards.sql',
    'supabase/migrations/20261112_prelaunch_guards_preview.sql',
  ]) {
    const sql = read(rel)
    assert.match(sql, /add column if not exists approval_snapshot_version integer;/)
    assert.equal(/approval_snapshot_version integer\s+not null/i.test(sql), false)
    assert.equal(/update\s+\w+\.tj_po_headers[\s\S]{0,120}approval_snapshot_version/i.test(sql), false, '不得回填旧记录')
  }

  const snapshot = read('web/src/lib/core/approved-snapshot.js')
  assert.match(snapshot, /APPROVAL_SNAPSHOT_VERSION = 2/)
  assert.match(snapshot, /crypto\?\.subtle/)
  for (const field of ['website_po_date', 'line_no', 'ordered_qty', 'accepted_qty', 'unit_price', 'source_refs', 'note']) {
    assert.ok(snapshot.includes(field), `canonical 必须覆盖 ${field}`)
  }

  // 正式导出（合并 PO / GR）都必须先过 v2 校验
  const excel = read('web/src/lib/tjPoExcel.ts')
  assert.match(excel, /mode === EXPORT_MODE_COMBINED[\s\S]{0,160}assertVerifiedApprovedSnapshot/)
  assert.match(excel, /po\.po_type === 'combined'[\s\S]{0,200}assertVerifiedApprovedSnapshot/)

  const sample = read('scripts/lib/preview-sample.mjs')
  assert.match(sample, /mode === 'formal'[\s\S]{0,200}APPROVAL_SNAPSHOT_UNVERIFIED/)
})

test('应用层：合并单/来源单推送冻结 + 预览环境禁止推送', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /合并单永久冻结推送/)
  assert.match(api, /已并入合并单/)
  assert.match(api, /IS_PREVIEW_SCHEMA/)

  const policy = read('web/src/lib/core/push-policy.js')
  assert.match(policy, /GR_PUSH_ENABLED = false/)
  assert.match(policy, /assertGrPushDisabled/)

  const entry = read('scripts/lib/po-push-core.mjs')
  assert.match(entry, /推送器只允许 public schema/)
  // 来源判定：服务端 array contains + limit 1，禁止全量拉取合并单
  assert.match(entry, /source_po_ids.*cs\./s)
  assert.match(entry, /buildOwnerLookupPath/)
  assert.equal(/fetchCombined/.test(entry), false, '不得再全量 fetch 合并单')
  assert.match(entry, /findSourceOwners\(latest\.po_id\)/)
  assert.match(entry, /findSourceOwners\(header\?\.po_id\)/)
})
