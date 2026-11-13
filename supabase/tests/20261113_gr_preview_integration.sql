-- ============================================================================
-- TJ-AI-Ops — 统一收货（GR）预览库集成验收（真实 DB 语义、事务内全回滚）
-- 文件名：20261113_gr_preview_integration.sql
--
-- 前提：已应用 supabase/migrations/20261113_gr_unified_preview.sql（tj_preview）。
-- 执行（主脑）：
--   psql -v ON_ERROR_STOP=1 "$PREVIEW_DB_URL" \
--     -f supabase/tests/20261113_gr_preview_integration.sql
--   （也可整段粘进 Supabase SQL Editor；脚本自带 begin/rollback，零持久写入。）
--
-- 约束：
--   * 只写 tj_preview；没有任何 public.* 写语句，不建 auth 用户。
--   * 身份用 set local role authenticated + request.jwt.claim.sub 合成 uuid，
--     membership fixtures 只存在本事务（结束时消失）。
--   * po_seq 用显式负数 + OVERRIDING SYSTEM VALUE，不消耗 identity。
--   * 任何断言失败立刻 raise，整笔 ROLLBACK。
--
-- 覆盖：函数权限矩阵（B1）/ 旧表 anon 写撤除（B4）/ FK RESTRICT /
--       主流程 save→submit→approve→mapping→release→claim→verified /
--       来源必须原始 standard（B7）/ 额外行阻塞（B6）/ 零数量来源不建任务 /
--       invoice-only 释放（B8）/ task_result 幂等与审计（B2/B3）/
--       过期 lease 不自动重领 / 完整 payload 可离线重算 / combine 完整性（B5）/
--       po_get / po_save 重放 / 旧 PO 引用保护。事件哈希读回一致、零残留。
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0) 断言助手（只在 pg_temp；随事务回滚消失）
-- ----------------------------------------------------------------------------
create or replace function pg_temp.gr_assert(p_ok boolean, p_label text)
returns void
language plpgsql
as $fn$
begin
  if p_ok is not true then
    raise exception 'ASSERT_FAILED: %', p_label;
  end if;
  raise notice 'PASS 断言: %', p_label;
end
$fn$;

-- 期望本模块 JSON 错误码（sqlstate P0001 + message 为 JSON）
create or replace function pg_temp.gr_expect_error(p_sql text, p_code text, p_label text)
returns text
language plpgsql
as $fn$
declare
  v_msg text;
  v_code text;
begin
  begin
    execute p_sql;
    raise exception 'ASSERT_FAILED: % 竟然成功（应报 %）', p_label, p_code;
  exception
    when others then
      v_msg := sqlerrm;
      if v_msg like 'ASSERT_FAILED%' then raise; end if;
      begin
        v_code := (v_msg::jsonb) ->> 'code';
      exception when others then
        raise exception 'ASSERT_FAILED: % 不是可识别 JSON 错误：% (%)', p_label, v_msg, sqlstate;
      end;
  end;
  if v_code is distinct from p_code then
    raise exception 'ASSERT_FAILED: % 错误码 % 与期望 % 不符', p_label, v_code, p_code;
  end if;
  raise notice 'PASS 拒绝: % -> %', p_label, v_code;
  return v_msg;
end
$fn$;

-- 期望数据库权限错误（42501）
create or replace function pg_temp.gr_expect_denied(p_sql text, p_label text)
returns void
language plpgsql
as $fn$
begin
  begin
    execute p_sql;
    raise exception 'ASSERT_FAILED: % 竟然成功（应权限拒绝）', p_label;
  exception
    when insufficient_privilege then
      raise notice 'PASS 拒绝: % -> 42501', p_label;
  end;
end
$fn$;

-- 期望 FK RESTRICT 拒绝删除来源
create or replace function pg_temp.gr_expect_fk(p_sql text, p_label text)
returns void
language plpgsql
as $fn$
begin
  begin
    execute p_sql;
    raise exception 'ASSERT_FAILED: % 竟然成功（应 FK 拒绝）', p_label;
  exception
    when sqlstate '23001' or sqlstate '23503' then
      raise notice 'PASS 拒绝: % -> RESTRICT（23001/23503）', p_label;
  end;
end
$fn$;

-- 基线（回滚后比对零残留）：必须在 fixture 之前
create temp table _gr_baseline on commit drop as
select
  (select count(*) from tj_preview.tj_gr_receipt_events) as events,
  (select count(*) from tj_preview.tj_gr_receipt_lines) as lines,
  (select count(*) from tj_preview.tj_gr_line_sources) as sources,
  (select count(*) from tj_preview.tj_gr_tasks) as tasks,
  (select count(*) from tj_preview.tj_gr_outbox) as outbox,
  (select count(*) from tj_preview.tj_gr_po_mappings) as mappings,
  (select count(*) from tj_preview.tj_gr_audit) as audit,
  (select count(*) from tj_preview.tj_po_headers) as po_headers,
  (select count(*) from tj_preview.tj_po_lines) as po_lines,
  (select md5(coalesce(string_agg(row_to_json(h)::text, '|' order by h.id), '')) from tj_preview.tj_po_headers h) as po_hdr_hash;

savepoint gr_tests;

-- ----------------------------------------------------------------------------
-- 1) fixtures（postgres 身份；全部在本事务，最后回滚）
-- ----------------------------------------------------------------------------
do $fixtures$
declare
  v_staff uuid := 'a0000000-0000-4000-8000-000000000002';
  v_appr uuid := 'a0000000-0000-4000-8000-000000000001';
  v_exec uuid := 'a0000000-0000-4000-8000-000000000003';
  v_admin uuid := 'a0000000-0000-4000-8000-000000000004';
begin
  delete from tj_preview.tj_gr_memberships where user_id in (v_staff, v_appr, v_exec, v_admin);
  insert into tj_preview.tj_gr_memberships (user_id, role, active, note) values
    (v_staff, 'staff', true, 'integration fixture'),
    (v_appr, 'approver', true, 'integration fixture'),
    (v_exec, 'executor', true, 'integration fixture'),
    (v_admin, 'admin', true, 'integration fixture');

  -- PO1 / PO2：同一供应商，共享商品 00101/UNIT/2.50（分批与多来源拆分）
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values
    ('10000000-0000-4000-8000-000000000001', -9001, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture'),
    ('10000000-0000-4000-8000-000000000002', -9002, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture');

  insert into tj_preview.tj_po_lines
    (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
     1, '00101', 'HINGE', 'UNIT', 5, 2.50),
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
     1, '00101', 'HINGE', 'UNIT', 3, 2.50);

  -- PO3 / PO4：combine 测试（同供应商、未冻结、各 1 行）
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values
    ('10000000-0000-4000-8000-000000000003', -9003, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture'),
    ('10000000-0000-4000-8000-000000000004', -9004, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture');
  insert into tj_preview.tj_po_lines (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values
    ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
     1, '00301', 'SCREW', 'BOX', 2, 25.00),
    ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004',
     1, '00301', 'SCREW', 'BOX', 1, 25.00);

  -- PO5：已冻结（旧 PO 保护 + combine 冻结来源拒绝）
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values ('10000000-0000-4000-8000-000000000005', -9005, '4000/A01', 'AMFIX',
          'confirmed', 'standard', 'fixture');
  insert into tj_preview.tj_po_lines (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
          1, '00101', 'HINGE', 'UNIT', 2, 2.50);
  update tj_preview.tj_po_headers
     set frozen = true, approved_by = 'fixture', approved_at = now()
   where id = '10000000-0000-4000-8000-000000000005';

  -- PO7 / PO8：零数量来源 + 额外行 + invoice-only 释放
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values
    ('10000000-0000-4000-8000-000000000007', -9007, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture'),
    ('10000000-0000-4000-8000-000000000008', -9008, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture');
  insert into tj_preview.tj_po_lines (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values
    ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007',
     1, '00701', 'BOLT', 'UNIT', 10, 1.00),
    ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000008',
     1, '00801', 'NUT', 'UNIT', 3, 5.00);

  -- PO9：po_save 无稳定行 id 的重放测试
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values ('10000000-0000-4000-8000-000000000009', -9009, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture');

  -- PO10 / PO11：B1 部分收货回归（同商品 00101、未消费、qty 充足）
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
  overriding system value
  values
    ('10000000-0000-4000-8000-00000000000a', -9010, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture'),
    ('10000000-0000-4000-8000-00000000000b', -9011, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'fixture');
  insert into tj_preview.tj_po_lines (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values
    ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a',
     1, '00101', 'HINGE', 'UNIT', 5, 2.50),
    ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b',
     1, '00101', 'HINGE', 'UNIT', 5, 2.50);
end
$fixtures$;

-- ----------------------------------------------------------------------------
-- 2) 权限/安全基线（B1 / B4 / FK RESTRICT）
-- ----------------------------------------------------------------------------
do $sec$
declare
  v_bad text;
begin
  -- service_role 无 tj_preview USAGE（预览隔离）
  perform pg_temp.gr_assert(has_schema_privilege('service_role', 'tj_preview', 'USAGE') = false,
    'service_role 不得拥有 tj_preview USAGE');

  -- 入口：只有三个函数对 authenticated 开放
  perform pg_temp.gr_assert(has_function_privilege('anon', 'tj_preview.tj_gr_api(text,jsonb)', 'EXECUTE') = false,
    'anon 不得 EXECUTE tj_gr_api');
  perform pg_temp.gr_assert(has_function_privilege('authenticated', 'tj_preview.tj_gr_api(text,jsonb)', 'EXECUTE') = true,
    'authenticated 可 EXECUTE tj_gr_api');
  perform pg_temp.gr_assert(has_function_privilege('authenticated', 'tj_preview.tj_gr_is_member()', 'EXECUTE') = true,
    'authenticated 可 EXECUTE tj_gr_is_member');
  perform pg_temp.gr_assert(has_function_privilege('authenticated', 'tj_preview.tj_gr_roles()', 'EXECUTE') = true,
    'authenticated 可 EXECUTE tj_gr_roles');

  -- B1：内部 helper 不得被 authenticated / anon / service_role 直接执行
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname)
    into v_bad
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tj_preview'
    and p.proname like 'tj_gr\_%'
    and p.proname not in ('tj_gr_api', 'tj_gr_is_member', 'tj_gr_roles')
    and (pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'));
  perform pg_temp.gr_assert(v_bad is null, '内部 helper 不得被 authenticated/anon 直接执行：' || coalesce(v_bad, ''));

  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname)
    into v_bad
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tj_preview'
    and p.proname like 'tj_gr\_%'
    and p.proname not in ('tj_gr_api', 'tj_gr_is_member', 'tj_gr_roles')
    and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE');
  perform pg_temp.gr_assert(v_bad is null, '内部 helper 不得被 service_role 直接执行：' || coalesce(v_bad, ''));

  -- 新表：authenticated 只读，不能直写
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_gr_receipt_events', 'INSERT') = false,
    'authenticated 不得直插新表（写只走 RPC）');
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_gr_receipt_events', 'SELECT') = true,
    'authenticated 可读新表（RLS 再按 membership）');

  -- B4：旧 6 表 anon 全无权限；authenticated 无写
  perform pg_temp.gr_assert(
    has_table_privilege('anon', 'tj_preview.tj_po_headers', 'SELECT') = false,
    'B4: anon 不得读旧 PO');
  perform pg_temp.gr_assert(
    has_table_privilege('anon', 'tj_preview.tj_po_headers', 'INSERT') = false,
    'B4: anon 不得写旧 PO');
  perform pg_temp.gr_assert(
    has_table_privilege('anon', 'tj_preview.tj_po_headers', 'TRUNCATE') = false,
    'B4: anon 不得 TRUNCATE 旧 PO');
  perform pg_temp.gr_assert(
    has_table_privilege('anon', 'tj_preview.tj_po_lines', 'DELETE') = false,
    'B4: anon 不得 DELETE 旧 PO 明细');
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_po_headers', 'UPDATE') = false,
    '预览旧表 authenticated 直写已撤销');
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_po_headers', 'SELECT') = true,
    '预览旧表 authenticated 可读（RLS 再按 membership 过滤）');
end
$sec$;

-- anon 直接写/读 → 权限拒绝
set local role anon;
do $anon$
begin
  perform pg_temp.gr_expect_denied(
    $q$insert into tj_preview.tj_gr_receipt_events (id, event_no, po_ids, receive_date, created_by)
       values ('30000000-0000-4000-8000-00000000ffff', 'GR-ANON', array['10000000-0000-4000-8000-000000000001']::uuid[], current_date, gen_random_uuid())$q$,
    'anon 直插收货事件');
  perform pg_temp.gr_expect_denied(
    $q$select count(*) from tj_preview.tj_po_headers$q$, 'anon 读旧 PO（B4 已撤）');
  perform pg_temp.gr_expect_denied(
    $q$delete from tj_preview.tj_po_lines where false$q$, 'anon 删除旧 PO 明细');
  perform pg_temp.gr_expect_denied(
    $q$truncate tj_preview.tj_po_headers$q$, 'anon TRUNCATE 旧 PO');
  perform pg_temp.gr_expect_denied(
    $q$select tj_preview.tj_gr_event_json('30000000-0000-4000-8000-000000000001'::uuid)$q$,
    'anon 直接调用内部 helper');
end
$anon$;
reset role;

-- authenticated 直插/直改 → 权限拒绝
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $direct$
begin
  perform pg_temp.gr_expect_denied(
    $q$insert into tj_preview.tj_gr_receipt_events (id, event_no, po_ids, receive_date, created_by)
       values ('30000000-0000-4000-8000-00000000ffff', 'GR-DIRECT', array['10000000-0000-4000-8000-000000000001']::uuid[], current_date, gen_random_uuid())$q$,
    'authenticated 直插收货事件');
  perform pg_temp.gr_expect_denied(
    $q$update tj_preview.tj_po_headers set supplier_name = 'HACK' where id = '10000000-0000-4000-8000-000000000001'$q$,
    'authenticated 直改旧 PO');
  perform pg_temp.gr_expect_denied(
    $q$select tj_preview.tj_gr_event_json('30000000-0000-4000-8000-000000000001'::uuid)$q$,
    'authenticated 直接调用内部 helper（B1）');
  perform pg_temp.gr_expect_denied(
    $q$select tj_preview.tj_gr_receipt_list('{}'::jsonb)$q$,
    'authenticated 直接调用 receipt_list helper（B1）');
end
$direct$;
reset role;

-- 无 JWT → GR_AUTH_REQUIRED
set local role authenticated;
set local request.jwt.claim.sub = '';
do $noauth$
begin
  perform pg_temp.gr_expect_error(
    $q$select tj_preview.tj_gr_api('session', '{}'::jsonb)$q$,
    'GR_AUTH_REQUIRED', '无 JWT 调 session');
end
$noauth$;
reset role;

-- ----------------------------------------------------------------------------
-- 3) 主流程：staff 保存 → submit → approver 批准 → 映射 → release
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';

do $save$
declare
  v_staff uuid := 'a0000000-0000-4000-8000-000000000002';
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_data jsonb;
  v_json jsonb;
begin
  -- session 的 can 来自真实角色（不是 UI 声明）
  execute $q$select tj_preview.tj_gr_api('session', '{}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert((v_json ->> 'active')::boolean = true, 'staff session.active=true');
  perform pg_temp.gr_assert((v_json -> 'can' ->> 'receipt_save')::boolean = true, 'staff 可 receipt_save');
  perform pg_temp.gr_assert((v_json -> 'can' ->> 'receipt_approve')::boolean = false, 'staff 不可 approve');
  perform pg_temp.gr_assert((v_json -> 'can' ->> 'po_get')::boolean = true, 'staff 可 po_get');

  v_data := jsonb_build_object(
    'id', v_ev,
    'revision', 0,
    'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
    'invoice_no', 'INV-1001',
    'delivery_order_no', 'DO-1001',
    'receive_date', '2026-11-13',
    'invoice_date', '2026-11-10',
    'checked_by', 'Ah Huat',
    'note', 'first batch',
    'lines', jsonb_build_array(
      jsonb_build_object(
        'id', '40000000-0000-4000-8000-000000000001',
        'line_no', 1,
        'item_code', '00101',
        'description', 'HINGE',
        'uom', 'UNIT',
        'unit_price', '2.50',
        'ordered_qty', '8',
        'accepted_qty', '5',
        'note', 'split across two POs',
        'source_allocations', jsonb_build_array(
          jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000001',
                             'po_line_id', '20000000-0000-4000-8000-000000000001',
                             'accepted_qty', '3'),
          jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000002',
                             'po_line_id', '20000000-0000-4000-8000-000000000002',
                             'accepted_qty', '2')
        )
      )
    )
  );

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data::text) into v_json;

  perform pg_temp.gr_assert((v_json ->> 'status') = 'draft', '保存后为 draft');
  perform pg_temp.gr_assert((v_json ->> 'revision')::int = 0, '首次保存 revision=0');
  perform pg_temp.gr_assert((v_json ->> 'payload_sha256') ~ '^[0-9a-f]{64}$', 'payload_sha256 为 64 hex');
  perform pg_temp.gr_assert((v_json ->> 'supplier_code') = '4000/A01', '供应商由来源 PO 推导');
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'ordered_qty') = '8', 'ordered_qty 由来源合计（8）');
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 -> 'sources' -> 0 ->> 'accepted_qty') = '3', '来源分配保留（3）');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'missing_mappings') = 2, '两张来源 PO 都缺映射');
  perform pg_temp.gr_assert((v_json ->> 'created_by') = v_staff::text, 'created_by 来自 auth.uid()');
  perform pg_temp.gr_assert((v_json -> 'warnings') ? 'short_receipt', '短收 warning');

  -- 列表 / 单条读取（契约形状）
  execute $q$select tj_preview.tj_gr_api('receipt_list', '{"limit": 20}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json) = 'array', 'receipt_list 返回数组');
  perform pg_temp.gr_assert(pg_catalog.jsonb_array_length(v_json) >= 1, 'receipt_list 至少 1 条');
  perform pg_temp.gr_assert((v_json -> 0 ->> 'id') = v_ev::text, 'receipt_list 含刚保存的事件');
  perform pg_temp.gr_assert((v_json -> 0 ->> 'receive_date') = '2026-11-13', '列表日期格式 yyyy-MM-dd');

  execute $q$select tj_preview.tj_gr_api('receipt_list', '{"status": ["draft"]}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert(pg_catalog.jsonb_array_length(v_json) >= 1, 'status 数组过滤可用');
  execute $q$select tj_preview.tj_gr_api('receipt_list', '{"status": "verified", "po_id":"10000000-0000-4000-8000-000000000001"}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert(pg_catalog.jsonb_array_length(v_json) = 0, 'status 文本过滤可用');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_get',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'id') = v_ev::text, 'receipt_get 返回事件');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'lines') = 1, 'receipt_get 带 1 行');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'lines' -> 0 -> 'sources') = 2, 'receipt_get 带全部来源分配');
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json -> 'tasks') = 'array', 'receipt_get 带 tasks 数组');

  -- revision CAS：0 → 1，然后用旧 revision 再存 → 冲突
  v_data := jsonb_set(jsonb_set(v_data, '{revision}', '0'::jsonb), '{note}', '"first batch (edited)"');
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'revision')::int = 1, '再次保存 revision 递增到 1');
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data::text),
    'GR_REVISION_CONFLICT', '用过期 revision=0 保存');

  -- staff 不能批准
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
      jsonb_build_object('id', v_ev, 'revision', 1, 'allow_exceptions', false)::text),
    'GR_FORBIDDEN', 'staff 不能批准');

  -- submit（staff 可提交）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
    jsonb_build_object('id', v_ev, 'revision', 1)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'submitted', '提交后 submitted');
end
$save$;
reset role;

-- approver：批准（正常单，无异常）
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $approve$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_json jsonb;
  v_hash text;
begin
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
    jsonb_build_object('id', v_ev, 'revision', 1, 'allow_exceptions', false)::text) into v_json;

  perform pg_temp.gr_assert((v_json ->> 'status') = 'approved', '批准后 approved');
  perform pg_temp.gr_assert((v_json ->> 'approved_by') is not null, 'approved_by 记录为 auth.uid()');
  perform pg_temp.gr_assert((v_json ->> 'payload_sha256') ~ '^[0-9a-f]{64}$', '批准后 hash 仍为 64 hex');

  -- release：缺映射 → waiting_mapping（不是错误）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'event' ->> 'status') = 'waiting_mapping', '缺映射时 waiting_mapping');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'missing_mappings') = 2, '返回 2 个缺映射 PO');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 0, '缺映射不建任务');

  -- mapping_set：证据必须齐全
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'mapping_set',
      jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000001',
                         'irs_po_no', '5', 'evidence', jsonb_build_object('checked_by', 'Ah Huat'))::text),
    'GR_VALIDATION', '映射缺 checked_at 证据');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'mapping_set',
    jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000001',
      'irs_po_no', '5',
      'evidence', jsonb_build_object('checked_by', 'Ah Huat', 'checked_at', '2026-11-13T01:00:00Z',
                                     'source', 'IRS PO list screenshot', 'irs_po_no', '5'))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'irs_po_no') = '5', '映射保存 irs_po_no=5（内容原样）');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'mapping_set',
    jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000002',
      'irs_po_no', '6',
      'evidence', jsonb_build_object('checked_by', 'Ah Huat', 'checked_at', '2026-11-13T01:00:00Z'))::text) into v_json;

  -- release → 每张来源 PO 一个任务（多 IRS PO 事件可拆）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'event' ->> 'status') = 'released', '映射齐全后 released');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 2, '两个任务（按 IRS PO 拆分）');
  perform pg_temp.gr_assert((v_json -> 'tasks' -> 0 ->> 'mock_only')::boolean = true, '任务 mock_only=true');
  perform pg_temp.gr_assert((v_json -> 'tasks' -> 0 ->> 'environment') = 'preview', '任务 environment=preview');
  perform pg_temp.gr_assert((v_json -> 'tasks' -> 0 ->> 'schema') = 'tj.gr.v1', '任务 schema=tj.gr.v1');
  perform pg_temp.gr_assert((v_json -> 'tasks' -> 0 ->> 'task_type') = 'GOODS_RECEIVE', '任务 type=GOODS_RECEIVE');
  perform pg_temp.gr_assert((v_json -> 'tasks' -> 0 ->> 'po_id') is not null, '任务带 website PO 显示编号');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_outbox where receipt_event_id = v_ev and kind = 'gr_task_dispatch' and mock_only and status = 'pending') = 2,
    'outbox 持久化 2 条 pending（mock_only）');

  -- 重复 release 幂等
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 2, '重复 release 不重复建任务');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_outbox where receipt_event_id = v_ev and kind = 'gr_task_dispatch') = 2,
    'outbox 未重复');

  -- 已释放后 submit/approve 重试：只返回现有事件，不改 revision/hash/批准记录
  declare
    v_rev_before int;
    v_hash_before text;
    v_status_before text;
  begin
    select revision, payload_sha256, status into v_rev_before, v_hash_before, v_status_before
      from tj_preview.tj_gr_receipt_events where id = v_ev;

    execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
      jsonb_build_object('id', v_ev, 'revision', v_rev_before)::text) into v_json;
    execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
      jsonb_build_object('id', v_ev, 'revision', v_rev_before, 'allow_exceptions', false)::text) into v_json;

    perform pg_temp.gr_assert(
      (select revision from tj_preview.tj_gr_receipt_events where id = v_ev) = v_rev_before,
      '已释放后 submit/approve 重试不改 revision');
    perform pg_temp.gr_assert(
      (select payload_sha256 from tj_preview.tj_gr_receipt_events where id = v_ev) = v_hash_before,
      '已释放后 submit/approve 重试不改 hash');
    perform pg_temp.gr_assert(
      (select status from tj_preview.tj_gr_receipt_events where id = v_ev) = v_status_before,
      '已释放后 submit/approve 重试不改状态');
    perform pg_temp.gr_assert(
      (select count(*) from tj_preview.tj_gr_tasks where receipt_event_id = v_ev) = 2,
      '已释放后重试不重建任务');
  end;
end
$approve$;
reset role;

-- 事件哈希 / 任务 payload 离线复算（postgres 身份；helper 已不对 authenticated 开放）
do $hashcheck$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_t record;
  v_snap jsonb;
begin
  perform pg_temp.gr_assert(
    (select payload_sha256 from tj_preview.tj_gr_receipt_events where id = v_ev)
      = tj_preview.tj_gr_event_hash(v_ev),
    '存储 hash == 读回重算（批准时锁定内容）');

  for v_t in select * from tj_preview.tj_gr_tasks where receipt_event_id = v_ev loop
    v_snap := v_t.payload -> 'approved_event_snapshot';
    perform pg_temp.gr_assert(v_snap is not null, '任务 payload 含完整 approved_event_snapshot');
    perform pg_temp.gr_assert(
      jsonb_array_length(v_snap -> 'lines') = 1,
      '快照含事件全部行（不只是 header）');
    perform pg_temp.gr_assert(
      jsonb_array_length(v_snap -> 'lines' -> 0 -> 'sources') = 2,
      '快照含全部来源分配');
    perform pg_temp.gr_assert(
      (v_snap ->> 'payload_sha256') = (v_t.event_payload_sha256),
      '快照内事件哈希 == 冻结 event_payload_sha256');
    perform pg_temp.gr_assert(
      tj_preview.tj_gr_sha256(tj_preview.tj_gr_task_canonical(v_t.payload)) = v_t.payload_sha256,
      '任务 payload hash 可由 payload 自身离线复算');
    perform pg_temp.gr_assert(
      jsonb_array_length(v_t.payload -> 'source_refs') = 1,
      'source_refs 完整（该 PO 的每条分配）');
    perform pg_temp.gr_assert(
      (v_t.payload -> 'mapping' ->> 'irs_invoice_no') = 'INV-1001',
      'payload 带 selected IRS invoice（有发票号用发票号）');
  end loop;
end
$hashcheck$;

-- ----------------------------------------------------------------------------
-- 4) 任务：claim / 幂等 / 乱序 / 审计拒绝 / 过期 lease / verified 终态
-- ----------------------------------------------------------------------------
-- 4a) 非成员：read 动作也必须有 membership（definer 不能绕过）
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000009';
do $outsider$
declare
  v_json jsonb;
begin
  execute $q$select tj_preview.tj_gr_api('session', '{}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert((v_json ->> 'active')::boolean = false, '非成员 session.active=false');
  perform pg_temp.gr_expect_error(
    $q$select tj_preview.tj_gr_api('receipt_list', '{}'::jsonb)$q$,
    'GR_NOT_MEMBER', '非成员不能读列表');
end
$outsider$;
reset role;

-- 4b) 已释放事件不能再编辑（行/来源被任务哈希绑定）
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $postrelease$
begin
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'revision', 1,
        'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000001'),
        'receive_date', '2026-11-13', 'lines', jsonb_build_array())::text),
    'GR_STATE', '已释放事件禁止再编辑');
end
$postrelease$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $staffclaim$
begin
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_claim',
      jsonb_build_object('task_id', (select id from tj_preview.tj_gr_tasks order by po_header_id limit 1))::text),
    'GR_FORBIDDEN', 'staff 不能领取任务');
end
$staffclaim$;
reset role;

-- 4c) 零数量来源 / invoice-only 事件：只给正数量来源 PO 建任务，不建空任务
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $zerosrc$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000005';
  v_json jsonb;
  v_data jsonb;
  v_rev int;
begin
  v_data := jsonb_build_object(
    'id', v_ev, 'revision', 0,
    'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000008'),
    'invoice_no', 'INV-ONLY-1', 'delivery_order_no', null,
    'receive_date', '2026-11-16', 'invoice_date', '2026-11-15', 'checked_by', 'Ah Huat',
    'lines', jsonb_build_array(jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000007', 'line_no', 1,
      'item_code', '00701', 'description', 'BOLT', 'uom', 'UNIT',
      'unit_price', '1.00', 'ordered_qty', '10', 'accepted_qty', '2',
      'source_allocations', jsonb_build_array(jsonb_build_object(
        'po_header_id', '10000000-0000-4000-8000-000000000007',
        'po_line_id', '20000000-0000-4000-8000-000000000007',
        'accepted_qty', '2'))
    ))
  );
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data::text) into v_json;
  v_rev := (v_json ->> 'revision')::int;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
    jsonb_build_object('id', v_ev, 'revision', v_rev)::text) into v_json;
end
$zerosrc$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $zerorelease$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000005';
  v_json jsonb;
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
    jsonb_build_object('id', v_ev, 'revision', v_rev, 'allow_exceptions', false)::text) into v_json;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'mapping_set',
    jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000007',
      'irs_po_no', '11',
      'evidence', jsonb_build_object('checked_by', 'Ah Huat', 'checked_at', '2026-11-16T01:00:00Z'))::text) into v_json;

  -- invoice-only（DO 为空）必须允许释放
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'event' ->> 'status') = 'released', 'invoice-only 可释放（B8）');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 1, '只有正数量来源 PO 建 1 个任务');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_tasks where receipt_event_id = v_ev) = 1,
    '零数量来源 PO8 不建空任务');
  perform pg_temp.gr_assert(
    not exists (select 1 from tj_preview.tj_gr_po_mappings where po_header_id = '10000000-0000-4000-8000-000000000008'),
    '零数量来源不要求映射');
  perform pg_temp.gr_assert(
    (select payload -> 'mapping' ->> 'irs_invoice_no' from tj_preview.tj_gr_tasks where receipt_event_id = v_ev)
      = 'INV-ONLY-1',
    'invoice-only 时 IRS invoice 仍取发票号');
end
$zerorelease$;
reset role;

-- 4d) 过期 lease / save_attempted：持久 needs_review，不 raise 回滚
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $stale$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000005';
  v_task uuid;
  v_hash text;
  v_json jsonb;
  v_audit_before int;
begin
  select id, payload_sha256 into v_task, v_hash
  from tj_preview.tj_gr_tasks where receipt_event_id = v_ev;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_claim',
    jsonb_build_object('task_id', v_task)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'claimed', '任务领取成功');

  -- 缺 receipt_event_id：用 IS DISTINCT FROM 拒绝，且审计持久（不 raise 回滚）
  select count(*) into v_audit_before from tj_preview.tj_gr_audit where action = 'task_result_rejected';
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'payload_sha256', v_hash,
      'callback_id', 'cb-noevent', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'rejected')::boolean = true, '缺 receipt_event_id 被拒');
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_EVENT_MISMATCH', '缺事件 id 错误码');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_audit where action = 'task_result_rejected') = v_audit_before + 1,
    '拒绝已持久审计（不是 raise 回滚）');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'claimed', '拒绝后任务状态不变');

  -- 同 callback_id 换 body（补上事件 id）→ 冲突（第一次被拒也必须登记）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-noevent', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_CONFLICT', '同 id 不同 body 冲突（含已拒绝）');

  -- 错误 hash → 拒绝 + 审计，不 raise
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', repeat('0', 64),
      'callback_id', 'cb-badhash', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_PAYLOAD_HASH_MISMATCH', '错误 hash 被拒绝（不 raise）');
  perform pg_temp.gr_assert(
    exists (select 1 from tj_preview.tj_gr_task_callbacks
            where task_id = v_task and callback_id = 'cb-badhash' and accepted = false),
    '错误 hash 回调已审计');

  -- 开始保存（正确 hash / 事件）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-s1', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'save_attempted', 'save_attempted 记录');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'save_attempted_at') is not null, 'save_attempted_at 写入');
end
$stale$;
reset role;

-- postgres 造“lease 过期”（只改测试用字段）
update tj_preview.tj_gr_tasks
   set lease_expires_at = now() - interval '1 minute'
 where receipt_event_id = '30000000-0000-4000-8000-000000000005';

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $staleclaim$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000005';
  v_task uuid;
  v_json jsonb;
begin
  select id into v_task from tj_preview.tj_gr_tasks where receipt_event_id = v_ev;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_claim',
    jsonb_build_object('task_id', v_task)::text) into v_json;

  perform pg_temp.gr_assert((v_json ->> 'rejected')::boolean = true, '过期 lease + save_attempted 拒绝重领');
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_TASK_STALE_REVIEW', '过期重领错误码');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', '过期重领持久 needs_review');
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_gr_tasks where id = v_task) = 'needs_review',
    'needs_review 已提交（不是 raise 回滚）');
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_gr_receipt_events where id = v_ev) = 'needs_review',
    '事件聚合 needs_review');
  perform pg_temp.gr_assert(
    exists (select 1 from tj_preview.tj_gr_audit where action = 'task_claim_blocked'
            and entity_id = v_task::text),
    '过期重领已审计');
end
$staleclaim$;
reset role;

-- 4e) 完整 verified 路径（事件 1 的第二个任务）+ 证据严格比对 + 终态
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $verify$
declare
  v_task uuid;
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_hash text;
  v_json jsonb;
  v_payload jsonb;
  v_line jsonb;
  v_qty text;
  v_price text;
  v_irs text;
begin
  select t.id, t.payload_sha256, t.payload, t.irs_po_no
    into v_task, v_hash, v_payload, v_irs
  from tj_preview.tj_gr_tasks t
  where t.receipt_event_id = v_ev and t.status = 'ready'
  order by t.po_header_id limit 1;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_claim',
    jsonb_build_object('task_id', v_task)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'claimed', 'verified 任务领取');
  perform pg_temp.gr_assert((v_json ->> 'claimed_by') = 'a0000000-0000-4000-8000-000000000003', 'claimed_by 绑定 executor');
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_gr_receipt_events where id = v_ev) = 'in_progress',
    '事件聚合为 in_progress');

  -- 乱序：saved 早于 save_attempted → 拒绝（rejected=true + 审计；状态不回退）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-out-of-order', 'event_type', 'saved',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'rejected')::boolean = true, 'saved 早于 save_attempted 被拒');
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_OUT_OF_ORDER', '乱序错误码');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'claimed', '乱序拒绝后状态不变');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-1', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'save_attempted', 'save_attempted 记录（事件1）');

  -- 同 callback_id + 同内容 → replay
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-1', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'replayed')::boolean = true, '相同 callback 幂等 replay');

  -- 同 callback_id + 不同内容 → 冲突审计拒绝
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-1', 'event_type', 'failed',
      'evidence', jsonb_build_object('bridge_ok', false))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_CONFLICT', '回调冲突错误码');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'save_attempted', '冲突后状态不变');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_task_callbacks where callback_id = 'cb-1' and accepted = false) = 1,
    '冲突已审计（accepted=false）');

  -- bridge_ok="yes"（字符串）→ needs_review，绝不因 cast 报错回滚
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-bridge-string', 'event_type', 'saved',
      'evidence', jsonb_build_object('bridge_ok', 'yes'))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', 'bridge_ok 字符串 → needs_review');

  -- 测试构造：复位为 save_attempted 继续 verified 路径（postgres 身份后续）
  perform pg_temp.gr_assert(true, 'bridge 字符串用例完成');
end
$verify$;
reset role;

-- 测试构造：把 needs_review 复位为 save_attempted（postgres 身份；仅测试用）
update tj_preview.tj_gr_tasks set status = 'save_attempted', saved_at = null, verified_at = null
 where receipt_event_id = '30000000-0000-4000-8000-000000000001' and status = 'needs_review';
update tj_preview.tj_gr_receipt_events set status = 'in_progress'
 where id = '30000000-0000-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $v_a$
declare
  v_task uuid;
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_hash text;
  v_json jsonb;
  v_payload jsonb;
  v_line jsonb;
  v_qty text;
  v_price text;
  v_irs text;
  v_evidence jsonb;
begin
  select t.id, t.payload_sha256, t.payload, t.irs_po_no
    into v_task, v_hash, v_payload, v_irs
  from tj_preview.tj_gr_tasks t
  where t.receipt_event_id = v_ev and t.status = 'save_attempted'
  order by t.po_header_id limit 1;

  v_line := v_payload -> 'scope' -> 'lines' -> 0;
  v_qty := v_line ->> 'accepted_qty';
  v_price := v_line ->> 'unit_price';

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v1', 'event_type', 'saved',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'saved_unverified', 'saved → saved_unverified');

  v_evidence := jsonb_build_object(
    'bridge_ok', true,
    'irs_po_no', v_irs,
    'irs_grn_no', '7',
    'irs_invoice_no', 'INV-1001',
    'evidence_ref', 'IRS GRN screenshot 2026-11-13',
    'supplier_code', '4000/A01',
    'invoice_no', 'INV-1001',
    'delivery_order_no', 'DO-1001',
    'receive_date', '2026-11-13',
    'invoice_date', '2026-11-10',
    'saved_at', '2026-11-13T01:05:00Z',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_id', v_line ->> 'line_id',
      'line_no', v_line ->> 'line_no',
      'item_code', v_line ->> 'item_code',
      'uom', v_line ->> 'uom',
      'qty', v_qty,
      'unit_price', v_price,
      'sources', v_line -> 'sources'
    ))
  );

  -- 缺 GRN → needs_review（不是 verified）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v-nogr', 'event_type', 'verified',
      'evidence', v_evidence - 'irs_grn_no')::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', '缺 GRN → needs_review');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'mismatches') > 0, '返回 mismatches');
end
$v_a$;
reset role;

-- 测试构造（postgres）：准备可复用的完整证据 + 复位状态
-- 用 session GUC 传递（temp 表对 authenticated 没有权限）
create temp table _gr_ev on commit drop as
select
  t.id as task_id,
  t.receipt_event_id,
  t.payload_sha256,
  jsonb_build_object(
    'bridge_ok', true,
    'irs_po_no', t.irs_po_no,
    'irs_grn_no', '7',
    'irs_invoice_no', 'INV-1001',
    'evidence_ref', 'IRS GRN screenshot 2026-11-13',
    'supplier_code', '4000/A01',
    'invoice_no', 'INV-1001',
    'delivery_order_no', 'DO-1001',
    'receive_date', '2026-11-13',
    'invoice_date', '2026-11-10',
    'saved_at', '2026-11-13T01:05:00Z',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_id', t.payload -> 'scope' -> 'lines' -> 0 ->> 'line_id',
      'line_no', t.payload -> 'scope' -> 'lines' -> 0 ->> 'line_no',
      'item_code', t.payload -> 'scope' -> 'lines' -> 0 ->> 'item_code',
      'uom', t.payload -> 'scope' -> 'lines' -> 0 ->> 'uom',
      'qty', t.payload -> 'scope' -> 'lines' -> 0 ->> 'accepted_qty',
      'unit_price', t.payload -> 'scope' -> 'lines' -> 0 ->> 'unit_price',
      'sources', t.payload -> 'scope' -> 'lines' -> 0 -> 'sources'
    ))
  ) as evidence
from tj_preview.tj_gr_tasks t
where t.receipt_event_id = '30000000-0000-4000-8000-000000000001'
  and t.status = 'needs_review'
order by t.po_header_id limit 1;

do $evcfg$
begin
  perform pg_catalog.set_config('gr.ev_task', (select task_id::text from _gr_ev), true);
  perform pg_catalog.set_config('gr.ev_hash', (select payload_sha256 from _gr_ev), true);
  perform pg_catalog.set_config('gr.ev_json', (select evidence::text from _gr_ev), true);
end
$evcfg$;

update tj_preview.tj_gr_tasks set status = 'saved_unverified'
 where id = (select task_id from _gr_ev);

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $v_b$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_task uuid := current_setting('gr.ev_task')::uuid;
  v_hash text := current_setting('gr.ev_hash');
  v_json jsonb;
  v_evd jsonb := current_setting('gr.ev_json')::jsonb;
begin
  -- 证据里 line_id 重复 → needs_review
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v-dup', 'event_type', 'verified',
      'evidence', jsonb_set(v_evd, '{lines}',
        (v_evd -> 'lines') || (v_evd -> 'lines'), true))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', '重复 line_id → needs_review');
end
$v_b$;
reset role;

update tj_preview.tj_gr_tasks set status = 'saved_unverified' where id = (select task_id from _gr_ev);

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $v_c$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_task uuid := current_setting('gr.ev_task')::uuid;
  v_hash text := current_setting('gr.ev_hash');
  v_json jsonb;
  v_evd jsonb := current_setting('gr.ev_json')::jsonb;
begin
  -- 来源分配不匹配 → needs_review
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v-src', 'event_type', 'verified',
      'evidence', jsonb_set(v_evd, '{lines,0,sources,0,accepted_qty}', '"999"'::jsonb))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', '来源分配不匹配 → needs_review');
end
$v_c$;
reset role;

update tj_preview.tj_gr_tasks set status = 'saved_unverified' where id = (select task_id from _gr_ev);

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $v_d$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_task uuid := current_setting('gr.ev_task')::uuid;
  v_hash text := current_setting('gr.ev_hash');
  v_json jsonb;
  v_evd jsonb := current_setting('gr.ev_json')::jsonb;
begin
  -- 完整证据 → verified
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v3', 'event_type', 'verified', 'evidence', v_evd)::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'verified', '完整证据 → verified');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'verified_at') is not null, 'verified_at 写入');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'irs_grn_no') = '7', 'GRN 写入结构化字段（task）');
  perform pg_temp.gr_assert(
    (select irs_grn_no from tj_preview.tj_gr_receipt_events where id = v_ev) = '7',
    'GRN 写入结构化字段（event）');

  -- verified 终态：needs_review / failed 一律拒绝，不得降级
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v4', 'event_type', 'needs_review')::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_OUT_OF_ORDER', 'verified 拒绝 needs_review 降级');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'verified', 'verified 终态未被改写');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v5', 'event_type', 'failed')::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_OUT_OF_ORDER', 'verified 拒绝 failed');
end
$v_d$;
reset role;

-- ----------------------------------------------------------------------------
-- 5) 分批累计超余额：第二个事件要超过来源剩余 → 必须显式确认
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $batch$
declare
  v_ev2 uuid := '30000000-0000-4000-8000-000000000002';
  v_data jsonb;
  v_json jsonb;
  v_rev int;
begin
  v_data := jsonb_build_object(
    'id', v_ev2, 'revision', 0,
    'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000001'),
    'invoice_no', 'INV-1002', 'delivery_order_no', 'DO-1002',
    'receive_date', '2026-11-14', 'invoice_date', '2026-11-14', 'checked_by', 'Ah Huat',
    'lines', jsonb_build_array(jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000002', 'line_no', 1,
      'item_code', '00101', 'description', 'HINGE', 'uom', 'UNIT',
      'unit_price', '2.50', 'ordered_qty', '5', 'accepted_qty', '4',
      'source_allocations', jsonb_build_array(jsonb_build_object(
        'po_header_id', '10000000-0000-4000-8000-000000000001',
        'po_line_id', '20000000-0000-4000-8000-000000000001',
        'accepted_qty', '4'))
    ))
  );
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'exceptions') @> '[{"code":"over_balance"}]'::jsonb, '累计超余额标记 over_balance');
  perform pg_temp.gr_assert((v_json ->> 'review_required')::boolean = true, 'review_required=true');

  v_rev := (v_json ->> 'revision')::int;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
    jsonb_build_object('id', v_ev2, 'revision', v_rev)::text) into v_json;
end
$batch$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $batchapprove$
declare
  v_ev2 uuid := '30000000-0000-4000-8000-000000000002';
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev2;

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
      jsonb_build_object('id', v_ev2, 'revision', v_rev, 'allow_exceptions', false)::text),
    'GR_EXCEPTION_NOT_ALLOWED', '超余额未确认');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
      jsonb_build_object('id', v_ev2, 'revision', v_rev, 'allow_exceptions', 'yes')::text),
    'GR_VALIDATION', 'allow_exceptions 字符串被拒（不强转）');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
      jsonb_build_object('id', v_ev2, 'revision', v_rev, 'allow_exceptions', true)::text),
    'GR_VALIDATION', '确认异常但缺 review_note');

  perform tj_preview.tj_gr_api('receipt_approve',
    jsonb_build_object('id', v_ev2, 'revision', v_rev, 'allow_exceptions', true,
                       'review_note', '供应商多送，经核对接受')::text::jsonb);
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_gr_receipt_events where id = v_ev2) = 'approved',
    '显式确认后可批准');
end
$batchapprove$;
reset role;

-- ----------------------------------------------------------------------------
-- 6) 精度 / 额外行 / 来源不匹配 / 合成行不能做收货来源
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $precision$
declare
  v_ev3 uuid := '30000000-0000-4000-8000-000000000003';
  v_data jsonb;
  v_json jsonb;
begin
  v_data := jsonb_build_object(
    'id', v_ev3, 'revision', 0,
    'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000002'),
    'invoice_no', 'INV-1003', 'delivery_order_no', 'DO-1003',
    'receive_date', '2026-11-15', 'invoice_date', '2026-11-15', 'checked_by', 'Ah Huat',
    'lines', jsonb_build_array(jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000003', 'line_no', 1,
      'item_code', '00101', 'description', 'HINGE', 'uom', 'UNIT',
      'unit_price', '2.500', 'ordered_qty', '3.000', 'accepted_qty', '0.125',
      'source_allocations', jsonb_build_array(jsonb_build_object(
        'po_header_id', '10000000-0000-4000-8000-000000000002',
        'po_line_id', '20000000-0000-4000-8000-000000000002',
        'accepted_qty', '0.125'))
    ))
  );
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'accepted_qty') = '0.125', '小数精度保留（0.125）');
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'unit_price') = '2.5', '单价规范（2.500 → 2.5）');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_set(jsonb_set(v_data, '{lines,0,accepted_qty}', '"1e3"'), '{id}', '"30000000-0000-4000-8000-0000000000ff"')::text),
    'GR_INVALID_DECIMAL', '指数形式拒绝');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_set(jsonb_set(v_data, '{lines,0,accepted_qty}', '"0.1234567"'), '{id}', '"30000000-0000-4000-8000-0000000000fe"')::text),
    'GR_DECIMAL_SCALE', '超过 6 位小数拒绝');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_set(jsonb_set(v_data, '{lines,0,accepted_qty}', '"2"'), '{id}', '"30000000-0000-4000-8000-0000000000fd"')::text),
    'GR_QTY_MISMATCH', '行数量与来源分配不平');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_set(jsonb_set(v_data, '{lines,0,item_code}', '"WRONG"'), '{id}', '"30000000-0000-4000-8000-0000000000fc"')::text),
    'GR_SOURCE_MISMATCH', 'item_code 与来源不符');

  -- 同一来源行重复分配 → 拒绝
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_set(v_data, '{lines,0,source_allocations}',
        (v_data -> 'lines' -> 0 -> 'source_allocations') ||
        (v_data -> 'lines' -> 0 -> 'source_allocations'), true)::text),
    'GR_VALIDATION', '同一来源行重复分配');

  -- 额外行（无来源）→ exception（允许保存但需审批确认）
  declare
    v_data2 jsonb;
  begin
    v_data2 := jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000004', 'revision', 0,
      'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000002'),
      'invoice_no', 'INV-1004', 'delivery_order_no', 'DO-1004',
      'receive_date', '2026-11-15', 'invoice_date', '2026-11-15', 'checked_by', 'Ah Huat',
      'lines', jsonb_build_array(jsonb_build_object(
        'id', '40000000-0000-4000-8000-000000000004', 'line_no', 1,
        'item_code', 'EXTRA-1', 'description', 'FREE GIFT', 'uom', 'UNIT',
        'unit_price', '0', 'ordered_qty', '0', 'accepted_qty', '2',
        'source_allocations', '[]'::jsonb
      ))
    );
    execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save', v_data2::text) into v_json;
    perform pg_temp.gr_assert((v_json -> 'exceptions') @> '[{"code":"extra_line"}]'::jsonb, '额外行异常 extra_line');
    perform pg_temp.gr_assert((v_json ->> 'review_required')::boolean = true, '额外行 review_required');
  end;
end
$precision$;
reset role;

-- 6b) 来源当前状态/字段必须与保存快照一致（批准前复核，fail closed）
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $srccheck$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000003';
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_po_headers where id = '10000000-0000-4000-8000-000000000002') = 'confirmed',
    '来源 PO 初始 confirmed');
  perform pg_temp.gr_assert(v_rev >= 0, '事件3 有 revision');
end
$srccheck$;
reset role;

-- 来源状态被改成 draft → 提交必须 fail closed
update tj_preview.tj_po_headers set status = 'draft' where id = '10000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $srcstate$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000003';
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
      jsonb_build_object('id', v_ev, 'revision', v_rev)::text),
    'GR_STATE', '来源 PO 退回 draft 时禁止提交（fail closed）');
end
$srcstate$;
reset role;
update tj_preview.tj_po_headers set status = 'confirmed' where id = '10000000-0000-4000-8000-000000000002';

-- 来源订购量被改（快照 3 → 当前 4）→ 提交必须 fail closed
update tj_preview.tj_po_lines set qty = 4 where id = '20000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $srcsnap$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000003';
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
      jsonb_build_object('id', v_ev, 'revision', v_rev)::text),
    'GR_SOURCE_CHANGED', '来源订购量事后被改时禁止提交（快照不符）');
end
$srcsnap$;
reset role;
update tj_preview.tj_po_lines set qty = 3 where id = '20000000-0000-4000-8000-000000000002';

-- ----------------------------------------------------------------------------
-- 7) 旧 PO 安全：po_get 全量 / po_save 幂等 / 引用保护
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $poget$
declare
  v_json jsonb;
begin
  execute $q$select tj_preview.tj_gr_api('po_get', '{"id":"10000000-0000-4000-8000-000000000001"}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert((v_json ->> 'po_id') is not null, 'po_get 返回 po_id 显示编号');
  perform pg_temp.gr_assert((v_json ->> 'supplier_code') = '4000/A01', 'po_get 返回完整 header');
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json -> 'lines') = 'array', 'po_get 带 lines 数组');
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json -> 'lines' -> 0 -> 'qty') = 'string', 'po_get qty 为十进制字符串（不丢精度）');
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json -> 'lines' -> 0 -> 'unit_price') = 'string', 'po_get unit_price 为十进制字符串');
  perform pg_temp.gr_assert(v_json ? 'source_po_ids', 'po_get 带 source_po_ids 字段（standard 为 null）');
  perform pg_temp.gr_expect_error(
    $q$select tj_preview.tj_gr_api('po_get', '{"id":"10000000-0000-4000-8000-0000000000ff"}'::jsonb)$q$,
    'GR_NOT_FOUND', 'po_get 不存在 PO');

  -- 非法数字传参：不接受 float 精度丢失的字符串
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'qty') = '5', 'po_get 十进制文本与库内一致');
end
$poget$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $posave$
declare
  v_po uuid := '10000000-0000-4000-8000-000000000003';
  v_req text := 'req-po-save-1';
  v_data jsonb;
  v_json jsonb;
  v_json2 jsonb;
  v_lines_before int;
begin
  v_data := jsonb_build_object(
    'id', v_po, 'request_id', v_req,
    'supplier_code', '4000/A01', 'supplier_name', 'AMFIX',
    'notes', 'call supplier before 3pm', 'created_by', 'Ah Huat',
    'lines', jsonb_build_array(
      jsonb_build_object('id', '20000000-0000-4000-8000-000000000003', 'line_no', 1,
                         'item_code', '00301', 'description', 'SCREW', 'uom', 'BOX',
                         'qty', '2', 'unit_price', '25.00'),
      jsonb_build_object('line_no', 2, 'item_code', '00302', 'description', 'NAIL',
                         'uom', 'BOX', 'qty', '1', 'unit_price', '10.00')
    )
  );
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save', v_data::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'notes') = 'call supplier before 3pm', 'po_save notes 落库');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'lines') = 2, 'po_save 新增未引用行');

  -- request_id 幂等：同参返回同一结果（不再写）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save', v_data::text) into v_json2;
  perform pg_temp.gr_assert(v_json2 = v_json, 'po_save request_id 幂等返回同结果');

  -- 同 request_id 不同参数 → 冲突
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_set(v_data, '{notes}', '"tampered"')::text),
    'GR_IDEMPOTENCY_CONFLICT', '同 request_id 不同参数');

  -- 换 request_id 但内容相同 → 幂等重放（不产生第二份行）
  select count(*) into v_lines_before from tj_preview.tj_po_lines where po_header_id = v_po;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
    jsonb_set(v_data, '{request_id}', '"req-po-save-2"')::text) into v_json2;
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_lines where po_header_id = v_po) = v_lines_before,
    '同内容不同 request_id 不产生第二份明细');

  -- 冻结 PO 不能 po_save
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_build_object('id', '10000000-0000-4000-8000-000000000005', 'request_id', 'req-po-frozen',
        'supplier_code', '4000/A01', 'notes', 'x', 'lines', '[]'::jsonb)::text),
    'GR_STATE', '冻结 PO 禁止 po_save');

  -- preview 里 po_push 一律硬禁
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_push',
      jsonb_build_object('id', v_po, 'request_id', 'req-push-1')::text),
    'GR_PUSH_BLOCKED', 'preview po_push 硬禁');
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_po_headers where id = v_po) = 'confirmed',
    'po_push 失败后状态未变');

  -- 清掉临时新增的未引用行，恢复 PO3 单行（供 combine 全量覆盖断言）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
    jsonb_build_object('id', v_po, 'request_id', 'req-po-save-clean',
      'supplier_code', '4000/A01',
      'lines', jsonb_build_array(
        jsonb_build_object('id', '20000000-0000-4000-8000-000000000003', 'line_no', 1,
                           'item_code', '00301', 'description', 'SCREW', 'uom', 'BOX',
                           'qty', '2', 'unit_price', '25.00')))::text) into v_json;
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_lines where po_header_id = v_po) = 1,
    '清理临时行后 PO3 恢复 1 行');
end
$posave$;
reset role;

-- po_save 无稳定行 id：按 line_no 更新，不重复插入
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $posave2$
declare
  v_po uuid := '10000000-0000-4000-8000-000000000009';
  v_data jsonb;
  v_json jsonb;
begin
  v_data := jsonb_build_object(
    'id', v_po, 'request_id', 'req-po9-1',
    'supplier_code', '4000/A01', 'supplier_name', 'AMFIX',
    'lines', jsonb_build_array(
      jsonb_build_object('line_no', 1, 'item_code', '00901', 'description', 'WASHER',
                         'uom', 'UNIT', 'qty', '4', 'unit_price', '2.00'),
      jsonb_build_object('line_no', 2, 'item_code', '00902', 'description', 'RING',
                         'uom', 'UNIT', 'qty', '2', 'unit_price', '3.00')
    )
  );
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save', v_data::text) into v_json;
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'lines') = 2, '无 id 首次保存 2 行');

  -- 同内容重试（新 request_id）→ 仍然 2 行（line_no 更新，不再插一份）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
    jsonb_set(v_data, '{request_id}', '"req-po9-2"')::text) into v_json;
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_lines where po_header_id = v_po) = 2,
    '无 id 重试不重复插入');
end
$posave2$;
reset role;

-- 引用保护 + FK RESTRICT
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $refguard$
begin
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_build_object('id', '10000000-0000-4000-8000-000000000001', 'request_id', 'req-po-ref-1',
        'supplier_code', '4000/A01',
        'lines', jsonb_build_array(
          jsonb_build_object('id', '20000000-0000-4000-8000-000000000001', 'line_no', 1,
                             'item_code', 'HACKED', 'description', 'HINGE', 'uom', 'UNIT',
                             'qty', '5', 'unit_price', '2.50')))::text),
    'GR_STATE', '被引用明细不得改业务字段');

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_build_object('id', '10000000-0000-4000-8000-000000000001', 'request_id', 'req-po-ref-2',
        'supplier_code', '4000/A01', 'lines', '[]'::jsonb)::text),
    'GR_STATE', '被引用明细不得删除');
end
$refguard$;
reset role;

do $fkrestrict$
begin
  perform pg_temp.gr_expect_fk(
    $q$delete from tj_preview.tj_po_lines where id = '20000000-0000-4000-8000-000000000001'$q$,
    '被收货引用的来源明细不能删除（FK RESTRICT）');
  perform pg_temp.gr_expect_fk(
    $q$delete from tj_preview.tj_po_headers where id = '10000000-0000-4000-8000-000000000001'$q$,
    '被来源分配引用的 PO 不能删除（FK RESTRICT）');
end
$fkrestrict$;

-- ----------------------------------------------------------------------------
-- 8) combine：完整性 / 冻结来源 / 不伪造收货字段 / v2 快照
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $combined$
declare
  v_req text := 'req-combine-1';
  v_data jsonb;
  v_json jsonb;
  v_json2 jsonb;
  v_id uuid;
begin
  v_data := jsonb_build_object(
    'request_id', v_req,
    'source_ids', jsonb_build_array('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004'),
    'website_po_date', '2026-11-09',
    'created_by', 'Ah Huat',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'item_code', '00301', 'description', 'SCREW', 'uom', 'BOX',
      'unit_price', '25.00', 'ordered_qty', '3', 'accepted_qty', '5',
      'source_refs', jsonb_build_array(
        jsonb_build_object('po_id', '10000000-0000-4000-8000-000000000003',
                           'po_number', 'PO-FIXTURE-3', 'line_id', '20000000-0000-4000-8000-000000000003', 'qty', '2'),
        jsonb_build_object('po_id', '10000000-0000-4000-8000-000000000004',
                           'po_number', 'PO-FIXTURE-4', 'line_id', '20000000-0000-4000-8000-000000000004', 'qty', '1'))))
  );

  -- 已被收货引用的来源 PO 不得并入合并单（禁止混用）
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create',
      jsonb_build_object('request_id', 'req-combine-receipted',
        'source_ids', jsonb_build_array('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
        'website_po_date', '2026-11-09',
        'lines', jsonb_build_array(jsonb_build_object(
          'line_no', 1, 'item_code', '00101', 'description', 'HINGE', 'uom', 'UNIT',
          'unit_price', '2.50', 'ordered_qty', '8', 'accepted_qty', '8',
          'source_refs', jsonb_build_array(
            jsonb_build_object('po_id', '10000000-0000-4000-8000-000000000001',
                               'line_id', '20000000-0000-4000-8000-000000000001', 'qty', '5'),
            jsonb_build_object('po_id', '10000000-0000-4000-8000-000000000002',
                               'line_id', '20000000-0000-4000-8000-000000000002', 'qty', '3')))))::text),
    'GR_STATE', '已被收货引用的来源不得合并');

  -- 引用放大原订购量（2 → 3）→ 拒绝
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create',
      jsonb_set(jsonb_set(v_data, '{request_id}', '"req-combine-inflate"'),
        '{lines,0,source_refs,0,qty}', '"3"')::text),
    'GR_QTY_MISMATCH', 'ref qty 不得放大原订购量');

  -- 漏掉来源行（只引用 PO3）→ 拒绝
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create',
      jsonb_set(jsonb_set(v_data, '{request_id}', '"req-combine-miss"'),
        '{lines,0,source_refs}',
        pg_catalog.jsonb_build_array(v_data -> 'lines' -> 0 -> 'source_refs' -> 0), false)::text),
    'GR_QTY_MISMATCH', 'source_refs 必须覆盖全部来源行');

  -- 重复引用同一来源行 → 拒绝
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create',
      jsonb_set(jsonb_set(v_data, '{request_id}', '"req-combine-dup"'),
        '{lines,0,source_refs}',
        pg_catalog.jsonb_build_array(v_data -> 'lines' -> 0 -> 'source_refs' -> 0)
          || (v_data -> 'lines' -> 0 -> 'source_refs'), true)::text),
    'GR_VALIDATION', 'source_refs 不得重复引用');

  -- 冻结来源 → 明确拒绝
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create',
      jsonb_build_object('request_id', 'req-combine-frozen',
        'source_ids', jsonb_build_array('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004'),
        'website_po_date', '2026-11-09',
        'lines', jsonb_build_array(jsonb_build_object(
          'line_no', 1, 'item_code', '00101', 'description', 'HINGE', 'uom', 'UNIT',
          'unit_price', '2.50', 'ordered_qty', '2', 'accepted_qty', '2',
          'source_refs', jsonb_build_array(jsonb_build_object(
            'po_id', '10000000-0000-4000-8000-000000000005',
            'line_id', '20000000-0000-4000-8000-000000000005', 'qty', '2')))))::text),
    'GR_STATE', '冻结来源不能合并');

  -- 正常合并且 accepted > ordered（允许，但需独立收货审查）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create', v_data::text) into v_json;
  v_id := (v_json ->> 'id')::uuid;
  perform pg_temp.gr_assert((v_json ->> 'po_type') = 'combined', 'combine_create 建合并单');
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'qty') = '3', '合并行 qty=订购合计 3');
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'accepted_qty') = '5', '合并行 accepted 可超订购（不静默改写）');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_headers where source_po_ids is not null and id = v_id) = 1,
    'source_po_ids 写入');

  -- 幂等：同 request_id 同参数不新建
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create', v_data::text) into v_json2;
  perform pg_temp.gr_assert((v_json2 ->> 'id')::uuid = v_id, 'combine_create request_id 幂等');

  -- 来源单已被占用 → 再并一次被拒
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create',
      jsonb_set(v_data, '{request_id}', '"req-combine-2"')::text),
    'GR_STATE', '来源单被占用');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_submit',
    jsonb_build_object('id', v_id, 'checked_by', 'Ah Huat', 'delivery_order_no', 'DO-C-1')::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'pending_approval', 'combine_submit → pending_approval');
  perform pg_temp.gr_assert((v_json ->> 'receipt_event_id') is null, 'combine_submit 不伪造 receipt_event_id');
  perform pg_temp.gr_assert((v_json ->> 'received_at') is null, 'combine_submit 不伪造 received_at');

  -- 幂等 submit：再调一次不报错、状态不变
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_submit',
    jsonb_build_object('id', v_id)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'pending_approval', 'combine_submit 幂等');

  -- 用合并单合成行做收货来源 → 拒绝（B7）
  perform pg_catalog.set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000002', true);
  declare
    v_synth uuid;
    v_po_text text;
  begin
    select l.id into v_synth from tj_preview.tj_po_lines l where l.po_header_id = v_id order by l.line_no limit 1;
    select po_id into v_po_text from tj_preview.tj_po_headers where id = v_id;
    perform pg_temp.gr_expect_error(
      format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
        jsonb_build_object(
          'id', '30000000-0000-4000-8000-0000000000aa', 'revision', 0,
          'po_ids', jsonb_build_array(v_id),
          'invoice_no', 'INV-C-1', 'delivery_order_no', 'DO-C-2',
          'receive_date', '2026-11-20', 'invoice_date', '2026-11-20', 'checked_by', 'Ah Huat',
          'lines', jsonb_build_array(jsonb_build_object(
            'id', '40000000-0000-4000-8000-0000000000aa', 'line_no', 1,
            'item_code', '00301', 'description', 'SCREW', 'uom', 'BOX',
            'unit_price', '25.00', 'ordered_qty', '3', 'accepted_qty', '1',
            'source_allocations', jsonb_build_array(jsonb_build_object(
              'po_header_id', v_id, 'po_line_id', v_synth, 'accepted_qty', '1')))))::text),
      'GR_SOURCE_MISMATCH', '合并单合成行不能作为收货来源');
  end;
end
$combined$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $combineapprove$
declare
  v_id uuid;
  v_json jsonb;
  v_sha text;
  v_sha2 text;
  v_canon text;
begin
  select id into v_id from tj_preview.tj_po_headers
   where po_type = 'combined' and status = 'pending_approval' order by created_at desc limit 1;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_approve',
    jsonb_build_object('id', v_id)::text) into v_json;

  perform pg_temp.gr_assert((v_json ->> 'status') = 'confirmed', 'combine_approve → confirmed');
  perform pg_temp.gr_assert((v_json ->> 'frozen')::boolean = true, '合并单冻结');
  perform pg_temp.gr_assert(
    (select approval_snapshot_version from tj_preview.tj_po_headers where id = v_id) = 2, 'approval_snapshot_version=2');
  v_sha := (select source_sha256 from tj_preview.tj_po_headers where id = v_id);
  perform pg_temp.gr_assert(v_sha ~ '^[0-9a-f]{64}$', 'source_sha256 为 64 hex');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_headers where po_id in
       (select unnest(source_po_ids) from tj_preview.tj_po_headers where id = v_id)
       and status = 'combined') = 2, '来源单标 combined');

  -- 幂等 approve：不改 hash / approved_at
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_approve',
    jsonb_build_object('id', v_id)::text) into v_json;
  v_sha2 := (select source_sha256 from tj_preview.tj_po_headers where id = v_id);
  perform pg_temp.gr_assert(v_sha2 = v_sha, 'combine_approve 幂等（hash 不变）');

  -- 冻结后不可直改：authenticated 连 UPDATE 权限都没有（写只走 RPC）
  perform pg_temp.gr_expect_denied(
    format('update tj_preview.tj_po_headers set website_po_date = date %L where id = %L', '2026-11-10', v_id),
    '直改冻结合并单被权限拒绝');
end
$combineapprove$;
reset role;

-- 快照哈希 / v2 格式（postgres 身份；helper 不对 authenticated 开放）
do $combinesnap$
declare
  v_id uuid;
  v_canon text;
  v_sha text;
begin
  select id into v_id from tj_preview.tj_po_headers
   where po_type = 'combined' and status = 'confirmed' order by created_at desc limit 1;
  v_canon := tj_preview.tj_gr_approval_canonical(v_id);
  v_sha := (select source_sha256 from tj_preview.tj_po_headers where id = v_id);
  perform pg_temp.gr_assert(v_sha = tj_preview.tj_gr_sha256(v_canon), '快照哈希可重算一致');
  perform pg_temp.gr_assert(v_canon like '{"snapshot_version":2,%', 'v2 快照格式');
end
$combinesnap$;

-- 既有 freeze guard 仍然生效（以表 owner 身份验证，证明不是只靠权限）
do $frozen$
declare
  v_id uuid;
begin
  select id into v_id from tj_preview.tj_po_headers
   where po_type = 'combined' and status = 'confirmed' order by created_at desc limit 1;
  begin
    update tj_preview.tj_po_headers set website_po_date = date '2026-11-10' where id = v_id;
    raise exception 'ASSERT_FAILED: 冻结合并单竟然可改日期';
  exception when check_violation then
    raise notice 'PASS 拒绝: 冻结合并单改日期 -> check_violation（既有 guard 未被本轮关闭）';
  end;
end
$frozen$;

-- ----------------------------------------------------------------------------
-- 9) 额外行阻塞（B6）：保持 approved、不建任务、不静默丢行
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $extras$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000006';
  v_json jsonb;
  v_rev int;
begin
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
    jsonb_build_object(
      'id', v_ev, 'revision', 0,
      'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000008'),
      'invoice_no', 'INV-EXTRA', 'delivery_order_no', 'DO-EXTRA',
      'receive_date', '2026-11-17', 'invoice_date', '2026-11-17', 'checked_by', 'Ah Huat',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'id', '40000000-0000-4000-8000-000000000008', 'line_no', 1,
          'item_code', '00801', 'description', 'NUT', 'uom', 'UNIT',
          'unit_price', '5.00', 'ordered_qty', '3', 'accepted_qty', '1',
          'source_allocations', jsonb_build_array(jsonb_build_object(
            'po_header_id', '10000000-0000-4000-8000-000000000008',
            'po_line_id', '20000000-0000-4000-8000-000000000008',
            'accepted_qty', '1'))),
        jsonb_build_object(
          'id', '40000000-0000-4000-8000-000000000009', 'line_no', 2,
          'item_code', 'EXTRA-9', 'description', 'FREE GIFT', 'uom', 'UNIT',
          'unit_price', '0', 'ordered_qty', '0', 'accepted_qty', '2',
          'source_allocations', '[]'::jsonb)
      ))::text) into v_json;
  v_rev := (v_json ->> 'revision')::int;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
    jsonb_build_object('id', v_ev, 'revision', v_rev)::text) into v_json;
end
$extras$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $extrasapprove$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000006';
  v_json jsonb;
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
    jsonb_build_object('id', v_ev, 'revision', v_rev, 'allow_exceptions', true,
      'review_note', '额外赠品需指定来源')::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'approved', '额外行事件显式确认后可批准');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'mapping_set',
    jsonb_build_object('po_header_id', '10000000-0000-4000-8000-000000000008',
      'irs_po_no', '12',
      'evidence', jsonb_build_object('checked_by', 'Ah Huat', 'checked_at', '2026-11-17T01:00:00Z'))::text) into v_json;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;

  perform pg_temp.gr_assert((v_json -> 'blocked' ->> 'code') = 'GR_EXTRA_ASSIGNMENT_REQUIRED',
    '额外行明确阻塞 GR_EXTRA_ASSIGNMENT_REQUIRED');
  perform pg_temp.gr_assert((v_json -> 'event' ->> 'status') = 'approved', '阻塞后保持 approved');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 0, '阻塞时不建任何任务');
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_gr_receipt_events where id = v_ev) = 'approved',
    '阻塞不改变事件状态（不留半成品任务）');
  perform pg_temp.gr_assert(
    exists (select 1 from tj_preview.tj_gr_audit where action = 'receipt_release_blocked'
            and entity_id = v_ev::text),
    '阻塞已审计');
end
$extrasapprove$;
reset role;

-- 9b) 发票号与 DO 全空：可保存/批准，但绝不放出正式 GR
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $nodoc$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000007';
  v_json jsonb;
  v_rev int;
begin
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
    jsonb_build_object(
      'id', v_ev, 'revision', 0,
      'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000008'),
      'invoice_no', null, 'delivery_order_no', null,
      'receive_date', '2026-11-18', 'invoice_date', '2026-11-18', 'checked_by', 'Ah Huat',
      'lines', jsonb_build_array(jsonb_build_object(
        'id', '40000000-0000-4000-8000-00000000000a', 'line_no', 1,
        'item_code', '00801', 'description', 'NUT', 'uom', 'UNIT',
        'unit_price', '5.00', 'ordered_qty', '3', 'accepted_qty', '1',
        'source_allocations', jsonb_build_array(jsonb_build_object(
          'po_header_id', '10000000-0000-4000-8000-000000000008',
          'po_line_id', '20000000-0000-4000-8000-000000000008',
          'accepted_qty', '1'))
      )))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'draft', '两号全空仍可保存 draft');
  v_rev := (v_json ->> 'revision')::int;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
    jsonb_build_object('id', v_ev, 'revision', v_rev)::text) into v_json;
end
$nodoc$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $nodocrelease$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000007';
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  perform tj_preview.tj_gr_api('receipt_approve',
    jsonb_build_object('id', v_ev, 'revision', v_rev, 'allow_exceptions', false)::text::jsonb);

  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
      jsonb_build_object('id', v_ev)::text),
    'GR_VALIDATION', '发票号与 DO 全空时禁止释放正式 GR');
  perform pg_temp.gr_assert(
    (select status from tj_preview.tj_gr_receipt_events where id = v_ev) = 'approved',
    '拒绝释放后仍保持 approved（无半成品任务）');
end
$nodocrelease$;
reset role;

-- 9c) 部分收货（B1 回归）：某来源 PO 全 0 分配，release 只给正数 PO 建任务，不再卡死
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $partialsave$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000008';
  v_json jsonb;
  v_rev int;
begin
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
    jsonb_build_object(
      'id', v_ev, 'revision', 0,
      'po_ids', jsonb_build_array('10000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000b'),
      'invoice_no', 'INV-PARTIAL', 'delivery_order_no', 'DO-PARTIAL',
      'receive_date', '2026-11-19', 'invoice_date', '2026-11-18', 'checked_by', 'Ah Huat',
      'lines', jsonb_build_array(jsonb_build_object(
        'id', '40000000-0000-4000-8000-00000000000c', 'line_no', 1,
        'item_code', '00101', 'description', 'HINGE', 'uom', 'UNIT',
        'unit_price', '2.50', 'ordered_qty', '10', 'accepted_qty', '2',
        'source_allocations', jsonb_build_array(
          jsonb_build_object('po_header_id', '10000000-0000-4000-8000-00000000000a',
            'po_line_id', '20000000-0000-4000-8000-00000000000a', 'accepted_qty', '2'),
          jsonb_build_object('po_header_id', '10000000-0000-4000-8000-00000000000b',
            'po_line_id', '20000000-0000-4000-8000-00000000000b', 'accepted_qty', '0')
        ))))::text) into v_json;
  v_rev := (v_json ->> 'revision')::int;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_submit',
    jsonb_build_object('id', v_ev, 'revision', v_rev)::text) into v_json;
end
$partialsave$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $partialrelease$
declare
  v_ev uuid := '30000000-0000-4000-8000-000000000008';
  v_json jsonb;
  v_rev int;
begin
  select revision into v_rev from tj_preview.tj_gr_receipt_events where id = v_ev;
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_approve',
    jsonb_build_object('id', v_ev, 'revision', v_rev, 'allow_exceptions', false)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'approved', '部分收货（含 0 分配来源）可批准');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'mapping_set',
    jsonb_build_object('po_header_id', '10000000-0000-4000-8000-00000000000a',
      'irs_po_no', '13',
      'evidence', jsonb_build_object('checked_by', 'Ah Huat', 'checked_at', '2026-11-19T01:00:00Z'))::text) into v_json;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'event' ->> 'status') = 'released',
    '部分收货（某 PO 全 0 分配）可释放，不卡死（B1）');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 1,
    '只为正数量来源 PO 建 1 个任务');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_tasks where receipt_event_id = v_ev) = 1,
    '0 分配来源 PO2 不建空任务');
  perform pg_temp.gr_assert(
    (select po_header_id from tj_preview.tj_gr_tasks where receipt_event_id = v_ev)
      = '10000000-0000-4000-8000-00000000000a',
    '唯一任务属于正数量来源 PO1');
end
$partialrelease$;
reset role;

-- ----------------------------------------------------------------------------
-- 10) 回滚 + 零残留比对
-- ----------------------------------------------------------------------------
rollback to savepoint gr_tests;

do $compare$
declare
  b record;
  a record;
begin
  select * into b from _gr_baseline;

  select
    (select count(*) from tj_preview.tj_gr_receipt_events) as events,
    (select count(*) from tj_preview.tj_gr_receipt_lines) as lines,
    (select count(*) from tj_preview.tj_gr_line_sources) as sources,
    (select count(*) from tj_preview.tj_gr_tasks) as tasks,
    (select count(*) from tj_preview.tj_gr_outbox) as outbox,
    (select count(*) from tj_preview.tj_gr_po_mappings) as mappings,
    (select count(*) from tj_preview.tj_gr_audit) as audit,
    (select count(*) from tj_preview.tj_po_headers) as po_headers,
    (select count(*) from tj_preview.tj_po_lines) as po_lines,
    (select md5(coalesce(string_agg(row_to_json(h)::text, '|' order by h.id), ''))
       from tj_preview.tj_po_headers h) as po_hdr_hash
  into a;

  perform pg_temp.gr_assert(a.events = b.events, '回滚后收货事件数一致');
  perform pg_temp.gr_assert(a.lines = b.lines, '回滚后收货明细数一致');
  perform pg_temp.gr_assert(a.sources = b.sources, '回滚后来源分配数一致');
  perform pg_temp.gr_assert(a.tasks = b.tasks, '回滚后任务数一致');
  perform pg_temp.gr_assert(a.outbox = b.outbox, '回滚后 outbox 数一致');
  perform pg_temp.gr_assert(a.mappings = b.mappings, '回滚后映射数一致');
  perform pg_temp.gr_assert(a.audit = b.audit, '回滚后审计数一致');
  perform pg_temp.gr_assert(a.po_headers = b.po_headers, '回滚后 PO 数一致（零残留）');
  perform pg_temp.gr_assert(a.po_lines = b.po_lines, '回滚后 PO 明细数一致（零残留）');
  perform pg_temp.gr_assert(a.po_hdr_hash = b.po_hdr_hash, '回滚后 PO 内容摘要一致（原数据未改）');

  raise notice '====================================================';
  raise notice 'GR PREVIEW INTEGRATION: ALL PASS（全部写入已回滚）';
  raise notice '====================================================';
end
$compare$;

rollback;
