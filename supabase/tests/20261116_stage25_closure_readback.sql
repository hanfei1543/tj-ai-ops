-- ============================================================================
-- Stage25 Preview 修复包 —— 应用后只读回读校验（无任何写语句）
--
-- 用法（主脑在已应用两条迁移的隔离预览库执行）：
--   psql "$PREVIEW_DB_URL" -f supabase/tests/20261116_stage25_closure_readback.sql
-- 或 Supabase Management API POST /projects/{ref}/database/query（postgres 身份）。
--
-- 只读：select 系统目录 + 本包新增对象；不建表、不改权限、不触数据。
-- 每一项都给出「期望值」列，便于人工核对，而不是只看有没有报错。
-- ============================================================================

-- 1) 本包 RPC / helper 的清单与 EXECUTE 授权（期望：只有 wrapper 与 push_request
--    给 authenticated；manual_reconcile 与全部 helper 对 public/anon/authenticated/
--    service_role 全撤）
select
  p.oid::regprocedure::text as function,
  pg_catalog.pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  coalesce(array_to_string(p.proacl, ' | '), '(owner only)') as acl,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
  pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_exec,
  pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'tj_preview'
  and p.proname in (
    'tj_po_preview_request_push', 'tj_po_preview_require_staff',
    'tj_po_ack_ingest', 'tj_po_ack_ingest_v1_internal', 'tj_po_ack_reject',
    'tj_po_ack_event_id', 'tj_po_ack_fingerprint', 'tj_po_ack_require_worker',
    'tj_po_ack_worker_roles', 'tj_po_ack_sha256', 'tj_po_ack_fail',
    'tj_po_manual_reconcile', 'tj_manual_text', 'tj_manual_json',
    'tj_po_push_intent_delivery_guard', 'tj_po_push_evidence_guard',
    'tj_append_only_guard'
  )
order by 1;

-- 2) 新增/变更的表结构（期望：push_intents.delivery_channel 非空、默认
--    legacy_local_unverified；证据表 stage 有 server_prepared/windows_received 约束）
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'tj_preview'
  and table_name in ('tj_po_preview_push_requests',
                     'tj_po_push_delivery_evidence',
                     'tj_po_manual_reconciliations',
                     'tj_po_push_intents')
order by table_name, ordinal_position;

-- 3) RLS 与策略（期望：三张新表 relrowsecurity=true，策略数=0；
--    push_intents 保持 RLS 开启）
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       (select count(*) from pg_catalog.pg_policies pol
         where pol.schemaname = 'tj_preview' and pol.tablename = c.relname) as policy_count,
       array_to_string(c.relacl, ' | ') as acl
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'tj_preview'
  and c.relkind = 'r'
  and c.relname in ('tj_po_preview_push_requests',
                    'tj_po_push_delivery_evidence',
                    'tj_po_manual_reconciliations',
                    'tj_po_push_intents')
order by c.relname;

-- 4) 唯一索引与约束（期望：
--    uq_..._po_header / uq_..._request_id / uq_..._intent_stage /
--    uq_..._event_id / uq_..._po_header / uq_..._irs 全部存在）
select tablename, indexname, indexdef
from pg_catalog.pg_indexes
where schemaname = 'tj_preview'
  and (indexname like 'uq_tj_po_preview_push_requests%'
       or indexname like 'uq_tj_po_push_delivery_evidence%'
       or indexname like 'uq_tj_po_manual_reconciliations%')
order by tablename, indexname;

select c.relname as table_name, con.conname, pg_catalog.pg_get_constraintdef(con.oid) as definition
from pg_catalog.pg_constraint con
join pg_catalog.pg_class c on c.oid = con.conrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'tj_preview'
  and c.relname in ('tj_po_push_intents',
                    'tj_po_push_delivery_evidence',
                    'tj_po_manual_reconciliations')
order by c.relname, con.conname;

-- 5) 触发器（期望：证据表/对账表各两个 append-only 触发器 + 证据插入守卫；
--    push_intents 有 delivered 门禁触发器）
select event_object_table as table_name, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where trigger_schema = 'tj_preview'
  and event_object_table in ('tj_po_push_intents',
                             'tj_po_push_delivery_evidence',
                             'tj_po_manual_reconciliations',
                             'tj_po_preview_push_requests')
order by table_name, trigger_name, event_manipulation;

-- 6) 存量数据现状（只读；期望：旧 intent 全部是 legacy_local_unverified，
--    新表初始为空，人工对账 0 行）
select delivery_channel, state, count(*) as rows
from tj_preview.tj_po_push_intents
group by delivery_channel, state
order by delivery_channel, state;

select 'tj_po_preview_push_requests' as table_name, count(*) as rows from tj_preview.tj_po_preview_push_requests
union all
select 'tj_po_push_delivery_evidence', count(*) from tj_preview.tj_po_push_delivery_evidence
union all
select 'tj_po_manual_reconciliations', count(*) from tj_preview.tj_po_manual_reconciliations;

-- 7) 隔离证据：public 下不得出现本包对象（期望：计数=0）
select count(*) as public_objects_from_this_package
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('tj_po_preview_push_requests',
                    'tj_po_push_delivery_evidence',
                    'tj_po_manual_reconciliations');
