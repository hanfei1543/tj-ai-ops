-- ============================================================================
-- TJ-AI-Ops — Combined PO 上线前修正（隔离预览 tj_preview）
-- 文件名：20261112_prelaunch_guards_preview.sql
--
-- 【状态：PREPARED ONLY，由主脑在 tj_preview 单独应用；绝不动 public】
--   * 本文件没有任何 public.* 语句；只操作 tj_preview。
--   * 与 public 版的区别：预览库额外加「推送总闸」——
--     tj_preview 中任何单据（包括普通测试 PO）都不得进入 pending_push / exported，
--     即使未来 Preview 被错误接线到真实推送器，也进不了 Windows Queue。
--   * 普通业务 CRUD（建单/改单/明细/日期/审批）在预览库照常可用，用 mock Queue 验证。
--   * 全部 additive + 幂等；刻意不写 begin/commit，便于 SQL 编辑器里显式事务回滚。
-- ============================================================================

alter table tj_preview.tj_po_headers add column if not exists website_po_date date;
alter table tj_preview.tj_po_headers add column if not exists irs_po_no_verified_at timestamptz;
alter table tj_preview.tj_po_headers add column if not exists irs_po_no_verified_by text;
alter table tj_preview.tj_po_headers add column if not exists irs_grn_no_verified_at timestamptz;
alter table tj_preview.tj_po_headers add column if not exists irs_grn_no_verified_by text;
-- approval_snapshot_version：批准摘要算法版本（2 = DB header+lines 的 v2 快照）。
--   nullable、无 DEFAULT、不回填：既有已冻结单（v1 摘要）保持原状，导出时按
--   「缺版本 = 旧摘要，只允许内部 review」处理。
alter table tj_preview.tj_po_headers add column if not exists approval_snapshot_version integer;

-- 合并单日期硬约束（NOT VALID：既有缺日期冻结合并单保持不动；新写入必须满足）
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'tj_preview'
      and t.relname = 'tj_po_headers'
      and c.conname = 'tj_po_combined_requires_date'
  ) then
    alter table tj_preview.tj_po_headers
      add constraint tj_po_combined_requires_date
      check (
        po_type <> 'combined'
        or status not in ('pending_approval', 'confirmed')
        or website_po_date is not null
      ) not valid;
  end if;
end $$;

create or replace function tj_preview.tj_po_combined_date_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
begin
  if new.po_type = 'combined'
     and new.status in ('pending_approval', 'confirmed')
     and new.website_po_date is null then
    raise exception '合并单 % 不能进入 %：缺少 Website PO Date（必须由开单/核对人显式选择，不默认当天）',
      new.po_id, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end
$body$;

drop trigger if exists trg_tj_po_combined_date_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_combined_date_guard
  before insert or update of status, website_po_date, po_type on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_combined_date_guard();

-- ----------------------------------------------------------------------------
-- 预览库推送总闸：所有 pending_push / exported 一律拒绝（含普通测试单）。
-- 未来 Preview 若被错误接到真实推送器/桥，数据库层也进不了 Queue。
-- combined 永久冻结与来源关系拦截仍保留更具体的错误信息。
-- ----------------------------------------------------------------------------
create or replace function tj_preview.tj_po_push_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
declare
  v_owner text;
begin
  if new.status in ('pending_push', 'exported') then
    -- 先给更具体的拒绝原因，最终都落到同一条总闸
    if new.po_type = 'combined' then
      raise exception 'combined PO % 永久冻结推送（status=%）', new.po_id, new.status
        using errcode = 'check_violation';
    end if;

    if new.status = 'pending_push' then
      execute pg_catalog.format(
        'select h.po_id from %I.tj_po_headers h '
        'where h.po_type = %L and %L = any(h.source_po_ids) limit 1',
        tg_table_schema, 'combined', new.po_id)
        into v_owner;
      if v_owner is not null then
        raise exception 'PO % 已并入合并单 %，禁止单独推送', new.po_id, v_owner
          using errcode = 'check_violation';
      end if;
    end if;

    raise exception '预览隔离库（tj_preview）禁止推送：% 不得进入 %（所有单据一律拒绝，含普通测试单）',
      new.po_id, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end
$body$;

drop trigger if exists trg_tj_po_push_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_push_guard
  before insert or update of status, po_type on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_push_guard();

-- 冻结 header 整行不可改、不可删（OLD.frozen 为准）
create or replace function tj_preview.tj_po_header_frozen_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
begin
  if tg_op = 'DELETE' then
    if coalesce(old.frozen, false) then
      raise exception '已批准冻结的 PO 不可删除（po_id=%）', old.po_id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if coalesce(old.frozen, false) and row(new.*) is distinct from row(old.*) then
    raise exception '已批准冻结的 PO 整行不可修改（po_id=%）：不能解冻/改类型/改来源/改日期/改摘要/改审批字段',
      old.po_id
      using errcode = 'check_violation';
  end if;

  if old.po_type = 'combined'
     and old.status = 'confirmed'
     and new.website_po_date is distinct from old.website_po_date then
    raise exception '合并单 % 批准后 Website PO Date 已冻结，不可修改', old.po_id
      using errcode = 'check_violation';
  end if;

  return new;
end
$body$;

drop trigger if exists trg_tj_po_header_frozen_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_header_frozen_guard
  before update or delete on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_header_frozen_guard();

-- 冻结明细不可增/改/删（UPDATE 同时检查 OLD 与 NEW parent）
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
    execute pg_catalog.format(
      'select h.frozen from %I.tj_po_headers h where h.id = $1', tg_table_schema)
      into v_old_frozen using old.po_header_id;
    if coalesce(v_old_frozen, false) then
      raise exception '已批准冻结的 PO 明细不可增/改/删（old po_header_id=%）', old.po_header_id
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    execute pg_catalog.format(
      'select h.frozen from %I.tj_po_headers h where h.id = $1', tg_table_schema)
      into v_new_frozen using new.po_header_id;
    if coalesce(v_new_frozen, false) then
      raise exception '已批准冻结的 PO 明细不可增/改/删（new po_header_id=%）', new.po_header_id
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$body$;

drop trigger if exists trg_tj_po_lines_frozen_guard on tj_preview.tj_po_lines;
create trigger trg_tj_po_lines_frozen_guard
  before insert or update or delete on tj_preview.tj_po_lines
  for each row execute function tj_preview.tj_po_lines_frozen_guard();

-- IRS 编号防伪：必须有 verified_at + verified_by 证据
create or replace function tj_preview.tj_po_irs_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
begin
  if new.irs_po_no is not null and btrim(new.irs_po_no) <> '' then
    if new.irs_po_no_verified_at is null
       or coalesce(btrim(new.irs_po_no_verified_by), '') = '' then
      raise exception 'irs_po_no 写入被拒绝：缺少 verified_at / verified_by 验证证据（po_id=%）',
        new.po_id using errcode = 'check_violation';
    end if;
  end if;

  if new.irs_grn_no is not null and btrim(new.irs_grn_no) <> '' then
    if new.irs_grn_no_verified_at is null
       or coalesce(btrim(new.irs_grn_no_verified_by), '') = '' then
      raise exception 'irs_grn_no 写入被拒绝：缺少 verified_at / verified_by 验证证据（po_id=%）',
        new.po_id using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$body$;

drop trigger if exists trg_tj_po_irs_guard on tj_preview.tj_po_headers;
create trigger trg_tj_po_irs_guard
  before insert or update of
    irs_po_no, irs_po_no_verified_at, irs_po_no_verified_by,
    irs_grn_no, irs_grn_no_verified_at, irs_grn_no_verified_by
  on tj_preview.tj_po_headers
  for each row execute function tj_preview.tj_po_irs_guard();

-- ----------------------------------------------------------------------------
-- 回滚（仅预览库）
-- ----------------------------------------------------------------------------
-- drop trigger if exists trg_tj_po_push_guard on tj_preview.tj_po_headers;
-- drop trigger if exists trg_tj_po_combined_date_guard on tj_preview.tj_po_headers;
-- drop trigger if exists trg_tj_po_header_frozen_guard on tj_preview.tj_po_headers;
-- drop trigger if exists trg_tj_po_irs_guard on tj_preview.tj_po_headers;
-- drop trigger if exists trg_tj_po_lines_frozen_guard on tj_preview.tj_po_lines;
-- alter table tj_preview.tj_po_headers drop constraint if exists tj_po_combined_requires_date;
-- drop function if exists tj_preview.tj_po_push_guard();
-- drop function if exists tj_preview.tj_po_combined_date_guard();
-- drop function if exists tj_preview.tj_po_header_frozen_guard();
-- drop function if exists tj_preview.tj_po_irs_guard();
-- drop function if exists tj_preview.tj_po_lines_frozen_guard();
