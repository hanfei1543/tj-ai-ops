-- ============================================================================
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
--        \i supabase/migrations/gr_unified_public_prepared.sql
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

-- ----------------------------------------------------------------------------
-- 0) 前置检查：只允许在预览 schema 上运行，避免误连 public 时“以为在预览”
-- ----------------------------------------------------------------------------
do $pre$
begin
  if not exists (
    select 1 from pg_catalog.pg_namespace n where n.nspname = 'public'
  ) then
    raise exception 'public schema 不存在：本文件只用于隔离预览库，不自动创建/污染生产';
  end if;
end
$pre$;

-- ----------------------------------------------------------------------------
-- 1) 表
-- ----------------------------------------------------------------------------

-- 1.1 角色成员（只在 public；真实 auth.uid()，不建 auth 用户）
create table if not exists public.tj_gr_memberships (
  user_id uuid not null,
  role text not null check (role in ('staff', 'approver', 'executor', 'admin')),
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- 1.2 收货事件
create table if not exists public.tj_gr_receipt_events (
  id uuid primary key,
  event_no text not null unique,
  revision integer not null default 0 check (revision >= 0),
  status text not null default 'draft' check (status in (
    'draft','submitted','approved','waiting_mapping','released',
    'in_progress','saved_unverified','verified','needs_review','cancelled'
  )),
  supplier_code text not null,
  supplier_name text,
  po_ids uuid[] not null check (array_length(po_ids, 1) >= 1),
  invoice_no text,
  delivery_order_no text,
  receive_date date not null,
  invoice_date date,
  checked_by text,
  note text,
  created_by uuid not null,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  allow_exceptions boolean not null default false,
  review_note text,
  released_by uuid,
  released_at timestamptz,
  payload_sha256 text,
  warnings jsonb not null default '[]'::jsonb,
  exceptions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tj_gr_events_status on public.tj_gr_receipt_events (status);
create index if not exists idx_tj_gr_events_supplier on public.tj_gr_receipt_events (supplier_code);
create index if not exists idx_tj_gr_events_po_ids on public.tj_gr_receipt_events using gin (po_ids);

-- 1.3 收货明细（客户端稳定 uuid；金额/数量 numeric(20,6) 精确）
create table if not exists public.tj_gr_receipt_lines (
  id uuid primary key,
  receipt_event_id uuid not null references public.tj_gr_receipt_events (id) on delete cascade,
  line_no integer not null check (line_no > 0),
  item_code text not null,
  description text,
  uom text,
  unit_price numeric(20,6) not null check (unit_price >= 0),
  ordered_qty numeric(20,6) not null check (ordered_qty >= 0),
  accepted_qty numeric(20,6) not null check (accepted_qty >= 0),
  note text,
  created_at timestamptz not null default now(),
  unique (receipt_event_id, line_no),
  unique (receipt_event_id, id)
);

create index if not exists idx_tj_gr_lines_event on public.tj_gr_receipt_lines (receipt_event_id);

-- 1.4 来源分配（完整 source_allocations；ordered_qty = 原始订购快照，不覆盖 PO）
create table if not exists public.tj_gr_line_sources (
  id uuid primary key default gen_random_uuid(),
  receipt_event_id uuid not null references public.tj_gr_receipt_events (id) on delete cascade,
  receipt_line_id uuid not null references public.tj_gr_receipt_lines (id) on delete cascade,
  po_header_id uuid not null,
  po_line_id uuid not null,
  ordered_qty numeric(20,6) not null check (ordered_qty >= 0),
  accepted_qty numeric(20,6) not null check (accepted_qty >= 0),
  created_at timestamptz not null default now(),
  unique (receipt_line_id, po_line_id)
);

create index if not exists idx_tj_gr_sources_event on public.tj_gr_line_sources (receipt_event_id);
create index if not exists idx_tj_gr_sources_po_line on public.tj_gr_line_sources (po_line_id);
create index if not exists idx_tj_gr_sources_po_header on public.tj_gr_line_sources (po_header_id);

-- 1.5 IRS PO 映射（独立于冻结 header：批准后也能登记真实已核对编号）
create table if not exists public.tj_gr_po_mappings (
  po_header_id uuid primary key,
  irs_po_no text not null check (btrim(irs_po_no) <> ''),
  evidence jsonb not null default '{}'::jsonb,
  verified_by uuid not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1.6 GR 任务（独立 type；环境/模拟硬约束）
create table if not exists public.tj_gr_tasks (
  id uuid primary key default gen_random_uuid(),
  task_type text not null default 'GOODS_RECEIVE' check (task_type = 'GOODS_RECEIVE'),
  schema_version text not null default 'tj.gr.v1' check (schema_version = 'tj.gr.v1'),
  environment text not null default 'preview' check (environment = 'preview'),
  mock_only boolean not null default true check (mock_only = true),
  receipt_event_id uuid not null references public.tj_gr_receipt_events (id) on delete cascade,
  event_revision integer not null,
  po_header_id uuid not null,
  irs_po_no text not null,
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_payload_sha256 text not null check (event_payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'ready' check (status in (
    'ready','claimed','save_attempted','saved_unverified','verified',
    'failed_unsaved','needs_review','cancelled'
  )),
  callback_id text,
  executor_id uuid,
  claimed_by uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  save_attempted_at timestamptz,
  saved_at timestamptz,
  verified_at timestamptz,
  bridge_ok boolean,
  evidence jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (receipt_event_id, event_revision, po_header_id)
);

create index if not exists idx_tj_gr_tasks_event on public.tj_gr_tasks (receipt_event_id);
create index if not exists idx_tj_gr_tasks_status on public.tj_gr_tasks (status);

-- 1.7 回调审计（同 id 不同内容也要留痕）
create table if not exists public.tj_gr_task_callbacks (
  id bigserial primary key,
  task_id uuid not null references public.tj_gr_tasks (id) on delete cascade,
  callback_id text not null,
  content_sha256 text not null,
  event_type text not null,
  actor uuid,
  accepted boolean not null,
  reject_code text,
  body jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index if not exists idx_tj_gr_callbacks_task on public.tj_gr_task_callbacks (task_id, callback_id);

-- 1.8 outbox（持久化后才允许模拟 dispatch；本环境只写本地 scratch）
create table if not exists public.tj_gr_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  kind text not null check (kind in ('gr_task_dispatch', 'po_push')),
  task_id uuid,
  receipt_event_id uuid,
  po_header_id uuid,
  payload jsonb not null,
  payload_sha256 text not null,
  status text not null default 'pending' check (status in ('pending','dispatched','mock_dispatched','cancelled','failed')),
  mock_only boolean not null default true,
  dispatched_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tj_gr_outbox_status on public.tj_gr_outbox (status);

-- 1.9 请求幂等记录（request_id → 首次结果）
create table if not exists public.tj_gr_requests (
  request_id text primary key,
  action text not null,
  actor uuid,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now()
);

-- 1.10 审计（权限拒绝/幂等冲突/映射/释放等）
create table if not exists public.tj_gr_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists idx_tj_gr_audit_at on public.tj_gr_audit (at);

-- ----------------------------------------------------------------------------
-- 2) 基础助手：错误 / 身份 / 角色 / 十进制 / 哈希 / 规范化
-- ----------------------------------------------------------------------------

-- 可识别错误：message 是 JSON 文本（PostgREST 原样返回，客户端 JSON.parse）
create or replace function public.tj_gr_fail(p_code text, p_message text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception using
    errcode = 'P0001',
    message = pg_catalog.jsonb_build_object(
      'code', p_code,
      'message', p_message,
      'detail', coalesce(p_detail, '{}'::jsonb)
    )::text;
end
$fn$;

create or replace function public.tj_gr_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $fn$
begin
  return auth.uid();
end
$fn$;

-- 读侧 membership（policy 里调用，必须 definer，避免 RLS 递归）
create or replace function public.tj_gr_is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.tj_gr_memberships m
    where m.user_id = auth.uid() and m.active
  )
$fn$;

create or replace function public.tj_gr_roles()
returns text[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(m.role order by m.role), '{}'::text[])
  from public.tj_gr_memberships m
  where m.user_id = auth.uid() and m.active
$fn$;

-- 角色门禁：p_roles 内任一角色或 admin；无 JWT/无 membership 分别报错
create or replace function public.tj_gr_require_role(p_roles text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_roles text[];
begin
  if v_uid is null then
    perform public.tj_gr_fail('GR_AUTH_REQUIRED', '需要真实登录用户（auth.uid() 为空）');
  end if;

  v_roles := public.tj_gr_roles();
  if coalesce(array_length(v_roles, 1), 0) = 0 then
    perform public.tj_gr_fail('GR_NOT_MEMBER', '当前用户没有 public 收货角色授权');
  end if;

  if not (v_roles && p_roles) and not ('admin' = any (v_roles)) then
    perform public.tj_gr_fail(
      'GR_FORBIDDEN',
      pg_catalog.format('需要角色 %s，当前角色 %s', array_to_string(p_roles, '/'), array_to_string(v_roles, '/')),
      pg_catalog.jsonb_build_object('required', to_jsonb(p_roles), 'actual', to_jsonb(v_roles))
    );
  end if;

  return v_uid;
end
$fn$;

-- 十进制入参：只接受十进制文本（或 JSON number），拒绝指数/负数/空值/超 6 位小数
create or replace function public.tj_gr_dec(p_value jsonb, p_field text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_type text;
  v_text text;
begin
  if p_value is null then
    perform public.tj_gr_fail('GR_INVALID_DECIMAL', p_field || ' 不能为空（缺失不允许当作 0）',
      pg_catalog.jsonb_build_object('field', p_field));
  end if;

  v_type := pg_catalog.jsonb_typeof(p_value);
  if v_type = 'null' then
    perform public.tj_gr_fail('GR_INVALID_DECIMAL', p_field || ' 不能为 null（不允许当作 0）',
      pg_catalog.jsonb_build_object('field', p_field));
  elsif v_type = 'number' then
    v_text := p_value #>> '{}';
  elsif v_type = 'string' then
    v_text := pg_catalog.btrim(p_value #>> '{}');
  else
    perform public.tj_gr_fail('GR_INVALID_DECIMAL', p_field || ' 类型非法（需要十进制字符串）',
      pg_catalog.jsonb_build_object('field', p_field, 'type', v_type));
  end if;

  if v_text !~ '^[0-9]+(\.[0-9]+)?$' then
    perform public.tj_gr_fail('GR_INVALID_DECIMAL',
      p_field || ' 不是十进制数（不接受负数/指数/空串）：' || v_text,
      pg_catalog.jsonb_build_object('field', p_field, 'value', v_text));
  end if;

  if v_text ~ '^[0-9]+\.[0-9]{7,}$' then
    perform public.tj_gr_fail('GR_DECIMAL_SCALE',
      p_field || ' 小数位超过 6 位：' || v_text || '（拒绝四舍五入）',
      pg_catalog.jsonb_build_object('field', p_field, 'value', v_text));
  end if;

  return v_text::numeric;
end
$fn$;

-- 规范十进制文本（与 JS normalizeDecimal 一致：去尾随 0、无指数）
create or replace function public.tj_gr_dec_text(p_value numeric)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_value is null then null else pg_catalog.trim_scale(p_value)::text end
$fn$;

-- 规范文本转义（反斜杠 → \\、TAB → \t、LF → \n、CR → \r）
create or replace function public.tj_gr_esc(p_value text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select pg_catalog.replace(
           pg_catalog.replace(
             pg_catalog.replace(
               pg_catalog.replace(p_value, '\', '\\'),
               chr(9), '\t'),
             chr(10), '\n'),
           chr(13), '\r')
$fn$;

-- canonical 行：key TAB value（null → \N）
create or replace function public.tj_gr_kv(p_key text, p_value text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select p_key || chr(9) ||
         case when p_value is null then '\N' else public.tj_gr_esc(p_value) end
$fn$;

create or replace function public.tj_gr_sha256(p_text text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select pg_catalog.encode(extensions.digest(p_text, 'sha256'), 'hex')
$fn$;

-- 日期/时间规范文本（UTC，秒精度；与 JS timestampText 一致）
create or replace function public.tj_gr_ts_text(p_value timestamptz)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_value is null then null
              else pg_catalog.to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end
$fn$;

create or replace function public.tj_gr_date_text(p_value date)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_value is null then null else pg_catalog.to_char(p_value, 'YYYY-MM-DD') end
$fn$;

-- ----------------------------------------------------------------------------
-- 3) 事件规范化键值（与 receipt-core.js eventKeyValues 逐字节一致）
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_event_kv(p_event_id uuid)
returns table(k text, v text)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  e public.tj_gr_receipt_events%rowtype;
  l record;
  s record;
  v_i integer := 0;
  v_j integer;
begin
  select * into e from public.tj_gr_receipt_events where id = p_event_id;
  if not found then
    return;
  end if;

  k := 'schema'; v := 'tj.gr.v1'; return next;
  k := 'kind'; v := 'goods_receive'; return next;
  k := 'environment'; v := 'preview'; return next;
  k := 'event.id'; v := e.id::text; return next;
  k := 'event.revision'; v := e.revision::text; return next;
  k := 'event.supplier_code'; v := e.supplier_code; return next;
  k := 'event.supplier_name'; v := e.supplier_name; return next;
  k := 'event.po_ids';
  v := (select pg_catalog.string_agg(x::text, ',' order by x::text) from pg_catalog.unnest(e.po_ids) as x);
  return next;
  k := 'event.invoice_no'; v := e.invoice_no; return next;
  k := 'event.delivery_order_no'; v := e.delivery_order_no; return next;
  k := 'event.receive_date'; v := public.tj_gr_date_text(e.receive_date); return next;
  k := 'event.invoice_date'; v := public.tj_gr_date_text(e.invoice_date); return next;
  k := 'event.checked_by'; v := e.checked_by; return next;
  k := 'event.approved_by'; v := e.approved_by::text; return next;
  k := 'event.approved_at'; v := public.tj_gr_ts_text(e.approved_at); return next;

  for l in
    select * from public.tj_gr_receipt_lines
    where receipt_event_id = p_event_id
    order by line_no, id::text
  loop
    v_i := v_i + 1;
    k := pg_catalog.format('lines.%s.id', pg_catalog.to_char(v_i - 1, 'FM0000')); v := l.id::text; return next;
    k := pg_catalog.format('lines.%s.line_no', pg_catalog.to_char(v_i - 1, 'FM0000')); v := l.line_no::text; return next;
    k := pg_catalog.format('lines.%s.item_code', pg_catalog.to_char(v_i - 1, 'FM0000')); v := l.item_code; return next;
    k := pg_catalog.format('lines.%s.description', pg_catalog.to_char(v_i - 1, 'FM0000')); v := l.description; return next;
    k := pg_catalog.format('lines.%s.uom', pg_catalog.to_char(v_i - 1, 'FM0000')); v := l.uom; return next;
    k := pg_catalog.format('lines.%s.unit_price', pg_catalog.to_char(v_i - 1, 'FM0000')); v := public.tj_gr_dec_text(l.unit_price); return next;
    k := pg_catalog.format('lines.%s.ordered_qty', pg_catalog.to_char(v_i - 1, 'FM0000')); v := public.tj_gr_dec_text(l.ordered_qty); return next;
    k := pg_catalog.format('lines.%s.accepted_qty', pg_catalog.to_char(v_i - 1, 'FM0000')); v := public.tj_gr_dec_text(l.accepted_qty); return next;
    k := pg_catalog.format('lines.%s.note', pg_catalog.to_char(v_i - 1, 'FM0000')); v := l.note; return next;

    v_j := 0;
    for s in
      select * from public.tj_gr_line_sources
      where receipt_line_id = l.id
      order by po_header_id::text, po_line_id::text
    loop
      v_j := v_j + 1;
      k := pg_catalog.format('lines.%s.sources.%s.po_header_id',
             pg_catalog.to_char(v_i - 1, 'FM0000'), pg_catalog.to_char(v_j - 1, 'FM0000')); v := s.po_header_id::text; return next;
      k := pg_catalog.format('lines.%s.sources.%s.po_line_id',
             pg_catalog.to_char(v_i - 1, 'FM0000'), pg_catalog.to_char(v_j - 1, 'FM0000')); v := s.po_line_id::text; return next;
      k := pg_catalog.format('lines.%s.sources.%s.ordered_qty',
             pg_catalog.to_char(v_i - 1, 'FM0000'), pg_catalog.to_char(v_j - 1, 'FM0000')); v := public.tj_gr_dec_text(s.ordered_qty); return next;
      k := pg_catalog.format('lines.%s.sources.%s.accepted_qty',
             pg_catalog.to_char(v_i - 1, 'FM0000'), pg_catalog.to_char(v_j - 1, 'FM0000')); v := public.tj_gr_dec_text(s.accepted_qty); return next;
    end loop;
  end loop;
end
$fn$;

create or replace function public.tj_gr_event_canonical(p_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.string_agg(public.tj_gr_kv(x.k, x.v), chr(10) order by x.k)
  from public.tj_gr_event_kv(p_event_id) as x
$fn$;

create or replace function public.tj_gr_event_hash(p_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.tj_gr_sha256(public.tj_gr_event_canonical(p_event_id))
$fn$;

-- ----------------------------------------------------------------------------
-- 4) 事件读取 JSON（UI 契约直接业务 JSON）
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_event_summary_json(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.jsonb_build_object(
    'id', e.id,
    'event_no', e.event_no,
    'revision', e.revision,
    'status', e.status,
    'supplier_code', e.supplier_code,
    'supplier_name', e.supplier_name,
    'po_ids', to_jsonb(e.po_ids),
    'invoice_no', e.invoice_no,
    'delivery_order_no', e.delivery_order_no,
    'receive_date', public.tj_gr_date_text(e.receive_date),
    'invoice_date', public.tj_gr_date_text(e.invoice_date),
    'checked_by', e.checked_by,
    'approved_by', e.approved_by,
    'approved_at', public.tj_gr_ts_text(e.approved_at),
    'released_at', public.tj_gr_ts_text(e.released_at),
    'warnings', e.warnings,
    'exception_count', pg_catalog.jsonb_array_length(e.exceptions),
    'created_at', public.tj_gr_ts_text(e.created_at),
    'updated_at', public.tj_gr_ts_text(e.updated_at)
  )
  from public.tj_gr_receipt_events e
  where e.id = p_event_id
$fn$;

create or replace function public.tj_gr_event_json(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_json jsonb;
begin
  select public.tj_gr_event_summary_json(e.id) || pg_catalog.jsonb_build_object(
    'note', e.note,
    'created_by', e.created_by,
    'submitted_by', e.submitted_by,
    'submitted_at', public.tj_gr_ts_text(e.submitted_at),
    'allow_exceptions', e.allow_exceptions,
    'review_note', e.review_note,
    'payload_sha256', e.payload_sha256,
    'exceptions', e.exceptions,
    'review_required', (pg_catalog.jsonb_array_length(e.exceptions) > 0
                        or e.warnings ? 'duplicate_document'),
    'lines', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', l.id,
          'line_no', l.line_no,
          'item_code', l.item_code,
          'description', l.description,
          'uom', l.uom,
          'unit_price', public.tj_gr_dec_text(l.unit_price),
          'ordered_qty', public.tj_gr_dec_text(l.ordered_qty),
          'accepted_qty', public.tj_gr_dec_text(l.accepted_qty),
          'note', l.note,
          'sources', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'po_header_id', s.po_header_id,
                'po_line_id', s.po_line_id,
                'ordered_qty', public.tj_gr_dec_text(s.ordered_qty),
                'accepted_qty', public.tj_gr_dec_text(s.accepted_qty)
              ) order by s.po_header_id::text, s.po_line_id::text
            )
            from public.tj_gr_line_sources s
            where s.receipt_line_id = l.id
          ), '[]'::jsonb)
        ) order by l.line_no, l.id::text
      )
      from public.tj_gr_receipt_lines l
      where l.receipt_event_id = e.id
    ), '[]'::jsonb),
    'tasks', coalesce((
      select pg_catalog.jsonb_agg(public.tj_gr_task_json(t.id) order by t.po_header_id::text)
      from public.tj_gr_tasks t
      where t.receipt_event_id = e.id
    ), '[]'::jsonb),
    'missing_mappings', coalesce((
      select pg_catalog.jsonb_agg(x.po_id)
      from pg_catalog.unnest(e.po_ids) as x(po_id)
      where not exists (
        select 1 from public.tj_gr_po_mappings m where m.po_header_id = x.po_id
      )
    ), '[]'::jsonb)
  )
  into v_json
  from public.tj_gr_receipt_events e
  where e.id = p_event_id;

  return v_json;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 5) 任务 JSON / payload / canonical / 证据比对
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_task_json(p_task_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.jsonb_build_object(
    'id', t.id,
    'task_type', t.task_type,
    'schema', t.schema_version,
    'environment', t.environment,
    'mock_only', t.mock_only,
    'receipt_event_id', t.receipt_event_id,
    'event_revision', t.event_revision,
    'po_header_id', t.po_header_id,
    'irs_po_no', t.irs_po_no,
    'status', t.status,
    'payload_sha256', t.payload_sha256,
    'event_payload_sha256', t.event_payload_sha256,
    'callback_id', t.callback_id,
    'executor_id', t.executor_id,
    'claimed_by', t.claimed_by,
    'claimed_at', public.tj_gr_ts_text(t.claimed_at),
    'lease_expires_at', public.tj_gr_ts_text(t.lease_expires_at),
    'attempt', t.attempt,
    'save_attempted_at', public.tj_gr_ts_text(t.save_attempted_at),
    'saved_at', public.tj_gr_ts_text(t.saved_at),
    'verified_at', public.tj_gr_ts_text(t.verified_at),
    'bridge_ok', t.bridge_ok,
    'last_error', t.last_error,
    'created_at', public.tj_gr_ts_text(t.created_at),
    'updated_at', public.tj_gr_ts_text(t.updated_at)
  )
  from public.tj_gr_tasks t
  where t.id = p_task_id
$fn$;

-- 该 PO 在事件里的行切片（数量 = 分配到该 PO 的数量，不是整行合计）
create or replace function public.tj_gr_task_scope(p_event_id uuid, p_po_header_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'line_id', l.id,
      'line_no', l.line_no,
      'item_code', l.item_code,
      'uom', l.uom,
      'unit_price', public.tj_gr_dec_text(l.unit_price),
      'accepted_qty', public.tj_gr_dec_text(sc.qty),
      'sources', sc.sources
    ) order by l.line_no, l.id::text
  ), '[]'::jsonb)
  from public.tj_gr_receipt_lines l
  join lateral (
    select
      pg_catalog.sum(s.accepted_qty) as qty,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'po_line_id', s.po_line_id,
          'ordered_qty', public.tj_gr_dec_text(s.ordered_qty),
          'accepted_qty', public.tj_gr_dec_text(s.accepted_qty)
        ) order by s.po_line_id::text
      ) as sources
    from public.tj_gr_line_sources s
    where s.receipt_line_id = l.id and s.po_header_id = p_po_header_id
    having pg_catalog.count(*) > 0
  ) sc on true
  where l.receipt_event_id = p_event_id
$fn$;

create or replace function public.tj_gr_task_payload(
  p_task_id uuid,
  p_event_id uuid,
  p_po_header_id uuid,
  p_irs_po_no text,
  p_evidence_sha256 text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.jsonb_build_object(
    'task', pg_catalog.jsonb_build_object(
      'id', p_task_id,
      'type', 'GOODS_RECEIVE',
      'schema', 'tj.gr.v1',
      'environment', 'preview',
      'po_header_id', p_po_header_id
    ),
    'mapping', pg_catalog.jsonb_build_object(
      'po_header_id', p_po_header_id,
      'irs_po_no', p_irs_po_no,
      'evidence_sha256', p_evidence_sha256
    ),
    'event_payload_sha256', e.payload_sha256,
    'event', pg_catalog.jsonb_build_object(
      'id', e.id,
      'revision', e.revision,
      'supplier_code', e.supplier_code,
      'supplier_name', e.supplier_name,
      'invoice_no', e.invoice_no,
      'delivery_order_no', e.delivery_order_no,
      'receive_date', public.tj_gr_date_text(e.receive_date),
      'invoice_date', public.tj_gr_date_text(e.invoice_date),
      'checked_by', e.checked_by,
      'approved_by', e.approved_by::text,
      'approved_at', public.tj_gr_ts_text(e.approved_at)
    ),
    'scope', pg_catalog.jsonb_build_object(
      'lines', public.tj_gr_task_scope(p_event_id, p_po_header_id)
    )
  )
  from public.tj_gr_receipt_events e
  where e.id = p_event_id
$fn$;

-- 任务 canonical = 事件全部键 + 任务/映射/切片键（覆盖 IRS 字段全集）
create or replace function public.tj_gr_task_canonical(p_event_id uuid, p_payload jsonb)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  with ev as (
    select k, v from public.tj_gr_event_kv(p_event_id)
  ),
  t as (
    select
      'event_payload_sha256'::text as k, p_payload ->> 'event_payload_sha256' as v
    union all select 'task.id', p_payload -> 'task' ->> 'id'
    union all select 'task.type', p_payload -> 'task' ->> 'type'
    union all select 'task.schema', p_payload -> 'task' ->> 'schema'
    union all select 'task.environment', p_payload -> 'task' ->> 'environment'
    union all select 'task.po_header_id', p_payload -> 'task' ->> 'po_header_id'
    union all select 'mapping.po_header_id', p_payload -> 'mapping' ->> 'po_header_id'
    union all select 'mapping.irs_po_no', p_payload -> 'mapping' ->> 'irs_po_no'
    union all select 'mapping.evidence_sha256', p_payload -> 'mapping' ->> 'evidence_sha256'
  ),
  sl as (
    select
      pg_catalog.format('scope.lines.%s', pg_catalog.to_char(ord - 1, 'FM0000')) as p,
      x.line
    from pg_catalog.jsonb_array_elements(p_payload -> 'scope' -> 'lines')
      with ordinality as x(line, ord)
  ),
  slk as (
    select p || '.line_id' as k, line ->> 'line_id' as v from sl
    union all select p || '.line_no', line ->> 'line_no' from sl
    union all select p || '.item_code', line ->> 'item_code' from sl
    union all select p || '.uom', line ->> 'uom' from sl
    union all select p || '.unit_price', line ->> 'unit_price' from sl
    union all select p || '.accepted_qty', line ->> 'accepted_qty' from sl
  ),
  src as (
    select
      sl.p,
      pg_catalog.format('scope.lines.%s.sources.%s', substr(sl.p, 13), pg_catalog.to_char(ord - 1, 'FM0000')) as sp,
      s.line
    from sl
    cross join lateral pg_catalog.jsonb_array_elements(sl.line -> 'sources')
      with ordinality as s(line, ord)
  ),
  srck as (
    select sp || '.po_line_id' as k, line ->> 'po_line_id' as v from src
    union all select sp || '.ordered_qty', line ->> 'ordered_qty' from src
    union all select sp || '.accepted_qty', line ->> 'accepted_qty' from src
  )
  select pg_catalog.string_agg(public.tj_gr_kv(k, v), chr(10) order by k)
  from (
    select k, v from ev
    union all select k, v from t
    union all select k, v from slk
    union all select k, v from srck
  ) allkv
$fn$;

-- 证据逐行严格比对（不是布尔）；返回 {ok, mismatches}
create or replace function public.tj_gr_verify_evidence(p_task_id uuid, p_evidence jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  t public.tj_gr_tasks%rowtype;
  v_event jsonb;
  v_mism jsonb := '[]'::jsonb;
  v_lines jsonb;
  v_scope jsonb;
  v_line jsonb;
  v_got jsonb;
  v_i int;
begin
  select * into t from public.tj_gr_tasks where id = p_task_id;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '任务不存在', pg_catalog.jsonb_build_object('task_id', p_task_id));
  end if;

  v_event := t.payload -> 'event';
  v_scope := coalesce(t.payload -> 'scope' -> 'lines', '[]'::jsonb);
  v_lines := coalesce(p_evidence -> 'lines', '[]'::jsonb);

  if coalesce((p_evidence ->> 'bridge_ok')::boolean, false) is not true then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','bridge','field','bridge_ok','expected',true,'actual',p_evidence -> 'bridge_ok'));
  end if;

  if t.environment <> 'preview' then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','environment','field','environment','expected','preview','actual',t.environment));
  end if;

  if p_evidence ->> 'irs_po_no' is distinct from t.irs_po_no then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','mapping','field','irs_po_no','expected',t.irs_po_no,'actual',p_evidence ->> 'irs_po_no'));
  end if;

  if coalesce(v_event ->> 'supplier_code','') <> coalesce(p_evidence ->> 'supplier_code','') then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','header','field','supplier_code','expected',v_event ->> 'supplier_code','actual',p_evidence ->> 'supplier_code'));
  end if;

  if coalesce(v_event ->> 'invoice_no','') <> '' and (p_evidence ->> 'invoice_no') is distinct from (v_event ->> 'invoice_no') then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','header','field','invoice_no','expected',v_event ->> 'invoice_no','actual',p_evidence ->> 'invoice_no'));
  end if;

  if coalesce(v_event ->> 'delivery_order_no','') <> '' and (p_evidence ->> 'delivery_order_no') is distinct from (v_event ->> 'delivery_order_no') then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','header','field','delivery_order_no','expected',v_event ->> 'delivery_order_no','actual',p_evidence ->> 'delivery_order_no'));
  end if;

  begin
    if (p_evidence ->> 'saved_at') is null or (p_evidence ->> 'saved_at')::timestamptz is null then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','header','field','saved_at','expected','timestamp','actual',p_evidence ->> 'saved_at'));
    end if;
  exception when others then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','header','field','saved_at','expected','timestamp','actual',p_evidence ->> 'saved_at'));
  end;

  if pg_catalog.jsonb_typeof(v_lines) <> 'array' then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','lines','field','lines','expected','array','actual',pg_catalog.jsonb_typeof(v_lines)));
    return pg_catalog.jsonb_build_object('ok', false, 'mismatches', v_mism);
  end if;

  if pg_catalog.jsonb_array_length(v_lines) = 0 then
    v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind','lines','field','lines','expected',pg_catalog.jsonb_array_length(v_scope),'actual',0));
  end if;

  for v_line in
    select value from pg_catalog.jsonb_array_elements(v_scope)
  loop
    select value into v_got
    from pg_catalog.jsonb_array_elements(v_lines)
    where value ->> 'line_id' = v_line ->> 'line_id'
    limit 1;

    if v_got is null then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','line_missing','field','line','expected',v_line ->> 'line_id','actual',null,
        'line_id',v_line ->> 'line_id'));
      continue;
    end if;

    if (v_got ->> 'item_code') is distinct from (v_line ->> 'item_code') then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','line','field','item_code','expected',v_line ->> 'item_code','actual',v_got ->> 'item_code',
        'line_id',v_line ->> 'line_id'));
    end if;

    if coalesce(v_got ->> 'uom','') <> coalesce(v_line ->> 'uom','') then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','line','field','uom','expected',v_line ->> 'uom','actual',v_got ->> 'uom',
        'line_id',v_line ->> 'line_id'));
    end if;

    begin
      if public.tj_gr_dec(v_got -> 'qty', 'qty') is distinct from (v_line ->> 'accepted_qty')::numeric then
        v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind','line','field','qty','expected',v_line ->> 'accepted_qty','actual',v_got ->> 'qty',
          'line_id',v_line ->> 'line_id'));
      end if;
    exception when others then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','line','field','qty','expected',v_line ->> 'accepted_qty','actual',v_got ->> 'qty',
        'line_id',v_line ->> 'line_id'));
    end;

    begin
      if public.tj_gr_dec(v_got -> 'unit_price', 'unit_price') is distinct from (v_line ->> 'unit_price')::numeric then
        v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind','line','field','unit_price','expected',v_line ->> 'unit_price','actual',v_got ->> 'unit_price',
          'line_id',v_line ->> 'line_id'));
      end if;
    exception when others then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','line','field','unit_price','expected',v_line ->> 'unit_price','actual',v_got ->> 'unit_price',
        'line_id',v_line ->> 'line_id'));
    end;
  end loop;

  -- 多余行（证据里出现了该 PO 切片没有的行）
  for v_got in
    select value from pg_catalog.jsonb_array_elements(v_lines)
  loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(v_scope)
      where value ->> 'line_id' = v_got ->> 'line_id'
    ) then
      v_mism := v_mism || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','line_unexpected','field','line_id','expected',null,'actual',v_got ->> 'line_id',
        'line_id',v_got ->> 'line_id'));
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('ok', pg_catalog.jsonb_array_length(v_mism) = 0, 'mismatches', v_mism);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6) 事件检查（warning / exception / 累计余额）—— 保存与批准共用
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_event_check(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  e public.tj_gr_receipt_events%rowtype;
  v_warn text[] := '{}';
  v_exc jsonb := '[]'::jsonb;
  r record;
  v_src record;
  v_dup boolean := false;
begin
  select * into e from public.tj_gr_receipt_events where id = p_event_id;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '收货事件不存在', pg_catalog.jsonb_build_object('id', p_event_id));
  end if;

  for r in
    select l.*, coalesce((select count(*) from public.tj_gr_line_sources s where s.receipt_line_id = l.id), 0) as src_count
    from public.tj_gr_receipt_lines l
    where l.receipt_event_id = p_event_id
    order by l.line_no, l.id::text
  loop
    if r.src_count = 0 then
      v_exc := v_exc || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'code','extra_line','line_id',r.id,'detail','该行没有来源 PO 明细（额外货品）'));
    elsif r.accepted_qty = 0 then
      v_warn := v_warn || 'zero_receipt'::text;
    elsif r.accepted_qty < r.ordered_qty then
      v_warn := v_warn || 'short_receipt'::text;
    elsif r.accepted_qty > r.ordered_qty then
      v_exc := v_exc || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'code','over_receipt','line_id',r.id,
        'detail', pg_catalog.format('实收 %s 超过订购 %s',
          public.tj_gr_dec_text(r.accepted_qty), public.tj_gr_dec_text(r.ordered_qty))));
    end if;

    -- 累计余额：对每条来源分配单独判断（避免用行合计掩盖单条来源超收）。
    -- 计入所有已批准/在途/已保存事件（与 receipt-core.js EVENT_COMMITTED_STATUSES 一致）。
    for v_src in
      select
        src.po_line_id,
        src.accepted_qty,
        coalesce(pl.original_qty, pl.qty) as po_ordered,
        coalesce((
          select pg_catalog.sum(s2.accepted_qty)
          from public.tj_gr_line_sources s2
          join public.tj_gr_receipt_events e2 on e2.id = s2.receipt_event_id
          where s2.po_line_id = src.po_line_id
            and e2.id <> p_event_id
            and e2.status in ('approved','waiting_mapping','released','in_progress',
                              'saved_unverified','verified','needs_review')
        ), 0) as prev_qty
      from public.tj_gr_line_sources src
      join public.tj_po_lines pl on pl.id = src.po_line_id
      where src.receipt_line_id = r.id
    loop
      if v_src.prev_qty + v_src.accepted_qty > v_src.po_ordered then
        v_exc := v_exc || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'code','over_balance','line_id',r.id,'po_line_id',v_src.po_line_id,
          'detail', pg_catalog.format('累计已批准 %s + 本次 %s 超过来源订购 %s',
            public.tj_gr_dec_text(v_src.prev_qty), public.tj_gr_dec_text(v_src.accepted_qty),
            public.tj_gr_dec_text(v_src.po_ordered))));
      end if;
    end loop;
  end loop;

  -- 疑似重复单据（合法分批不禁止，只标 warning + review_required）
  select exists (
    select 1 from public.tj_gr_receipt_events o
    where o.id <> e.id
      and o.status <> 'cancelled'
      and o.supplier_code = e.supplier_code
      and (
        (e.invoice_no is not null and o.invoice_no = e.invoice_no)
        or (e.delivery_order_no is not null and o.delivery_order_no = e.delivery_order_no)
      )
  ) into v_dup;

  if v_dup then
    v_warn := v_warn || 'duplicate_document'::text;
  end if;

  return pg_catalog.jsonb_build_object(
    'warnings', to_jsonb(v_warn),
    'exceptions', v_exc,
    'review_required', (pg_catalog.jsonb_array_length(v_exc) > 0 or v_dup)
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 7) 动作：receipt_save / submit / approve / release
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_receipt_save(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid;
  v_rev_in int;
  v_rev int;
  v_po_ids uuid[];
  v_existing public.tj_gr_receipt_events%rowtype;
  v_found boolean := false;
  v_supplier_code text;
  v_supplier_name text;
  v_receive_date date;
  v_invoice_date date;
  v_lines jsonb := '[]'::jsonb;
  v_srcs jsonb := '[]'::jsonb;
  v_line jsonb;
  v_src jsonb;
  v_i int := 0;
  v_j int;
  v_item_code text;
  v_uom text;
  v_desc text;
  v_note text;
  v_price numeric;
  v_ordered numeric;
  v_accepted numeric;
  v_alloc_sum numeric;
  v_order_sum numeric;
  v_po_line record;
  v_line_id uuid;
  v_seen_line_ids uuid[] := '{}';
  v_pl_ids uuid[] := '{}';
  v_warn text[] := '{}';
  v_exc jsonb := '[]'::jsonb;
  v_dup boolean;
  v_event_no text;
  v_check jsonb;
  v_status text;
  v_prev numeric;
  v_po_ordered numeric;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  if p_data is null or pg_catalog.jsonb_typeof(p_data) <> 'object' then
    perform public.tj_gr_fail('GR_VALIDATION', 'p_data 必须是对象');
  end if;
  if (p_data ->> 'id') is null or (p_data ->> 'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    perform public.tj_gr_fail('GR_VALIDATION', 'id 必须是稳定 uuid', pg_catalog.jsonb_build_object('field','id'));
  end if;
  v_id := (p_data ->> 'id')::uuid;
  v_rev_in := coalesce((p_data ->> 'revision')::int, -1);
  if v_rev_in < 0 then
    perform public.tj_gr_fail('GR_VALIDATION', 'revision 必须是 >=0 的整数', pg_catalog.jsonb_build_object('field','revision'));
  end if;

  select * into v_existing from public.tj_gr_receipt_events where id = v_id for update;
  v_found := found;

  if v_found then
    if v_existing.status not in ('draft','needs_review') then
      perform public.tj_gr_fail('GR_STATE',
        pg_catalog.format('事件 %s 当前状态 %s 不允许修改', v_existing.event_no, v_existing.status),
        pg_catalog.jsonb_build_object('status', v_existing.status));
    end if;
    if v_existing.revision <> v_rev_in then
      perform public.tj_gr_fail('GR_REVISION_CONFLICT',
        pg_catalog.format('修订号不匹配（库中 %s，提交 %s）：可能已被他人修改，请刷新', v_existing.revision, v_rev_in),
        pg_catalog.jsonb_build_object('expected', v_existing.revision, 'actual', v_rev_in));
    end if;
    if v_existing.created_by <> v_uid then
      perform public.tj_gr_fail('GR_FORBIDDEN', '只有创建人可以修改该收货事件');
    end if;
    -- 已释放（甚至已建任务）的事件绝不能再改行/来源：任务 payload 哈希绑定了当时的
    -- 行与来源，事后重写会导致证据比对与 IRS 实际内容永久不一致。
    if v_existing.released_at is not null
       or exists (select 1 from public.tj_gr_tasks t where t.receipt_event_id = v_id) then
      perform public.tj_gr_fail('GR_STATE',
        '事件已释放出任务，不能再编辑（需要更正请作废并按新事件重新收货）',
        pg_catalog.jsonb_build_object('status', v_existing.status));
    end if;
    v_rev := v_existing.revision + 1;
    v_event_no := v_existing.event_no;
  else
    if v_rev_in <> 0 then
      perform public.tj_gr_fail('GR_REVISION_CONFLICT', '首次保存 revision 必须为 0',
        pg_catalog.jsonb_build_object('expected', 0, 'actual', v_rev_in));
    end if;
    v_rev := 0;
    v_event_no := 'GR-' || pg_catalog.to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-'
                  || pg_catalog.substr(pg_catalog.replace(gen_random_uuid()::text, '-', ''), 1, 8);
  end if;

  -- po_ids
  if pg_catalog.jsonb_typeof(p_data -> 'po_ids') <> 'array'
     or pg_catalog.jsonb_array_length(p_data -> 'po_ids') = 0 then
    perform public.tj_gr_fail('GR_VALIDATION', 'po_ids 至少一张来源 PO', pg_catalog.jsonb_build_object('field','po_ids'));
  end if;
  select pg_catalog.array_agg(value::uuid) into v_po_ids
  from pg_catalog.jsonb_array_elements_text(p_data -> 'po_ids') as v(value);
  if pg_catalog.array_length(v_po_ids, 1) <> pg_catalog.jsonb_array_length(p_data -> 'po_ids')
     or pg_catalog.array_length(v_po_ids, 1) <> (select pg_catalog.count(distinct x) from pg_catalog.unnest(v_po_ids) x) then
    perform public.tj_gr_fail('GR_VALIDATION', 'po_ids 含非法或重复 uuid', pg_catalog.jsonb_build_object('field','po_ids'));
  end if;

  select pg_catalog.count(*), pg_catalog.min(h.supplier_code), pg_catalog.min(h.supplier_name)
    into v_j, v_supplier_code, v_supplier_name
  from public.tj_po_headers h
  where h.id = any (v_po_ids) and h.status <> 'cancelled';

  if v_j <> pg_catalog.array_length(v_po_ids, 1) then
    perform public.tj_gr_fail('GR_NOT_FOUND', 'po_ids 含不存在的来源 PO', pg_catalog.jsonb_build_object('po_ids', to_jsonb(v_po_ids)));
  end if;
  if (select pg_catalog.count(distinct h.supplier_code) from public.tj_po_headers h where h.id = any (v_po_ids)) > 1 then
    perform public.tj_gr_fail('GR_VALIDATION', '同一收货事件只能对应同一供应商');
  end if;

  if (p_data ->> 'receive_date') is null or (p_data ->> 'receive_date') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.tj_gr_fail('GR_VALIDATION', 'receive_date 必须是显式 yyyy-MM-dd（不猜日期）',
      pg_catalog.jsonb_build_object('field','receive_date'));
  end if;
  v_receive_date := (p_data ->> 'receive_date')::date;

  if (p_data ->> 'invoice_date') is not null and p_data ->> 'invoice_date' <> '' then
    if (p_data ->> 'invoice_date') !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.tj_gr_fail('GR_VALIDATION', 'invoice_date 只能是 yyyy-MM-dd 或 null（不猜）',
        pg_catalog.jsonb_build_object('field','invoice_date'));
    end if;
    v_invoice_date := (p_data ->> 'invoice_date')::date;
  end if;

  -- lines
  if pg_catalog.jsonb_typeof(p_data -> 'lines') <> 'array'
     or pg_catalog.jsonb_array_length(p_data -> 'lines') = 0 then
    perform public.tj_gr_fail('GR_VALIDATION', 'lines 至少一行', pg_catalog.jsonb_build_object('field','lines'));
  end if;

  for v_line in select value from pg_catalog.jsonb_array_elements(p_data -> 'lines') loop
    v_i := v_i + 1;
    if pg_catalog.jsonb_typeof(v_line -> 'id') <> 'string' then
      perform public.tj_gr_fail('GR_VALIDATION', pg_catalog.format('lines[%s].id 必须是 uuid', v_i - 1));
    end if;
    v_line_id := (v_line ->> 'id')::uuid;

    -- 只检查本次请求内的重复（持久行会在写入前整体重写，不能用库内存在性判断）
    if v_line_id = any (v_seen_line_ids) then
      perform public.tj_gr_fail('GR_VALIDATION', 'line id 重复：' || v_line_id::text);
    end if;
    v_seen_line_ids := v_seen_line_ids || v_line_id;

    if (v_line ->> 'line_no') is null or (v_line ->> 'line_no') !~ '^[0-9]+$' then
      perform public.tj_gr_fail('GR_VALIDATION', 'line_no 必须是正整数');
    end if;
    if v_line ->> 'item_code' is null or btrim(v_line ->> 'item_code') = '' then
      perform public.tj_gr_fail('GR_VALIDATION', 'item_code 必填');
    end if;
    v_item_code := v_line ->> 'item_code';   -- 文本原样：不 trim、不改大小写
    v_uom := v_line ->> 'uom';
    v_desc := v_line ->> 'description';
    v_note := v_line ->> 'note';
    v_price := public.tj_gr_dec(v_line -> 'unit_price', 'unit_price');
    v_ordered := public.tj_gr_dec(v_line -> 'ordered_qty', 'ordered_qty');
    v_accepted := public.tj_gr_dec(v_line -> 'accepted_qty', 'accepted_qty');

    if pg_catalog.jsonb_typeof(v_line -> 'source_allocations') <> 'array' then
      perform public.tj_gr_fail('GR_VALIDATION', 'source_allocations 必须是数组（空数组=额外行，需审批确认）');
    end if;

    v_j := 0;
    v_alloc_sum := 0;
    v_order_sum := 0;
    for v_src in select value from pg_catalog.jsonb_array_elements(v_line -> 'source_allocations') loop
      v_j := v_j + 1;

      select l.id, l.po_header_id, l.item_code, l.uom, l.unit_price,
             coalesce(l.original_qty, l.qty) as ordered
        into v_po_line
      from public.tj_po_lines l
      where l.id = (v_src ->> 'po_line_id')::uuid;

      if not found then
        perform public.tj_gr_fail('GR_NOT_FOUND', '来源 PO 明细不存在',
          pg_catalog.jsonb_build_object('po_line_id', v_src ->> 'po_line_id'));
      end if;

      if v_po_line.po_header_id::text <> (v_src ->> 'po_header_id') then
        perform public.tj_gr_fail('GR_SOURCE_MISMATCH', '来源明细不属于该 PO',
          pg_catalog.jsonb_build_object('po_line_id', v_src ->> 'po_line_id'));
      end if;
      if not (v_po_line.po_header_id = any (v_po_ids)) then
        perform public.tj_gr_fail('GR_SOURCE_MISMATCH', '来源 PO 不在 po_ids 内');
      end if;

      -- 多来源共享商品：item / UOM / 单价必须严格对应（文本精确 + 十进制相等）
      if v_po_line.item_code <> v_item_code then
        perform public.tj_gr_fail('GR_SOURCE_MISMATCH',
          pg_catalog.format('item_code 与来源行不一致（来源 %s，本行 %s）', v_po_line.item_code, v_item_code));
      end if;
      if coalesce(v_po_line.uom, '') <> coalesce(v_uom, '') then
        perform public.tj_gr_fail('GR_SOURCE_MISMATCH',
          pg_catalog.format('uom 与来源行不一致（来源 %s，本行 %s）', coalesce(v_po_line.uom,''), coalesce(v_uom,'')));
      end if;
      if v_po_line.unit_price <> v_price then
        perform public.tj_gr_fail('GR_SOURCE_MISMATCH',
          pg_catalog.format('unit_price 与来源行不一致（来源 %s，本行 %s）',
            public.tj_gr_dec_text(v_po_line.unit_price), public.tj_gr_dec_text(v_price)));
      end if;

      v_order_sum := v_order_sum + v_po_line.ordered;
      v_alloc_sum := v_alloc_sum + public.tj_gr_dec(v_src -> 'accepted_qty', 'source.accepted_qty');

      v_srcs := v_srcs || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'receipt_event_id', v_id,
        'receipt_line_id', v_line_id,
        'po_header_id', v_po_line.po_header_id,
        'po_line_id', v_po_line.id,
        'ordered_qty', v_po_line.ordered,
        'accepted_qty', public.tj_gr_dec(v_src -> 'accepted_qty', 'source.accepted_qty')
      ));
      v_pl_ids := v_pl_ids || v_po_line.id;
    end loop;

    if v_j > 0 and v_alloc_sum <> v_accepted then
      perform public.tj_gr_fail('GR_QTY_MISMATCH',
        pg_catalog.format('accepted_qty=%s 与来源分配合计=%s 不一致',
          public.tj_gr_dec_text(v_accepted), public.tj_gr_dec_text(v_alloc_sum)),
        pg_catalog.jsonb_build_object('field','accepted_qty'));
    end if;

    if v_j > 0 and v_ordered <> v_order_sum then
      perform public.tj_gr_fail('GR_QTY_MISMATCH',
        pg_catalog.format('ordered_qty=%s 与来源订购合计=%s 不一致（不得自造订购量）',
          public.tj_gr_dec_text(v_ordered), public.tj_gr_dec_text(v_order_sum)),
        pg_catalog.jsonb_build_object('field','ordered_qty'));
    end if;

    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', v_line_id,
      'receipt_event_id', v_id,
      'line_no', (v_line ->> 'line_no')::int,
      'item_code', v_item_code,
      'description', v_desc,
      'uom', v_uom,
      'unit_price', v_price,
      'ordered_qty', v_ordered,
      'accepted_qty', v_accepted,
      'note', v_note
    ));

    if v_j = 0 then
      v_exc := v_exc || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'code','extra_line','line_id',v_line_id,'detail','该行没有来源 PO 明细（额外货品）'));
    elsif v_accepted = 0 then
      v_warn := v_warn || 'zero_receipt'::text;
    elsif v_accepted < v_ordered then
      v_warn := v_warn || 'short_receipt'::text;
    elsif v_accepted > v_ordered then
      v_exc := v_exc || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'code','over_receipt','line_id',v_line_id,
        'detail', pg_catalog.format('实收 %s 超过订购 %s',
          public.tj_gr_dec_text(v_accepted), public.tj_gr_dec_text(v_ordered))));
    end if;
  end loop;

  -- 写 header（CAS 已由上面的锁+revision 校验保证）
  if v_found then
    update public.tj_gr_receipt_events set
      revision = v_rev,
      po_ids = v_po_ids,
      supplier_code = v_supplier_code,
      supplier_name = v_supplier_name,
      invoice_no = p_data ->> 'invoice_no',
      delivery_order_no = p_data ->> 'delivery_order_no',
      receive_date = v_receive_date,
      invoice_date = v_invoice_date,
      checked_by = p_data ->> 'checked_by',
      note = p_data ->> 'note',
      payload_sha256 = null,
      updated_at = now()
    where id = v_id;
  else
    insert into public.tj_gr_receipt_events (
      id, event_no, revision, status, supplier_code, supplier_name, po_ids,
      invoice_no, delivery_order_no, receive_date, invoice_date, checked_by, note, created_by
    ) values (
      v_id, v_event_no, 0, 'draft', v_supplier_code, v_supplier_name, v_po_ids,
      p_data ->> 'invoice_no', p_data ->> 'delivery_order_no', v_receive_date,
      v_invoice_date, p_data ->> 'checked_by', p_data ->> 'note', v_uid
    );
  end if;

  -- 重写行/来源（未批准事件；行 id 由客户端稳定提供）
  delete from public.tj_gr_receipt_lines where receipt_event_id = v_id;
  insert into public.tj_gr_receipt_lines
    (id, receipt_event_id, line_no, item_code, description, uom, unit_price, ordered_qty, accepted_qty, note)
  select x.id, x.receipt_event_id, x.line_no, x.item_code, x.description, x.uom,
         x.unit_price, x.ordered_qty, x.accepted_qty, x.note
  from pg_catalog.jsonb_to_recordset(v_lines) as x(
    id uuid, receipt_event_id uuid, line_no int, item_code text, description text,
    uom text, unit_price numeric, ordered_qty numeric, accepted_qty numeric, note text);

  insert into public.tj_gr_line_sources
    (receipt_event_id, receipt_line_id, po_header_id, po_line_id, ordered_qty, accepted_qty)
  select x.receipt_event_id, x.receipt_line_id, x.po_header_id, x.po_line_id, x.ordered_qty, x.accepted_qty
  from pg_catalog.jsonb_to_recordset(v_srcs) as x(
    receipt_event_id uuid, receipt_line_id uuid, po_header_id uuid, po_line_id uuid,
    ordered_qty numeric, accepted_qty numeric);

  -- 检查（warnings/exceptions 存档；保存阶段不因超收/额外行拒绝，审批时必须显式确认）
  v_check := public.tj_gr_event_check(v_id);

  update public.tj_gr_receipt_events
     set warnings = (v_check -> 'warnings'),
         exceptions = (v_check -> 'exceptions'),
         updated_at = now()
   where id = v_id;

  -- 事件 payload 哈希覆盖供商/单据/日期/全部行与来源
  update public.tj_gr_receipt_events
     set payload_sha256 = public.tj_gr_event_hash(v_id)
   where id = v_id;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'receipt_save', 'receipt_event', v_id::text,
          pg_catalog.jsonb_build_object('revision', v_rev, 'lines', pg_catalog.jsonb_array_length(v_lines)));

  return public.tj_gr_event_json(v_id);
end
$fn$;

create or replace function public.tj_gr_receipt_submit(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid := (p_data ->> 'id')::uuid;
  v_rev int := (p_data ->> 'revision')::int;
  e public.tj_gr_receipt_events%rowtype;
  v_check jsonb;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  select * into e from public.tj_gr_receipt_events where id = v_id for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '收货事件不存在', pg_catalog.jsonb_build_object('id', v_id));
  end if;
  if e.status not in ('draft','needs_review') then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.format('当前状态 %s 不能提交', e.status),
      pg_catalog.jsonb_build_object('status', e.status));
  end if;
  if e.revision <> v_rev then
    perform public.tj_gr_fail('GR_REVISION_CONFLICT',
      pg_catalog.format('修订号不匹配（库中 %s，提交 %s）', e.revision, v_rev),
      pg_catalog.jsonb_build_object('expected', e.revision, 'actual', v_rev));
  end if;
  if e.created_by <> v_uid then
    perform public.tj_gr_fail('GR_FORBIDDEN', '只有创建人可以提交该收货事件');
  end if;

  v_check := public.tj_gr_event_check(v_id);

  update public.tj_gr_receipt_events set
    status = 'submitted',
    submitted_by = v_uid,
    submitted_at = now(),
    warnings = v_check -> 'warnings',
    exceptions = v_check -> 'exceptions',
    payload_sha256 = public.tj_gr_event_hash(v_id),
    updated_at = now()
  where id = v_id;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'receipt_submit', 'receipt_event', v_id::text,
          pg_catalog.jsonb_build_object('revision', v_rev));

  return public.tj_gr_event_json(v_id);
end
$fn$;

create or replace function public.tj_gr_receipt_approve(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid := (p_data ->> 'id')::uuid;
  v_rev int := (p_data ->> 'revision')::int;
  v_allow boolean := coalesce((p_data ->> 'allow_exceptions')::boolean, false);
  v_note text := p_data ->> 'review_note';
  e public.tj_gr_receipt_events%rowtype;
  v_check jsonb;
  v_exc jsonb;
  v_pl uuid;
begin
  v_uid := public.tj_gr_require_role(array['approver']);

  select * into e from public.tj_gr_receipt_events where id = v_id for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '收货事件不存在', pg_catalog.jsonb_build_object('id', v_id));
  end if;
  if e.revision <> v_rev then
    perform public.tj_gr_fail('GR_REVISION_CONFLICT',
      pg_catalog.format('修订号不匹配（库中 %s，提交 %s）', e.revision, v_rev),
      pg_catalog.jsonb_build_object('expected', e.revision, 'actual', v_rev));
  end if;
  if e.status not in ('draft','needs_review','submitted') then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.format('当前状态 %s 不能批准', e.status),
      pg_catalog.jsonb_build_object('status', e.status));
  end if;

  -- 先锁所有来源行（按 id 排序，避免死锁），再重新校验累计余额
  for v_pl in
    select distinct s.po_line_id
    from public.tj_gr_line_sources s
    where s.receipt_event_id = v_id
    order by 1
  loop
    perform 1 from public.tj_po_lines l where l.id = v_pl for update;
  end loop;

  v_check := public.tj_gr_event_check(v_id);
  v_exc := v_check -> 'exceptions';

  if pg_catalog.jsonb_array_length(v_exc) > 0 then
    if not v_allow then
      perform public.tj_gr_fail('GR_EXCEPTION_NOT_ALLOWED',
        pg_catalog.format('存在 %s 项异常，必须显式确认后才能批准', pg_catalog.jsonb_array_length(v_exc)),
        pg_catalog.jsonb_build_object('exceptions', v_exc));
    end if;
    if v_note is null or btrim(v_note) = '' then
      perform public.tj_gr_fail('GR_VALIDATION', '确认异常时必须填写 review_note（审批说明）',
        pg_catalog.jsonb_build_object('field','review_note'));
    end if;
  end if;

  update public.tj_gr_receipt_events set
    status = 'approved',
    revision = case when e.status in ('draft','needs_review') then e.revision + 1 else e.revision end,
    submitted_by = coalesce(e.submitted_by, v_uid),
    submitted_at = coalesce(e.submitted_at, now()),
    approved_by = v_uid,
    approved_at = now(),
    allow_exceptions = v_allow,
    review_note = v_note,
    warnings = v_check -> 'warnings',
    exceptions = v_exc,
    updated_at = now()
  where id = v_id;

  -- 批准人/批准时间本身也进哈希：必须在写入之后单独重算（UPDATE 的 SET 表达式
  -- 看到的是 OLD 行，放在同一条里会算到旧的 approved_*）。
  update public.tj_gr_receipt_events
     set payload_sha256 = public.tj_gr_event_hash(v_id)
   where id = v_id;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'receipt_approve', 'receipt_event', v_id::text,
          pg_catalog.jsonb_build_object('allow_exceptions', v_allow,
            'exceptions', pg_catalog.jsonb_array_length(v_exc)));

  return public.tj_gr_event_json(v_id);
end
$fn$;

create or replace function public.tj_gr_receipt_release(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid := (p_data ->> 'id')::uuid;
  e public.tj_gr_receipt_events%rowtype;
  v_missing uuid[] := '{}';
  v_po uuid;
  m record;
  v_task_id uuid;
  v_payload jsonb;
  v_hash text;
  v_tasks jsonb;
  v_existing uuid;
begin
  v_uid := public.tj_gr_require_role(array['approver']);

  select * into e from public.tj_gr_receipt_events where id = v_id for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '收货事件不存在', pg_catalog.jsonb_build_object('id', v_id));
  end if;
  if e.status not in ('approved','waiting_mapping','released') then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.format('当前状态 %s 不能释放任务', e.status),
      pg_catalog.jsonb_build_object('status', e.status));
  end if;
  if e.receive_date is null or e.delivery_order_no is null or btrim(e.delivery_order_no) = '' then
    perform public.tj_gr_fail('GR_VALIDATION', '释放前必须有收货日期与 Delivery Order No',
      pg_catalog.jsonb_build_object('receive_date', e.receive_date, 'delivery_order_no', e.delivery_order_no));
  end if;
  if e.payload_sha256 is null then
    perform public.tj_gr_fail('GR_VALIDATION', '事件缺少 payload_sha256，不能释放');
  end if;

  -- 已释放：幂等返回现有任务
  if e.status = 'released' then
    select coalesce(jsonb_agg(public.tj_gr_task_json(t.id) order by t.po_header_id::text), '[]'::jsonb)
      into v_tasks
    from public.tj_gr_tasks t where t.receipt_event_id = v_id;
    return pg_catalog.jsonb_build_object('event', public.tj_gr_event_json(v_id), 'tasks', v_tasks, 'missing_mappings', '[]'::jsonb);
  end if;

  foreach v_po in array e.po_ids loop
    if not exists (select 1 from public.tj_gr_po_mappings mm
                    where mm.po_header_id = v_po and mm.verified_at is not null) then
      v_missing := v_missing || v_po;
    end if;
  end loop;

  if pg_catalog.array_length(v_missing, 1) > 0 then
    update public.tj_gr_receipt_events
       set status = 'waiting_mapping', updated_at = now()
     where id = v_id;
    insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
    values (v_uid, 'receipt_release_waiting_mapping', 'receipt_event', v_id::text,
            pg_catalog.jsonb_build_object('missing', to_jsonb(v_missing)));
    return pg_catalog.jsonb_build_object(
      'event', public.tj_gr_event_json(v_id),
      'tasks', '[]'::jsonb,
      'missing_mappings', to_jsonb(v_missing)
    );
  end if;

  foreach v_po in array e.po_ids loop
    select * into m from public.tj_gr_po_mappings where po_header_id = v_po;

    select id into v_existing from public.tj_gr_tasks
     where receipt_event_id = v_id and event_revision = e.revision and po_header_id = v_po;

    if v_existing is null then
      v_task_id := gen_random_uuid();
      v_payload := public.tj_gr_task_payload(
        v_task_id, v_id, v_po, m.irs_po_no,
        public.tj_gr_sha256(m.evidence::text));
      v_hash := public.tj_gr_sha256(public.tj_gr_task_canonical(v_id, v_payload));

      insert into public.tj_gr_tasks (
        id, receipt_event_id, event_revision, po_header_id, irs_po_no,
        payload, payload_sha256, event_payload_sha256, status
      ) values (
        v_task_id, v_id, e.revision, v_po, m.irs_po_no,
        v_payload, v_hash, e.payload_sha256, 'ready'
      );

      insert into public.tj_gr_outbox (
        request_id, kind, task_id, receipt_event_id, po_header_id,
        payload, payload_sha256, status, mock_only, created_by
      ) values (
        'gr:' || v_task_id::text, 'gr_task_dispatch', v_task_id, v_id, v_po,
        v_payload, v_hash, 'pending', true, v_uid
      ) on conflict (request_id) do nothing;
    end if;
  end loop;

  update public.tj_gr_receipt_events
     set status = 'released', released_by = v_uid, released_at = now(), updated_at = now()
   where id = v_id;

  select coalesce(jsonb_agg(public.tj_gr_task_json(t.id) order by t.po_header_id::text), '[]'::jsonb)
    into v_tasks
  from public.tj_gr_tasks t where t.receipt_event_id = v_id;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'receipt_release', 'receipt_event', v_id::text,
          pg_catalog.jsonb_build_object('tasks', pg_catalog.jsonb_array_length(v_tasks)));

  return pg_catalog.jsonb_build_object('event', public.tj_gr_event_json(v_id), 'tasks', v_tasks, 'missing_mappings', '[]'::jsonb);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 8) 动作：mapping_set / task_claim / task_result
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_mapping_set(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_po uuid := (p_data ->> 'po_header_id')::uuid;
  v_irs text := p_data ->> 'irs_po_no';
  v_evidence jsonb := coalesce(p_data -> 'evidence', '{}'::jsonb);
  v_row public.tj_gr_po_mappings%rowtype;
begin
  v_uid := public.tj_gr_require_role(array['approver']);

  if v_po is null or not exists (select 1 from public.tj_po_headers h where h.id = v_po) then
    perform public.tj_gr_fail('GR_NOT_FOUND', 'PO 不存在', pg_catalog.jsonb_build_object('po_header_id', v_po));
  end if;
  if v_irs is null or btrim(v_irs) = '' then
    perform public.tj_gr_fail('GR_VALIDATION', 'irs_po_no 必填（编号内容原样保存，不校验数字格式）',
      pg_catalog.jsonb_build_object('field','irs_po_no'));
  end if;
  if pg_catalog.jsonb_typeof(v_evidence) <> 'object' then
    perform public.tj_gr_fail('GR_VALIDATION', 'evidence 必须是对象（核对人/时间/来源）');
  end if;
  if coalesce(btrim(v_evidence ->> 'checked_by'), '') = '' then
    perform public.tj_gr_fail('GR_VALIDATION', 'evidence.checked_by 必填（不是布尔标志，而是核对证据）',
      pg_catalog.jsonb_build_object('field','evidence.checked_by'));
  end if;
  begin
    if (v_evidence ->> 'checked_at') is null or (v_evidence ->> 'checked_at')::timestamptz is null then
      perform public.tj_gr_fail('GR_VALIDATION', 'evidence.checked_at 必须是有效时间');
    end if;
  exception when others then
    perform public.tj_gr_fail('GR_VALIDATION', 'evidence.checked_at 必须是有效时间');
  end;
  if v_evidence ? 'irs_po_no' and (v_evidence ->> 'irs_po_no') is distinct from v_irs then
    perform public.tj_gr_fail('GR_VALIDATION', 'evidence.irs_po_no 与 irs_po_no 不一致');
  end if;

  insert into public.tj_gr_po_mappings as m
    (po_header_id, irs_po_no, evidence, verified_by, verified_at)
  values (v_po, v_irs, v_evidence, v_uid, now())
  on conflict (po_header_id) do update
    set irs_po_no = excluded.irs_po_no,
        evidence = excluded.evidence,
        verified_by = excluded.verified_by,
        verified_at = excluded.verified_at,
        updated_at = now()
  returning * into v_row;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'mapping_set', 'po_header', v_po::text,
          pg_catalog.jsonb_build_object('irs_po_no', v_irs));

  return pg_catalog.jsonb_build_object(
    'po_header_id', v_row.po_header_id,
    'irs_po_no', v_row.irs_po_no,
    'evidence', v_row.evidence,
    'verified_by', v_row.verified_by,
    'verified_at', public.tj_gr_ts_text(v_row.verified_at)
  );
end
$fn$;

create or replace function public.tj_gr_task_claim(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_task uuid := (p_data ->> 'task_id')::uuid;
  v_exec uuid := nullif(p_data ->> 'executor_id','')::uuid;
  t public.tj_gr_tasks%rowtype;
  v_roles text[];
begin
  v_uid := public.tj_gr_require_role(array['executor']);
  v_roles := public.tj_gr_roles();

  if v_exec is not null and v_exec <> v_uid and not ('admin' = any (v_roles)) then
    perform public.tj_gr_fail('GR_FORBIDDEN', 'executor_id 必须与当前登录用户一致');
  end if;

  select * into t from public.tj_gr_tasks where id = v_task for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '任务不存在', pg_catalog.jsonb_build_object('task_id', v_task));
  end if;

  if t.status = 'claimed' and t.lease_expires_at is not null and t.lease_expires_at < now() then
    if t.save_attempted_at is not null then
      update public.tj_gr_tasks
         set status = 'needs_review', last_error = 'lease 过期且已开始保存，禁止自动重发', updated_at = now()
       where id = v_task;
      perform public.tj_gr_fail('GR_TASK_STALE', '任务 lease 过期且已尝试保存：转人工核对，不盲目重发',
        pg_catalog.jsonb_build_object('task_id', v_task));
    else
      -- 未开始保存：允许重新领取（安全）
      null;
    end if;
  elsif t.status <> 'ready'
        and not (t.status = 'claimed' and (t.lease_expires_at is null or t.lease_expires_at < now())) then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.format('任务状态 %s 不能领取', t.status),
      pg_catalog.jsonb_build_object('status', t.status));
  end if;

  update public.tj_gr_tasks set
    status = 'claimed',
    claimed_by = v_uid,
    executor_id = coalesce(v_exec, v_uid),
    claimed_at = now(),
    lease_expires_at = now() + interval '5 minutes',
    attempt = attempt + 1,
    updated_at = now()
  where id = v_task
  returning * into t;

  update public.tj_gr_receipt_events
     set status = 'in_progress', updated_at = now()
   where id = t.receipt_event_id and status = 'released';

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'task_claim', 'gr_task', v_task::text,
          pg_catalog.jsonb_build_object('attempt', t.attempt));

  return public.tj_gr_task_json(v_task);
end
$fn$;

create or replace function public.tj_gr_task_result(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_task uuid := (p_data ->> 'task_id')::uuid;
  v_event uuid := (p_data ->> 'receipt_event_id')::uuid;
  v_hash text := p_data ->> 'payload_sha256';
  v_cb text := p_data ->> 'callback_id';
  v_type text := p_data ->> 'event_type';
  v_evidence jsonb := coalesce(p_data -> 'evidence', '{}'::jsonb);
  v_error text := p_data ->> 'error';
  t public.tj_gr_tasks%rowtype;
  v_roles text[];
  v_fp text;
  v_prev record;
  v_next text;
  v_mism jsonb;
  v_ev_status text;
  v_ok boolean := false;
  v_reject text;
begin
  v_uid := public.tj_gr_require_role(array['executor']);
  v_roles := public.tj_gr_roles();

  if v_cb is null or btrim(v_cb) = '' then
    perform public.tj_gr_fail('GR_VALIDATION', 'callback_id 必填（幂等键）');
  end if;
  if v_type not in ('save_attempted','saved','verified','failed','needs_review') then
    perform public.tj_gr_fail('GR_VALIDATION', '未知 event_type：' || coalesce(v_type,'(null)'));
  end if;

  select * into t from public.tj_gr_tasks where id = v_task for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '任务不存在', pg_catalog.jsonb_build_object('task_id', v_task));
  end if;

  if t.receipt_event_id <> v_event then
    perform public.tj_gr_fail('GR_VALIDATION', 'receipt_event_id 与任务不匹配');
  end if;
  if t.claimed_by is null or t.status = 'ready' then
    perform public.tj_gr_fail('GR_STATE', '任务必须先 task_claim 领取后才能回报结果',
      pg_catalog.jsonb_build_object('status', t.status));
  end if;
  if v_hash is null or v_hash <> t.payload_sha256 then
    perform public.tj_gr_fail('GR_VALIDATION', 'payload_sha256 与任务不一致（拒绝串任务/串版本）',
      pg_catalog.jsonb_build_object('expected', t.payload_sha256, 'actual', v_hash));
  end if;
  if t.claimed_by is not null and t.claimed_by <> v_uid and not ('admin' = any (v_roles)) then
    perform public.tj_gr_fail('GR_FORBIDDEN', '只有任务领取者可以回报结果');
  end if;
  if t.status = 'verified' then
    -- verified 是终态：只允许同 callback replay，下面按幂等处理
    null;
  end if;

  v_fp := public.tj_gr_sha256(
    v_task::text || '|' || v_type || '|' || coalesce(v_evidence, 'null'::jsonb)::text || '|' || coalesce(v_error, 'null'));

  select * into v_prev from public.tj_gr_task_callbacks
   where task_id = v_task and callback_id = v_cb and accepted
   order by id desc limit 1;

  if found then
    if v_prev.content_sha256 = v_fp then
      insert into public.tj_gr_task_callbacks
        (task_id, callback_id, content_sha256, event_type, actor, accepted, reject_code, body)
      values (v_task, v_cb, v_fp, v_type, v_uid, true, 'replay', v_evidence);
      return pg_catalog.jsonb_build_object(
        'task', public.tj_gr_task_json(v_task),
        'event_status', (select status from public.tj_gr_receipt_events where id = t.receipt_event_id),
        'replayed', true,
        'rejected', false
      );
    end if;
    insert into public.tj_gr_task_callbacks
      (task_id, callback_id, content_sha256, event_type, actor, accepted, reject_code, body)
    values (v_task, v_cb, v_fp, v_type, v_uid, false, 'GR_CALLBACK_CONFLICT', v_evidence);
    -- 不 raise：拒绝必须**提交**才能留下审计（raise 会连同审计一起回滚）。
    -- 任务状态不变，响应里带 rejected/code 供调用方判断。
    return pg_catalog.jsonb_build_object(
      'task', public.tj_gr_task_json(v_task),
      'event_status', (select status from public.tj_gr_receipt_events where id = t.receipt_event_id),
      'replayed', false,
      'rejected', true,
      'code', 'GR_CALLBACK_CONFLICT',
      'mismatches', '[]'::jsonb
    );
  end if;

  -- 状态迁移（与 receipt-tasks.js nextTaskStatus 同规则）
  if v_type = 'save_attempted' then
    if t.status = 'save_attempted' then
      v_next := 'save_attempted';
    elsif t.status in ('ready','claimed') then
      v_next := 'save_attempted';
    else
      v_reject := 'GR_CALLBACK_OUT_OF_ORDER';
    end if;
  elsif v_type = 'saved' then
    if t.status <> 'save_attempted' then
      v_reject := 'GR_CALLBACK_OUT_OF_ORDER';
    elsif not coalesce((v_evidence ->> 'bridge_ok')::boolean, false) then
      v_next := 'needs_review';
      v_error := coalesce(v_error, 'Bridge ok=false：视为失败，人工核对');
    else
      v_next := 'saved_unverified';
    end if;
  elsif v_type = 'verified' then
    if t.status <> 'saved_unverified' then
      v_reject := 'GR_CALLBACK_OUT_OF_ORDER';
    elsif not coalesce((v_evidence ->> 'bridge_ok')::boolean, false) then
      v_next := 'needs_review';
      v_error := coalesce(v_error, 'Bridge ok=false：视为失败');
    else
      v_mism := public.tj_gr_verify_evidence(v_task, v_evidence);
      if (v_mism ->> 'ok')::boolean then
        v_next := 'verified';
      else
        v_next := 'needs_review';
        v_error := 'verified 证据比对不通过（见 mismatches）';
      end if;
    end if;
  elsif v_type = 'failed' then
    if t.status = 'verified' then
      v_reject := 'GR_CALLBACK_OUT_OF_ORDER';
    elsif t.save_attempted_at is not null or t.status = 'save_attempted' then
      v_next := 'needs_review';
    else
      v_next := 'failed_unsaved';
    end if;
  else
    v_next := 'needs_review';
  end if;

  if v_reject is not null then
    insert into public.tj_gr_task_callbacks
      (task_id, callback_id, content_sha256, event_type, actor, accepted, reject_code, body)
    values (v_task, v_cb, v_fp, v_type, v_uid, false, v_reject, v_evidence);
    -- 同上：乱序/倒退拒绝也不 raise（要留审计、且状态确实没变）
    return pg_catalog.jsonb_build_object(
      'task', public.tj_gr_task_json(v_task),
      'event_status', (select status from public.tj_gr_receipt_events where id = t.receipt_event_id),
      'replayed', false,
      'rejected', true,
      'code', v_reject,
      'mismatches', '[]'::jsonb
    );
  end if;

  update public.tj_gr_tasks set
    status = v_next,
    callback_id = v_cb,
    bridge_ok = coalesce((v_evidence ->> 'bridge_ok')::boolean, bridge_ok),
    evidence = v_evidence,
    last_error = v_error,
    save_attempted_at = case when v_type = 'save_attempted' then coalesce(save_attempted_at, now()) else save_attempted_at end,
    saved_at = case when v_next in ('saved_unverified','verified') then coalesce(saved_at, now()) else saved_at end,
    verified_at = case when v_next = 'verified' then now() else verified_at end,
    lease_expires_at = case when v_next in ('verified','failed_unsaved','needs_review') then null else lease_expires_at end,
    updated_at = now()
  where id = v_task;

  insert into public.tj_gr_task_callbacks
    (task_id, callback_id, content_sha256, event_type, actor, accepted, reject_code, body)
  values (v_task, v_cb, v_fp, v_type, v_uid, true, null, v_evidence);

  -- 事件状态聚合（不掩盖单任务 needs_review）
  select
    case
      when exists (select 1 from public.tj_gr_tasks x where x.receipt_event_id = t.receipt_event_id
                      and x.status in ('needs_review','failed_unsaved')) then 'needs_review'
      when not exists (select 1 from public.tj_gr_tasks x where x.receipt_event_id = t.receipt_event_id
                          and x.status <> 'verified') then 'verified'
      when exists (select 1 from public.tj_gr_tasks x where x.receipt_event_id = t.receipt_event_id
                      and x.status = 'saved_unverified') then 'saved_unverified'
      when exists (select 1 from public.tj_gr_tasks x where x.receipt_event_id = t.receipt_event_id
                      and x.status in ('claimed','save_attempted')) then 'in_progress'
      else 'released'
    end into v_ev_status;

  update public.tj_gr_receipt_events
     set status = v_ev_status, updated_at = now()
   where id = t.receipt_event_id;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'task_result', 'gr_task', v_task::text,
          pg_catalog.jsonb_build_object('event_type', v_type, 'next', v_next,
            'mismatches', coalesce(v_mism -> 'mismatches', '[]'::jsonb)));

  return pg_catalog.jsonb_build_object(
    'task', public.tj_gr_task_json(v_task),
    'event_status', v_ev_status,
    'mismatches', coalesce(v_mism -> 'mismatches', '[]'::jsonb),
    'replayed', false,
    'rejected', false
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 9) 动作：po_save / po_push（旧 PO 安全修复；push 在 preview 硬禁）
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_request_begin(p_action text, p_request_id text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_hash text := public.tj_gr_sha256(p_data::text);
  r public.tj_gr_requests%rowtype;
begin
  if p_request_id is null or btrim(p_request_id) = '' then
    perform public.tj_gr_fail('GR_VALIDATION', 'request_id 必填（幂等键）', pg_catalog.jsonb_build_object('field','request_id'));
  end if;
  select * into r from public.tj_gr_requests where request_id = p_request_id;
  if found then
    if r.action <> p_action or r.request_hash <> v_hash then
      insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
      values (v_uid, p_action || '_idempotency_conflict', 'request', p_request_id,
              pg_catalog.jsonb_build_object('stored_action', r.action));
      perform public.tj_gr_fail('GR_IDEMPOTENCY_CONFLICT',
        '同一 request_id 已用于不同请求，拒绝重复提交',
        pg_catalog.jsonb_build_object('request_id', p_request_id));
    end if;
    return r.response;
  end if;
  return null;
end
$fn$;

create or replace function public.tj_gr_request_done(p_action text, p_request_id text, p_data jsonb, p_response jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.tj_gr_requests(request_id, action, actor, request_hash, response)
  values (p_request_id, p_action, auth.uid(), public.tj_gr_sha256(p_data::text), p_response)
  on conflict (request_id) do nothing;
end
$fn$;

create or replace function public.tj_gr_po_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select pg_catalog.jsonb_build_object(
    'id', h.id,
    'po_id', h.po_id,
    'status', h.status,
    'po_type', h.po_type,
    'po_revision', h.po_revision,
    'supplier_code', h.supplier_code,
    'supplier_name', h.supplier_name,
    'notes', h.notes,
    'created_by', h.created_by,
    'frozen', h.frozen,
    'website_po_date', public.tj_gr_date_text(h.website_po_date),
    'lines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id, 'line_no', l.line_no, 'item_code', l.item_code,
        'description', l.description, 'uom', l.uom,
        'qty', public.tj_gr_dec_text(l.qty),
        'unit_price', public.tj_gr_dec_text(l.unit_price),
        'original_qty', public.tj_gr_dec_text(l.original_qty),
        'accepted_qty', public.tj_gr_dec_text(l.accepted_qty),
        'note', l.note
      ) order by l.line_no, l.id::text)
      from public.tj_po_lines l where l.po_header_id = h.id
    ), '[]'::jsonb)
  )
  from public.tj_po_headers h where h.id = p_id
$fn$;

create or replace function public.tj_gr_po_save(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_request text := p_data ->> 'request_id';
  v_cached jsonb;
  v_id uuid := nullif(p_data ->> 'id','')::uuid;
  h public.tj_po_headers%rowtype;
  v_cur public.tj_po_lines%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_i int := 0;
  v_ref boolean;
  v_keep uuid[] := '{}';
  v_result jsonb;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  v_cached := public.tj_gr_request_begin('po_save', v_request, p_data);
  if v_cached is not null then
    return v_cached;
  end if;

  if v_id is null then
    v_id := gen_random_uuid();
  end if;

  select * into h from public.tj_po_headers where id = v_id for update;

  if found then
    if h.frozen then
      perform public.tj_gr_fail('GR_STATE', '已批准冻结的 PO 不能通过 po_save 修改（po_id=' || h.po_id || '）',
        pg_catalog.jsonb_build_object('po_id', h.po_id));
    end if;
    if p_data ? 'supplier_code' and (p_data ->> 'supplier_code') is not null
       and (p_data ->> 'supplier_code') <> h.supplier_code then
      -- 供应商变更会影响已引用收货：拒绝（避免历史来源错挂）
      if exists (select 1 from public.tj_gr_line_sources s
                 join public.tj_po_lines l on l.id = s.po_line_id
                 where l.po_header_id = h.id) then
        perform public.tj_gr_fail('GR_STATE', '该 PO 已被收货引用，不能改供应商');
      end if;
    end if;

    update public.tj_po_headers set
      supplier_code = coalesce(p_data ->> 'supplier_code', supplier_code),
      supplier_name = coalesce(p_data ->> 'supplier_name', supplier_name),
      notes = case when p_data ? 'notes' then p_data ->> 'notes' else notes end,
      updated_at = now()
    where id = v_id;
  else
    insert into public.tj_po_headers (id, supplier_code, supplier_name, status, po_type, notes, created_by)
    values (v_id,
            p_data ->> 'supplier_code',
            p_data ->> 'supplier_name',
            'confirmed',
            'standard',
            p_data ->> 'notes',
            coalesce(nullif(p_data ->> 'created_by',''), v_uid::text));
  end if;

  if pg_catalog.jsonb_typeof(p_data -> 'lines') = 'array' then
    for v_line in select value from pg_catalog.jsonb_array_elements(p_data -> 'lines') loop
      v_i := v_i + 1;
      v_line_id := nullif(v_line ->> 'id','')::uuid;

      if v_line_id is not null then
        -- 稳定明细 id：存在则更新；被收货引用时业务字段不可改
        if exists (select 1 from public.tj_po_lines l where l.id = v_line_id and l.po_header_id = v_id) then
          select * into v_cur from public.tj_po_lines where id = v_line_id;
          select exists (
            select 1 from public.tj_gr_line_sources s where s.po_line_id = v_line_id
          ) into v_ref;

          if v_ref then
            -- 已被收货引用：业务字段必须与原值一致（显式拒绝，不能静默忽略调用方修改）
            if (v_line ? 'item_code' and (v_line ->> 'item_code') is distinct from v_cur.item_code)
               or (v_line ? 'uom' and coalesce(v_line ->> 'uom','') is distinct from coalesce(v_cur.uom,''))
               or (v_line ? 'description' and coalesce(v_line ->> 'description','') is distinct from coalesce(v_cur.description,''))
               or (v_line ? 'unit_price' and public.tj_gr_dec(v_line -> 'unit_price','unit_price') is distinct from v_cur.unit_price)
               or (v_line ? 'qty' and public.tj_gr_dec(v_line -> 'qty','qty') is distinct from v_cur.qty)
            then
              perform public.tj_gr_fail('GR_STATE',
                '明细已被收货引用：item_code/uom/description/qty/unit_price 不可修改',
                pg_catalog.jsonb_build_object('po_line_id', v_line_id));
            end if;

            update public.tj_po_lines set
              line_no = coalesce((v_line ->> 'line_no')::int, line_no),
              note = coalesce(v_line ->> 'note', note)
            where id = v_line_id;
          else
            update public.tj_po_lines set
              line_no = coalesce((v_line ->> 'line_no')::int, line_no),
              description = coalesce(v_line ->> 'description', description),
              note = coalesce(v_line ->> 'note', note),
              item_code = coalesce(v_line ->> 'item_code', item_code),
              uom = coalesce(v_line ->> 'uom', uom),
              unit_price = coalesce(public.tj_gr_dec(v_line -> 'unit_price','unit_price'), unit_price),
              qty = coalesce(public.tj_gr_dec(v_line -> 'qty','qty'), qty)
            where id = v_line_id;
          end if;
        else
          insert into public.tj_po_lines
            (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
          values (
            v_line_id, v_id,
            coalesce((v_line ->> 'line_no')::int, v_i),
            v_line ->> 'item_code',
            v_line ->> 'description',
            v_line ->> 'uom',
            public.tj_gr_dec(v_line -> 'qty','qty'),
            public.tj_gr_dec(v_line -> 'unit_price','unit_price'));
        end if;
        v_keep := v_keep || v_line_id;
      else
        insert into public.tj_po_lines
          (po_header_id, line_no, item_code, description, uom, qty, unit_price)
        values (
          v_id,
          coalesce((v_line ->> 'line_no')::int, v_i),
          v_line ->> 'item_code',
          v_line ->> 'description',
          v_line ->> 'uom',
          public.tj_gr_dec(v_line -> 'qty','qty'),
          public.tj_gr_dec(v_line -> 'unit_price','unit_price'))
        returning id into v_line_id;
        v_keep := v_keep || v_line_id;
      end if;
    end loop;

    -- 只删除“本次未提交且未被收货引用”的明细；已引用明细禁止删除
    if exists (
      select 1 from public.tj_po_lines l
      where l.po_header_id = v_id
        and not (l.id = any (v_keep))
        and exists (select 1 from public.tj_gr_line_sources s where s.po_line_id = l.id)
    ) then
      perform public.tj_gr_fail('GR_STATE', '已被收货引用的明细不能删除', pg_catalog.jsonb_build_object('po_id', v_id));
    end if;
    delete from public.tj_po_lines l
     where l.po_header_id = v_id and not (l.id = any (v_keep));
  end if;

  v_result := public.tj_gr_po_json(v_id);
  perform public.tj_gr_request_done('po_save', v_request, p_data, v_result);

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'po_save', 'po_header', v_id::text, pg_catalog.jsonb_build_object('lines', v_i));

  return v_result;
end
$fn$;

create or replace function public.tj_gr_po_push(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_request text := p_data ->> 'request_id';
  v_cached jsonb;
  v_id uuid := (p_data ->> 'id')::uuid;
  v_po text;
  v_rev int := nullif(p_data ->> 'po_revision','')::int;
  v_outbox uuid;
  v_result jsonb;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  -- 预览隔离库：任何 push/出队一律硬禁（含普通测试单）
  if false then
    perform public.tj_gr_fail('GR_PUSH_BLOCKED',
      '预览隔离库禁止任何推送/出队（含普通单）；GR 任务也只允许 mock dispatcher',
      pg_catalog.jsonb_build_object('po_id', v_id));
  end if;

  v_cached := public.tj_gr_request_begin('po_push', v_request, p_data);
  if v_cached is not null then
    return v_cached;
  end if;

  -- 严格 CAS：不改 7 列业务字段、不改明细，只推进状态
  update public.tj_po_headers set status = 'pending_push', updated_at = now()
   where id = v_id
     and status = 'confirmed'
     and frozen = false
     and (v_rev is null or po_revision = v_rev)
  returning po_id into v_po;

  if v_po is null then
    perform public.tj_gr_fail('GR_STATE', 'CAS 失败：PO 状态/修订已变化或已冻结，未推送',
      pg_catalog.jsonb_build_object('id', v_id));
  end if;

  insert into public.tj_gr_outbox (request_id, kind, po_header_id, payload, payload_sha256, mock_only, created_by)
  values (v_request, 'po_push', v_id,
          pg_catalog.jsonb_build_object('po_id', v_po, 'po_header_id', v_id, 'revision', v_rev),
          public.tj_gr_sha256(v_po), false, v_uid)
  on conflict (request_id) do nothing
  returning id into v_outbox;

  v_result := pg_catalog.jsonb_build_object('po_id', v_po, 'status', 'pending_push',
    'outbox_id', v_outbox, 'request_id', v_request);
  perform public.tj_gr_request_done('po_push', v_request, p_data, v_result);
  return v_result;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 10) 动作：combine_create / submit / approve / cancel（保留 v2 快照语义）
-- ----------------------------------------------------------------------------

-- v2 批准快照 canonical（与 web/src/lib/core/approved-snapshot.js 逐字节一致）
create or replace function public.tj_gr_approval_canonical(p_header_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  h public.tj_po_headers%rowtype;
  v_lines text := '';
  l record;
  v_refs text;
  r record;
begin
  select * into h from public.tj_po_headers where id = p_header_id;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', 'PO 不存在');
  end if;
  if h.website_po_date is null then
    perform public.tj_gr_fail('GR_VALIDATION', '批准快照缺少 Website PO Date');
  end if;

  for l in
    select * from public.tj_po_lines
    where po_header_id = p_header_id order by line_no, id::text
  loop
    v_refs := '';
    for r in
      select * from pg_catalog.jsonb_array_elements(coalesce(l.source_refs, '[]'::jsonb)) as x
    loop
      v_refs := v_refs
        || case when v_refs = '' then '' else ',' end
        || pg_catalog.format('{"po_id":%s,"po_number":%s,"line_id":%s,"qty":%s}',
             to_jsonb(coalesce(r.value ->> 'po_id',''))::text,
             to_jsonb(coalesce(r.value ->> 'po_number',''))::text,
             to_jsonb(coalesce(r.value ->> 'line_id',''))::text,
             public.tj_gr_dec_text(coalesce((r.value ->> 'qty')::numeric, 0)));
    end loop;

    v_lines := v_lines
      || case when v_lines = '' then '' else ',' end
      || pg_catalog.format(
           '{"line_no":%s,"item_code":%s,"description":%s,"uom":%s,"ordered_qty":%s,"accepted_qty":%s,"unit_price":%s,"note":%s,"source_refs":[%s]}',
           l.line_no,
           to_jsonb(coalesce(l.item_code,''))::text,
           to_jsonb(coalesce(l.description,''))::text,
           to_jsonb(coalesce(l.uom,''))::text,
           public.tj_gr_dec_text(coalesce(l.original_qty, l.qty)),
           public.tj_gr_dec_text(coalesce(l.accepted_qty, l.qty)),
           public.tj_gr_dec_text(l.unit_price),
           to_jsonb(coalesce(l.note,''))::text,
           v_refs);
  end loop;

  return pg_catalog.format(
    '{"snapshot_version":2,"po_id":%s,"po_type":%s,"website_po_date":%s,"lines":[%s]}',
    to_jsonb(coalesce(h.po_id,''))::text,
    to_jsonb(coalesce(h.po_type,''))::text,
    to_jsonb(public.tj_gr_date_text(h.website_po_date))::text,
    v_lines);
end
$fn$;

create or replace function public.tj_gr_combine_create(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_request text := p_data ->> 'request_id';
  v_cached jsonb;
  v_sources uuid[];
  v_n int;
  v_supplier text;
  v_date date;
  v_id uuid;
  v_po text;
  v_line jsonb;
  v_ref record;
  v_i int := 0;
  v_key text;
  v_refs jsonb;
  v_ordered numeric;
  v_accepted numeric;
  v_first_po uuid;
  v_first_line uuid;
  v_result jsonb;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  v_cached := public.tj_gr_request_begin('combine_create', v_request, p_data);
  if v_cached is not null then
    return v_cached;
  end if;

  if pg_catalog.jsonb_typeof(p_data -> 'source_ids') <> 'array'
     or pg_catalog.jsonb_array_length(p_data -> 'source_ids') < 2 then
    perform public.tj_gr_fail('GR_VALIDATION', '合并至少需要 2 张来源 PO', pg_catalog.jsonb_build_object('field','source_ids'));
  end if;
  select pg_catalog.array_agg(value::uuid) into v_sources
  from pg_catalog.jsonb_array_elements_text(p_data -> 'source_ids') as v(value);
  v_n := pg_catalog.array_length(v_sources, 1);

  -- 锁来源单（顺序一致，避免并发同时并同一张单）
  perform 1 from public.tj_po_headers h where h.id = any (v_sources) order by h.id for update;
  select pg_catalog.count(*), pg_catalog.min(h.supplier_code)
    into v_i, v_supplier
  from public.tj_po_headers h where h.id = any (v_sources);
  if v_i <> v_n then
    perform public.tj_gr_fail('GR_NOT_FOUND', '来源 PO 不存在');
  end if;
  if (select pg_catalog.count(distinct h.status) from public.tj_po_headers h where h.id = any (v_sources)) > 1
     or (select pg_catalog.min(h.status) from public.tj_po_headers h where h.id = any (v_sources)) <> 'confirmed' then
    perform public.tj_gr_fail('GR_STATE', '来源 PO 必须全部是 confirmed 状态');
  end if;
  if (select pg_catalog.count(distinct h.supplier_code) from public.tj_po_headers h where h.id = any (v_sources)) > 1 then
    perform public.tj_gr_fail('GR_VALIDATION', '合并来源必须同一供应商');
  end if;
  if (select pg_catalog.count(*) from public.tj_po_headers h
       where h.id = any (v_sources) and h.po_type = 'standard') <> v_n then
    perform public.tj_gr_fail('GR_STATE', '来源 PO 必须是普通单（standard）');
  end if;
  -- 已被其他合并单占用 → 拒绝
  if exists (
    select 1 from public.tj_po_headers c
    where c.po_type = 'combined'
      and c.status <> 'cancelled'
      and c.source_po_ids && (select pg_catalog.array_agg(h.po_id) from public.tj_po_headers h where h.id = any (v_sources))
  ) then
    perform public.tj_gr_fail('GR_STATE', '来源 PO 已被其他合并单占用');
  end if;

  if (p_data ->> 'website_po_date') is null
     or (p_data ->> 'website_po_date') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.tj_gr_fail('GR_VALIDATION', 'website_po_date 必填 yyyy-MM-dd（不默认当天）',
      pg_catalog.jsonb_build_object('field','website_po_date'));
  end if;
  v_date := (p_data ->> 'website_po_date')::date;

  v_id := gen_random_uuid();
  insert into public.tj_po_headers
    (id, supplier_code, supplier_name, status, po_type, source_po_ids, website_po_date,
     po_revision, created_by)
  values (
    v_id, v_supplier,
    (select h.supplier_name from public.tj_po_headers h where h.id = v_sources[1]),
    'draft', 'combined', (select pg_catalog.array_agg(h.po_id) from public.tj_po_headers h where h.id = any (v_sources)),
    v_date, 1, coalesce(nullif(p_data ->> 'created_by',''), v_uid::text))
  returning po_id into v_po;

  if pg_catalog.jsonb_typeof(p_data -> 'lines') <> 'array'
     or pg_catalog.jsonb_array_length(p_data -> 'lines') = 0 then
    perform public.tj_gr_fail('GR_VALIDATION', '合并单必须有明细行');
  end if;

  for v_line in select value from pg_catalog.jsonb_array_elements(p_data -> 'lines') loop
    v_i := v_i + 1;
    if pg_catalog.jsonb_typeof(v_line -> 'source_refs') <> 'array'
       or pg_catalog.jsonb_array_length(v_line -> 'source_refs') = 0 then
      perform public.tj_gr_fail('GR_VALIDATION', '合并行必须带 source_refs（来源追溯）');
    end if;

    v_ordered := 0;
    v_refs := '[]'::jsonb;
    v_first_po := null;
    v_first_line := null;

    for v_ref in
      select value from pg_catalog.jsonb_array_elements(v_line -> 'source_refs')
    loop
      -- 每个 ref 必须真实属于来源单，且 item/uom/price 与合并行一致
      declare
        v_l record;
        v_qty numeric;
      begin
        select l.id, l.po_header_id, l.item_code, l.uom, l.unit_price, h.po_id as po_no
          into v_l
        from public.tj_po_lines l
        join public.tj_po_headers h on h.id = l.po_header_id
        where l.id = (v_ref.value ->> 'line_id')::uuid
          and l.po_header_id = (v_ref.value ->> 'po_id')::uuid;

        if not found then
          perform public.tj_gr_fail('GR_VALIDATION', 'source_refs 指向不存在的来源明细');
        end if;
        if not (v_l.po_header_id = any (v_sources)) then
          perform public.tj_gr_fail('GR_VALIDATION', 'source_refs 含非来源 PO');
        end if;
        if v_l.item_code <> (v_line ->> 'item_code')
           or coalesce(v_l.uom,'') <> coalesce(v_line ->> 'uom','')
           or v_l.unit_price <> public.tj_gr_dec(v_line -> 'unit_price','unit_price') then
          perform public.tj_gr_fail('GR_SOURCE_MISMATCH',
            '合并行的 item/uom/单价与来源明细不一致（不同 UOM/单价必须分行）');
        end if;

        v_qty := public.tj_gr_dec(v_ref.value -> 'qty', 'source_refs.qty');
        v_ordered := v_ordered + v_qty;
        if v_first_po is null then
          v_first_po := v_l.po_header_id;
          v_first_line := v_l.id;
        end if;

        v_refs := v_refs || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'po_id', v_l.po_header_id,
          'po_number', v_l.po_no,
          'line_id', v_l.id,
          'qty', v_qty
        ));
      end;
    end loop;

    if (v_line ->> 'ordered_qty') is not null
       and public.tj_gr_dec(v_line -> 'ordered_qty','ordered_qty') <> v_ordered then
      perform public.tj_gr_fail('GR_QTY_MISMATCH', '合并行 ordered_qty 与 source_refs 合计不一致');
    end if;

    v_accepted := coalesce(public.tj_gr_dec(v_line -> 'accepted_qty','accepted_qty'), v_ordered);
    if v_accepted > v_ordered then
      perform public.tj_gr_fail('GR_QTY_MISMATCH', '合并行 accepted_qty 不能超过订购量');
    end if;

    insert into public.tj_po_lines
      (po_header_id, line_no, item_code, description, uom, qty, unit_price,
       source_po_id, source_line_id, source_refs, original_qty, accepted_qty, note)
    values (
      v_id,
      coalesce((v_line ->> 'line_no')::int, v_i),
      v_line ->> 'item_code',
      v_line ->> 'description',
      v_line ->> 'uom',
      v_ordered,
      public.tj_gr_dec(v_line -> 'unit_price','unit_price'),
      v_first_po, v_first_line, v_refs, v_ordered, v_accepted, v_line ->> 'note');
  end loop;

  -- 来源单标记 combining（未冻结，允许）
  update public.tj_po_headers set status = 'combining', updated_at = now()
   where id = any (v_sources) and status = 'confirmed' and frozen = false;

  v_result := pg_catalog.jsonb_build_object('id', v_id, 'po_id', v_po, 'status', 'draft',
    'source_ids', to_jsonb(v_sources));
  perform public.tj_gr_request_done('combine_create', v_request, p_data, v_result);

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'combine_create', 'po_header', v_id::text,
          pg_catalog.jsonb_build_object('sources', to_jsonb(v_sources), 'lines', v_i));

  return public.tj_gr_po_json(v_id);
end
$fn$;

create or replace function public.tj_gr_combine_submit(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid := (p_data ->> 'id')::uuid;
  h public.tj_po_headers%rowtype;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  select * into h from public.tj_po_headers where id = v_id for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '合并单不存在');
  end if;
  if h.po_type <> 'combined' or h.status <> 'draft' or h.frozen then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.format('合并单当前状态 %s 不能提交审批', h.status),
      pg_catalog.jsonb_build_object('status', h.status));
  end if;
  if h.website_po_date is null then
    perform public.tj_gr_fail('GR_VALIDATION', '缺少 Website PO Date，不能提交审批（不默认当天）');
  end if;

  update public.tj_po_headers set
    status = 'pending_approval',
    checked_by = coalesce(p_data ->> 'checked_by', checked_by),
    delivery_order_no = coalesce(p_data ->> 'delivery_order_no', delivery_order_no),
    receipt_event_id = coalesce(receipt_event_id, gen_random_uuid()::text),
    received_at = coalesce(received_at, now()),
    updated_at = now()
  where id = v_id;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'combine_submit', 'po_header', v_id::text, '{}'::jsonb);

  return public.tj_gr_po_json(v_id);
end
$fn$;

create or replace function public.tj_gr_combine_approve(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid := (p_data ->> 'id')::uuid;
  h public.tj_po_headers%rowtype;
  v_hash text;
  v_src text;
begin
  v_uid := public.tj_gr_require_role(array['approver']);

  select * into h from public.tj_po_headers where id = v_id for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '合并单不存在');
  end if;
  if h.po_type <> 'combined' or h.status <> 'pending_approval' or h.frozen then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.format('合并单当前状态 %s 不能批准', h.status),
      pg_catalog.jsonb_build_object('status', h.status));
  end if;
  if h.website_po_date is null then
    perform public.tj_gr_fail('GR_VALIDATION', '缺少 Website PO Date，不能批准');
  end if;
  if not exists (select 1 from public.tj_po_lines l where l.po_header_id = v_id) then
    perform public.tj_gr_fail('GR_VALIDATION', '合并单没有明细，不能批准');
  end if;

  v_hash := public.tj_gr_sha256(public.tj_gr_approval_canonical(v_id));

  update public.tj_po_headers set
    status = 'confirmed',
    frozen = true,
    approved_by = v_uid::text,
    approved_at = now(),
    source_sha256 = v_hash,
    approval_snapshot_version = 2,
    updated_at = now()
  where id = v_id;

  foreach v_src in array h.source_po_ids loop
    update public.tj_po_headers set status = 'combined', updated_at = now()
     where po_id = v_src and frozen = false;
  end loop;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'combine_approve', 'po_header', v_id::text,
          pg_catalog.jsonb_build_object('source_sha256', v_hash, 'snapshot_version', 2));

  return public.tj_gr_po_json(v_id);
end
$fn$;

create or replace function public.tj_gr_combine_cancel(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_id uuid := (p_data ->> 'id')::uuid;
  h public.tj_po_headers%rowtype;
  v_src text;
begin
  v_uid := public.tj_gr_require_role(array['staff','approver']);

  select * into h from public.tj_po_headers where id = v_id for update;
  if not found then
    perform public.tj_gr_fail('GR_NOT_FOUND', '合并单不存在');
  end if;
  if h.po_type <> 'combined' or h.status not in ('draft','pending_approval') or h.frozen then
    perform public.tj_gr_fail('GR_STATE', pg_catalog.jsonb_build_object('status', h.status)::text);
  end if;

  update public.tj_po_headers set status = 'cancelled', updated_at = now() where id = v_id;

  foreach v_src in array coalesce(h.source_po_ids, '{}'::text[]) loop
    update public.tj_po_headers set status = 'confirmed', updated_at = now()
     where po_id = v_src and status = 'combining' and frozen = false;
  end loop;

  insert into public.tj_gr_audit(actor, action, entity, entity_id, detail)
  values (v_uid, 'combine_cancel', 'po_header', v_id::text, '{}'::jsonb);

  return public.tj_gr_po_json(v_id);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 11) dispatcher：单一 PostgREST 入口
-- ----------------------------------------------------------------------------
create or replace function public.tj_gr_api(p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_result jsonb;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform public.tj_gr_fail('GR_AUTH_REQUIRED', '需要真实登录用户（auth.uid() 为空）');
  end if;
  if p_action is null or btrim(p_action) = '' then
    perform public.tj_gr_fail('GR_VALIDATION', 'p_action 必填');
  end if;

  -- 读动作也必须 membership（definer 会绕过 RLS，不能只靠表策略）
  if p_action in ('receipt_list', 'receipt_get') then
    perform public.tj_gr_require_role(array['staff', 'approver', 'executor']);
  end if;

  case p_action
    when 'session' then
      v_result := pg_catalog.jsonb_build_object(
        'user_id', v_uid,
        'roles', to_jsonb(public.tj_gr_roles()),
        'is_admin', ('admin' = any (public.tj_gr_roles())),
        'active', public.tj_gr_is_member()
      );
    when 'receipt_list' then
      v_result := public.tj_gr_receipt_list(p_data);
    when 'receipt_get' then
      if not exists (select 1 from public.tj_gr_receipt_events where id = (p_data ->> 'id')::uuid) then
        perform public.tj_gr_fail('GR_NOT_FOUND', '收货事件不存在');
      end if;
      v_result := public.tj_gr_event_json((p_data ->> 'id')::uuid);
    when 'receipt_save' then
      v_result := public.tj_gr_receipt_save(p_data);
    when 'receipt_submit' then
      v_result := public.tj_gr_receipt_submit(p_data);
    when 'receipt_approve' then
      v_result := public.tj_gr_receipt_approve(p_data);
    when 'receipt_release' then
      v_result := public.tj_gr_receipt_release(p_data);
    when 'task_claim' then
      v_result := public.tj_gr_task_claim(p_data);
    when 'task_result' then
      v_result := public.tj_gr_task_result(p_data);
    when 'mapping_set' then
      v_result := public.tj_gr_mapping_set(p_data);
    when 'po_save' then
      v_result := public.tj_gr_po_save(p_data);
    when 'po_push' then
      v_result := public.tj_gr_po_push(p_data);
    when 'combine_create' then
      v_result := public.tj_gr_combine_create(p_data);
    when 'combine_submit' then
      v_result := public.tj_gr_combine_submit(p_data);
    when 'combine_approve' then
      v_result := public.tj_gr_combine_approve(p_data);
    when 'combine_cancel' then
      v_result := public.tj_gr_combine_cancel(p_data);
    else
      perform public.tj_gr_fail('GR_VALIDATION', '未知动作：' || p_action,
        pg_catalog.jsonb_build_object('action', p_action));
  end case;

  return v_result;
exception
  when others then
    -- 已是本模块的可识别 JSON 错误 → 原样抛出
    if sqlerrm like '{%' and sqlerrm like '%"code":%' then
      raise;
    end if;
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.jsonb_build_object(
        'code', 'GR_DB_ERROR',
        'message', sqlerrm,
        'detail', pg_catalog.jsonb_build_object('sqlstate', sqlstate)
      )::text;
end
$fn$;

create or replace function public.tj_gr_receipt_list(p_data jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(pg_catalog.jsonb_agg(public.tj_gr_event_summary_json(e.id) order by e.created_at desc), '[]'::jsonb)
  from (
    select e2.*
    from public.tj_gr_receipt_events e2
    where (
            (p_data ->> 'status') is null
            or e2.status = any (pg_catalog.string_to_array(p_data ->> 'status', ','))
            or exists (
              select 1 from pg_catalog.jsonb_array_elements_text(
                case when pg_catalog.jsonb_typeof(p_data -> 'status') = 'array' then p_data -> 'status' else '[]'::jsonb end
              ) s where s.value = e2.status
            )
          )
      and (nullif(p_data ->> 'po_id', '') is null
           or (p_data ->> 'po_id')::uuid = any (e2.po_ids))
    order by e2.created_at desc
    limit greatest(1, least(coalesce((p_data ->> 'limit')::int, 50), 200))
  ) e
$fn$;

-- ----------------------------------------------------------------------------
-- 12) 安全：RLS / 权限 / 只读策略 / 撤销直写
-- ----------------------------------------------------------------------------
alter table public.tj_gr_memberships     enable row level security;
alter table public.tj_gr_receipt_events  enable row level security;
alter table public.tj_gr_receipt_lines   enable row level security;
alter table public.tj_gr_line_sources    enable row level security;
alter table public.tj_gr_po_mappings     enable row level security;
alter table public.tj_gr_tasks           enable row level security;
alter table public.tj_gr_task_callbacks  enable row level security;
alter table public.tj_gr_outbox          enable row level security;
alter table public.tj_gr_requests        enable row level security;
alter table public.tj_gr_audit           enable row level security;

-- 成员表：只能看自己（admin 例外由 RPC/session 提供）
drop policy if exists gr_memberships_self_read on public.tj_gr_memberships;
create policy gr_memberships_self_read on public.tj_gr_memberships
  for select to authenticated
  using (user_id = auth.uid());

-- 业务表：membership 只读（无写策略 → 直写被拒）
do $policies$
declare
  t text;
begin
  foreach t in array array[
    'tj_gr_receipt_events','tj_gr_receipt_lines','tj_gr_line_sources',
    'tj_gr_po_mappings','tj_gr_tasks','tj_gr_task_callbacks','tj_gr_outbox',
    'tj_gr_requests','tj_gr_audit'
  ] loop
    execute pg_catalog.format('drop policy if exists gr_member_read on public.%I', t);
    execute pg_catalog.format(
      'create policy gr_member_read on public.%I for select to authenticated using (public.tj_gr_is_member())', t);
  end loop;
end
$policies$;

-- 权限：anon 完全无权；authenticated 只读；写只能经 definer RPC
do $grants$
declare
  t text;
begin
  foreach t in array array[
    'tj_gr_memberships','tj_gr_receipt_events','tj_gr_receipt_lines','tj_gr_line_sources',
    'tj_gr_po_mappings','tj_gr_tasks','tj_gr_task_callbacks','tj_gr_outbox',
    'tj_gr_requests','tj_gr_audit'
  ] loop
    execute pg_catalog.format('revoke all on public.%I from anon', t);
    execute pg_catalog.format('revoke all on public.%I from authenticated', t);
    execute pg_catalog.format('grant select on public.%I to authenticated', t);
  end loop;
  execute 'revoke all on sequence public.tj_gr_task_callbacks_id_seq from anon, authenticated';
  execute 'revoke all on sequence public.tj_gr_audit_id_seq from anon, authenticated';
end
$grants$;

grant usage on schema public to authenticated;
grant execute on function public.tj_gr_is_member() to authenticated;
grant execute on function public.tj_gr_roles() to authenticated;
grant execute on function public.tj_gr_api(text, jsonb) to authenticated;

revoke all on function public.tj_gr_api(text, jsonb) from public;
revoke all on function public.tj_gr_api(text, jsonb) from anon;
revoke all on function public.tj_gr_is_member() from public, anon;
revoke all on function public.tj_gr_roles() from public, anon;

-- service_role 可能在某些环境不存在（本地 harness）→ 有则撤，无则跳过
do $revoke_sr$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'service_role') then
    execute 'revoke all on function public.tj_gr_api(text, jsonb) from service_role';
    execute 'revoke all on function public.tj_gr_is_member() from service_role';
    execute 'revoke all on function public.tj_gr_roles() from service_role';
  end if;
end
$revoke_sr$;

-- service_role 不得拥有 public USAGE（保持生产推送器天然隔离）
do $sr$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'service_role') then
    execute 'revoke all on schema public from service_role';
    execute 'revoke all on all tables in schema public from service_role';
    execute 'revoke all on all functions in schema public from service_role';
    execute 'revoke all on all sequences in schema public from service_role';
  end if;
end
$sr$;



-- ----------------------------------------------------------------------------
-- 13) 读回校验（应用后手工执行或由集成测试覆盖）
-- ----------------------------------------------------------------------------
-- select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname like 'tj_gr_%';
-- select has_schema_privilege('service_role', 'public', 'USAGE');       -- 预览库必须 false
-- select has_function_privilege('anon', 'public.tj_gr_api(text,jsonb)', 'EXECUTE');  -- 必须 false
-- select has_table_privilege('authenticated', 'public.tj_gr_receipt_events', 'INSERT'); -- 必须 false
-- select proname, prosecdef, proconfig from pg_catalog.pg_proc p
--  join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef;

-- ----------------------------------------------------------------------------
-- 14) 回滚（只撤本轮新对象；不 DROP 旧表/列/索引/guard）
-- ----------------------------------------------------------------------------
-- drop function if exists public.tj_gr_api(text, jsonb);
-- drop function if exists public.tj_gr_receipt_list(jsonb);
-- ... 其余 tj_gr_* 函数逐个 drop（见文件内 create or replace 清单）
-- drop table if exists public.tj_gr_audit, public.tj_gr_requests,
--   public.tj_gr_outbox, public.tj_gr_task_callbacks, public.tj_gr_tasks,
--   public.tj_gr_po_mappings, public.tj_gr_line_sources,
--   public.tj_gr_receipt_lines, public.tj_gr_receipt_events, public.tj_gr_memberships;
-- 注意：回滚前先确认没有已 approved/verified 的收货证据需要保留；不要 DROP SCHEMA CASCADE。
