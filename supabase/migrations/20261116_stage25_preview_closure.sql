-- ============================================================================
-- TJ-AI-Ops — Stage25 Preview 隔离库完整修复包（只操作 tj_preview）
-- 文件名：20261116_stage25_preview_closure.sql
--
-- 【状态：PREPARED，由主脑在 tj_preview 单独应用；绝不动 public】
--   * 本文件没有任何 public.* 可执行语句（只读 tj_preview / auth / extensions）。
--   * additive + 可重入（IF NOT EXISTS / CREATE OR REPLACE / 受保护 RENAME）。
--   * 不写 begin/commit，便于事务内试跑后 ROLLBACK。
--
-- 【应用顺序（必须）】
--   1) 20261116_po_done_ack_preview.sql（ACK v1 主体，已部署 tj_preview）
--   2) 本文件
--   * 若在应用本文件后**再次**执行 20261116_po_done_ack_preview.sql，它会用旧主体
--     CREATE OR REPLACE 覆盖 tj_po_ack_ingest —— 使本文件的 wrapper 失效。届时重新
--     执行本文件即可（本文件的 RENAME 有保护，不会把 wrapper 误改名）。
--
-- 【本包包含四块】
--   A. 网站侧「请求推送到电脑」意图表 + 受控 RPC（不再改 header.status=pending_push，
--      保留 Preview 推送总闸）。
--   B. 投递证据链：push intent 增加 delivery_channel，新增 windows_received 收件证据
--      （追加式、无客户端写权限、delivered 必须有匹配证据）。
--   C. 独立的人工历史对账通道 tj_po_manual_reconcile（postgres-only，与标准 ACK 账本
--      完全独立，追加式，不改 push intent / 不改标准 ACK 回执）。
--   D. 标准 ACK 强化：原主体改名为 tj_po_ack_ingest_v1_internal（撤销外部执行），
--      新 wrapper 校验确定性 event_id、IRS 格式、MANUAL_POSTSAVE_VERIFIED、
--      Done / SAVED_VERIFIED_QUEUE_DONE、source/queue SHA、windows_bridge_v1 收件证据。
--
-- 【认证与权限模型】
--   * 网站请求：authenticated + tj_preview.tj_gr_memberships 的 staff/approver/admin。
--   * 标准 ACK：authenticated + tj_preview.tj_po_ack_workers 的 executor/admin（沿用 v1）。
--   * 人工对账：只允许 postgres（管理通道 SQL）。REST 角色（anon/authenticated/
--     service_role）在权限层被拒（42501）；带 JWT claim 的会话在函数内再拒一次。
--   * 新表一律 RLS 开启且无策略、显式 revoke 客户端权限。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) 前置检查：schema 与 ACK v1 主体必须已存在（避免“以为在预览库”）
-- ----------------------------------------------------------------------------
do $pre$
begin
  if not exists (select 1 from pg_catalog.pg_namespace n where n.nspname = 'tj_preview') then
    raise exception 'tj_preview schema 不存在：本文件只用于隔离预览库，不创建/污染生产';
  end if;
  if pg_catalog.to_regclass('tj_preview.tj_po_push_intents') is null then
    raise exception '缺少前置对象 tj_preview.tj_po_push_intents：请先应用 20261116_po_done_ack_preview.sql';
  end if;
  if pg_catalog.to_regclass('tj_preview.tj_po_ack_receipts') is null then
    raise exception '缺少前置对象 tj_preview.tj_po_ack_receipts：请先应用 20261116_po_done_ack_preview.sql';
  end if;
  if pg_catalog.to_regclass('tj_preview.tj_gr_memberships') is null then
    raise exception '缺少前置对象 tj_preview.tj_gr_memberships：网站请求 RPC 依赖 GR 角色成员';
  end if;
end
$pre$;

-- ============================================================================
-- A. 网站侧推送请求（意图登记，不推进 header.status）
-- ============================================================================

create table if not exists tj_preview.tj_po_preview_push_requests (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references tj_preview.tj_po_headers (id) on delete restrict,
  request_id text not null,
  state text not null default 'requested'
    check (state in ('requested', 'dispatch_started', 'delivered', 'delivery_uncertain')),
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 一个 PO 只允许一条推送请求；同一 request_id 只能对应一个 PO
create unique index if not exists uq_tj_po_preview_push_requests_po_header
  on tj_preview.tj_po_preview_push_requests (po_header_id);
create unique index if not exists uq_tj_po_preview_push_requests_request_id
  on tj_preview.tj_po_preview_push_requests (request_id);
create index if not exists idx_tj_po_preview_push_requests_state
  on tj_preview.tj_po_preview_push_requests (state);

alter table tj_preview.tj_po_preview_push_requests enable row level security;
revoke all on table tj_preview.tj_po_preview_push_requests from public;
revoke all on table tj_preview.tj_po_preview_push_requests from anon;
revoke all on table tj_preview.tj_po_preview_push_requests from authenticated;

create or replace function tj_preview.tj_po_preview_push_requests_touch()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := pg_catalog.now();
  return new;
end
$fn$;

drop trigger if exists trg_tj_po_preview_push_requests_touch on tj_preview.tj_po_preview_push_requests;
create trigger trg_tj_po_preview_push_requests_touch
  before update on tj_preview.tj_po_preview_push_requests
  for each row execute function tj_preview.tj_po_preview_push_requests_touch();

revoke all on function tj_preview.tj_po_preview_push_requests_touch() from public;
revoke all on function tj_preview.tj_po_preview_push_requests_touch() from anon, authenticated, service_role;

-- 网站可调用角色：GR staff/approver/admin（executor 是 Windows worker，不在此列）
create or replace function tj_preview.tj_po_preview_require_staff()
returns uuid
language plpgsql
stable security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_roles text[];
begin
  if v_uid is null then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_AUTH_REQUIRED', '需要真实登录用户（auth.uid() 为空）');
  end if;
  select coalesce(array_agg(m.role order by m.role), '{}'::text[])
    into v_roles
    from tj_preview.tj_gr_memberships m
   where m.user_id = v_uid and m.active;
  if coalesce(array_length(v_roles, 1), 0) = 0 then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_FORBIDDEN', '当前用户不是 GR 成员（无 staff/approver/admin 角色）');
  end if;
  if not (v_roles && array['staff', 'approver', 'admin']) then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_FORBIDDEN',
      pg_catalog.format('需要角色 staff/approver/admin，当前角色 %s', array_to_string(v_roles, '/')),
      pg_catalog.jsonb_build_object('actual', to_jsonb(v_roles))
    );
  end if;
  return v_uid;
end
$fn$;

-- 业务拒绝：写意图表之外只返回 jsonb（不改 header、不伪造成功）
create or replace function tj_preview.tj_po_preview_request_push(p_po_header_id uuid, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_request_id text := nullif(btrim(coalesce(p_request_id, '')), '');
  v_po tj_preview.tj_po_headers%rowtype;
  v_req tj_preview.tj_po_preview_push_requests%rowtype;
  v_owner_po text;
begin
  v_uid := tj_preview.tj_po_preview_require_staff();

  if p_po_header_id is null then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_INVALID_INPUT', 'p_po_header_id 不能为空');
  end if;
  if v_request_id is null or length(v_request_id) > 200 then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_INVALID_REQUEST_ID', 'request_id 必须是非空字符串（<=200 字符）');
  end if;

  -- 串行化同一 PO 的并发请求（幂等判定必须与插入同序）
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tj_po_preview_push:' || p_po_header_id::text, 0)
  );

  -- 1) 同一 request_id 已存在：同 PO → 幂等 replay；不同 PO → 冲突
  select * into v_req from tj_preview.tj_po_preview_push_requests where request_id = v_request_id;
  if found then
    if v_req.po_header_id = p_po_header_id then
      select h.po_id into v_owner_po from tj_preview.tj_po_headers h where h.id = v_req.po_header_id;
      return pg_catalog.jsonb_build_object(
        'id', v_req.id, 'po_id', v_owner_po, 'state', v_req.state,
        'request_id', v_req.request_id, 'replayed', true, 'duplicate', false
      );
    end if;
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_REQUEST_ID_CONFLICT',
      'request_id 已绑定另一张 PO，绝不重复使用',
      pg_catalog.jsonb_build_object('request_id', v_request_id, 'po_header_id', v_req.po_header_id)
    );
  end if;

  -- 2) 同一 PO 已有请求：返回既有行，但不重复 dispatch
  select * into v_req from tj_preview.tj_po_preview_push_requests where po_header_id = p_po_header_id;
  if found then
    select h.po_id into v_owner_po from tj_preview.tj_po_headers h where h.id = v_req.po_header_id;
    return pg_catalog.jsonb_build_object(
      'id', v_req.id, 'po_id', v_owner_po, 'state', v_req.state,
      'request_id', v_req.request_id, 'replayed', false, 'duplicate', true
    );
  end if;

  -- 3) 新建请求前的资格检查（全部只读，不改 header）
  select * into v_po from tj_preview.tj_po_headers where id = p_po_header_id for update;
  if not found then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_PO_NOT_FOUND', 'PO 不存在（可能已清理）');
  end if;

  if coalesce(v_po.po_type, 'standard') <> 'standard' then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_NOT_STANDARD',
      pg_catalog.format('只有 standard PO 可请求推送（当前 po_type=%s）', v_po.po_type)
    );
  end if;

  if coalesce(v_po.frozen, false) then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_PO_FROZEN', '已批准冻结的 PO 不能请求推送');
  end if;

  if v_po.status <> 'confirmed' then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_PO_NOT_CONFIRMED',
      pg_catalog.format('只有 confirmed PO 可请求推送（当前 status=%s）', v_po.status)
    );
  end if;

  if v_po.website_po_date is null then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_NO_WEBSITE_DATE', '缺少 Website PO Date（必须显式选择，不默认当天）');
  end if;

  -- 合并单来源：自身带 source_po_ids，或被某张 combined 单引用
  if coalesce(array_length(v_po.source_po_ids, 1), 0) > 0 then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_COMBINED_SOURCE',
      '该 PO 带 source_po_ids（合并来源关系），禁止单独推送',
      pg_catalog.jsonb_build_object('source_po_ids', to_jsonb(v_po.source_po_ids))
    );
  end if;

  select h.po_id into v_owner_po
    from tj_preview.tj_po_headers h
   where h.po_type = 'combined'
     and h.po_id is not null
     and v_po.po_id = any (h.source_po_ids)
   limit 1;
  if v_owner_po is not null then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_COMBINED_SOURCE',
      'PO 已被合并单引用，禁止单独推送',
      pg_catalog.jsonb_build_object('combined_po_id', v_owner_po)
    );
  end if;

  if v_po.status in ('combining', 'combined') then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_COMBINED_SOURCE',
      pg_catalog.format('PO 已进入合并流程（status=%s），禁止单独推送', v_po.status)
    );
  end if;

  -- 历史投递意图：一个 PO 一生只允许一条，已有即拒绝（绝不凭新请求重投）
  if exists (select 1 from tj_preview.tj_po_push_intents i where i.po_header_id = v_po.id) then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_INTENT_EXISTS',
      '该 PO 已有历史投递意图，禁止再次请求推送（需人工核对）'
    );
  end if;

  -- 已有 ERP 保存记录（标准 ACK 或人工对账）→ 不得再推
  if coalesce(nullif(btrim(v_po.irs_po_no), ''), null) is not null
     or coalesce(v_po.erp_status, 'none') not in ('none', '') then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_ERP_SAVED',
      pg_catalog.format('PO 已有 ERP 保存记录（erp_status=%s, irs_po_no=%s），禁止再次推送',
        coalesce(v_po.erp_status, ''), coalesce(v_po.irs_po_no, '')),
      pg_catalog.jsonb_build_object('erp_status', v_po.erp_status, 'irs_po_no', v_po.irs_po_no)
    );
  end if;

  if exists (
    select 1 from tj_preview.tj_po_ack_receipts r
     where r.po_header_id = v_po.id and r.state = 'accepted'
  ) then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_ERP_SAVED', 'PO 已有 accepted 的标准 ACK 回执，禁止再次推送');
  end if;

  -- 4) 登记请求。注意：绝不把 header.status 改成 pending_push（保留 Preview 总闸）。
  insert into tj_preview.tj_po_preview_push_requests (po_header_id, request_id, state, requested_by)
  values (v_po.id, v_request_id, 'requested', v_uid)
  returning * into v_req;

  return pg_catalog.jsonb_build_object(
    'id', v_req.id, 'po_id', v_po.po_id, 'state', v_req.state,
    'request_id', v_req.request_id, 'replayed', false, 'duplicate', false
  );
end
$fn$;

revoke all on function tj_preview.tj_po_preview_request_push(uuid, text) from public;
revoke all on function tj_preview.tj_po_preview_request_push(uuid, text) from anon;
grant execute on function tj_preview.tj_po_preview_request_push(uuid, text) to authenticated;

revoke all on function tj_preview.tj_po_preview_require_staff() from public;
revoke all on function tj_preview.tj_po_preview_require_staff() from anon;
revoke all on function tj_preview.tj_po_preview_require_staff() from authenticated;

-- ============================================================================
-- B. 投递证据链（server_prepared / windows_received）
-- ============================================================================

alter table tj_preview.tj_po_push_intents
  add column if not exists delivery_channel text not null default 'legacy_local_unverified';

do $chk$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'tj_preview' and t.relname = 'tj_po_push_intents'
      and c.conname = 'tj_po_push_intents_delivery_channel_chk'
  ) then
    alter table tj_preview.tj_po_push_intents
      add constraint tj_po_push_intents_delivery_channel_chk
      check (delivery_channel in ('legacy_local_unverified', 'windows_bridge_v1'));
  end if;
end
$chk$;

create table if not exists tj_preview.tj_po_push_delivery_evidence (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references tj_preview.tj_po_push_intents (id) on delete restrict,
  stage text not null check (stage in ('server_prepared', 'windows_received')),
  xlsx_sha256 text not null check (xlsx_sha256 ~ '^[0-9a-fA-F]{64}$'),
  byte_count bigint not null check (byte_count > 0),
  target_path text not null check (btrim(target_path) <> ''),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_tj_po_push_delivery_evidence_intent_stage
  on tj_preview.tj_po_push_delivery_evidence (intent_id, stage);

alter table tj_preview.tj_po_push_delivery_evidence enable row level security;
revoke all on table tj_preview.tj_po_push_delivery_evidence from public;
revoke all on table tj_preview.tj_po_push_delivery_evidence from anon;
revoke all on table tj_preview.tj_po_push_delivery_evidence from authenticated;

-- 通用追加式守卫：UPDATE/DELETE/TRUNCATE 一律拒绝（owner 也拒）。
-- 触发函数属主仍是表 owner，但追加式语义要求连 owner 也只能 INSERT。
create or replace function tj_preview.tj_append_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_code text := coalesce(nullif(btrim(coalesce(tg_argv[0], '')), ''), 'APPEND_ONLY_TABLE');
begin
  raise exception using
    errcode = 'P0001',
    message = pg_catalog.jsonb_build_object(
      'code', v_code,
      'message', pg_catalog.format('%s 是追加式账本：禁止 %s', tg_table_name, tg_op),
      'detail', pg_catalog.jsonb_build_object('table', tg_table_name, 'op', tg_op)
    )::text,
    hint = '只能 INSERT；更正必须新增事件，不得改写历史证据';
end
$fn$;

drop trigger if exists trg_tj_po_push_delivery_evidence_append_only on tj_preview.tj_po_push_delivery_evidence;
create trigger trg_tj_po_push_delivery_evidence_append_only
  before update or delete on tj_preview.tj_po_push_delivery_evidence
  for each row execute function tj_preview.tj_append_only_guard('PO_PUSH_EVIDENCE_APPEND_ONLY');

drop trigger if exists trg_tj_po_push_delivery_evidence_no_truncate on tj_preview.tj_po_push_delivery_evidence;
create trigger trg_tj_po_push_delivery_evidence_no_truncate
  before truncate on tj_preview.tj_po_push_delivery_evidence
  for each statement execute function tj_preview.tj_append_only_guard('PO_PUSH_EVIDENCE_APPEND_ONLY');

-- 证据只能挂在 windows_bridge_v1 意图上（legacy 记录保留不动，不得补证据洗白），
-- 且证据哈希必须与意图 xlsx_sha256 一致。
create or replace function tj_preview.tj_po_push_evidence_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_channel text;
  v_intent_sha text;
begin
  select i.delivery_channel, i.xlsx_sha256 into v_channel, v_intent_sha
    from tj_preview.tj_po_push_intents i where i.id = new.intent_id;
  if not found then
    perform tj_preview.tj_po_ack_fail('PO_PUSH_EVIDENCE_UNKNOWN_INTENT', '证据指向不存在的投递意图');
  end if;
  if v_channel <> 'windows_bridge_v1' then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_EVIDENCE_LEGACY_INTENT',
      'legacy_local_unverified 意图不得补收件证据（旧记录保留不动）',
      pg_catalog.jsonb_build_object('intent_id', new.intent_id, 'delivery_channel', v_channel)
    );
  end if;
  if v_intent_sha is not null and lower(v_intent_sha) <> lower(new.xlsx_sha256) then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_DELIVERY_HASH_MISMATCH',
      '证据哈希与投递意图 xlsx_sha256 不一致',
      pg_catalog.jsonb_build_object('intent_sha256', v_intent_sha, 'evidence_sha256', new.xlsx_sha256)
    );
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_tj_po_push_delivery_evidence_guard on tj_preview.tj_po_push_delivery_evidence;
create trigger trg_tj_po_push_delivery_evidence_guard
  before insert on tj_preview.tj_po_push_delivery_evidence
  for each row execute function tj_preview.tj_po_push_evidence_guard();

-- delivered 门禁：只约束新通道（windows_bridge_v1）。
-- legacy_local_unverified 的历史记录照常更新（如补 error 文本），不被本触发器影响。
create or replace function tj_preview.tj_po_push_intent_delivery_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_win_cnt integer;
  v_win_sha text;
  v_srv_sha text;
begin
  if new.delivery_channel <> 'windows_bridge_v1' then
    return new;
  end if;
  if new.state <> 'delivered' then
    return new;
  end if;

  select count(*), max(lower(e.xlsx_sha256)) into v_win_cnt, v_win_sha
    from tj_preview.tj_po_push_delivery_evidence e
   where e.intent_id = new.id and e.stage = 'windows_received';

  if coalesce(v_win_cnt, 0) = 0 then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_DELIVERY_EVIDENCE_MISSING',
      'windows_bridge_v1 意图进入 delivered 必须有 windows_received 收件证据',
      pg_catalog.jsonb_build_object('intent_id', new.id)
    );
  end if;

  if new.xlsx_sha256 is null or lower(new.xlsx_sha256) <> v_win_sha then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_DELIVERY_HASH_MISMATCH',
      'delivered 的 xlsx_sha256 必须与 windows_received 证据哈希一致',
      pg_catalog.jsonb_build_object('intent_sha256', new.xlsx_sha256, 'evidence_sha256', v_win_sha)
    );
  end if;

  select max(lower(e.xlsx_sha256)) into v_srv_sha
    from tj_preview.tj_po_push_delivery_evidence e
   where e.intent_id = new.id and e.stage = 'server_prepared';
  if v_srv_sha is not null and v_srv_sha <> v_win_sha then
    perform tj_preview.tj_po_ack_fail(
      'PO_PUSH_DELIVERY_HASH_MISMATCH',
      'server_prepared 与 windows_received 证据哈希不一致（疑似投递中途被替换）',
      pg_catalog.jsonb_build_object('server_prepared', v_srv_sha, 'windows_received', v_win_sha)
    );
  end if;

  return new;
end
$fn$;

drop trigger if exists trg_tj_po_push_intent_delivery_guard on tj_preview.tj_po_push_intents;
create trigger trg_tj_po_push_intent_delivery_guard
  before insert or update of state, delivery_channel, xlsx_sha256 on tj_preview.tj_po_push_intents
  for each row execute function tj_preview.tj_po_push_intent_delivery_guard();

revoke all on function tj_preview.tj_po_push_evidence_guard() from public;
revoke all on function tj_preview.tj_po_push_intent_delivery_guard() from public;
revoke all on function tj_preview.tj_append_only_guard() from public;

-- 触发器函数同样撤掉默认 PUBLIC EXECUTE（虽然不能直接当普通函数调用，但不留授权面）
revoke all on function tj_preview.tj_po_push_evidence_guard() from anon, authenticated, service_role;
revoke all on function tj_preview.tj_po_push_intent_delivery_guard() from anon, authenticated, service_role;
revoke all on function tj_preview.tj_append_only_guard() from anon, authenticated, service_role;

-- ============================================================================
-- C. 人工历史对账（独立通道，postgres-only）
-- ============================================================================

create table if not exists tj_preview.tj_po_manual_reconciliations (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  content_fingerprint text not null,
  po_header_id uuid not null references tj_preview.tj_po_headers (id) on delete restrict,
  po_id text not null,
  irs_po_no text not null,
  classification text not null default 'manual_delivery_historical_import'
    check (classification = 'manual_delivery_historical_import'),
  outbox_raw text not null,
  ledger_raw text not null,
  outbox_sha256 text not null check (outbox_sha256 ~ '^[0-9a-f]{64}$'),
  ledger_sha256 text not null check (ledger_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  screenshot_sha256 text not null check (screenshot_sha256 ~ '^[0-9a-f]{64}$'),
  expected_total_rm text not null,
  outbox_evidence jsonb not null default '{}'::jsonb,
  ledger_evidence jsonb not null default '{}'::jsonb,
  push_intent_id uuid references tj_preview.tj_po_push_intents (id) on delete restrict,
  push_intent_state text,
  push_intent_xlsx_sha256 text,
  push_intent_content_sha256 text,
  reviewer text not null,
  reason text not null,
  actor uuid,
  verified_by text not null,
  created_at timestamptz not null default now()
);

-- 同一事件只允许一条；同一 PO / 同一 IRS 号不得被第二个事件覆盖
create unique index if not exists uq_tj_po_manual_reconciliations_event_id
  on tj_preview.tj_po_manual_reconciliations (event_id);
create unique index if not exists uq_tj_po_manual_reconciliations_po_header
  on tj_preview.tj_po_manual_reconciliations (po_header_id);
create unique index if not exists uq_tj_po_manual_reconciliations_irs
  on tj_preview.tj_po_manual_reconciliations (irs_po_no);
create index if not exists idx_tj_po_manual_reconciliations_po_id
  on tj_preview.tj_po_manual_reconciliations (po_id);

alter table tj_preview.tj_po_manual_reconciliations enable row level security;
revoke all on table tj_preview.tj_po_manual_reconciliations from public;
revoke all on table tj_preview.tj_po_manual_reconciliations from anon;
revoke all on table tj_preview.tj_po_manual_reconciliations from authenticated;
revoke all on table tj_preview.tj_po_manual_reconciliations from service_role;

drop trigger if exists trg_tj_po_manual_reconciliations_append_only on tj_preview.tj_po_manual_reconciliations;
create trigger trg_tj_po_manual_reconciliations_append_only
  before update or delete on tj_preview.tj_po_manual_reconciliations
  for each row execute function tj_preview.tj_append_only_guard('MANUAL_RECONCILE_APPEND_ONLY');

drop trigger if exists trg_tj_po_manual_reconciliations_no_truncate on tj_preview.tj_po_manual_reconciliations;
create trigger trg_tj_po_manual_reconciliations_no_truncate
  before truncate on tj_preview.tj_po_manual_reconciliations
  for each statement execute function tj_preview.tj_append_only_guard('MANUAL_RECONCILE_APPEND_ONLY');

-- 必填文本取值（NULL/空白即拒，绝不把空串当证据）
create or replace function tj_preview.tj_manual_text(p_payload jsonb, p_key text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_value text;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_INVALID_PAYLOAD', 'p_payload 必须是 JSON 对象');
  end if;
  if pg_catalog.jsonb_typeof(p_payload -> p_key) is distinct from 'string' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_MISSING_FIELD',
      pg_catalog.format('缺少必填文本字段 %s', p_key),
      pg_catalog.jsonb_build_object('field', p_key)
    );
  end if;
  v_value := btrim(p_payload ->> p_key);
  if v_value = '' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_MISSING_FIELD',
      pg_catalog.format('必填文本字段 %s 不能为空白', p_key),
      pg_catalog.jsonb_build_object('field', p_key)
    );
  end if;
  return v_value;
end
$fn$;

create or replace function tj_preview.tj_manual_amount(p_text text, p_label text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v numeric;
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  begin
    v := btrim(p_text)::numeric;
  exception
    when others then
      perform tj_preview.tj_po_ack_fail(
        'MANUAL_RECONCILE_INVALID_TOTAL',
        pg_catalog.format('%s 不是合法金额', p_label),
        pg_catalog.jsonb_build_object('label', p_label, 'value', p_text)
      );
  end;
  return v;
end
$fn$;

create or replace function tj_preview.tj_manual_json(p_raw text, p_label text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v jsonb;
begin
  begin
    v := p_raw::jsonb;
  exception
    when others then
      perform tj_preview.tj_po_ack_fail(
        'MANUAL_RECONCILE_INVALID_JSON',
        pg_catalog.format('%s 不是合法 JSON', p_label),
        pg_catalog.jsonb_build_object('label', p_label)
      );
  end;
  if pg_catalog.jsonb_typeof(v) <> 'object' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_INVALID_JSON',
      pg_catalog.format('%s 必须是 JSON 对象', p_label),
      pg_catalog.jsonb_build_object('label', p_label)
    );
  end if;
  return v;
end
$fn$;

/**
 * tj_po_manual_reconcile —— 历史人工核验的唯一入库通道。
 *
 * 只允许 postgres（管理通道 / psql / Supabase Management API）执行：
 *   revoke execute from public/anon/authenticated/service_role。
 * 任何带 JWT claim 的会话在函数内再拒一次（防未来误授权）。
 *
 * 它做的核验（任一不满足即 raise，绝不写入）：
 *   1. outbox / ledger 原始 JSON 可解析，schema 正确；
 *   2. outbox 与 ledger 指向同一 PO、同一 event（ledger.queue_commit_event_id）、同一 IRS；
 *   3. IRS 号 ^PO[0-9]{8}$；
 *   4. outbox.source_sha256 == outbox.queue_done_sha256 == payload.source_sha256（大写/小写均接受）；
 *   5. outbox.queue_folder = 'Done'；outbox.ledger_state = 'SAVED_VERIFIED_QUEUE_DONE'；
 *      outbox.verification = 'MANUAL_POSTSAVE_VERIFIED'；ledger.state 同值（若给出）；
 *   6. ledger.postsave_evidence_sha256 == payload.screenshot_sha256；
 *   7. event_id == 'tj.po.queue.done.v1.' + sha256('TJ_QUEUE_DONE_V1|po|UPPER(source)|irs')；
 *   8. 表头+明细合计 == payload.expected_total_rm == ledger.expected_total_rm
 *      （并校验 ledger.expected_lines 的 amount_rm 求和）；
 *   9. 该 PO 尚无标准 ACK accepted 回执 / 无 saved_verified 记录（标准账本是唯一真相，
 *      人工通道不得覆盖它，也不得改写 push intent）。
 *
 * 幂等：同 event + 同内容 → replay（不新增行）；同 event + 内容变化 → 冲突；
 *       不同 event 撞同一 PO 或同一 IRS → 冲突（表级唯一索引 + 显式判定）。
 * 允许写回 header：irs_po_no + verified_by='manual-reconciliation:<id>' +
 *       erp_status='saved_verified_manual_reconciliation'。
 */
create or replace function tj_preview.tj_po_manual_reconcile(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_outbox_raw text;
  v_ledger_raw text;
  v_outbox jsonb;
  v_ledger jsonb;
  v_po_id text;
  v_outbox_po text;
  v_event text;
  v_irs text;
  v_source text;
  v_payload_source text;
  v_queue text;
  v_shot text;
  v_reviewer text;
  v_reason text;
  v_expected_text text;
  v_expected numeric;
  v_outbox_sha text;
  v_ledger_sha text;
  v_expected_event text;
  v_ledger_event text;
  v_ledger_total numeric;
  v_ledger_lines_total numeric;
  v_po tj_preview.tj_po_headers%rowtype;
  v_po_total numeric;
  v_line_count integer;
  v_intent tj_preview.tj_po_push_intents%rowtype;
  v_existing tj_preview.tj_po_manual_reconciliations%rowtype;
  v_fingerprint text;
  v_new_id uuid;
  v_verified_by text;
  v_actor uuid;
begin
  -- 0) 身份闸门：只允许数据库 owner / 管理通道（无 JWT claim 的会话）
  if current_user in ('anon', 'authenticated', 'service_role')
     or session_user in ('anon', 'authenticated', 'service_role') then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_FORBIDDEN', '人工对账只允许 postgres 管理通道执行');
  end if;
  if nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '') is not null then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_FORBIDDEN', '人工对账不接受带 JWT 身份的调用（只能由管理通道执行）');
  end if;

  -- 1) 原始证据（保留原始 JSON 字节：CRLF 不归一化）
  v_outbox_raw := p_payload ->> 'outbox_raw';
  v_ledger_raw := p_payload ->> 'ledger_raw';
  if v_outbox_raw is null or btrim(v_outbox_raw) = '' then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_MISSING_FIELD', '缺少 outbox_raw（原始 JSON 文本）');
  end if;
  if v_ledger_raw is null or btrim(v_ledger_raw) = '' then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_MISSING_FIELD', '缺少 ledger_raw（原始 JSON 文本）');
  end if;

  v_shot := lower(tj_preview.tj_manual_text(p_payload, 'screenshot_sha256'));
  v_source := lower(tj_preview.tj_manual_text(p_payload, 'source_sha256'));
  v_payload_source := v_source;
  v_reviewer := tj_preview.tj_manual_text(p_payload, 'reviewer');
  v_reason := tj_preview.tj_manual_text(p_payload, 'reason');
  v_expected_text := tj_preview.tj_manual_text(p_payload, 'expected_total_rm');

  if v_shot !~ '^[0-9a-f]{64}$' then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_INVALID_SHA', 'screenshot_sha256 必须是 64 位 hex');
  end if;
  if v_source !~ '^[0-9a-f]{64}$' then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_INVALID_SHA', 'source_sha256 必须是 64 位 hex');
  end if;
  if v_expected_text !~ '^[0-9]+(\.[0-9]{1,2})?$' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_INVALID_TOTAL',
      'expected_total_rm 必须是十进制金额字符串（最多两位小数）',
      pg_catalog.jsonb_build_object('expected_total_rm', v_expected_text)
    );
  end if;
  v_expected := v_expected_text::numeric;

  v_outbox := tj_preview.tj_manual_json(v_outbox_raw, 'outbox_raw');
  v_ledger := tj_preview.tj_manual_json(v_ledger_raw, 'ledger_raw');
  v_outbox_sha := tj_preview.tj_po_ack_sha256(v_outbox_raw);
  v_ledger_sha := tj_preview.tj_po_ack_sha256(v_ledger_raw);

  -- 2) outbox 业务字段
  if coalesce(v_outbox ->> 'schema', '') <> 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1' then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_SCHEMA', 'outbox.schema 必须是 TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1');
  end if;
  v_event := nullif(btrim(coalesce(v_outbox ->> 'event_id', '')), '');
  v_outbox_po := nullif(btrim(coalesce(v_outbox ->> 'po_id', '')), '');
  v_po_id := coalesce(v_outbox_po, nullif(btrim(coalesce(v_outbox ->> 'business_po_id', '')), ''));
  v_irs := nullif(btrim(coalesce(v_outbox ->> 'irs_po_number', '')), '');
  v_queue := nullif(btrim(coalesce(v_outbox ->> 'queue_done_sha256', '')), '');
  v_source := lower(coalesce(nullif(btrim(coalesce(v_outbox ->> 'source_sha256', '')), ''), v_source));

  if v_event is null then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_MISSING_FIELD', 'outbox.event_id 不能为空');
  end if;
  if v_po_id is null then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_MISSING_FIELD', 'outbox.po_id 不能为空');
  end if;
  if v_irs is null or v_irs !~ '^PO[0-9]{8}$' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_IRS_INVALID',
      'IRS 号必须形如 PO26000784（^PO[0-9]{8}$）',
      pg_catalog.jsonb_build_object('irs_po_number', v_irs)
    );
  end if;
  if v_source !~ '^[0-9a-f]{64}$' or v_queue is null or lower(v_queue) <> v_source then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_SHA_MISMATCH',
      'outbox.source_sha256 与 queue_done_sha256 必须一致（且为 64 位 hex）',
      pg_catalog.jsonb_build_object('source_sha256', v_source, 'queue_done_sha256', v_queue)
    );
  end if;
  if v_payload_source <> v_source then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_SHA_MISMATCH',
      'payload.source_sha256 与 outbox.source_sha256 不一致',
      pg_catalog.jsonb_build_object('payload_source_sha256', v_payload_source, 'outbox_source_sha256', v_source)
    );
  end if;
  if coalesce(v_outbox ->> 'queue_folder', '') <> 'Done' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_QUEUE_NOT_DONE',
      'outbox.queue_folder 必须是 Done',
      pg_catalog.jsonb_build_object('queue_folder', v_outbox ->> 'queue_folder')
    );
  end if;
  if coalesce(v_outbox ->> 'ledger_state', '') <> 'SAVED_VERIFIED_QUEUE_DONE' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_LEDGER_STATE',
      'outbox.ledger_state 必须是 SAVED_VERIFIED_QUEUE_DONE',
      pg_catalog.jsonb_build_object('ledger_state', v_outbox ->> 'ledger_state')
    );
  end if;
  if coalesce(v_outbox ->> 'verification', '') <> 'MANUAL_POSTSAVE_VERIFIED' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_VERIFICATION',
      'outbox.verification 必须是 MANUAL_POSTSAVE_VERIFIED',
      pg_catalog.jsonb_build_object('verification', v_outbox ->> 'verification')
    );
  end if;

  -- 3) ledger 业务字段（同一 PO / 同一 event / 同一 IRS / 同一 screenshot）
  if v_ledger ->> 'po_id' is distinct from v_po_id then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_PO_MISMATCH',
      'outbox 与 ledger 的 po_id 不一致',
      pg_catalog.jsonb_build_object('outbox_po_id', v_po_id, 'ledger_po_id', v_ledger ->> 'po_id')
    );
  end if;
  if v_ledger ->> 'irs_po_number' is distinct from v_irs then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_IRS_MISMATCH',
      'outbox 与 ledger 的 irs_po_number 不一致',
      pg_catalog.jsonb_build_object('outbox_irs', v_irs, 'ledger_irs', v_ledger ->> 'irs_po_number')
    );
  end if;
  v_ledger_event := nullif(btrim(coalesce(v_ledger ->> 'queue_commit_event_id', '')), '');
  if v_ledger_event is distinct from v_event then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_LEDGER_EVENT_MISMATCH',
      'ledger.queue_commit_event_id 必须等于 outbox.event_id',
      pg_catalog.jsonb_build_object('outbox_event_id', v_event, 'ledger_queue_commit_event_id', v_ledger_event)
    );
  end if;
  if v_ledger ->> 'state' is not null and (v_ledger ->> 'state') <> 'SAVED_VERIFIED_QUEUE_DONE' then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_LEDGER_STATE',
      'ledger.state 必须是 SAVED_VERIFIED_QUEUE_DONE',
      pg_catalog.jsonb_build_object('ledger_state', v_ledger ->> 'state')
    );
  end if;
  if lower(coalesce(v_ledger ->> 'postsave_evidence_sha256', '')) <> v_shot then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_SCREENSHOT_MISMATCH',
      'ledger.postsave_evidence_sha256 必须等于 payload.screenshot_sha256（保存后截图）',
      pg_catalog.jsonb_build_object('ledger_sha256', v_ledger ->> 'postsave_evidence_sha256', 'payload_sha256', v_shot)
    );
  end if;
  if v_ledger ? 'source_sha256'
     and lower(coalesce(v_ledger ->> 'source_sha256', '')) <> v_source then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_SHA_MISMATCH', 'ledger.source_sha256 与 outbox 不一致');
  end if;

  -- 4) 确定性 event_id（与 Windows 客户端逐字节一致，客户端用大写 hash）
  v_expected_event := tj_preview.tj_po_ack_event_id(v_po_id, v_source, v_irs);
  if lower(v_event) <> v_expected_event then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_EVENT_MISMATCH',
      'event_id 不等于 sha256(TJ_QUEUE_DONE_V1|po|UPPER(source)|irs) 推导值',
      pg_catalog.jsonb_build_object('claimed', v_event, 'expected', v_expected_event)
    );
  end if;

  -- 5) 锁：event 单元 + IRS 单元 + header 行锁（并发对账/ACK 互斥）
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tj_po_manual_event:' || lower(v_event), 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tj_po_manual_irs:' || v_irs, 0)
  );

  select * into v_po from tj_preview.tj_po_headers where po_id = v_po_id for update;
  if not found then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_PO_NOT_FOUND',
      'Website PO 不存在（人工对账不自动重建单据）',
      pg_catalog.jsonb_build_object('po_id', v_po_id)
    );
  end if;

  -- 6) 幂等 / 冲突（事件维度）
  v_fingerprint := tj_preview.tj_po_ack_sha256(
    'v1|' || v_outbox_sha || '|' || v_ledger_sha || '|' || v_shot || '|' ||
    v_expected_text || '|' || v_reviewer || '|' || v_reason
  );

  select * into v_existing from tj_preview.tj_po_manual_reconciliations where event_id = lower(v_event);
  if found then
    if v_existing.content_fingerprint = v_fingerprint then
      return pg_catalog.jsonb_build_object(
        'replayed', true, 'conflict', false,
        'id', v_existing.id, 'event_id', v_existing.event_id,
        'po_id', v_existing.po_id, 'irs_po_no', v_existing.irs_po_no,
        'classification', v_existing.classification,
        'verified_by', v_existing.verified_by,
        'expected_total_rm', v_existing.expected_total_rm
      );
    end if;
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_CONFLICT',
      '同一 event_id 的历史对账内容已变化（原始证据不可改写）',
      pg_catalog.jsonb_build_object('event_id', lower(v_event), 'existing_id', v_existing.id)
    );
  end if;

  -- 7) 不同事件不得覆盖同一 PO / 同一 IRS；不得覆盖标准 ACK 账本
  select * into v_existing from tj_preview.tj_po_manual_reconciliations
   where po_header_id = v_po.id or irs_po_no = v_irs
   limit 1;
  if found then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_ALREADY_RECONCILED',
      '该 PO 或该 IRS 号已有历史人工对账记录（不同 event 不得覆盖）',
      pg_catalog.jsonb_build_object('existing_event_id', v_existing.event_id, 'existing_po_id', v_existing.po_id)
    );
  end if;

  if coalesce(v_po.erp_status, 'none') in ('saved_verified_queue_done', 'saved_verified_manual_reconciliation') then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_ALREADY_SAVED',
      pg_catalog.format('PO 已有保存核验记录（erp_status=%s），人工通道不得覆盖', v_po.erp_status)
    );
  end if;
  if exists (
    select 1 from tj_preview.tj_po_ack_receipts r
     where r.po_header_id = v_po.id and r.state = 'accepted'
  ) then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_STANDARD_ACK_EXISTS',
      'PO 已有标准 ACK accepted 回执：标准账本优先，人工通道不得覆盖'
    );
  end if;
  if v_po.irs_po_no is not null and btrim(v_po.irs_po_no) <> '' and btrim(v_po.irs_po_no) <> v_irs then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_IRS_CONFLICT',
      'header 已保存另一个 IRS 号，人工对账不得覆盖',
      pg_catalog.jsonb_build_object('header_irs_po_no', v_po.irs_po_no, 'payload_irs_po_no', v_irs)
    );
  end if;

  -- 8) 金额核验：header+lines 合计 == expected == ledger expected
  select coalesce(count(*), 0), coalesce(sum(l.qty * l.unit_price), 0)
    into v_line_count, v_po_total
    from tj_preview.tj_po_lines l
   where l.po_header_id = v_po.id;
  if v_line_count = 0 then
    perform tj_preview.tj_po_ack_fail('MANUAL_RECONCILE_NO_LINES', 'PO 没有任何明细行，无法核验合计');
  end if;
  if round(v_po_total, 2) <> v_expected then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_TOTAL_MISMATCH',
      'PO 表头+明细合计与 expected_total_rm 不一致',
      pg_catalog.jsonb_build_object('po_total', round(v_po_total, 2)::text, 'expected_total_rm', v_expected_text)
    );
  end if;

  v_ledger_total := coalesce(
    tj_preview.tj_manual_amount(v_ledger ->> 'expected_total_rm', 'ledger.expected_total_rm'),
    tj_preview.tj_manual_amount(v_ledger ->> 'expected_total', 'ledger.expected_total')
  );
  if v_ledger_total is null or round(v_ledger_total, 2) <> v_expected then
    perform tj_preview.tj_po_ack_fail(
      'MANUAL_RECONCILE_LEDGER_TOTAL_MISMATCH',
      'ledger 的 expected_total 与 expected_total_rm 不一致（或缺失）',
      pg_catalog.jsonb_build_object('ledger_total', v_ledger_total::text, 'expected_total_rm', v_expected_text)
    );
  end if;
  if v_ledger ? 'expected_lines' and pg_catalog.jsonb_typeof(v_ledger -> 'expected_lines') = 'array' then
    select coalesce(sum(tj_preview.tj_manual_amount(e.value ->> 'amount_rm', 'ledger.expected_lines[].amount_rm')), 0)
      into v_ledger_lines_total
      from pg_catalog.jsonb_array_elements(v_ledger -> 'expected_lines') e;
    if round(v_ledger_lines_total, 2) <> v_expected then
      perform tj_preview.tj_po_ack_fail(
        'MANUAL_RECONCILE_LEDGER_TOTAL_MISMATCH',
        'ledger.expected_lines 金额求和与 expected_total_rm 不一致',
        pg_catalog.jsonb_build_object('ledger_lines_total', round(v_ledger_lines_total, 2)::text, 'expected_total_rm', v_expected_text)
      );
    end if;
  end if;

  -- 9) 原投递意图快照（只读，绝不改写 push intent / 标准 ACK 账本）
  select * into v_intent from tj_preview.tj_po_push_intents i
   where i.po_header_id = v_po.id
   order by i.created_at desc limit 1;

  v_actor := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;

  -- id 必须先于 INSERT 生成：本表追加式，装好账后不允许 UPDATE 回填 verified_by
  v_new_id := pg_catalog.gen_random_uuid();
  v_verified_by := 'manual-reconciliation:' || v_new_id::text;

  insert into tj_preview.tj_po_manual_reconciliations (
    id, event_id, content_fingerprint, po_header_id, po_id, irs_po_no, classification,
    outbox_raw, ledger_raw, outbox_sha256, ledger_sha256, source_sha256, screenshot_sha256,
    expected_total_rm, outbox_evidence, ledger_evidence,
    push_intent_id, push_intent_state, push_intent_xlsx_sha256, push_intent_content_sha256,
    reviewer, reason, actor, verified_by
  ) values (
    v_new_id, lower(v_event), v_fingerprint, v_po.id, v_po_id, v_irs, 'manual_delivery_historical_import',
    v_outbox_raw, v_ledger_raw, v_outbox_sha, v_ledger_sha, v_source, v_shot,
    v_expected_text, v_outbox, v_ledger,
    v_intent.id, v_intent.state, v_intent.xlsx_sha256, v_intent.content_sha256,
    v_reviewer, v_reason, v_actor, v_verified_by
  );

  -- 写回 header：IRS 号 + 人工对账验证证据（预览库 irs_guard 要求同时写 verified_at/by）
  update tj_preview.tj_po_headers
     set irs_po_no = v_irs,
         irs_po_no_verified_at = pg_catalog.now(),
         irs_po_no_verified_by = v_verified_by,
         erp_status = 'saved_verified_manual_reconciliation',
         updated_at = pg_catalog.now()
   where id = v_po.id;

  return pg_catalog.jsonb_build_object(
    'replayed', false,
    'conflict', false,
    'id', v_new_id,
    'event_id', lower(v_event),
    'po_id', v_po_id,
    'irs_po_no', v_irs,
    'classification', 'manual_delivery_historical_import',
    'expected_total_rm', v_expected_text,
    'verified_by', v_verified_by,
    'push_intent_id', v_intent.id,
    'source_sha256', v_source,
    'screenshot_sha256', v_shot,
    'outbox_sha256', v_outbox_sha,
    'ledger_sha256', v_ledger_sha
  );
end
$fn$;

revoke all on function tj_preview.tj_po_manual_reconcile(jsonb) from public;
revoke all on function tj_preview.tj_po_manual_reconcile(jsonb) from anon;
revoke all on function tj_preview.tj_po_manual_reconcile(jsonb) from authenticated;
revoke all on function tj_preview.tj_po_manual_reconcile(jsonb) from service_role;

revoke all on function tj_preview.tj_manual_amount(text, text) from public;
revoke all on function tj_preview.tj_manual_amount(text, text) from anon, authenticated, service_role;
revoke all on function tj_preview.tj_manual_text(jsonb, text) from public;
revoke all on function tj_preview.tj_manual_json(text, text) from public;

-- ============================================================================
-- D. 标准 ACK 强化
-- ============================================================================

-- D.1 原已验证主体改名为内部实现，撤销外部执行（幂等 + 不会误改 wrapper）
do $rename$
declare
  v_src text;
begin
  if pg_catalog.to_regprocedure('tj_preview.tj_po_ack_ingest_v1_internal(jsonb)') is null
     and pg_catalog.to_regprocedure('tj_preview.tj_po_ack_ingest(jsonb)') is not null then
    select p.prosrc into v_src
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure('tj_preview.tj_po_ack_ingest(jsonb)');
    if v_src like '%v_business_po_id%' then
      execute 'alter function tj_preview.tj_po_ack_ingest(jsonb) rename to tj_po_ack_ingest_v1_internal';
    end if;
  end if;
end
$rename$;

do $verify$
begin
  if pg_catalog.to_regprocedure('tj_preview.tj_po_ack_ingest_v1_internal(jsonb)') is null then
    raise exception 'ACK v1 主体缺失：tj_po_ack_ingest_v1_internal(jsonb) 不存在，请先应用 20261116_po_done_ack_preview.sql';
  end if;
end
$verify$;

revoke all on function tj_preview.tj_po_ack_ingest_v1_internal(jsonb) from public;
revoke all on function tj_preview.tj_po_ack_ingest_v1_internal(jsonb) from anon;
revoke all on function tj_preview.tj_po_ack_ingest_v1_internal(jsonb) from authenticated;
revoke all on function tj_preview.tj_po_ack_ingest_v1_internal(jsonb) from service_role;

-- D.2 确定性 event_id（与 Windows Stage23 客户端逐字节一致；客户端提供大写 hash）
create or replace function tj_preview.tj_po_ack_event_id(
  p_po_id text,
  p_source_sha256 text,
  p_irs_po_no text
)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select 'tj.po.queue.done.v1.' || pg_catalog.encode(
    extensions.digest(
      'TJ_QUEUE_DONE_V1|' || coalesce(p_po_id, '') || '|' ||
      pg_catalog.upper(coalesce(p_source_sha256, '')) || '|' || coalesce(p_irs_po_no, ''),
      'sha256'
    ),
    'hex'
  )
$fn$;

-- D.3 幂等指纹（与 v1 主体逐字节一致；wrapper 在委派前的拒绝也要写同一指纹）
create or replace function tj_preview.tj_po_ack_fingerprint(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select tj_preview.tj_po_ack_sha256(
    coalesce(nullif(btrim(p_payload ->> 'business_po_id'), ''), '') || '|' ||
    coalesce(nullif(btrim(p_payload ->> 'po_id'), ''), '') || '|' ||
    coalesce(nullif(btrim(p_payload ->> 'source_sha256'), ''), '') || '|' ||
    coalesce(nullif(btrim(p_payload ->> 'queue_done_sha256'), ''), '') || '|' ||
    coalesce(nullif(btrim(p_payload ->> 'irs_po_number'), ''), '') || '|' ||
    coalesce(nullif(btrim(p_payload ->> 'verification'), ''), '') || '|' ||
    case
      when pg_catalog.jsonb_typeof(p_payload -> 'queue_done_ack') = 'boolean'
           and (p_payload -> 'queue_done_ack') = 'true'::jsonb then '1'
      else '0'
    end || '|' ||
    coalesce(p_payload ->> 'queue_folder', '') || '|' ||
    coalesce(nullif(btrim(p_payload ->> 'ledger_state'), ''), '')
  )
$fn$;

-- D.4 统一业务拒绝落库（receipt + audit，HTTP 200 语义；绝不返回 accepted=true）
create or replace function tj_preview.tj_po_ack_reject(
  p_event_id text,
  p_fingerprint text,
  p_code text,
  p_po_header_id uuid,
  p_po_id text,
  p_irs text,
  p_payload jsonb,
  p_actor uuid,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_receipt_id uuid;
begin
  insert into tj_preview.tj_po_ack_receipts
    (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
  values (p_event_id, p_fingerprint, p_po_header_id, p_po_id, 'needs_review', p_code, p_irs,
          pg_catalog.jsonb_build_object('reason', p_code, 'detail', coalesce(p_detail, '{}'::jsonb), 'payload', p_payload),
          p_actor)
  returning id into v_receipt_id;

  insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
  values (p_event_id, 'reject', p_code, p_actor, coalesce(p_detail, '{}'::jsonb));

  return pg_catalog.jsonb_build_object(
    'accepted', false, 'replayed', false, 'rejected', true,
    'state', 'needs_review', 'code', p_code,
    'receipt_id', v_receipt_id, 'po_id', p_po_id, 'irs_po_number', p_irs
  );
end
$fn$;

/**
 * tj_po_ack_ingest —— 标准 ACK 入口（Stage25 强化版）。
 *
 * 强化点（在委派 v1 主体之前完成，失败绝不伪造成功）：
 *  1. 调用者必须是 active executor/admin worker（沿用 v1 成员表）；
 *  2. schema / event_id 结构校验；
 *  3. event_id 必须等于 sha256('TJ_QUEUE_DONE_V1|po_id|UPPER(source_sha256)|irs') 推导值
 *     —— 只校验 hex 格式不够，必须证明是 Stage23 客户端的确定性事件；
 *  4. IRS 号必须形如 ^PO[0-9]{8}$；
 *  5. verification=MANUAL_POSTSAVE_VERIFIED、queue_folder=Done、ledger_state=SAVED_VERIFIED_QUEUE_DONE；
 *  6. source_sha256 / queue_done_sha256 均为 64hex 且相等；
 *  7. 对应投递意图必须是 windows_bridge_v1 且存在 windows_received 收件证据、哈希一致
 *     （legacy_local_unverified 一律 PO_ACK_NO_WINDOWS_RECEIPT）；
 *  8. 已保存的 irs_po_no 不得被新 event 覆盖（PO_ACK_IRS_OVERWRITE）；
 *  9. event / IRS advisory lock + header row lock；同 event 同指纹仍安全 replay。
 * 其余判定（SHA 对比意图、PO 不存在、IRS 占用、落库）继续委派
 * tj_po_ack_ingest_v1_internal 处理。
 */
create or replace function tj_preview.tj_po_ack_ingest(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_event_id text;
  v_po_id text;
  v_business_po_id text;
  v_source text;
  v_queue text;
  v_irs text;
  v_verification text;
  v_queue_folder text;
  v_ledger_state text;
  v_expected_event text;
  v_fingerprint text;
  v_po tj_preview.tj_po_headers%rowtype;
  v_intent tj_preview.tj_po_push_intents%rowtype;
  v_receipt tj_preview.tj_po_ack_receipts%rowtype;
  v_evidence_sha text;
begin
  v_uid := tj_preview.tj_po_ack_require_worker();

  if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_INVALID_PAYLOAD', 'p_payload 必须是 JSON 对象');
  end if;
  if (p_payload ->> 'schema') is distinct from 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_INVALID_SCHEMA', 'schema 必须是 TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1');
  end if;

  v_event_id := nullif(btrim(coalesce(p_payload ->> 'event_id', '')), '');
  if v_event_id is null or v_event_id !~ '^tj\.po\.queue\.done\.v1\.[0-9a-fA-F]{8,}$' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_INVALID_EVENT_ID', 'event_id 必须是 tj.po.queue.done.v1.<hex>（确定性幂等 ID）');
  end if;

  v_business_po_id := nullif(btrim(coalesce(p_payload ->> 'business_po_id', '')), '');
  v_po_id := nullif(btrim(coalesce(p_payload ->> 'po_id', '')), '');
  v_source := nullif(btrim(coalesce(p_payload ->> 'source_sha256', '')), '');
  v_queue := nullif(btrim(coalesce(p_payload ->> 'queue_done_sha256', '')), '');
  v_irs := nullif(btrim(coalesce(p_payload ->> 'irs_po_number', '')), '');
  v_verification := nullif(btrim(coalesce(p_payload ->> 'verification', '')), '');
  v_queue_folder := nullif(btrim(coalesce(p_payload ->> 'queue_folder', '')), '');
  v_ledger_state := nullif(btrim(coalesce(p_payload ->> 'ledger_state', '')), '');

  v_fingerprint := tj_preview.tj_po_ack_fingerprint(p_payload);

  -- 结构校验（硬错误：客户端 bug，不写账本，修正后可用同一确定性 event 重试）
  if v_irs is null or v_irs !~ '^PO[0-9]{8}$' then
    perform tj_preview.tj_po_ack_fail(
      'PO_ACK_INVALID_IRS',
      'irs_po_number 必须形如 PO26000784（^PO[0-9]{8}$）',
      pg_catalog.jsonb_build_object('irs_po_number', v_irs)
    );
  end if;
  if v_verification is distinct from 'MANUAL_POSTSAVE_VERIFIED' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_VERIFICATION_REQUIRED', 'verification 必须是 MANUAL_POSTSAVE_VERIFIED');
  end if;
  if v_queue_folder is distinct from 'Done' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_QUEUE_FOLDER_REQUIRED', 'queue_folder 必须是 Done');
  end if;
  if v_ledger_state is distinct from 'SAVED_VERIFIED_QUEUE_DONE' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_LEDGER_STATE_REQUIRED', 'ledger_state 必须是 SAVED_VERIFIED_QUEUE_DONE');
  end if;
  if v_source is null or v_source !~ '^[0-9a-fA-F]{64}$'
     or v_queue is null or v_queue !~ '^[0-9a-fA-F]{64}$'
     or lower(v_source) <> lower(v_queue) then
    perform tj_preview.tj_po_ack_fail(
      'PO_ACK_SHA_MISMATCH',
      'source_sha256 / queue_done_sha256 必须是同一份导出文件的 64 位 hex sha256',
      pg_catalog.jsonb_build_object('source_sha256', v_source, 'queue_done_sha256', v_queue)
    );
  end if;
  if v_po_id is null then
    perform tj_preview.tj_po_ack_fail('PO_ACK_PO_NOT_FOUND', '缺少 po_id / business_po_id');
  end if;

  -- 确定性 event_id：Stage23 客户端算法的服务端复核
  v_expected_event := tj_preview.tj_po_ack_event_id(v_po_id, v_source, v_irs);
  if lower(v_event_id) <> v_expected_event then
    perform tj_preview.tj_po_ack_fail(
      'PO_ACK_EVENT_ID_MISMATCH',
      'event_id 不是由 po_id + UPPER(source_sha256) + irs_po_number 推导的确定性事件',
      pg_catalog.jsonb_build_object('claimed', v_event_id, 'expected', v_expected_event)
    );
  end if;

  -- event 单元锁 + IRS 单元锁：并发 ACK 不得交叉写同一事件/号码
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tj_po_ack_event:' || lower(v_event_id), 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tj_po_ack_irs:' || v_irs, 0)
  );

  -- 幂等：同 event 同指纹 → replay（不新增回执）；不同指纹 → 冲突
  select * into v_receipt from tj_preview.tj_po_ack_receipts where event_id = v_event_id;
  if found then
    if v_receipt.content_sha256 = v_fingerprint then
      insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
      values (v_event_id, 'replay', 'PO_ACK_REPLAY', v_uid,
              pg_catalog.jsonb_build_object('receipt_id', v_receipt.id, 'state', v_receipt.state, 'via', 'stage25_wrapper'));
      return pg_catalog.jsonb_build_object(
        'accepted', (v_receipt.state = 'accepted'),
        'replayed', true, 'rejected', false,
        'state', v_receipt.state, 'code', 'PO_ACK_REPLAY',
        'receipt_id', v_receipt.id, 'po_id', v_receipt.po_id,
        'irs_po_number', v_receipt.irs_po_number
      );
    end if;
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', 'PO_ACK_CONFLICT', v_uid,
            pg_catalog.jsonb_build_object('receipt_id', v_receipt.id, 'prev_state', v_receipt.state, 'via', 'stage25_wrapper'));
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'replayed', false, 'rejected', true,
      'state', 'rejected', 'code', 'PO_ACK_CONFLICT', 'receipt_id', v_receipt.id
    );
  end if;

  -- header 行锁（未找到则交给 v1 主体记录 PO_NOT_FOUND）
  select * into v_po from tj_preview.tj_po_headers where po_id = v_po_id limit 1 for update;
  if not found then
    return tj_preview.tj_po_ack_ingest_v1_internal(p_payload);
  end if;

  -- 已保存的 IRS 号不得被新 event 覆盖
  if v_po.irs_po_no is not null and btrim(v_po.irs_po_no) <> '' then
    if btrim(v_po.irs_po_no) = v_irs then
      -- 同 PO 同 IRS 已保存：若已有 accepted 回执则按 replay 返回，不重复写账本
      select * into v_receipt from tj_preview.tj_po_ack_receipts
       where po_header_id = v_po.id and state = 'accepted' and irs_po_number = v_irs
       order by received_at desc limit 1;
      if found then
        insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
        values (v_event_id, 'replay', 'PO_ACK_REPLAY', v_uid,
                pg_catalog.jsonb_build_object('receipt_id', v_receipt.id, 'state', v_receipt.state,
                  'reason', 'header 已保存同一 IRS 号'));
        return pg_catalog.jsonb_build_object(
          'accepted', true, 'replayed', true, 'rejected', false,
          'state', v_receipt.state, 'code', 'PO_ACK_REPLAY',
          'receipt_id', v_receipt.id, 'po_id', v_receipt.po_id,
          'irs_po_number', v_receipt.irs_po_number
        );
      end if;
    else
      return tj_preview.tj_po_ack_reject(
        v_event_id, v_fingerprint, 'PO_ACK_IRS_OVERWRITE', v_po.id, v_po.po_id, v_irs, p_payload, v_uid,
        pg_catalog.jsonb_build_object('header_irs_po_no', v_po.irs_po_no, 'payload_irs_po_number', v_irs)
      );
    end if;
  end if;

  -- 人工对账通道优先：同一 PO 已由 manual_reconcile 落账时，标准 ACK 不得改写其证据
  if coalesce(v_po.erp_status, 'none') = 'saved_verified_manual_reconciliation' then
    return tj_preview.tj_po_ack_reject(
      v_event_id, v_fingerprint, 'PO_ACK_MANUAL_RECONCILED', v_po.id, v_po.po_id, v_irs, p_payload, v_uid,
      pg_catalog.jsonb_build_object('erp_status', v_po.erp_status,
        'reason', '该 PO 已由人工历史对账通道落账，标准 ACK 不得覆盖')
    );
  end if;

  -- 收件证据链：必须 windows_bridge_v1 + delivered + windows_received 哈希一致
  select * into v_intent from tj_preview.tj_po_push_intents i
   where i.po_header_id = v_po.id
   order by i.updated_at desc limit 1;
  if not found then
    return tj_preview.tj_po_ack_ingest_v1_internal(p_payload);
  end if;

  if coalesce(v_intent.delivery_channel, 'legacy_local_unverified') <> 'windows_bridge_v1' then
    return tj_preview.tj_po_ack_reject(
      v_event_id, v_fingerprint, 'PO_ACK_NO_WINDOWS_RECEIPT', v_po.id, v_po.po_id, v_irs, p_payload, v_uid,
      pg_catalog.jsonb_build_object('delivery_channel', v_intent.delivery_channel,
        'reason', 'legacy_local_unverified 投递没有 Windows 收件证据，不得作为标准 ACK 依据')
    );
  end if;

  if v_intent.state <> 'delivered' then
    -- 交由 v1 主体给出既有语义（PO_ACK_NO_PUSH_DELIVERY / needs_review）
    return tj_preview.tj_po_ack_ingest_v1_internal(p_payload);
  end if;

  select lower(e.xlsx_sha256) into v_evidence_sha
    from tj_preview.tj_po_push_delivery_evidence e
   where e.intent_id = v_intent.id and e.stage = 'windows_received';
  if not found or v_evidence_sha is distinct from lower(v_source) then
    return tj_preview.tj_po_ack_reject(
      v_event_id, v_fingerprint, 'PO_ACK_NO_WINDOWS_RECEIPT', v_po.id, v_po.po_id, v_irs, p_payload, v_uid,
      pg_catalog.jsonb_build_object('intent_id', v_intent.id,
        'windows_received_sha256', v_evidence_sha, 'payload_source_sha256', v_source,
        'reason', '缺少 windows_received 收件证据或哈希不一致')
    );
  end if;

  -- 委托已验证的 v1 主体：标准 SHA 对比、幂等、落库与 header 写回
  return tj_preview.tj_po_ack_ingest_v1_internal(p_payload);
end
$fn$;

revoke all on function tj_preview.tj_po_ack_ingest(jsonb) from public;
revoke all on function tj_preview.tj_po_ack_ingest(jsonb) from anon;
grant execute on function tj_preview.tj_po_ack_ingest(jsonb) to authenticated;

revoke all on function tj_preview.tj_po_ack_event_id(text, text, text) from public;
revoke all on function tj_preview.tj_po_ack_event_id(text, text, text) from anon;
revoke all on function tj_preview.tj_po_ack_event_id(text, text, text) from authenticated;
revoke all on function tj_preview.tj_po_ack_fingerprint(jsonb) from public;
revoke all on function tj_preview.tj_po_ack_fingerprint(jsonb) from anon;
revoke all on function tj_preview.tj_po_ack_fingerprint(jsonb) from authenticated;
revoke all on function tj_preview.tj_po_ack_reject(text, text, text, uuid, text, text, jsonb, uuid, jsonb) from public;
revoke all on function tj_preview.tj_po_ack_reject(text, text, text, uuid, text, text, jsonb, uuid, jsonb) from anon;
revoke all on function tj_preview.tj_po_ack_reject(text, text, text, uuid, text, text, jsonb, uuid, jsonb) from authenticated;

-- ============================================================================
-- 回滚（需要时手动执行；只影响本包新增对象）
-- ============================================================================
-- drop function if exists tj_preview.tj_po_ack_ingest(jsonb);
-- alter function tj_preview.tj_po_ack_ingest_v1_internal(jsonb) rename to tj_po_ack_ingest;
-- grant execute on function tj_preview.tj_po_ack_ingest(jsonb) to authenticated;
-- drop function if exists tj_preview.tj_po_ack_reject(text, text, text, uuid, text, text, jsonb, uuid, jsonb);
-- drop function if exists tj_preview.tj_po_ack_fingerprint(jsonb);
-- drop function if exists tj_preview.tj_po_ack_event_id(text, text, text);
-- drop function if exists tj_preview.tj_po_manual_reconcile(jsonb);
-- drop function if exists tj_preview.tj_manual_amount(text, text);
-- drop function if exists tj_preview.tj_manual_json(text, text);
-- drop function if exists tj_preview.tj_manual_text(jsonb, text);
-- drop table if exists tj_preview.tj_po_manual_reconciliations;
-- drop trigger if exists trg_tj_po_push_intent_delivery_guard on tj_preview.tj_po_push_intents;
-- drop function if exists tj_preview.tj_po_push_intent_delivery_guard();
-- drop table if exists tj_preview.tj_po_push_delivery_evidence;
-- alter table tj_preview.tj_po_push_intents drop column if exists delivery_channel;
-- drop function if exists tj_preview.tj_po_preview_request_push(uuid, text);
-- drop function if exists tj_preview.tj_po_preview_require_staff();
-- drop table if exists tj_preview.tj_po_preview_push_requests;
