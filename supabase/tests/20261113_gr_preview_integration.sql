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
-- 覆盖：权限矩阵 / 直接写拒绝 / 读数精度 / 分批累计超余额 / 额外行 / 映射 /
--       任务拆分 / claim / lease / 回调幂等 / 乱序 / verified 逐行证据 /
--       旧 PO 安全（po_save 幂等+引用保护、po_push preview 硬禁）/
--       combine 幂等+v2 快照+冻结。并断言事件哈希读回一致、零残留。
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

  -- PO3 / PO4：combine 测试（同供应商、未冻结）
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

  -- PO5：已冻结（旧 PO 保护测试）
  insert into tj_preview.tj_po_headers
    (id, po_seq, supplier_code, supplier_name, status, po_type, created_by, frozen, approved_by, approved_at)
  overriding system value
  values ('10000000-0000-4000-8000-000000000005', -9005, '4000/A01', 'AMFIX',
          'confirmed', 'standard', 'fixture', false, null, null);
  insert into tj_preview.tj_po_lines (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
  values ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005',
          1, '00101', 'HINGE', 'UNIT', 2, 2.50);
  update tj_preview.tj_po_headers
     set frozen = true, approved_by = 'fixture', approved_at = now()
   where id = '10000000-0000-4000-8000-000000000005';
end
$fixtures$;


-- ----------------------------------------------------------------------------
-- 2) 权限/安全基线（catalog 级）
-- ----------------------------------------------------------------------------
do $sec$
begin
  perform pg_temp.gr_assert(has_schema_privilege('service_role', 'tj_preview', 'USAGE') = false,
    'service_role 不得拥有 tj_preview USAGE');
  perform pg_temp.gr_assert(has_function_privilege('anon', 'tj_preview.tj_gr_api(text,jsonb)', 'EXECUTE') = false,
    'anon 不得 EXECUTE tj_gr_api');
  perform pg_temp.gr_assert(has_function_privilege('authenticated', 'tj_preview.tj_gr_api(text,jsonb)', 'EXECUTE') = true,
    'authenticated 可 EXECUTE tj_gr_api');
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_gr_receipt_events', 'INSERT') = false,
    'authenticated 不得直插新表（写只走 RPC）');
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_po_headers', 'UPDATE') = false,
    '预览旧表 authenticated 直写已撤销');
  perform pg_temp.gr_assert(
    has_table_privilege('authenticated', 'tj_preview.tj_po_headers', 'SELECT') = true,
    '预览旧表 authenticated 可读（RLS 再按 membership 过滤）');
end
$sec$;

-- anon 直接写新表 → 权限拒绝
set local role anon;
do $anon$
begin
  perform pg_temp.gr_expect_denied(
    $q$insert into tj_preview.tj_gr_receipt_events (id, event_no, po_ids, receive_date, created_by)
       values ('30000000-0000-4000-8000-00000000ffff', 'GR-ANON', array['10000000-0000-4000-8000-000000000001']::uuid[], current_date, gen_random_uuid())$q$,
    'anon 直插收货事件');
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
-- 3) 主流程：staff 保存 → submit → approver 一步批准 → 映射 → release
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';

do $save$
declare
  v_staff uuid := 'a0000000-0000-4000-8000-000000000002';
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_data jsonb;
  v_json jsonb;
  v_line jsonb;
begin
  v_data := jsonb_build_object(
    'id', v_ev,
    'revision', 0,
    'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
    'invoice_no', 'INV-1001',
    'delivery_order_no', 'DO-1001',
    'receive_date', '2026-11-13',
    'invoice_date', null,
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
  -- 短收 + 疑似重复单号 → warning
  perform pg_temp.gr_assert((v_json -> 'warnings') ? 'short_receipt', '短收 warning');

  -- 列表 / 单条读取（契约形状）
  execute $q$select tj_preview.tj_gr_api('receipt_list', '{"limit": 20}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json) = 'array', 'receipt_list 返回数组');
  perform pg_temp.gr_assert(pg_catalog.jsonb_array_length(v_json) >= 1, 'receipt_list 至少 1 条');
  perform pg_temp.gr_assert((v_json -> 0 ->> 'id') = v_ev::text, 'receipt_list 含刚保存的事件');
  perform pg_temp.gr_assert((v_json -> 0 ->> 'receive_date') = '2026-11-13', '列表日期格式 yyyy-MM-dd');

  execute $q$select tj_preview.tj_gr_api('receipt_list', '{"status": ["draft"]}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert(pg_catalog.jsonb_array_length(v_json) >= 1, 'status 数组过滤可用');
  execute $q$select tj_preview.tj_gr_api('receipt_list', '{"status": "verified"}'::jsonb)$q$ into v_json;
  perform pg_temp.gr_assert(pg_catalog.jsonb_array_length(v_json) = 0, 'status 文本过滤可用');

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_get',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'id') = v_ev::text, 'receipt_get 返回事件');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'lines') = 1, 'receipt_get 带 1 行');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'lines' -> 0 -> 'sources') = 2, 'receipt_get 带全部来源分配');
  perform pg_temp.gr_assert(pg_catalog.jsonb_typeof(v_json -> 'tasks') = 'array', 'receipt_get 带 tasks 数组');

  -- revision CAS：用返回的 revision 再存一次（0 → 1），然后用旧 revision 再存 → 冲突
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
  v_hash := v_json ->> 'payload_sha256';
  perform pg_temp.gr_assert(v_hash = tj_preview.tj_gr_event_hash(v_ev), '存储 hash == 读回重算（批准时锁定内容）');

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
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_outbox where kind = 'gr_task_dispatch' and mock_only and status = 'pending') = 2,
    'outbox 持久化 2 条 pending（mock_only）');

  -- 重复 release 幂等
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_release',
    jsonb_build_object('id', v_ev)::text) into v_json;
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'tasks') = 2, '重复 release 不重复建任务');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_outbox where kind = 'gr_task_dispatch') = 2,
    'outbox 未重复');
end
$approve$;
reset role;

-- ----------------------------------------------------------------------------
-- 4) 任务：claim / 回调幂等 / 乱序 / bridge 失败 / 逐行证据
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

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $tasks$
declare
  v_task uuid;
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_hash text;
  v_json jsonb;
  v_evidence jsonb;
begin
  select id into v_task from tj_preview.tj_gr_tasks order by po_header_id limit 1;
  select payload_sha256 into v_hash from tj_preview.tj_gr_tasks where id = v_task;

  -- 领取：绑定当前 executor
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_claim',
    jsonb_build_object('task_id', v_task)::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'status') = 'claimed', '领取后 claimed');
  perform pg_temp.gr_assert((v_json ->> 'claimed_by') = 'a0000000-0000-4000-8000-000000000003', 'claimed_by 绑定 executor');
  perform pg_temp.gr_assert((v_json ->> 'lease_expires_at') is not null, 'lease 已设置');
  perform pg_temp.gr_assert((select status from tj_preview.tj_gr_receipt_events where id = v_ev) = 'in_progress',
    '事件聚合为 in_progress');

  -- 乱序：saved 早于 save_attempted → 拒绝（rejected=true + 审计；状态不回退）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-out-of-order', 'event_type', 'saved',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'rejected')::boolean = true, 'saved 早于 save_attempted 被拒');
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_OUT_OF_ORDER', '乱序错误码');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'claimed', '乱序拒绝后状态不变');

  -- 串任务 hash
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
      jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev,
        'payload_sha256', repeat('0', 64),
        'callback_id', 'cb-bad-hash', 'event_type', 'save_attempted')::text),
    'GR_VALIDATION', 'payload_sha256 不匹配');

  -- 开始保存
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-1', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'save_attempted', 'save_attempted 记录');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'save_attempted_at') is not null, 'save_attempted_at 写入');

  -- 同 callback_id + 同内容 → replay（不重复改状态）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-1', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'replayed')::boolean = true, '相同 callback 幂等 replay');

  -- 同 callback_id + 不同内容 → 冲突审计拒绝（不 raise：审计必须提交才留得住）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-1', 'event_type', 'failed',
      'evidence', jsonb_build_object('bridge_ok', false))::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'rejected')::boolean = true, '同 callback_id 不同内容被拒');
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_CONFLICT', '回调冲突错误码');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'save_attempted', '冲突后状态不变');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_gr_task_callbacks where callback_id = 'cb-1' and accepted = false) = 1,
    '冲突已审计（accepted=false）');

  -- bridge ok=false 的 saved → needs_review（不自动重做）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-2', 'event_type', 'saved',
      'evidence', jsonb_build_object('bridge_ok', false))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', 'bridge ok=false → needs_review');
  perform pg_temp.gr_assert((v_json ->> 'event_status') = 'needs_review', '事件聚合 needs_review');
end
$tasks$;
reset role;

-- 第二个任务：完整 verified 路径 + 逐行证据严格比对
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
  v_evidence jsonb;
  v_qty text;
  v_price text;
  v_irs text;
  v_po uuid;
begin
  select t.id, t.payload_sha256, t.payload, t.irs_po_no, t.po_header_id
    into v_task, v_hash, v_payload, v_irs, v_po
  from tj_preview.tj_gr_tasks t
  where t.receipt_event_id = v_ev and t.status = 'ready'
  order by t.po_header_id limit 1;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_claim',
    jsonb_build_object('task_id', v_task)::text) into v_json;

  v_line := v_payload -> 'scope' -> 'lines' -> 0;
  v_qty := v_line ->> 'accepted_qty';
  v_price := v_line ->> 'unit_price';

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v0', 'event_type', 'save_attempted',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v1', 'event_type', 'saved',
      'evidence', jsonb_build_object('bridge_ok', true))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'saved_unverified', 'saved → saved_unverified');

  -- 证据不带逐行 → 不通过（不是布尔标志就能过）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v2', 'event_type', 'verified',
      'evidence', jsonb_build_object('bridge_ok', true, 'irs_po_no', v_irs))::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'needs_review', '缺逐行证据 → needs_review');
  perform pg_temp.gr_assert(jsonb_array_length(v_json -> 'mismatches') > 0, '返回 mismatches');
end
$verify$;
reset role;

-- 测试构造：把刚才的 needs_review 复位为 saved_unverified（postgres 身份；仅测试用）
update tj_preview.tj_gr_tasks set status = 'saved_unverified'
 where receipt_event_id = '30000000-0000-4000-8000-000000000001' and status = 'needs_review';

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';
do $verify2$
declare
  v_task uuid;
  v_ev uuid := '30000000-0000-4000-8000-000000000001';
  v_hash text;
  v_json jsonb;
  v_payload jsonb;
  v_line jsonb;
  v_evidence jsonb;
  v_qty text;
  v_price text;
  v_irs text;
begin
  select t.id, t.payload_sha256, t.payload, t.irs_po_no
    into v_task, v_hash, v_payload, v_irs
  from tj_preview.tj_gr_tasks t
  where t.receipt_event_id = v_ev and t.status = 'saved_unverified'
  order by t.po_header_id limit 1;

  v_line := v_payload -> 'scope' -> 'lines' -> 0;
  v_qty := v_line ->> 'accepted_qty';
  v_price := v_line ->> 'unit_price';

  v_evidence := jsonb_build_object(
    'bridge_ok', true,
    'irs_po_no', v_irs,
    'irs_grn_no', '7',
    'supplier_code', '4000/A01',
    'invoice_no', 'INV-1001',
    'delivery_order_no', 'DO-1001',
    'saved_at', '2026-11-13T01:05:00Z',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_id', v_line ->> 'line_id',
      'item_code', v_line ->> 'item_code',
      'uom', v_line ->> 'uom',
      'qty', v_qty,
      'unit_price', v_price
    ))
  );

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v3', 'event_type', 'verified', 'evidence', v_evidence)::text) into v_json;
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'verified', '完整证据 → verified');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'verified_at') is not null, 'verified_at 写入');

  -- verified 终态：再发其他回调 → 乱序拒绝（状态不变）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'task_result',
    jsonb_build_object('task_id', v_task, 'receipt_event_id', v_ev, 'payload_sha256', v_hash,
      'callback_id', 'cb-v4', 'event_type', 'failed')::text) into v_json;
  perform pg_temp.gr_assert((v_json ->> 'code') = 'GR_CALLBACK_OUT_OF_ORDER', 'verified 终态拒绝后续回调');
  perform pg_temp.gr_assert((v_json -> 'task' ->> 'status') = 'verified', 'verified 终态未被改写');
end
$verify2$;
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
    'receive_date', '2026-11-14', 'invoice_date', null, 'checked_by', 'Ah Huat',
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
  -- 已批准 3 + 本次 4 > 来源订购 5 → over_balance exception（保存允许，审批需确认）
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

  -- 只确认但没审批说明 → 拒绝
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
-- 6) 精度 / 额外行 / 来源不匹配
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
    'receive_date', '2026-11-15', 'invoice_date', null, 'checked_by', 'Ah Huat',
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

  -- 指数/超精度/分配不平
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

  -- 来源 item 不匹配
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'receipt_save',
      jsonb_set(jsonb_set(v_data, '{lines,0,item_code}', '"WRONG"'), '{id}', '"30000000-0000-4000-8000-0000000000fc"')::text),
    'GR_SOURCE_MISMATCH', 'item_code 与来源不符');

  -- 额外行（无来源）→ exception（允许保存但需审批确认）
  declare
    v_data2 jsonb;
  begin
    v_data2 := jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000004', 'revision', 0,
      'po_ids', jsonb_build_array('10000000-0000-4000-8000-000000000002'),
      'invoice_no', 'INV-1004', 'delivery_order_no', 'DO-1004',
      'receive_date', '2026-11-15', 'invoice_date', null, 'checked_by', 'Ah Huat',
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

-- ----------------------------------------------------------------------------
-- 7) 旧 PO 安全：po_save / po_push / 引用保护 / combine v2 快照
-- ----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $posave$
declare
  v_po uuid := '10000000-0000-4000-8000-000000000003';
  v_req text := 'req-po-save-1';
  v_data jsonb;
  v_json jsonb;
  v_json2 jsonb;
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
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_lines where po_header_id = v_po) = 2, '明细实际写入');

  -- request_id 幂等：同参返回同一结果（不再写）
  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save', v_data::text) into v_json2;
  perform pg_temp.gr_assert(v_json2 = v_json, 'po_save request_id 幂等返回同结果');

  -- 同 request_id 不同参数 → 冲突
  perform pg_temp.gr_expect_error(
    format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'po_save',
      jsonb_set(v_data, '{notes}', '"tampered"')::text),
    'GR_IDEMPOTENCY_CONFLICT', '同 request_id 不同参数');

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
end
$posave$;
reset role;

-- 引用保护：被收货引用的明细不能改 item/uom/price/qty，也不能删
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $refguard$
declare
  v_json jsonb;
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

-- combine：幂等 + v2 快照 + 冻结 + 不覆盖旧批准
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
do $combine$
declare
  v_req text := 'req-combine-1';
  v_data jsonb;
  v_json jsonb;
  v_json2 jsonb;
  v_id uuid;
  v_sha text;
begin
  v_data := jsonb_build_object(
    'request_id', v_req,
    'source_ids', jsonb_build_array('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004'),
    'website_po_date', '2026-11-09',
    'created_by', 'Ah Huat',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'item_code', '00301', 'description', 'SCREW', 'uom', 'BOX',
      'unit_price', '25.00', 'ordered_qty', '3', 'accepted_qty', '3',
      'source_refs', jsonb_build_array(
        jsonb_build_object('po_id', '10000000-0000-4000-8000-000000000003',
                           'po_number', 'PO-FIXTURE-3', 'line_id', '20000000-0000-4000-8000-000000000003', 'qty', '2'),
        jsonb_build_object('po_id', '10000000-0000-4000-8000-000000000004',
                           'po_number', 'PO-FIXTURE-4', 'line_id', '20000000-0000-4000-8000-000000000004', 'qty', '1'))))
  );

  execute format('select tj_preview.tj_gr_api(%L, %L::jsonb)', 'combine_create', v_data::text) into v_json;
  v_id := (v_json ->> 'id')::uuid;
  perform pg_temp.gr_assert((v_json ->> 'po_type') = 'combined', 'combine_create 建合并单');
  perform pg_temp.gr_assert((v_json -> 'lines' -> 0 ->> 'qty') = '3', '合并行 qty=订购合计 3');
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
end
$combine$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
do $combineapprove$
declare
  v_id uuid;
  v_json jsonb;
  v_sha text;
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
  v_canon := tj_preview.tj_gr_approval_canonical(v_id);
  perform pg_temp.gr_assert(v_sha = tj_preview.tj_gr_sha256(v_canon), '快照哈希可重算一致');
  perform pg_temp.gr_assert(v_canon like '{"snapshot_version":2,%', 'v2 快照格式');
  perform pg_temp.gr_assert(
    (select count(*) from tj_preview.tj_po_headers where po_id in
       (select unnest(source_po_ids) from tj_preview.tj_po_headers where id = v_id)
       and status = 'combined') = 2, '来源单标 combined');

  -- 冻结后不可改：authenticated 连 UPDATE 权限都没有（写只走 RPC）
  perform pg_temp.gr_expect_denied(
    format('update tj_preview.tj_po_headers set website_po_date = date %L where id = %L', '2026-11-10', v_id),
    '直改冻结合并单被权限拒绝');
end
$combineapprove$;
reset role;

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
-- 8) 回滚 + 零残留比对
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
