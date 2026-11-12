-- ============================================================================
-- TJ-AI-Ops — Combined PO 上线前修正（生产 public）
-- 文件名：20261112_prelaunch_guards.sql
--
-- 【状态：PREPARED ONLY，未应用】
--   * 本文件只针对 public（生产）schema，不会碰 tj_preview；没有任何语句引用 tj_preview。
--   * public 必须由用户单独授权后才能应用。当前生产 cron 每分钟 exec 推送器，
--     推送器已由代码侧冻结，本迁移只是数据库级兜底。
--   * tj_preview 的同一组对象 + 预览库推送总闸见
--     20261112_prelaunch_guards_preview.sql（该文件可单独应用，不动 public）。
--   * 全部 additive：只加列 / 约束 / 触发器，不删列、不改类型、不重写既有数据。
--   * 幂等：重复执行安全（IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS）。
--   * 刻意不写 begin/commit，便于在事务中试跑后 ROLLBACK。
--
-- 覆盖：1) 日期/IRS 验证列  2) 合并单日期硬约束  3) 推送防绕过
--       4) 冻结 header 整行不可改/不可删  5) 冻结明细不可增/改/删（old/new 双 parent）
--       6) IRS 编号防伪（必须有验证证据）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 新列
--    website_po_date：开单/核对人显式选择的业务日期，date 类型（无时区歧义）。
--      合并单在 pending_approval 前必须有值；缺失时由触发器/CHECK 拒绝推进，
--      绝不回退 created_at / received_at / approved_at，也不默认当天。
--    irs_*_verified_at / _by：IRS 编号验证证据；没有证据时导出留空。
--    刻意不加 NOT NULL / DEFAULT：既有单据（含已冻结合并单）不因迁移被改写。
-- ----------------------------------------------------------------------------
alter table public.tj_po_headers add column if not exists website_po_date date;
alter table public.tj_po_headers add column if not exists irs_po_no_verified_at timestamptz;
alter table public.tj_po_headers add column if not exists irs_po_no_verified_by text;
alter table public.tj_po_headers add column if not exists irs_grn_no_verified_at timestamptz;
alter table public.tj_po_headers add column if not exists irs_grn_no_verified_by text;
-- approval_snapshot_version：批准摘要算法版本（2 = DB header+lines 的 v2 快照）。
--   刻意 nullable、无 DEFAULT、不回填：既有已冻结单（v1 浏览器摘要）保持原样，
--   导出时按「缺版本 = 旧摘要，只允许内部 review」处理，不冒充已校验批准快照。
alter table public.tj_po_headers add column if not exists approval_snapshot_version integer;

-- ----------------------------------------------------------------------------
-- 2) 合并单日期硬约束（数据库级，应用层/直连 REST 都绕不过）
--    只限制 combined 进入 pending_approval / confirmed 时必须已有日期；
--    draft 允许暂时为空（但 API 建单时已要求先填）。
--    NOT VALID：不校验历史行（例如迁移前已存在、缺日期的冻结合并单保持不动），
--    但 INSERT / UPDATE 的新值必须满足。
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'tj_po_headers'
      and c.conname = 'tj_po_combined_requires_date'
  ) then
    alter table public.tj_po_headers
      add constraint tj_po_combined_requires_date
      check (
        po_type <> 'combined'
        or status not in ('pending_approval', 'confirmed')
        or website_po_date is not null
      ) not valid;
  end if;
end $$;

-- 友好错误信息版（CHECK 仍是硬约束，本触发器让操作员看到原因）
create or replace function public.tj_po_combined_date_guard() returns trigger
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

drop trigger if exists trg_tj_po_combined_date_guard on public.tj_po_headers;
create trigger trg_tj_po_combined_date_guard
  before insert or update of status, website_po_date, po_type on public.tj_po_headers
  for each row execute function public.tj_po_combined_date_guard();

-- ----------------------------------------------------------------------------
-- 3) 推送防绕过：combined 永久冻结 + 来源单按关系拦截（不看 status）
--    应用层 requestPush / 列表 UI / 推送器已拦截；这里兜住直连 REST 改 status。
-- ----------------------------------------------------------------------------
create or replace function public.tj_po_push_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $body$
declare
  v_owner text;
begin
  -- 合并单永久冻结：任何路径都不得进入 pending_push / exported
  if new.po_type = 'combined' and new.status in ('pending_push', 'exported') then
    raise exception 'combined PO % 永久冻结推送（status=%）', new.po_id, new.status
      using errcode = 'check_violation';
  end if;

  -- 来源单：按 source_po_ids 关系拦截，与 status 无关（改回 confirmed 也不能绕过）
  if new.status in ('pending_push', 'exported') then
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

  return new;
end
$body$;

drop trigger if exists trg_tj_po_push_guard on public.tj_po_headers;
create trigger trg_tj_po_push_guard
  before insert or update of status, po_type on public.tj_po_headers
  for each row execute function public.tj_po_push_guard();

-- ----------------------------------------------------------------------------
-- 4) 冻结 header 整行不可改、不可删
--    以 OLD.frozen 为准：只要更新前已冻结，就不允许 unfreeze / 改 po_type /
--    改 source_po_ids / 改 website_po_date / 改 source_sha256 / 改 approved_* /
--    甚至只改 updated_at。唯一允许的是完全相同的 UPDATE（no-op）。
--    另外：combined 一旦 status=confirmed，日期单独再校验一次（防止异常清空 frozen）。
-- ----------------------------------------------------------------------------
create or replace function public.tj_po_header_frozen_guard() returns trigger
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

drop trigger if exists trg_tj_po_header_frozen_guard on public.tj_po_headers;
create trigger trg_tj_po_header_frozen_guard
  before update or delete on public.tj_po_headers
  for each row execute function public.tj_po_header_frozen_guard();

-- ----------------------------------------------------------------------------
-- 5) 冻结明细不可增/改/删
--    UPDATE 必须同时检查 OLD 和 NEW 的 parent：把行"搬走"到另一张单时，
--    OLD parent 冻结同样拒绝；同时 NEW parent 冻结也拒绝（双向）。
-- ----------------------------------------------------------------------------
create or replace function public.tj_po_lines_frozen_guard() returns trigger
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

drop trigger if exists trg_tj_po_lines_frozen_guard on public.tj_po_lines;
create trigger trg_tj_po_lines_frozen_guard
  before insert or update or delete on public.tj_po_lines
  for each row execute function public.tj_po_lines_frozen_guard();

-- ----------------------------------------------------------------------------
-- 6) IRS 编号防伪：irs_po_no / irs_grn_no 必须有该编号自己的验证证据
--    证据 = verified_at（timestamptz）+ verified_by（非空文本）都齐。
--    不按编号内容（长度/前缀/具体数字）判断真伪 —— 任何具体数字都不是规则。
--    清空证据但保留编号同样被拒绝（不留"已发布但无证据"的编号）。
-- ----------------------------------------------------------------------------
create or replace function public.tj_po_irs_guard() returns trigger
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

drop trigger if exists trg_tj_po_irs_guard on public.tj_po_headers;
create trigger trg_tj_po_irs_guard
  before insert or update of
    irs_po_no, irs_po_no_verified_at, irs_po_no_verified_by,
    irs_grn_no, irs_grn_no_verified_at, irs_grn_no_verified_by
  on public.tj_po_headers
  for each row execute function public.tj_po_irs_guard();

-- ----------------------------------------------------------------------------
-- 回滚（需要时手动执行；新列一旦有业务数据，不要回滚 DROP COLUMN）
-- ----------------------------------------------------------------------------
-- drop trigger if exists trg_tj_po_push_guard on public.tj_po_headers;
-- drop trigger if exists trg_tj_po_combined_date_guard on public.tj_po_headers;
-- drop trigger if exists trg_tj_po_header_frozen_guard on public.tj_po_headers;
-- drop trigger if exists trg_tj_po_irs_guard on public.tj_po_headers;
-- drop trigger if exists trg_tj_po_lines_frozen_guard on public.tj_po_lines;
-- alter table public.tj_po_headers drop constraint if exists tj_po_combined_requires_date;
-- drop function if exists public.tj_po_push_guard();
-- drop function if exists public.tj_po_combined_date_guard();
-- drop function if exists public.tj_po_header_frozen_guard();
-- drop function if exists public.tj_po_irs_guard();
-- drop function if exists public.tj_po_lines_frozen_guard();
