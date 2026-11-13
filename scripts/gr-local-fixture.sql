-- ============================================================================
-- 本地 harness 专用：模拟 tj_preview 的既有环境（不是生产、不是测试库凭据）
-- 仅由 scripts/gr-local-smoke.mjs 在内存 Postgres(WASM/PGlite) 中执行。
-- 目的：让 20261113_gr_unified_preview.sql 与集成 SQL 可以在本地真实执行一次，
--       捕获语法/plpgsql/权限/RLS 错误。**不要**对真实 Supabase 执行本文件：
--       它会在本库创建 role/表，真实环境这些对象已经存在。
-- 结构按 20261112_* 迁移与 docs/tj-po-system.md 复刻（仅用于恒等回归）。
-- ============================================================================

create schema if not exists auth;
create schema if not exists extensions;

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then create role service_role; end if;
end
$roles$;

-- Supabase auth.uid() 的最小复刻（只读 request.jwt.claim.sub）
create or replace function auth.uid() returns uuid
language sql stable
as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

-- 生产是 pgcrypto 装在 extensions schema；PGlite 无扩展 → 用内置 sha256 复刻
create or replace function extensions.digest(p_text text, p_algo text) returns bytea
language sql immutable
as $fn$
  select case
    when lower(p_algo) = 'sha256' then sha256(convert_to(p_text, 'UTF8'))
    when lower(p_algo) = 'md5' then decode(md5(p_text), 'hex')
    else null
  end
$fn$;

create schema if not exists tj_preview;

create table if not exists tj_preview.tj_suppliers (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text
);

create table if not exists tj_preview.tj_items (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  description text,
  uom text,
  cost numeric,
  selling_price numeric
);

create table if not exists tj_preview.tj_po_headers (
  id uuid primary key default gen_random_uuid(),
  po_seq bigint generated always as identity,
  po_id text unique,
  supplier_code text not null,
  supplier_name text,
  status text not null default 'confirmed',
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  po_type text not null default 'standard',
  source_po_ids text[],
  po_revision integer not null default 1,
  source_sha256 text,
  delivery_order_no text,
  receipt_event_id text,
  checked_by text,
  approved_by text,
  approved_at timestamptz,
  received_at timestamptz,
  frozen boolean not null default false,
  erp_status text not null default 'none',
  irs_po_no text,
  irs_grn_no text,
  website_po_date date,
  irs_po_no_verified_at timestamptz,
  irs_po_no_verified_by text,
  irs_grn_no_verified_at timestamptz,
  irs_grn_no_verified_by text,
  approval_snapshot_version integer
);

create table if not exists tj_preview.tj_po_lines (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references tj_preview.tj_po_headers (id) on delete cascade,
  line_no integer not null default 1,
  item_code text not null,
  description text,
  uom text,
  qty numeric not null default 0,
  unit_price numeric not null default 0,
  source_po_id uuid,
  source_line_id uuid,
  original_qty numeric,
  accepted_qty numeric,
  source_refs jsonb,
  note text
);

create table if not exists tj_preview.tj_po_exports (
  id uuid primary key default gen_random_uuid(),
  po_id text,
  exported_at timestamptz not null default now()
);

create table if not exists tj_preview.tj_item_requests (
  id uuid primary key default gen_random_uuid(),
  item_code text not null,
  description text not null,
  status text not null default 'pending',
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- po_id 生成（真实库里是 tj_gen_po_id trigger，格式 PO-000001）
create or replace function tj_preview.tj_gen_po_id() returns trigger
language plpgsql
as $fn$
begin
  if new.po_id is null then
    new.po_id := 'PO-' || lpad(new.po_seq::text, 6, '0');
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_tj_gen_po_id on tj_preview.tj_po_headers;
create trigger trg_tj_gen_po_id before insert on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_gen_po_id();

-- 预览库推送总闸（与 20261112_prelaunch_guards_preview.sql 同语义）
create or replace function tj_preview.tj_po_push_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
begin
  if new.status in ('pending_push', 'exported') then
    raise exception '预览隔离库（tj_preview）禁止推送：% 不得进入 %', new.po_id, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end
$body$;

drop trigger if exists trg_tj_po_push_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_push_guard
  before insert or update of status, po_type on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_push_guard();

-- 冻结 header 整行不可改/不可删
create or replace function tj_preview.tj_po_header_frozen_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
begin
  if tg_op = 'DELETE' then
    if coalesce(old.frozen, false) then
      raise exception '已批准冻结的 PO 不可删除（po_id=%）', old.po_id using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if coalesce(old.frozen, false) and row(new.*) is distinct from row(old.*) then
    raise exception '已批准冻结的 PO 整行不可修改（po_id=%）', old.po_id using errcode = 'check_violation';
  end if;
  return new;
end
$body$;

drop trigger if exists trg_tj_po_header_frozen_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_header_frozen_guard
  before update or delete on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_header_frozen_guard();

-- 冻结明细不可增/改/删
create or replace function tj_preview.tj_po_lines_frozen_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
declare
  v_old_frozen boolean;
  v_new_frozen boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    execute pg_catalog.format('select h.frozen from %I.tj_po_headers h where h.id = $1', tg_table_schema)
      into v_old_frozen using old.po_header_id;
    if coalesce(v_old_frozen, false) then
      raise exception '已批准冻结的 PO 明细不可增/改/删（old po_header_id=%）', old.po_header_id
        using errcode = 'check_violation';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    execute pg_catalog.format('select h.frozen from %I.tj_po_headers h where h.id = $1', tg_table_schema)
      into v_new_frozen using new.po_header_id;
    if coalesce(v_new_frozen, false) then
      raise exception '已批准冻结的 PO 明细不可增/改/删（new po_header_id=%）', new.po_header_id
        using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$body$;

drop trigger if exists trg_tj_po_lines_frozen_guard on tj_preview.tj_po_lines;
create trigger trg_tj_po_lines_frozen_guard
  before insert or update or delete on tj_preview.tj_po_lines
  for each row execute function tj_preview.tj_po_lines_frozen_guard();

-- IRS 编号必须有验证证据
create or replace function tj_preview.tj_po_irs_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
begin
  if new.irs_po_no is not null and btrim(new.irs_po_no) <> '' then
    if new.irs_po_no_verified_at is null or coalesce(btrim(new.irs_po_no_verified_by), '') = '' then
      raise exception 'irs_po_no 写入被拒绝：缺少验证证据（po_id=%）', new.po_id using errcode = 'check_violation';
    end if;
  end if;
  if new.irs_grn_no is not null and btrim(new.irs_grn_no) <> '' then
    if new.irs_grn_no_verified_at is null or coalesce(btrim(new.irs_grn_no_verified_by), '') = '' then
      raise exception 'irs_grn_no 写入被拒绝：缺少验证证据（po_id=%）', new.po_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$body$;

drop trigger if exists trg_tj_po_irs_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_irs_guard
  before insert or update of irs_po_no, irs_po_no_verified_at, irs_po_no_verified_by,
    irs_grn_no, irs_grn_no_verified_at, irs_grn_no_verified_by
  on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_irs_guard();

-- 合并单必须有 Website PO Date（NOT VALID：历史行不动）
do $c$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'tj_preview' and t.relname = 'tj_po_headers'
      and c.conname = 'tj_po_combined_requires_date'
  ) then
    alter table tj_preview.tj_po_headers add constraint tj_po_combined_requires_date
      check (po_type <> 'combined' or status not in ('pending_approval','confirmed') or website_po_date is not null)
      not valid;
  end if;
end
$c$;

-- 收货事件防重复（已应用）
create unique index if not exists uq_tj_po_headers_receipt_event_id
  on tj_preview.tj_po_headers (receipt_event_id)
  where receipt_event_id is not null;

-- 既有权限状态：anon/authenticated 都有 ALL grants，RLS 只有 anon ALL 策略
grant usage on schema tj_preview to anon, authenticated;
grant all on all tables in schema tj_preview to anon, authenticated;
grant all on all sequences in schema tj_preview to anon, authenticated;

do $pol$
declare
  t text;
begin
  foreach t in array array['tj_po_headers','tj_po_lines','tj_po_exports','tj_item_requests','tj_suppliers','tj_items'] loop
    execute pg_catalog.format('alter table tj_preview.%I enable row level security', t);
    execute pg_catalog.format('drop policy if exists anon_all on tj_preview.%I', t);
    execute pg_catalog.format('create policy anon_all on tj_preview.%I for all to anon using (true) with check (true)', t);
  end loop;
end
$pol$;
