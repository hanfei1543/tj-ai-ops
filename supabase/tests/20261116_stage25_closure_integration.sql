-- ============================================================================
-- Stage25 Preview 修复包 —— 真实 SQL 集成断言（事务内全回滚，零残留）
--
-- 由 scripts/stage25-local-smoke.mjs 在 PGlite(WASM Postgres) 中执行：
--   fixture → 20261116_po_done_ack_preview.sql → 20261116_stage25_preview_closure.sql → 本文件
-- 主脑也可在隔离预览库用 psql 跑（脚本自带 begin/rollback），但本文件只写 tj_preview
-- 与临时表；全部回滚，不用真实凭据、不碰 public。
--
-- 覆盖：
--   A. 结构/权限读回（表、列、唯一索引、RLS、函数 EXECUTE 授权）
--   B. 网站请求推送 RPC（角色、资格闸门、幂等/冲突、不改 header.status）
--   C. 投递证据链（legacy 不补证据、delivered 必须有 windows_received、追加式、哈希一致）
--   D. 标准 ACK wrapper（确定性 event_id、IRS/verification/Done/SHA、legacy 拒绝、
--      replay、IRS 覆盖拒绝、内部主体不可外部执行）
--   E. 人工历史对账（postgres-only、证据/事件/金额核验、replay/冲突、不改 push intent/ACK 账本）
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0) 断言脚手架
-- ----------------------------------------------------------------------------
create temp table _tj_assertions (
  section text not null,
  label text not null,
  ok boolean not null,
  primary key (section, label)
) on commit drop;

create or replace function pg_temp.tj_assert(p_ok boolean, p_section text, p_label text)
returns void
language plpgsql
as $fn$
begin
  if p_ok is null or not p_ok then
    raise exception 'ASSERT_FAILED [%] %', p_section, p_label;
  end if;
  insert into _tj_assertions (section, label, ok) values (p_section, p_label, true)
  on conflict (section, label) do update set ok = excluded.ok;
end
$fn$;

-- 期望失败：p_expect 是拒绝信息里必须出现的子串
create or replace function pg_temp.tj_err(p_sql text, p_section text, p_label text, p_expect text default null)
returns text
language plpgsql
as $fn$
declare
  v_err text;
begin
  begin
    execute p_sql;
    v_err := null;
  exception
    when others then
      v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERT_FAILED [%] %：应当被拒绝但成功执行', p_section, p_label;
  end if;
  if p_expect is not null and position(p_expect in v_err) = 0 then
    raise exception 'ASSERT_FAILED [%] %：拒绝原因不符。期望含 [%]，实际 [%]', p_section, p_label, p_expect, v_err;
  end if;
  perform pg_temp.tj_assert(true, p_section, p_label);
  return v_err;
end
$fn$;

-- 期望失败（参数顺序：SQL, 期望错误码, 分组, 标签）—— 供 E 段使用
create or replace function pg_temp.tj_sql_reject(p_sql text, p_expect text, p_section text, p_label text)
returns text
language sql
as $fn$
  select pg_temp.tj_err(p_sql, p_section, p_label, p_expect)
$fn$;

-- 以指定 PostgREST 角色 + JWT 身份调用 RPC（返回 {ok,result,error}，不向外抛异常）
create or replace function pg_temp.tj_rpc_json(p_role text, p_uid uuid, p_fn text, p_arg jsonb)
returns jsonb
language plpgsql
as $fn$
declare
  v_res jsonb;
  v_err text;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  begin
    execute pg_catalog.format('set local role %I', p_role);
    execute pg_catalog.format('select %s($1)', p_fn) into v_res using p_arg;
    execute 'reset role';
  exception
    when others then
      v_err := sqlerrm;
      execute 'reset role';
  end;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  return pg_catalog.jsonb_build_object('ok', v_err is null, 'result', v_res, 'error', v_err);
end
$fn$;

create or replace function pg_temp.tj_push(p_role text, p_uid uuid, p_header uuid, p_request text)
returns jsonb
language plpgsql
as $fn$
declare
  v_res jsonb;
  v_err text;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  begin
    execute pg_catalog.format('set local role %I', p_role);
    v_res := tj_preview.tj_po_preview_request_push(p_header, p_request);
    execute 'reset role';
  exception
    when others then
      v_err := sqlerrm;
      execute 'reset role';
  end;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  return pg_catalog.jsonb_build_object('ok', v_err is null, 'result', v_res, 'error', v_err);
end
$fn$;

create or replace function pg_temp.tj_ok(p_res jsonb, p_section text, p_label text)
returns jsonb
language plpgsql
as $fn$
begin
  if not coalesce((p_res ->> 'ok')::boolean, false) then
    raise exception 'ASSERT_FAILED [%] %：调用失败 [%]', p_section, p_label, p_res ->> 'error';
  end if;
  perform pg_temp.tj_assert(true, p_section, p_label);
  return p_res -> 'result';
end
$fn$;

create or replace function pg_temp.tj_bad(p_res jsonb, p_expect text, p_section text, p_label text)
returns void
language plpgsql
as $fn$
declare
  v_err text := p_res ->> 'error';
begin
  if coalesce((p_res ->> 'ok')::boolean, false) then
    raise exception 'ASSERT_FAILED [%] %：应当失败却成功，result=%', p_section, p_label, p_res -> 'result';
  end if;
  if position(p_expect in coalesce(v_err, '')) = 0 then
    raise exception 'ASSERT_FAILED [%] %：期望错误 [%]，实际 [%]', p_section, p_label, p_expect, v_err;
  end if;
  perform pg_temp.tj_assert(true, p_section, p_label);
end
$fn$;

-- 业务拒绝（HTTP 200 语义）：rejected=true 且 code 精确匹配
create or replace function pg_temp.tj_rejected(p_res jsonb, p_code text, p_section text, p_label text)
returns jsonb
language plpgsql
as $fn$
declare
  v jsonb := p_res -> 'result';
begin
  if p_res ->> 'error' is not null then
    raise exception 'ASSERT_FAILED [%] %：期望业务拒绝，实际抛错 [%]', p_section, p_label, p_res ->> 'error';
  end if;
  if (v ->> 'code') is distinct from p_code or (v ->> 'rejected')::boolean is not true then
    raise exception 'ASSERT_FAILED [%] %：期望 code=% 且 rejected=true，实际 %', p_section, p_label, p_code, v;
  end if;
  perform pg_temp.tj_assert(true, p_section, p_label);
  return v;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 1) 身份与合成夹具（全部由 SQL 计算，不写死 hash / 不用真实业务数据）
-- ----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'staff@stage25.test'),
  ('22222222-2222-4222-8222-222222222222', 'approver@stage25.test'),
  ('33333333-3333-4333-8333-333333333333', 'admin@stage25.test'),
  ('44444444-4444-4444-8444-444444444444', 'executor@stage25.test'),
  ('55555555-5555-4555-8555-555555555555', 'outsider@stage25.test'),
  ('66666666-6666-4666-8666-666666666666', 'worker@stage25.test');

insert into tj_preview.tj_gr_memberships (user_id, role, active) values
  ('11111111-1111-4111-8111-111111111111', 'staff', true),
  ('22222222-2222-4222-8222-222222222222', 'approver', true),
  ('33333333-3333-4333-8333-333333333333', 'admin', true),
  ('44444444-4444-4444-8444-444444444444', 'executor', true),
  ('33333333-3333-4333-8333-333333333333', 'executor', true);

insert into tj_preview.tj_po_ack_workers (user_id, role, active) values
  ('66666666-6666-4666-8666-666666666666', 'executor', true);

create temp table _fx (name text primary key, val text) on commit drop;
insert into _fx (name, val)
select 'sha_ack_new', pg_catalog.encode(extensions.digest('stage25:fixture:ack-new', 'sha256'), 'hex')
union all select 'sha_ack_ev2', pg_catalog.encode(extensions.digest('stage25:fixture:ack-ev2', 'sha256'), 'hex')
union all select 'sha_ack_legacy', pg_catalog.encode(extensions.digest('stage25:fixture:ack-legacy', 'sha256'), 'hex')
union all select 'sha_manual', pg_catalog.encode(extensions.digest('stage25:fixture:manual', 'sha256'), 'hex')
union all select 'shot_manual', pg_catalog.encode(extensions.digest('stage25:fixture:shot', 'sha256'), 'hex')
union all select 'sha_evtest', pg_catalog.encode(extensions.digest('stage25:fixture:evtest', 'sha256'), 'hex')
union all select 'sha_evtest_other', pg_catalog.encode(extensions.digest('stage25:fixture:evtest-other', 'sha256'), 'hex');

-- ----------------------------------------------------------------------------
-- A) 结构与权限读回
-- ----------------------------------------------------------------------------
select pg_temp.tj_assert(
  (select count(*) from information_schema.columns
    where table_schema = 'tj_preview' and table_name = 'tj_po_preview_push_requests'
      and column_name in ('id','po_header_id','request_id','state','requested_by','created_at','updated_at')) = 7,
  'A-structure', 'push_requests 七个契约列齐备');

select pg_temp.tj_assert(
  (select count(*) from pg_catalog.pg_indexes
    where schemaname = 'tj_preview'
      and indexname in ('uq_tj_po_preview_push_requests_po_header','uq_tj_po_preview_push_requests_request_id')) = 2,
  'A-structure', 'push_requests 有 po_header_id / request_id 两个唯一索引');

select pg_temp.tj_assert(
  (select relrowsecurity from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tj_preview' and c.relname = 'tj_po_preview_push_requests'),
  'A-structure', 'push_requests 开启 RLS');

select pg_temp.tj_assert(
  (select count(*) from pg_catalog.pg_policies
    where schemaname = 'tj_preview' and tablename = 'tj_po_preview_push_requests') = 0,
  'A-structure', 'push_requests 无客户端策略（只经 RPC 写）');

select pg_temp.tj_assert(
  (select is_nullable = 'NO' and column_default like '''legacy_local_unverified''%'
     from information_schema.columns
    where table_schema = 'tj_preview' and table_name = 'tj_po_push_intents'
      and column_name = 'delivery_channel'),
  'A-structure', 'push_intents.delivery_channel NOT NULL DEFAULT legacy_local_unverified（旧数据不动）');

select pg_temp.tj_assert(
  (select count(*) from information_schema.columns
    where table_schema = 'tj_preview' and table_name = 'tj_po_push_delivery_evidence'
      and column_name in ('id','intent_id','stage','xlsx_sha256','byte_count','target_path','evidence','created_at')) = 8,
  'A-structure', 'delivery_evidence 契约列齐备');

select pg_temp.tj_assert(
  exists (select 1 from pg_catalog.pg_indexes
    where schemaname = 'tj_preview' and indexname = 'uq_tj_po_push_delivery_evidence_intent_stage'),
  'A-structure', 'delivery_evidence UNIQUE(intent_id, stage)');

select pg_temp.tj_assert(
  (select relrowsecurity from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tj_preview' and c.relname = 'tj_po_push_delivery_evidence')
  and (select relrowsecurity from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tj_preview' and c.relname = 'tj_po_manual_reconciliations'),
  'A-structure', '证据表与人工对账表都开启 RLS');

select pg_temp.tj_assert(
  (select count(*) from pg_catalog.pg_indexes
    where schemaname = 'tj_preview'
      and indexname in ('uq_tj_po_manual_reconciliations_event_id',
                        'uq_tj_po_manual_reconciliations_po_header',
                        'uq_tj_po_manual_reconciliations_irs')) = 3,
  'A-structure', 'manual_reconciliations 保证 event / PO / IRS 三唯一');

select pg_temp.tj_assert(
  (select is_nullable from information_schema.columns
    where table_schema = 'tj_preview' and table_name = 'tj_po_manual_reconciliations'
      and column_name = 'classification') = 'NO',
  'A-structure', 'manual_reconciliations.classification NOT NULL');

select pg_temp.tj_assert(
  pg_catalog.to_regprocedure('tj_preview.tj_po_ack_ingest_v1_internal(jsonb)') is not null,
  'A-perm', 'ACK v1 主体已改名为 tj_po_ack_ingest_v1_internal');

select pg_temp.tj_assert(
  not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_ack_ingest_v1_internal(jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'tj_preview.tj_po_ack_ingest_v1_internal(jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('service_role', 'tj_preview.tj_po_ack_ingest_v1_internal(jsonb)', 'execute'),
  'A-perm', '内部 ACK 主体无外部 EXECUTE');

select pg_temp.tj_assert(
  pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_ack_ingest(jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'tj_preview.tj_po_ack_ingest(jsonb)', 'execute'),
  'A-perm', 'wrapper 仅 authenticated 可执行（anon 无）');

select pg_temp.tj_assert(
  pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_preview_request_push(uuid,text)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'tj_preview.tj_po_preview_request_push(uuid,text)', 'execute')
  and not pg_catalog.has_function_privilege('service_role', 'tj_preview.tj_po_preview_request_push(uuid,text)', 'execute'),
  'A-perm', '网站请求 RPC 仅 authenticated 可执行（anon/service_role 无）');

select pg_temp.tj_assert(
  pg_catalog.has_function_privilege('postgres', 'tj_preview.tj_po_manual_reconcile(jsonb)', 'execute'),
  'A-perm', '人工对账 RPC 可由 postgres（管理通道）执行');

select pg_temp.tj_assert(
  not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_manual_reconcile(jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('anon', 'tj_preview.tj_po_manual_reconcile(jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('service_role', 'tj_preview.tj_po_manual_reconcile(jsonb)', 'execute'),
  'A-perm', '人工对账 RPC 对 anon/authenticated/service_role 全部撤销');

select pg_temp.tj_assert(
  not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_ack_require_worker()', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_ack_sha256(text)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_ack_event_id(text,text,text)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_ack_fingerprint(jsonb)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated', 'tj_preview.tj_po_preview_require_staff()', 'execute'),
  'A-perm', '全部 helper 函数撤销外部执行');

select pg_temp.tj_assert(
  (select count(*) from information_schema.table_privileges
    where table_schema = 'tj_preview'
      and table_name in ('tj_po_preview_push_requests','tj_po_push_delivery_evidence','tj_po_manual_reconciliations')
      and grantee in ('anon','authenticated')) = 0,
  'A-perm', '新表无 anon/authenticated 表权限');

-- 本包新增的 helper / 触发器函数一律不得有 anon/authenticated 的 EXECUTE
select pg_temp.tj_assert(
  not exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'tj_preview'
       and p.proname in ('tj_po_push_intent_delivery_guard','tj_po_push_evidence_guard',
                         'tj_append_only_guard','tj_po_preview_push_requests_touch',
                         'tj_po_preview_require_staff','tj_po_ack_reject',
                         'tj_po_ack_fingerprint','tj_po_ack_event_id',
                         'tj_manual_text','tj_manual_json')
       and (pg_catalog.has_function_privilege('anon', p.oid, 'execute')
            or pg_catalog.has_function_privilege('authenticated', p.oid, 'execute')
            or pg_catalog.has_function_privilege('service_role', p.oid, 'execute'))
  ),
  'A-perm', '本包 helper/trigger 函数对 anon/authenticated/service_role 一律无 EXECUTE');

-- ----------------------------------------------------------------------------
-- B) 网站请求推送 RPC
-- ----------------------------------------------------------------------------
insert into tj_preview.tj_po_headers (po_seq, po_id, supplier_code, status, po_type, website_po_date)
overriding system value values
  (-910101, 'PO-910101', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910102, 'PO-910102', '4000/C17', 'draft', 'standard', date '2026-11-16'),
  (-910103, 'PO-910103', '4000/C17', 'confirmed', 'standard', null),
  (-910104, 'PO-910104', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910105, 'PO-910105', '4000/C17', 'confirmed', 'combined', date '2026-11-16'),
  (-910106, 'PO-910106', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910107, 'PO-910107', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910108, 'PO-910108', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910109, 'PO-910109', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910114, 'PO-910114', '4000/C17', 'confirmed', 'standard', date '2026-11-16');

update tj_preview.tj_po_headers set frozen = true where po_id = 'PO-910104';
update tj_preview.tj_po_headers set source_po_ids = array['PO-910106'] where po_id = 'PO-910105';
update tj_preview.tj_po_headers
   set irs_po_no = 'PO99000008', irs_po_no_verified_at = now(), irs_po_no_verified_by = 'fixture',
       erp_status = 'saved_verified_queue_done'
 where po_id = 'PO-910108';

insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, xlsx_sha256, state)
select h.id, h.po_id, 'content-fixture-intent',
       (select val from _fx where name = 'sha_ack_legacy'), 'delivered'
  from tj_preview.tj_po_headers h where h.po_id = 'PO-910107';

-- B1 授权角色（staff / approver / admin）成功，且不改 header.status
select pg_temp.tj_assert(
  (pg_temp.tj_ok(
     pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                     (select id from tj_preview.tj_po_headers where po_id = 'PO-910101'),
                     'req-910101-a'),
     'B-request', 'staff 可请求推送') ->> 'state') = 'requested',
  'B-request', '新建请求状态为 requested');

select pg_temp.tj_assert(
  (pg_temp.tj_ok(
     pg_temp.tj_push('authenticated', '22222222-2222-4222-8222-222222222222',
                     (select id from tj_preview.tj_po_headers where po_id = 'PO-910109'),
                     'req-910109-a'),
     'B-request', 'approver 可请求推送') ->> 'po_id') = 'PO-910109',
  'B-request', '返回 po_id 正确');

select pg_temp.tj_assert(
  (pg_temp.tj_ok(
     pg_temp.tj_push('authenticated', '33333333-3333-4333-8333-333333333333',
                     (select id from tj_preview.tj_po_headers where po_id = 'PO-910114'),
                     'req-910114-a'),
     'B-request', 'admin 可请求推送') ->> 'state') = 'requested',
  'B-request', 'admin 请求记录 requested_by');

select pg_temp.tj_assert(
  (select requested_by from tj_preview.tj_po_preview_push_requests where request_id = 'req-910114-a')
    = '33333333-3333-4333-8333-333333333333',
  'B-request', 'requested_by 记录真实调用者 auth.uid()');

select pg_temp.tj_assert(
  (select status from tj_preview.tj_po_headers where po_id = 'PO-910101') = 'confirmed',
  'B-request', '请求推送不改 header.status（仍 confirmed，不进入 pending_push）');

select pg_temp.tj_assert(
  (select count(*) from tj_preview.tj_po_headers where status in ('pending_push','exported')) = 0,
  'B-request', '全库无任何 PO 进入 pending_push/exported（Preview 总闸保留）');

select pg_temp.tj_assert(
  (select count(*) from tj_preview.tj_po_preview_push_requests where request_id = 'req-910101-a') = 1,
  'B-request', '请求行只写一条');

-- B2 幂等 / 冲突
select pg_temp.tj_assert(
  (pg_temp.tj_ok(
     pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                     (select id from tj_preview.tj_po_headers where po_id = 'PO-910101'),
                     'req-910101-a'),
     'B-idem', '同 request_id 同 PO 幂等 replay') ->> 'replayed')::boolean,
  'B-idem', '同 request_id 标记 replayed=true');

select pg_temp.tj_assert(
  (select count(*) from tj_preview.tj_po_preview_push_requests) = 3,
  'B-idem', '重放不新增请求行');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910102'), 'req-910101-a'),
  'PO_PUSH_REQUEST_ID_CONFLICT', 'B-idem', '同 request_id 不同 PO 冲突');

select pg_temp.tj_assert(
  (pg_temp.tj_ok(
     pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                     (select id from tj_preview.tj_po_headers where po_id = 'PO-910101'),
                     'req-910101-b'),
     'B-idem', '同 PO 不同 request 返回既有行') ->> 'duplicate')::boolean,
  'B-idem', '重复 PO 标记 duplicate=true');

select pg_temp.tj_assert(
  (select count(*) from tj_preview.tj_po_preview_push_requests where po_header_id =
     (select id from tj_preview.tj_po_headers where po_id = 'PO-910101')) = 1,
  'B-idem', '重复请求不产生第二条 dispatch 记录');

-- B3 角色闸门
select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '55555555-5555-4555-8555-555555555555',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910102'), 'req-outsider'),
  'PO_PUSH_FORBIDDEN', 'B-role', '非 GR 成员被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '44444444-4444-4444-8444-444444444444',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910102'), 'req-executor'),
  'PO_PUSH_FORBIDDEN', 'B-role', 'executor（Windows worker）不能请求网站推送');

select pg_temp.tj_bad(
  pg_temp.tj_push('anon', null,
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910102'), 'req-anon'),
  'permission denied', 'B-role', 'anon 在权限层被拒（42501）');

-- B4 资格闸门
select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111', pg_catalog.gen_random_uuid(), 'req-404'),
  'PO_PUSH_PO_NOT_FOUND', 'B-gate', '不存在的 PO 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910102'), 'req-draft'),
  'PO_PUSH_PO_NOT_CONFIRMED', 'B-gate', 'draft PO 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910103'), 'req-nodate'),
  'PO_PUSH_NO_WEBSITE_DATE', 'B-gate', '缺 Website PO Date 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910104'), 'req-frozen'),
  'PO_PUSH_PO_FROZEN', 'B-gate', '已冻结 PO 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910105'), 'req-combined'),
  'PO_PUSH_NOT_STANDARD', 'B-gate', 'combined 单被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910106'), 'req-source'),
  'PO_PUSH_COMBINED_SOURCE', 'B-gate', '被合并单引用的来源单被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910107'), 'req-intent'),
  'PO_PUSH_INTENT_EXISTS', 'B-gate', '有历史投递意图的 PO 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910108'), 'req-saved'),
  'PO_PUSH_ERP_SAVED', 'B-gate', '已有 ERP 保存记录的 PO 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_push('authenticated', '11111111-1111-4111-8111-111111111111',
                  (select id from tj_preview.tj_po_headers where po_id = 'PO-910102'), '   '),
  'PO_PUSH_INVALID_REQUEST_ID', 'B-gate', '空白 request_id 被拒');

-- ----------------------------------------------------------------------------
-- C) 投递证据链
-- ----------------------------------------------------------------------------
-- windows_bridge_v1 意图（新通道）：先 dispatch_started
insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, xlsx_sha256, state, delivery_channel)
select h.id, h.po_id, 'content-evtest', (select val from _fx where name = 'sha_evtest'), 'dispatch_started', 'windows_bridge_v1'
  from tj_preview.tj_po_headers h where h.po_id = 'PO-910103';

-- C1 legacy 意图不得补收件证据（PO-910107 的意图是 legacy）
select pg_temp.tj_err($sql$
  insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path)
  select i.id, 'windows_received', (select val from _fx where name = 'sha_ack_legacy'), 1024, 'C:\scan\Done\x.xlsx'
    from tj_preview.tj_po_push_intents i
    join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910107'
$sql$, 'C-evidence', 'legacy 意图补证据被拒', 'PO_PUSH_EVIDENCE_LEGACY_INTENT');

-- C2 新通道未收到证据 → 不能 delivered
select pg_temp.tj_err($sql$
  update tj_preview.tj_po_push_intents set state = 'delivered'
   where po_header_id = (select id from tj_preview.tj_po_headers where po_id = 'PO-910103')
$sql$, 'C-evidence', '无 windows_received 证据不得 delivered', 'PO_PUSH_DELIVERY_EVIDENCE_MISSING');

-- C3 证据哈希与意图不一致 → 拒
select pg_temp.tj_err($sql$
  insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path)
  select i.id, 'windows_received', (select val from _fx where name = 'sha_evtest_other'), 1024, 'C:\scan\Done\x.xlsx'
    from tj_preview.tj_po_push_intents i
    join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910103'
$sql$, 'C-evidence', '证据哈希与意图不一致被拒', 'PO_PUSH_DELIVERY_HASH_MISMATCH');

-- C4 正确证据 → 允许 delivered
insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path, evidence)
select i.id, 'server_prepared', (select val from _fx where name = 'sha_evtest'), 6855, 'preview/stage25/PO-910103.xlsx',
       '{"fixture": true}'::jsonb
  from tj_preview.tj_po_push_intents i
  join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910103';

insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path, evidence)
select i.id, 'windows_received', (select val from _fx where name = 'sha_evtest'), 6855, 'C:\scan\Done\PO-910103.xlsx',
       '{"fixture": true}'::jsonb
  from tj_preview.tj_po_push_intents i
  join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910103';

update tj_preview.tj_po_push_intents set state = 'delivered'
 where po_header_id = (select id from tj_preview.tj_po_headers where po_id = 'PO-910103');

select pg_temp.tj_assert(
  (select i.state from tj_preview.tj_po_push_intents i
     join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910103') = 'delivered',
  'C-evidence', 'server_prepared + windows_received 哈希一致后可 delivered');

-- C5 同 stage 重复证据 → 唯一约束
select pg_temp.tj_err($sql$
  insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path)
  select i.id, 'windows_received', (select val from _fx where name = 'sha_evtest'), 6855, 'C:\scan\Done\dup.xlsx'
    from tj_preview.tj_po_push_intents i
    join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910103'
$sql$, 'C-evidence', '同 stage 重复证据被唯一约束拒绝', 'duplicate key');

-- C6 追加式：UPDATE / DELETE / TRUNCATE 都拒绝（owner 也拒）
select pg_temp.tj_err(
  'update tj_preview.tj_po_push_delivery_evidence set byte_count = 1',
  'C-evidence', '证据表禁止 UPDATE（owner 也拒）', 'PO_PUSH_EVIDENCE_APPEND_ONLY');

select pg_temp.tj_err(
  'delete from tj_preview.tj_po_push_delivery_evidence',
  'C-evidence', '证据表禁止 DELETE（owner 也拒）', 'PO_PUSH_EVIDENCE_APPEND_ONLY');

select pg_temp.tj_err(
  'truncate tj_preview.tj_po_push_delivery_evidence',
  'C-evidence', '证据表禁止 TRUNCATE', 'PO_PUSH_EVIDENCE_APPEND_ONLY');

-- C7 legacy 记录保留可更新性（新门禁不追溯旧数据）
update tj_preview.tj_po_push_intents
   set error = 'legacy-history-note'
 where po_header_id = (select id from tj_preview.tj_po_headers where po_id = 'PO-910107');

select pg_temp.tj_assert(
  (select i.error from tj_preview.tj_po_push_intents i
     join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910107') = 'legacy-history-note',
  'C-evidence', 'legacy_local_unverified 记录不受新 delivered 门禁影响');

-- C8 delivery_channel 取值约束
select pg_temp.tj_err($sql$
  insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, state, delivery_channel)
  select h.id, h.po_id, 'content-bad-channel', 'dispatch_started', 'carrier_pigeon'
    from tj_preview.tj_po_headers h where h.po_id = 'PO-910102'
$sql$, 'C-evidence', '非法 delivery_channel 被约束拒绝', 'delivery_channel_chk');

-- ----------------------------------------------------------------------------
-- D) 标准 ACK wrapper
-- ----------------------------------------------------------------------------
do $ackfix$
declare
  v_sha_new text := (select val from _fx where name = 'sha_ack_new');
  v_sha_ev2 text := (select val from _fx where name = 'sha_ack_ev2');
  v_intent uuid;
begin
  insert into tj_preview.tj_po_headers (po_seq, po_id, supplier_code, status, po_type, website_po_date)
  overriding system value values
    (-910111, 'PO-910111', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
    (-910112, 'PO-910112', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
    (-910113, 'PO-910113', '4000/C17', 'confirmed', 'standard', date '2026-11-16');

  insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, xlsx_sha256, state, delivery_channel)
  select h.id, h.po_id, 'content-ack-new', v_sha_new, 'dispatch_started', 'windows_bridge_v1'
    from tj_preview.tj_po_headers h where h.po_id = 'PO-910111'
  returning id into v_intent;

  insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path, evidence)
  values (v_intent, 'server_prepared', v_sha_new, 6855, 'preview/stage25/PO-910111.xlsx', '{"fixture":true}'),
         (v_intent, 'windows_received', v_sha_new, 6855, 'C:\scan\Done\PO-910111.xlsx', '{"fixture":true}');

  update tj_preview.tj_po_push_intents set state = 'delivered' where id = v_intent;

  insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, xlsx_sha256, state, delivery_channel)
  select h.id, h.po_id, 'content-ack-ev2', v_sha_ev2, 'dispatch_started', 'windows_bridge_v1'
    from tj_preview.tj_po_headers h where h.po_id = 'PO-910112'
  returning id into v_intent;

  insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path)
  values (v_intent, 'windows_received', v_sha_ev2, 6855, 'C:\scan\Done\PO-910112.xlsx');

  update tj_preview.tj_po_push_intents set state = 'delivered' where id = v_intent;

  -- 第三个新通道 PO：意图仍停在 dispatch_started（未确认投递）→ 应委派 v1 主体拒绝
  insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, xlsx_sha256, state, delivery_channel)
  select h.id, h.po_id, 'content-ack-pending', v_sha_new, 'dispatch_started', 'windows_bridge_v1'
    from tj_preview.tj_po_headers h where h.po_id = 'PO-910113'
  returning id into v_intent;

  insert into tj_preview.tj_po_push_delivery_evidence (intent_id, stage, xlsx_sha256, byte_count, target_path)
  values (v_intent, 'windows_received', v_sha_new, 6855, 'C:\scan\Done\PO-910113.xlsx');
end
$ackfix$;

create or replace function pg_temp.tj_ack_payload(
  p_po_id text,
  p_irs text,
  p_sha text,
  p_overrides jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
as $fn$
  select pg_catalog.jsonb_build_object(
    'schema', 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1',
    'event_id', tj_preview.tj_po_ack_event_id(p_po_id, p_sha, p_irs),
    'business_po_id', p_po_id,
    'po_id', p_po_id,
    'source_sha256', pg_catalog.upper(p_sha),
    'queue_done_sha256', pg_catalog.upper(p_sha),
    'irs_po_number', p_irs,
    'verification', 'MANUAL_POSTSAVE_VERIFIED',
    'queue_done_ack', true,
    'queue_folder', 'Done',
    'ledger_state', 'SAVED_VERIFIED_QUEUE_DONE',
    'callback_state', 'OUTBOX_NOT_SENT'
  ) || coalesce(p_overrides, '{}'::jsonb)
$fn$;

-- D0 确定性 event_id 公式（大写 hash 参与）
select pg_temp.tj_assert(
  tj_preview.tj_po_ack_event_id('PO-910111', (select val from _fx where name = 'sha_ack_new'), 'PO99000111')
  = 'tj.po.queue.done.v1.' || pg_catalog.encode(
      extensions.digest(
        'TJ_QUEUE_DONE_V1|PO-910111|' || pg_catalog.upper((select val from _fx where name = 'sha_ack_new')) || '|PO99000111',
        'sha256'), 'hex'),
  'D-event', 'event_id 公式 = sha256(TJ_QUEUE_DONE_V1|po|UPPER(source)|irs)');

select pg_temp.tj_assert(
  tj_preview.tj_po_ack_event_id('PO-910111', (select val from _fx where name = 'sha_ack_new'), 'PO99000111')
  = tj_preview.tj_po_ack_event_id('PO-910111', pg_catalog.upper((select val from _fx where name = 'sha_ack_new')), 'PO99000111'),
  'D-event', '大写/小写 hash 推导同一 event_id（客户端用大写）');

-- D1 正常 accepted
do $d1$
declare
  v_payload jsonb := pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'));
  v_res jsonb;
begin
  v_res := pg_temp.tj_ok(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
      'tj_preview.tj_po_ack_ingest', v_payload),
    'D-accept', 'worker 用新通道 ACK 被接受');

  perform pg_temp.tj_assert((v_res ->> 'accepted')::boolean, 'D-accept', 'accepted=true');
  perform pg_temp.tj_assert((v_res ->> 'irs_po_number') = 'PO99000111', 'D-accept', '返回 IRS 号');

  perform pg_temp.tj_assert(
    (select erp_status from tj_preview.tj_po_headers where po_id = 'PO-910111') = 'saved_verified_queue_done',
    'D-accept', 'header.erp_status=saved_verified_queue_done');

  perform pg_temp.tj_assert(
    (select irs_po_no from tj_preview.tj_po_headers where po_id = 'PO-910111') = 'PO99000111',
    'D-accept', 'header.irs_po_no 写回');

  perform pg_temp.tj_assert(
    (select irs_po_no_verified_by from tj_preview.tj_po_headers where po_id = 'PO-910111') like 'po-ack:%',
    'D-accept', 'header 写入 po-ack:<actor> 验证证据');

  perform pg_temp.tj_assert(
    (select r.content_sha256 from tj_preview.tj_po_ack_receipts r
      where r.po_id = 'PO-910111' and r.state = 'accepted') = tj_preview.tj_po_ack_fingerprint(v_payload),
    'D-accept', 'wrapper 幂等指纹与 v1 主体落库指纹一致');

  -- v1 主体的 `returning id into v_receipt`（record 变量）实跑确认：返回的是真实回执行
  perform pg_temp.tj_assert(
    exists (select 1 from tj_preview.tj_po_ack_receipts r
             where r.id = (v_res ->> 'receipt_id')::uuid and r.po_id = 'PO-910111' and r.state = 'accepted'),
    'D-accept', 'v1 主体返回的 receipt_id 指向真实 accepted 回执（RETURNING INTO rowtype 实测可用）');
end
$d1$;

-- D2 同 event 同 payload → replay
do $d2$
declare
  v_payload jsonb := pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'));
  v_res jsonb;
begin
  v_res := pg_temp.tj_ok(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
      'tj_preview.tj_po_ack_ingest', v_payload),
    'D-replay', '同 event 同 payload 重放成功');
  perform pg_temp.tj_assert((v_res ->> 'replayed')::boolean, 'D-replay', 'replayed=true');
  perform pg_temp.tj_assert(
    (select count(*) from tj_preview.tj_po_ack_receipts where po_id = 'PO-910111') = 1,
    'D-replay', '重放不新增回执');
  perform pg_temp.tj_assert(
    (v_res ->> 'receipt_id') = (select r.id::text from tj_preview.tj_po_ack_receipts r where r.po_id = 'PO-910111'),
    'D-replay', '重放返回同一 receipt_id');
end
$d2$;

-- D3 确定性 event_id 不符 → 硬拒绝（不只是 hex 格式）
select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'),
      pg_catalog.jsonb_build_object('event_id', 'tj.po.queue.done.v1.' || repeat('ab', 32)))),
  'PO_ACK_EVENT_ID_MISMATCH', 'D-event', '伪造 event_id（格式合法但非推导值）被拒');

-- D4 结构闸门
select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO-99000111', (select val from _fx where name = 'sha_ack_new'))),
  'PO_ACK_INVALID_IRS', 'D-structure', 'IRS 号格式不符被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'),
      pg_catalog.jsonb_build_object('verification', 'AUTO_ASSUMED'))),
  'PO_ACK_VERIFICATION_REQUIRED', 'D-structure', 'verification 非 MANUAL_POSTSAVE_VERIFIED 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'),
      pg_catalog.jsonb_build_object('queue_folder', 'Pending'))),
  'PO_ACK_QUEUE_FOLDER_REQUIRED', 'D-structure', 'queue_folder 非 Done 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'),
      pg_catalog.jsonb_build_object('ledger_state', 'SAVED_UNVERIFIED'))),
  'PO_ACK_LEDGER_STATE_REQUIRED', 'D-structure', 'ledger_state 非 SAVED_VERIFIED_QUEUE_DONE 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'),
      pg_catalog.jsonb_build_object('queue_done_sha256', repeat('c', 64)))),
  'PO_ACK_SHA_MISMATCH', 'D-structure', 'source/queue SHA 不一致被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'),
      pg_catalog.jsonb_build_object('source_sha256', 'abc'))),
  'PO_ACK_SHA_MISMATCH', 'D-structure', 'SHA 非 64hex 被拒');

-- D5 legacy 通道 ACK → PO_ACK_NO_WINDOWS_RECEIPT（不伪造 accepted）
do $d5$
declare
  v_payload jsonb := pg_temp.tj_ack_payload('PO-910107', 'PO99000107', (select val from _fx where name = 'sha_ack_legacy'));
  v_res jsonb;
begin
  v_res := pg_temp.tj_rejected(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
      'tj_preview.tj_po_ack_ingest', v_payload),
    'PO_ACK_NO_WINDOWS_RECEIPT', 'D-legacy', 'legacy_local_unverified 标准 ACK 被拒');

  perform pg_temp.tj_assert((v_res ->> 'state') = 'needs_review', 'D-legacy', '拒绝记为 needs_review');

  perform pg_temp.tj_assert(
    (select count(*) from tj_preview.tj_po_ack_receipts where po_id = 'PO-910107' and state = 'needs_review') = 1,
    'D-legacy', '拒绝写入 needs_review 回执（可审计）');

  perform pg_temp.tj_assert(
    (select erp_status from tj_preview.tj_po_headers where po_id = 'PO-910107') = 'none',
    'D-legacy', '拒绝不改 header（仍是 none）');
end
$d5$;

-- D5b 收件证据齐备但意图未 delivered → 时序型延迟：只审计，不落 receipt 墓碑
do $d5b$
declare
  v_res jsonb;
begin
  perform pg_temp.tj_bad(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
      'tj_preview.tj_po_ack_ingest',
      pg_temp.tj_ack_payload('PO-910113', 'PO99000113x', (select val from _fx where name = 'sha_ack_new'))),
    'PO_ACK_INVALID_IRS', 'D-delegate', '非法 IRS 优先于意图状态被拒（硬错误，不写账本）');

  v_res := pg_temp.tj_rejected(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
      'tj_preview.tj_po_ack_ingest',
      pg_temp.tj_ack_payload('PO-910113', 'PO99000114', (select val from _fx where name = 'sha_ack_new'))),
    'PO_ACK_NO_PUSH_DELIVERY', 'D-delegate', '未 delivered 的意图被拒绝（不伪造成功）');

  perform pg_temp.tj_assert((v_res ->> 'retryable')::boolean, 'D-delegate',
    '未 delivered 是时序型拒绝：retryable=true');
  perform pg_temp.tj_assert(
    (select count(*) from tj_preview.tj_po_ack_receipts where po_id = 'PO-910113') = 0,
    'D-delegate', '时序型拒绝不落唯一 receipt 墓碑（证据到齐后同一 event 可 accepted）');

  perform pg_temp.tj_assert(
    (select erp_status from tj_preview.tj_po_headers where po_id = 'PO-910113') = 'none',
    'D-delegate', '委派拒绝后 header 未被改写');
end
$d5b$;

-- D6 已保存 IRS 不被新 event 覆盖
do $d6$
declare
  v_first jsonb;
  v_second jsonb;
begin
  v_first := pg_temp.tj_ok(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
      pg_temp.tj_ack_payload('PO-910112', 'PO99000112', (select val from _fx where name = 'sha_ack_ev2'))),
    'D-overwrite', '第一张新通道 PO 保存成功');
  perform pg_temp.tj_assert((v_first ->> 'accepted')::boolean, 'D-overwrite', '首次保存 accepted=true');

  v_second := pg_temp.tj_rejected(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666', 'tj_preview.tj_po_ack_ingest',
      pg_temp.tj_ack_payload('PO-910112', 'PO99000113', (select val from _fx where name = 'sha_ack_ev2'))),
    'PO_ACK_IRS_OVERWRITE', 'D-overwrite', '新 event 覆盖已保存 IRS 号被拒');

  perform pg_temp.tj_assert(
    (select irs_po_no from tj_preview.tj_po_headers where po_id = 'PO-910112') = 'PO99000112',
    'D-overwrite', 'header.irs_po_no 保持第一次保存的号码');
end
$d6$;

-- D7 权限
select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '55555555-5555-4555-8555-555555555555', 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'))),
  'PO_ACK_FORBIDDEN', 'D-perm', '非 ACK worker 被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('anon', null, 'tj_preview.tj_po_ack_ingest',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'))),
  'permission denied', 'D-perm', 'anon 调 ACK 在权限层被拒');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
    'tj_preview.tj_po_ack_ingest_v1_internal',
    pg_temp.tj_ack_payload('PO-910111', 'PO99000111', (select val from _fx where name = 'sha_ack_new'))),
  'permission denied', 'D-perm', '内部 ACK 主体不能被 authenticated 直接调用');

-- ----------------------------------------------------------------------------
-- E) 人工历史对账
-- ----------------------------------------------------------------------------
insert into tj_preview.tj_po_headers (po_seq, po_id, supplier_code, status, po_type, website_po_date)
overriding system value values
  (-910120, 'PO-910120', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910122, 'PO-910122', '4000/C17', 'confirmed', 'standard', date '2026-11-16'),
  (-910123, 'PO-910123', '4000/C17', 'confirmed', 'standard', date '2026-11-16');

insert into tj_preview.tj_po_lines (po_header_id, line_no, item_code, description, uom, qty, unit_price)
select h.id, v.line_no, v.item_code, v.descr, 'UNIT', v.qty, v.price
  from tj_preview.tj_po_headers h
  cross join (values
    (1, '1010001000004', 'fixture line 1', 3::numeric, 12.60::numeric),
    (2, '1010001000002', 'fixture line 2', 1::numeric, 19.76::numeric)
  ) as v(line_no, item_code, descr, qty, price)
 where h.po_id in ('PO-910120', 'PO-910122', 'PO-910123');

-- PO-910120 有一个 legacy 投递意图（对账要对它做快照，但绝不改写）
insert into tj_preview.tj_po_push_intents (po_header_id, po_id, content_sha256, xlsx_sha256, state)
select h.id, h.po_id, 'content-manual-legacy', (select val from _fx where name = 'sha_manual'), 'delivered'
  from tj_preview.tj_po_headers h where h.po_id = 'PO-910120';

-- PO-910123 已有标准 ACK accepted 回执（人工通道不得覆盖）
insert into tj_preview.tj_po_ack_receipts (event_id, content_sha256, po_header_id, po_id, state, irs_po_number, actor)
select 'tj.po.queue.done.v1.' || repeat('cd', 32), 'fp-fixture-standard', h.id, h.po_id, 'accepted', 'PO99000123',
       '66666666-6666-4666-8666-666666666666'
  from tj_preview.tj_po_headers h where h.po_id = 'PO-910123';

-- 关键账本快照（对账结束后必须逐字节不变）
create temp table _snap on commit drop as
select
  (select count(*) || ':' || coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(i)::text, '|' order by i.id)), '')
     from tj_preview.tj_po_push_intents i) as intents,
  (select count(*) || ':' || coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(r)::text, '|' order by r.id)), '')
     from tj_preview.tj_po_ack_receipts r) as receipts,
  -- 只统计与被测人工对账 PO 无关的回执：用来证明对账/标准 ACK 都没有触碰既有账本
  (select count(*) || ':' || coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(r)::text, '|' order by r.id)), '')
     from tj_preview.tj_po_ack_receipts r where r.po_id is distinct from 'PO-910120') as receipts_others,
  (select i.id from tj_preview.tj_po_push_intents i
     join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910120') as manual_intent_id;

/**
 * 构造人工对账 payload。原始 outbox/ledger 带 CRLF（验证原始字节保留）。
 * p_variant 用于单点篡改：event_override / queue_folder / verification /
 * outbox_ledger_state / ledger_state / ledger_total / ledger_po / ledger_event /
 * screenshot / source / extra。
 */
create or replace function pg_temp.tj_manual_payload(
  p_po text,
  p_irs text,
  p_sha text,
  p_shot text,
  p_total text,
  p_variant jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
as $fn$
declare
  crlf text := chr(13) || chr(10);
  v_event text := coalesce(p_variant ->> 'event_override', tj_preview.tj_po_ack_event_id(p_po, p_sha, p_irs));
  v_folder text := coalesce(p_variant ->> 'queue_folder', 'Done');
  v_verif text := coalesce(p_variant ->> 'verification', 'MANUAL_POSTSAVE_VERIFIED');
  v_ostate text := coalesce(p_variant ->> 'outbox_ledger_state', 'SAVED_VERIFIED_QUEUE_DONE');
  v_lstate text := coalesce(p_variant ->> 'ledger_state', 'SAVED_VERIFIED_QUEUE_DONE');
  v_ltotal text := coalesce(p_variant ->> 'ledger_total', p_total);
  v_lpo text := coalesce(p_variant ->> 'ledger_po', p_po);
  v_levents text := coalesce(p_variant ->> 'ledger_event', v_event);
  v_lines text;
  v_out text;
  v_led text;
begin
  if (p_variant ->> 'ledger_lines_bad') = 'true' then
    v_lines := '    {"item_code": "1010001000004", "qty": "3", "unit_price_rm": "12.60", "amount_rm": "abc"}';
  else
    v_lines :=
      '    {"item_code": "1010001000004", "qty": "3", "unit_price_rm": "12.60", "amount_rm": "37.80"},' || crlf ||
      '    {"item_code": "1010001000002", "qty": "1", "unit_price_rm": "19.76", "amount_rm": "19.76"}';
  end if;

  v_out :=
    '{' || crlf ||
    '  "schema": "TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1",' || crlf ||
    '  "event_id": "' || v_event || '",' || crlf ||
    '  "business_po_id": "' || p_po || '",' || crlf ||
    '  "po_id": "' || p_po || '",' || crlf ||
    '  "source_sha256": "' || pg_catalog.upper(p_sha) || '",' || crlf ||
    '  "irs_po_number": "' || p_irs || '",' || crlf ||
    '  "verification": "' || v_verif || '",' || crlf ||
    '  "queue_done_ack": true,' || crlf ||
    '  "queue_done_sha256": "' || pg_catalog.upper(p_sha) || '",' || crlf ||
    '  "queue_folder": "' || v_folder || '",' || crlf ||
    '  "ledger_state": "' || v_ostate || '"' || crlf ||
    '}';

  v_led :=
    '{' || crlf ||
    '  "schema": "TJ_STAGE25_FIXTURE_LEDGER_V1",' || crlf ||
    '  "po_id": "' || v_lpo || '",' || crlf ||
    '  "state": "' || v_lstate || '",' || crlf ||
    '  "source_sha256": "' || pg_catalog.upper(p_sha) || '",' || crlf ||
    '  "irs_po_number": "' || p_irs || '",' || crlf ||
    '  "verification": "MANUAL_POSTSAVE_VERIFIED",' || crlf ||
    '  "expected_total_rm": "' || v_ltotal || '",' || crlf ||
    '  "expected_lines": [' || crlf || v_lines || crlf ||
    '  ],' || crlf ||
    '  "postsave_evidence_sha256": "' || pg_catalog.upper(p_shot) || '",' || crlf ||
    '  "queue_commit_event_id": "' || v_levents || '",' || crlf ||
    '  "queue_disposition": "DONE_VERIFIED"' || crlf ||
    '}';

  return pg_catalog.jsonb_build_object(
    'outbox_raw', v_out,
    'ledger_raw', v_led,
    'screenshot_sha256', pg_catalog.upper(coalesce(p_variant ->> 'screenshot', p_shot)),
    'source_sha256', pg_catalog.upper(coalesce(p_variant ->> 'source', p_sha)),
    'reviewer', 'stage25-test-reviewer',
    'reason', 'stage25 离线契约测试夹具（非真实业务对账，不写真实库）',
    'expected_total_rm', p_total
  ) || coalesce(p_variant -> 'extra', '{}'::jsonb);
end
$fn$;

create or replace function pg_temp.tj_mp(p_variant jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
as $fn$
  select pg_temp.tj_manual_payload(
    'PO-910120', 'PO99000120',
    (select val from _fx where name = 'sha_manual'),
    (select val from _fx where name = 'shot_manual'),
    '57.56', p_variant)
$fn$;

-- E0 身份闸门（REST 角色在权限层被拒 + 带 JWT 的会话在函数内再拒）
select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('authenticated', '33333333-3333-4333-8333-333333333333',
    'tj_preview.tj_po_manual_reconcile', pg_temp.tj_mp()),
  'permission denied', 'E-perm', 'authenticated 无人工对账 EXECUTE（42501）');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('anon', null, 'tj_preview.tj_po_manual_reconcile', pg_temp.tj_mp()),
  'permission denied', 'E-perm', 'anon 无人工对账 EXECUTE（42501）');

select pg_temp.tj_bad(
  pg_temp.tj_rpc_json('service_role', null, 'tj_preview.tj_po_manual_reconcile', pg_temp.tj_mp()),
  'permission denied', 'E-perm', 'service_role 无人工对账 EXECUTE（42501）');

do $e0$
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
  begin
    perform tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp());
    raise exception 'ASSERT_FAILED [E-perm] 带 JWT 身份的人工对账竟然成功';
  exception
    when others then
      if position('MANUAL_RECONCILE_FORBIDDEN' in sqlerrm) = 0 then
        raise exception 'ASSERT_FAILED [E-perm] 预期 MANUAL_RECONCILE_FORBIDDEN，实际 %', sqlerrm;
      end if;
  end;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.tj_assert(true, 'E-perm', '带 JWT claim 的会话被函数内拒绝');
end
$e0$;

-- E1 正常人工对账（合成夹具；真实实据由主脑在隔离库执行）
do $e1$
declare
  v_res jsonb;
  v_id uuid;
begin
  v_res := tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp());
  v_id := (v_res ->> 'id')::uuid;

  perform pg_temp.tj_assert((v_res ->> 'replayed')::boolean = false, 'E-accept', '首次对账不标记 replay');
  perform pg_temp.tj_assert((v_res ->> 'classification') = 'manual_delivery_historical_import',
    'E-accept', '分类为 manual_delivery_historical_import');
  perform pg_temp.tj_assert((v_res ->> 'verified_by') = 'manual-reconciliation:' || v_id::text,
    'E-accept', 'verified_by = manual-reconciliation:<receipt-id>');

  perform pg_temp.tj_assert(
    (select irs_po_no from tj_preview.tj_po_headers where po_id = 'PO-910120') = 'PO99000120',
    'E-accept', 'header.irs_po_no 写回');

  perform pg_temp.tj_assert(
    (select erp_status from tj_preview.tj_po_headers where po_id = 'PO-910120') = 'saved_verified_manual_reconciliation',
    'E-accept', 'header.erp_status=saved_verified_manual_reconciliation');

  perform pg_temp.tj_assert(
    (select irs_po_no_verified_by from tj_preview.tj_po_headers where po_id = 'PO-910120')
      = 'manual-reconciliation:' || v_id::text,
    'E-accept', 'header 验证证据指向人工对账 receipt');

  perform pg_temp.tj_assert(
    (select m.outbox_raw from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)
      = (pg_temp.tj_mp() ->> 'outbox_raw'),
    'E-accept', 'outbox_raw 原始文本（含 CRLF）逐字保留');

  perform pg_temp.tj_assert(
    (select m.ledger_raw from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)
      = (pg_temp.tj_mp() ->> 'ledger_raw'),
    'E-accept', 'ledger_raw 原始文本（含 CRLF）逐字保留');

  perform pg_temp.tj_assert(
    (position(chr(13) || chr(10) in (select m.outbox_raw from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)) > 0),
    'E-accept', 'outbox_raw 保留 CRLF（未做换行归一化）');

  perform pg_temp.tj_assert(
    (select m.outbox_sha256 from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)
      = tj_preview.tj_po_ack_sha256(pg_temp.tj_mp() ->> 'outbox_raw'),
    'E-accept', '记录 outbox 原始字节 sha256');

  perform pg_temp.tj_assert(
    (select m.ledger_sha256 from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)
      = tj_preview.tj_po_ack_sha256(pg_temp.tj_mp() ->> 'ledger_raw'),
    'E-accept', '记录 ledger 原始字节 sha256');

  perform pg_temp.tj_assert(
    (select m.expected_total_rm from tj_preview.tj_po_manual_reconciliations m where m.id = v_id) = '57.56',
    'E-accept', '记录 expected_total_rm');

  -- 原 push intent 快照（不改写）
  perform pg_temp.tj_assert(
    (select m.push_intent_id from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)
      = (select i.id from tj_preview.tj_po_push_intents i
           join tj_preview.tj_po_headers h on h.id = i.po_header_id where h.po_id = 'PO-910120'),
    'E-accept', '快照原 push intent id');

  perform pg_temp.tj_assert(
    (select m.push_intent_xlsx_sha256 from tj_preview.tj_po_manual_reconciliations m where m.id = v_id)
      = (select val from _fx where name = 'sha_manual'),
    'E-accept', '快照原 push intent xlsx_sha256');

  perform pg_temp.tj_assert(
    (select m.push_intent_state from tj_preview.tj_po_manual_reconciliations m where m.id = v_id) = 'delivered',
    'E-accept', '快照原 push intent state');
end
$e1$;

-- E2 同 event 同内容 replay
do $e2$
declare
  v_res jsonb;
begin
  v_res := tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp());
  perform pg_temp.tj_assert((v_res ->> 'replayed')::boolean, 'E-idem', '同 event 同内容 replay');
  perform pg_temp.tj_assert(
    (select count(*) from tj_preview.tj_po_manual_reconciliations) = 1,
    'E-idem', 'replay 不新增对账行');
end
$e2$;

-- E3 同 event 内容变化 → 冲突
select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp('{"extra": {"reason": "改了理由"}}'))$sql$,
  'MANUAL_RECONCILE_CONFLICT', 'E-idem', '同 event 内容变化被判冲突');

-- E4 不同 event 撞同一 PO / 同一 IRS → 冲突
select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910120', 'PO99000129',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56'))$sql$,
  'MANUAL_RECONCILE_ALREADY_RECONCILED', 'E-idem', '同一 PO 的第二个事件被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910122', 'PO99000120',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56'))$sql$,
  'MANUAL_RECONCILE_ALREADY_RECONCILED', 'E-idem', '同一 IRS 号的第二个事件被拒');

-- E5 证据核验失败矩阵
select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp(('{"screenshot": "' || repeat('e', 64) || '"}')::jsonb))$sql$,
  'MANUAL_RECONCILE_SCREENSHOT_MISMATCH', 'E-evidence', 'screenshot 与 ledger.postsave_evidence_sha256 不符被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp('{"queue_folder": "Pending"}'))$sql$,
  'MANUAL_RECONCILE_QUEUE_NOT_DONE', 'E-evidence', 'queue_folder 非 Done 被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp('{"verification": "AUTO_ASSUMED"}'))$sql$,
  'MANUAL_RECONCILE_VERIFICATION', 'E-evidence', 'verification 非 MANUAL_POSTSAVE_VERIFIED 被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp('{"outbox_ledger_state": "SAVED_UNVERIFIED"}'))$sql$,
  'MANUAL_RECONCILE_LEDGER_STATE', 'E-evidence', 'ledger_state 非 SAVED_VERIFIED_QUEUE_DONE 被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910120', 'PO-99000120',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56'))$sql$,
  'MANUAL_RECONCILE_IRS_INVALID', 'E-evidence', 'IRS 号格式不符被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_mp(('{"ledger_event": "tj.po.queue.done.v1.' || repeat('1f', 32) || '"}')::jsonb))$sql$,
  'MANUAL_RECONCILE_LEDGER_EVENT_MISMATCH', 'E-evidence', 'ledger.queue_commit_event_id 与 event 不一致被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp('{"ledger_po": "PO-999999"}'))$sql$,
  'MANUAL_RECONCILE_PO_MISMATCH', 'E-evidence', 'ledger 与 outbox 的 PO 不一致被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_mp(('{"event_override": "tj.po.queue.done.v1.' || repeat('7f', 32) || '"}')::jsonb))$sql$,
  'MANUAL_RECONCILE_EVENT_MISMATCH', 'E-evidence', 'event_id 不等于推导值被拒');

-- 用一个尚未对账的 PO：金额/账本核验发生在幂等判定之后，已对账事件会先撞冲突
select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910122', 'PO99000122',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.57'))$sql$,
  'MANUAL_RECONCILE_TOTAL_MISMATCH', 'E-evidence', 'PO 合计与 expected_total_rm 不符被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910122', 'PO99000122',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56',
          '{"ledger_total": "57.50"}'::jsonb))$sql$,
  'MANUAL_RECONCILE_LEDGER_TOTAL_MISMATCH', 'E-evidence', 'ledger expected_total 与实据不符被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp('{"extra": {"reason": "   "}}'))$sql$,
  'MANUAL_RECONCILE_MISSING_FIELD', 'E-evidence', '缺必填 reason 被拒');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(pg_temp.tj_mp(('{"source": "' || repeat('d', 64) || '"}')::jsonb))$sql$,
  'MANUAL_RECONCILE_SHA_MISMATCH', 'E-evidence', 'payload source_sha256 与 outbox 不符被拒');

-- E6 已有标准 ACK accepted 的 PO 不得走人工通道
select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910123', 'PO99000123',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56'))$sql$,
  'MANUAL_RECONCILE_STANDARD_ACK_EXISTS', 'E-conflict', '已有标准 ACK accepted 的 PO 被人工通道拒绝');

-- E6b 已人工对账的 PO：标准 ACK 不得覆盖（人工通道与标准通道互不覆盖）
do $e6b$
declare
  v_res jsonb;
begin
  v_res := pg_temp.tj_rejected(
    pg_temp.tj_rpc_json('authenticated', '66666666-6666-4666-8666-666666666666',
      'tj_preview.tj_po_ack_ingest',
      pg_temp.tj_ack_payload('PO-910120', 'PO99000120', (select val from _fx where name = 'sha_manual'))),
    'PO_ACK_MANUAL_RECONCILED', 'E-conflict', '已人工对账的 PO 拒绝标准 ACK 覆盖');

  perform pg_temp.tj_assert(
    (select erp_status from tj_preview.tj_po_headers where po_id = 'PO-910120') = 'saved_verified_manual_reconciliation',
    'E-conflict', '人工对账的 header 证据未被标准 ACK 改写');
end
$e6b$;

-- E6c 账本里的非数字金额必须给业务错误码（不能抛出 22P02 原生错误）
select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910122', 'PO99000131',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56',
          '{"ledger_total": "not-a-number"}'::jsonb))$sql$,
  'MANUAL_RECONCILE_INVALID_TOTAL', 'E-evidence', 'ledger expected_total 非数字给业务码');

select pg_temp.tj_sql_reject(
  $sql$select tj_preview.tj_po_manual_reconcile(
        pg_temp.tj_manual_payload('PO-910122', 'PO99000124',
          (select val from _fx where name = 'sha_manual'),
          (select val from _fx where name = 'shot_manual'), '57.56',
          '{"ledger_lines_bad": true}'::jsonb))$sql$,
  'MANUAL_RECONCILE_INVALID_TOTAL', 'E-evidence', 'ledger expected_lines 非数字给业务码');

-- E7 追加式：人工对账表禁止改删
select pg_temp.tj_err(
  'update tj_preview.tj_po_manual_reconciliations set reviewer = ''other''',
  'E-append', '人工对账表禁止 UPDATE', 'MANUAL_RECONCILE_APPEND_ONLY');
select pg_temp.tj_err(
  'delete from tj_preview.tj_po_manual_reconciliations',
  'E-append', '人工对账表禁止 DELETE', 'MANUAL_RECONCILE_APPEND_ONLY');

-- E8 人工通道不得改动 push intent / 标准 ACK 账本
select pg_temp.tj_assert(
  (select intents from _snap) = (select count(*) || ':' || coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(i)::text, '|' order by i.id)), '')
     from tj_preview.tj_po_push_intents i),
  'E-isolation', 'push_intents 全表内容未被人工对账改动');

select pg_temp.tj_assert(
  (select receipts_others from _snap) = (select count(*) || ':' || coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.row_to_json(r)::text, '|' order by r.id)), '')
     from tj_preview.tj_po_ack_receipts r where r.po_id is distinct from 'PO-910120'),
  'E-isolation', '既有标准 ACK 回执账本未被本次对账/ACK 触碰');

select pg_temp.tj_assert(
  (select count(*) from tj_preview.tj_po_ack_receipts where po_id = 'PO-910120') = 1
  and (select state from tj_preview.tj_po_ack_receipts where po_id = 'PO-910120') = 'needs_review'
  and (select reject_code from tj_preview.tj_po_ack_receipts where po_id = 'PO-910120') = 'PO_ACK_MANUAL_RECONCILED',
  'E-isolation', '人工对账 PO 只留下一条 ACK 拒绝回执（人工通道自身不写 ACK 账本）');

select pg_temp.tj_assert(
  (select count(*) from tj_preview.tj_po_ack_receipts where state = 'accepted') = 3,
  'E-isolation', 'accepted 回执 = 标准 ACK 写入 2 条 + 夹具预置 1 条（未被人工通道改变）');

-- ----------------------------------------------------------------------------
-- 汇总（harness 读最后一条语句的 rows）
-- ----------------------------------------------------------------------------
select
  (select count(*) from _tj_assertions) as assertions,
  (select count(*) from _tj_assertions where ok) as passed,
  (select count(*) from _tj_assertions where not ok) as failed,
  (select pg_catalog.jsonb_object_agg(section, cnt order by section)
     from (select section, count(*) as cnt from _tj_assertions group by section) s) as sections;

rollback;
