#!/usr/bin/env node
// 由 tj_preview 版生成 public 版「仅准备」迁移：保证两侧逻辑零漂移，同时让 public
// 永不被自动套用。
//
// 输出：supabase/migrations/gr_unified_public_prepared.sql
//   * 文件名**没有版本号前缀** → Supabase CLI `db push` / migration runner 不会选中它。
//   * 文件头部带 SQL 门禁：必须在同一事务执行
//       select set_config('tj.gr.apply_public', 'AUTHORIZED_MANUAL', true);
//     否则整文件 raise 中止（连第一条 DDL 都不会执行）。
//   * 与预览版的差异只有：schema 限定符 tj_preview → public；
//     去掉 PREVIEW_ONLY_LEGACY_HARDENING 块（public 旧表仍是 MVP anon 权限，
//     收敛 authenticated 直写属于另一项需单独授权的变更）。
//
// 用法：
//   node scripts/gr-gen-public-prepared.mjs          # 生成/覆盖
//   node scripts/gr-gen-public-prepared.mjs --check  # 只校验是否与预览版同步（CI/测试用）
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'supabase/migrations/20261113_gr_unified_preview.sql')
const OUT = path.join(ROOT, 'supabase/migrations/gr_unified_public_prepared.sql')

const BLOCK_START = '-- >>> PREVIEW_ONLY_LEGACY_HARDENING_BEGIN'
const BLOCK_END = '-- <<< PREVIEW_ONLY_LEGACY_HARDENING_END'

export const BANNER = `-- ============================================================================
-- TJ-AI-Ops — 统一收货（GR）安全内核：生产 public 版
-- 文件名：gr_unified_public_prepared.sql（**无版本号前缀 → 迁移工具不会自动套用**）
--
-- 【状态：PREPARED ONLY。未经单独授权不得执行。】
--   本文件由 scripts/gr-gen-public-prepared.mjs 从 tj_preview 版自动生成，
--   两侧逻辑逐行一致，只有 schema 限定符与「预览旧表直写收敛」块不同。
--
-- 【双重门禁】
--   1) 文件名不带时间戳版本：supabase db push / CI migration runner 不会选择它。
--   2) 文件内 SQL 门禁：必须在同一事务先显式声明授权，否则第一条语句前就 raise：
--        begin;
--        select set_config('tj.gr.apply_public', 'AUTHORIZED_MANUAL', true);
--        \\i supabase/migrations/gr_unified_public_prepared.sql
--        -- 校验读回后再 commit
--   在任何未授权场景（自动迁移、误粘贴执行）都会立即失败，不会留下半套对象。
--
-- 【执行前检查清单（主脑）】
--   * 已备份 public（含 tj_po_headers / tj_po_lines / tj_po_exports / tj_item_requests）。
--   * 已确认没有真实 GR 任务在跑；GR 正式 push / IRS 过账仍为停用状态。
--   * 已单独授权生产迁移；三项冻结（Combined Push / GR Push / Add New Item）不被本
--     迁移解除。
--   * 应用后读回：
--       select has_schema_privilege('service_role','public','USAGE');         -- 期望 true（public 本就可用），
--                                                                              -- 但 GR 表不授予 service_role 写权限
--       select has_function_privilege('anon','public.tj_gr_api(text,jsonb)','EXECUTE'); -- 期望 false
--       select has_table_privilege('authenticated','public.tj_gr_receipt_events','INSERT'); -- 期望 false
--   * 生产旧表仍是 anon 宽松权限（本轮**不**收敛）：GR 新表与 RPC 不依赖 anon；
--     收敛 public 直写必须另立授权与回归（普通单仍在用 anon 写路径）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) 手工门禁（在任何 DDL 之前）
-- ----------------------------------------------------------------------------
do $gr_gate$
begin
  if coalesce(current_setting('tj.gr.apply_public', true), '') <> 'AUTHORIZED_MANUAL' then
    raise exception using
      errcode = 'P0001',
      message = 'GR public 迁移为 PREPARED，禁止自动套用：必须在同一事务先执行 '
             || 'select set_config(''tj.gr.apply_public'', ''AUTHORIZED_MANUAL'', true)，'
             || '并确认已获生产迁移授权。';
  end if;
end
$gr_gate$;

`

function generate(source) {
  const startIdx = source.indexOf(BLOCK_START)
  const endIdx = source.indexOf(BLOCK_END)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('预览迁移缺少 PREVIEW_ONLY_LEGACY_HARDENING 标记块')
  }
  const stripped = source.slice(0, startIdx) + source.slice(endIdx + BLOCK_END.length)

  // 去掉预览版头部注释（到第一段分隔线之后），换成 public 横幅
  const firstDdl = stripped.indexOf('-- ----------------------------------------------------------------------------\n-- 0) 前置检查')
  if (firstDdl === -1) throw new Error('找不到预览迁移的 0) 前置检查 段落')
  const body = stripped.slice(firstDdl)

  // 顺序很重要：
  //   1) 先把「预览库 push 总闸」改写成 false（否则下面的字符串替换会把两边都变成 'public'，
  //      导致 public 版的 po_push 也永远被拦）。
  //   2) 再改 schema 限定符与注释里的裸名字。
  const converted = body
    .replaceAll("if 'tj_preview' = 'tj_preview' then", 'if false then')
    .replaceAll('tj_preview.', 'public.')
    .replaceAll('tj_preview', 'public')

  if (converted.includes('tj_preview')) {
    throw new Error('生成的 public 版仍包含 tj_preview 引用，拒绝写入')
  }
  return BANNER + converted.trimEnd() + '\n'
}

async function main() {
  const src = await readFile(SRC, 'utf8')
  const out = generate(src)
  const checkOnly = process.argv.includes('--check')

  if (checkOnly) {
    let current = ''
    try {
      current = await readFile(OUT, 'utf8')
    } catch {
      throw new Error(`缺少 ${path.relative(ROOT, OUT)}，请先运行 node scripts/gr-gen-public-prepared.mjs`)
    }
    if (current !== out) {
      throw new Error('public PREPARED 迁移与预览版不同步：请重新运行 node scripts/gr-gen-public-prepared.mjs')
    }
    console.log('[gr-gen] public PREPARED 与预览版同步')
    return
  }

  await writeFile(OUT, out)
  console.log(`[gr-gen] wrote ${path.relative(ROOT, OUT)} (${out.length} bytes)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[gr-gen] FAILED:', e.message)
    process.exit(1)
  })
}

export { generate, SRC, OUT }
