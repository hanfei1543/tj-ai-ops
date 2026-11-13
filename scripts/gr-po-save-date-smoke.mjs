#!/usr/bin/env node
// 本地 harness：验证 20261114_gr_po_save_website_date.sql 修复。
// 在内存 Postgres（PGlite/WASM）中真实执行：
//   1) scripts/gr-local-fixture.sql（复刻 tj_preview 既有对象/权限 + auth.uid()）
//   2) supabase/migrations/20261113_gr_unified_preview.sql（GR 内核）
//   3) supabase/migrations/20261114_gr_po_save_website_date.sql（本修复）
//   4) 再次 apply 20261114（reentrancy 校验）
//   5) 事务内跑 po_save 带/缺/非法日期断言，最后回滚零残留
//
// 这不等同真实 Supabase tj_preview 验收（由主脑执行）。
// 依赖（与 gr-local-smoke.mjs 相同）：
//   GR_PGLITE_ENTRY=/tmp/gr-pg/node_modules/@electric-sql/pglite/dist/index.js \
//     node scripts/gr-po-save-date-smoke.mjs
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadPGlite() {
  try {
    return (await import('@electric-sql/pglite')).PGlite
  } catch {
    const entry = process.env.GR_PGLITE_ENTRY
    if (!entry) throw new Error('缺少 @electric-sql/pglite，请设置 GR_PGLITE_ENTRY')
    const require = createRequire(pathToFileURL(entry))
    return require(entry).PGlite
  }
}

function log(step, detail = '') {
  console.log(`[gr-po-save-date-smoke] ${step}${detail ? ' :: ' + detail : ''}`)
}

const TEST_SQL = `
begin;

create or replace function pg_temp.gr_assert(p_ok boolean, p_label text)
returns void language plpgsql as $fn$
begin
  if p_ok is not true then raise exception 'ASSERT_FAILED: %', p_label; end if;
end $fn$;

create or replace function pg_temp.gr_expect_error(p_sql text, p_code text, p_label text)
returns text language plpgsql as $fn$
declare v_msg text; v_code text;
begin
  begin
    execute p_sql;
    raise exception 'ASSERT_FAILED: % 竟然成功（应报 %）', p_label, p_code;
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'ASSERT_FAILED%' then raise; end if;
    begin
      v_code := (v_msg::jsonb) ->> 'code';
    exception when others then
      raise exception 'ASSERT_FAILED: % 不是可识别 JSON 错误：%', p_label, v_msg;
    end;
  end;
  if v_code is distinct from p_code then
    raise exception 'ASSERT_FAILED: % 错误码 % 与期望 % 不符', p_label, v_code, p_code;
  end if;
  return v_msg;
end $fn$;

-- membership fixture（postgres 身份，早于 set local role）
insert into tj_preview.tj_gr_memberships (user_id, role, active, note)
values ('a0000000-0000-4000-8000-000000000002', 'staff', true, 'po-save-date smoke');

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';

do $date$
declare
  v_json jsonb;
  v_data jsonb;
  v_id uuid;
begin
  -- 1) 带日期新建 PO
  v_data := jsonb_build_object(
    'request_id', 'req-date-1',
    'supplier_code', '4000/A01', 'supplier_name', 'AMFIX',
    'website_po_date', '2026-11-14',
    'created_by', 'Ah Huat',
    'lines', jsonb_build_array(
      jsonb_build_object('line_no', 1, 'item_code', '00101', 'description', 'HINGE',
                         'uom', 'UNIT', 'qty', '5', 'unit_price', '2.50')
    )
  );
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save', v_data::text) into v_json;
  v_id := (v_json ->> 'id')::uuid;
  perform pg_temp.gr_assert((v_json ->> 'website_po_date') = '2026-11-14', 'po_save 返回 website_po_date');
  perform pg_temp.gr_assert(
    (select website_po_date from tj_preview.tj_po_headers where id = v_id) = '2026-11-14',
    'DB 读回 website_po_date 一致（新建）');

  -- 2) 更新带日期（同 id，改日期）
  v_data := v_data || jsonb_build_object('id', v_id, 'request_id', 'req-date-2', 'website_po_date', '2026-11-15');
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save', v_data::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'website_po_date') = '2026-11-15', 'po_save 更新后返回新日期');
  perform pg_temp.gr_assert(
    (select website_po_date from tj_preview.tj_po_headers where id = v_id) = '2026-11-15',
    'DB 读回更新后的 website_po_date 一致');

  -- 3) 缺日期 → GR_VALIDATION
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_build_object('id', v_id, 'request_id', 'req-date-missing',
        'supplier_code', '4000/A01', 'lines', '[]'::jsonb)::text),
    'GR_VALIDATION', 'po_save 缺 website_po_date 拒绝');

  -- 4) 非法格式 → GR_VALIDATION
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_build_object('id', v_id, 'request_id', 'req-date-bad',
        'supplier_code', '4000/A01', 'website_po_date', '2026/11/14', 'lines', '[]'::jsonb)::text),
    'GR_VALIDATION', 'po_save 非法日期格式拒绝');
end
$date$;

reset role;
rollback;
`

async function main() {
  const PGlite = await loadPGlite()
  const db = new PGlite()

  const fixture = await readFile(path.join(ROOT, 'scripts/gr-local-fixture.sql'), 'utf8')
  const migration = await readFile(
    path.join(ROOT, 'supabase/migrations/20261113_gr_unified_preview.sql'),
    'utf8',
  )
  const fix = await readFile(
    path.join(ROOT, 'supabase/migrations/20261114_gr_po_save_website_date.sql'),
    'utf8',
  )

  log('apply fixture')
  await db.exec(fixture)
  log('apply 20261113 migration')
  await db.exec(migration)
  log('apply 20261114 fix')
  await db.exec(fix)
  log('apply 20261114 fix again (reentrancy)')
  await db.exec(fix)
  log('PASS', '20261114 fix 可重入')

  log('run po_save date assertions (transactional, rolls back)')
  await db.exec(TEST_SQL)
  log('PASS', 'po_save website_po_date 写入/读回/缺日期拒绝/非法格式拒绝 全部通过')

  // 零残留确认：回滚后 membership 行应消失（本事务插入）
  const membership = await db.query(
    `select count(*)::int as n from tj_preview.tj_gr_memberships`,
  )
  log('rollback 后 membership 残留', String(membership.rows[0]?.n ?? '?'))
  log('ALL PASS')
}

main().catch((e) => {
  console.error('[gr-po-save-date-smoke] FAIL:', e.message)
  process.exit(1)
})
