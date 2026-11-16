-- ============================================================================
-- TJ-AI-Ops — PO Save/Queue Done ACK（Windows→Website）隔离预览 tj_preview 版
-- 文件名：20261116_po_done_ack_preview.sql
--
-- 【状态：PREPARED，由主脑在 tj_preview 单独应用；绝不动 public】
--   * 本文件没有任何 public.* 可执行语句；只操作 tj_preview。
--   * 与 public 版（20261115_po_done_ack.sql）同一契约同一判定，仅作用于隔离预览 schema，
--     使 tj_preview 的测试 PO（PO-000025/26）能走完整 Preview ACK 回环，而不是把
--     Preview 回执错误写进 public。
--   * additive：只加列 / 建表 / 建函数，不改既有列/约束/数据。
--   * 幂等：IF NOT EXISTS / CREATE OR REPLACE。
--   * 不写 begin/commit，便于在事务中试跑后 ROLLBACK。
--
-- 与 public 版唯一语义差异（隔离预览必须适配）：
--   tj_preview.tj_po_headers 有 trg_tj_po_irs_guard 触发器（写 irs_po_no 必须带
--   irs_po_no_verified_at + irs_po_no_verified_by 证据）。PO Done ACK 的 accepted
--   本身就是「Windows 保存后人工核对」的验证证据，故 accepted 分支同时写入这两个
--   验证字段（verified_by 记为 po-ack:<actor uuid>，可追溯到调用 worker）。
--   public 无该触发器、无这两个列，故 public 版不写这两个字段。
--
-- 认证：复用 Supabase Auth（password 登录）+ 角色成员表 tj_preview.tj_po_ack_workers，
--   镜像 tj_preview.tj_gr_memberships 的 require_role 模式。调用者必须携带真实用户
--   JWT（auth.uid() 非空）且是该表 role='executor'/'admin' 的 active 成员；
--   anon 无 EXECUTE 权限，service_role 不经此通道（绕过 auth.uid()，且对 tj_preview
--   无 USAGE）。注意：security definer 不改变 auth.uid()——它读 PostgREST 按 JWT 设的
--   request.jwt.claim.sub GUC，仍返回原始调用者（worker），不是函数 owner。
--
-- 关键：tj_po_push_intents.content_sha256 = 业务 JSON 摘要（非 XLSX 哈希）。
--   真实 XLSX 字节 sha256 记录在 xlsx_sha256 列，ACK 只与它比较。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 投递清单表（隔离预览）：记录真实 XLSX 字节 sha256。
--    镜像 public 版 20261114_po_push_intents.sql + 20261115 的 xlsx_sha256 列。
-- ----------------------------------------------------------------------------
create table if not exists tj_preview.tj_po_push_intents (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references tj_preview.tj_po_headers (id) on delete restrict,
  po_id text not null,
  content_sha256 text not null,
  xlsx_sha256 text,
  state text not null default 'dispatch_started'
    check (state in ('dispatch_started', 'delivered', 'delivery_uncertain', 'needs_review')),
  filename text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_tj_po_push_intents_po_header
  on tj_preview.tj_po_push_intents (po_header_id);

create index if not exists idx_tj_po_push_intents_state
  on tj_preview.tj_po_push_intents (state);

alter table tj_preview.tj_po_push_intents enable row level security;

-- ----------------------------------------------------------------------------
-- 2) ACK 调用者角色成员表（镜像 tj_preview.tj_gr_memberships）。
--    由管理员为可信 Windows worker 的 auth 用户插入 role='executor' 行。
-- ----------------------------------------------------------------------------
create table if not exists tj_preview.tj_po_ack_workers (
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'executor',
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

alter table tj_preview.tj_po_ack_workers enable row level security;

-- ----------------------------------------------------------------------------
-- 3) ACK 回执账本（幂等键 event_id 唯一）。只有 security definer RPC 写入；
--    anon/authenticated 经 REST 无策略 → 拒绝直连读写。
-- ----------------------------------------------------------------------------
create table if not exists tj_preview.tj_po_ack_receipts (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  content_sha256 text not null,
  po_header_id uuid references tj_preview.tj_po_headers (id) on delete set null,
  po_id text,
  state text not null check (state in ('accepted','rejected','needs_review')),
  reject_code text,
  irs_po_number text,
  evidence jsonb not null default '{}'::jsonb,
  actor uuid,
  received_at timestamptz not null default now()
);

create unique index if not exists uq_tj_po_ack_receipts_event_id
  on tj_preview.tj_po_ack_receipts (event_id);

create index if not exists idx_tj_po_ack_receipts_po_header
  on tj_preview.tj_po_ack_receipts (po_header_id);

create index if not exists idx_tj_po_ack_receipts_irs
  on tj_preview.tj_po_ack_receipts (irs_po_number)
  where irs_po_number is not null;

alter table tj_preview.tj_po_ack_receipts enable row level security;

-- ----------------------------------------------------------------------------
-- 4) 追加式审计（每次 ingest 都记一条：accept / replay / reject），不回滚。
-- ----------------------------------------------------------------------------
create table if not exists tj_preview.tj_po_ack_audit (
  id bigserial primary key,
  event_id text not null,
  action text not null,
  code text,
  actor uuid,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index if not exists idx_tj_po_ack_audit_event
  on tj_preview.tj_po_ack_audit (event_id);

alter table tj_preview.tj_po_ack_audit enable row level security;

-- ----------------------------------------------------------------------------
-- 5) 辅助函数（security definer，空 search_path，内部专用）
-- ----------------------------------------------------------------------------

create or replace function tj_preview.tj_po_ack_sha256(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(p_text, 'sha256'), 'hex')
$$;

create or replace function tj_preview.tj_po_ack_fail(p_code text, p_message text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = pg_catalog.jsonb_build_object(
      'code', p_code,
      'message', p_message,
      'detail', coalesce(p_detail, '{}'::jsonb)
    )::text;
end
$$;

create or replace function tj_preview.tj_po_ack_worker_roles()
returns text[]
language sql
stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.role order by m.role), '{}'::text[])
  from tj_preview.tj_po_ack_workers m
  where m.user_id = auth.uid() and m.active
$$;

create or replace function tj_preview.tj_po_ack_require_worker()
returns uuid
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_roles text[];
begin
  if v_uid is null then
    perform tj_preview.tj_po_ack_fail('PO_ACK_AUTH_REQUIRED', '需要真实登录用户（auth.uid() 为空）');
  end if;
  v_roles := tj_preview.tj_po_ack_worker_roles();
  if coalesce(array_length(v_roles, 1), 0) = 0 then
    perform tj_preview.tj_po_ack_fail('PO_ACK_FORBIDDEN', '当前用户不是 ACK worker（无 role 授权）');
  end if;
  if not (v_roles && array['executor','admin']) then
    perform tj_preview.tj_po_ack_fail(
      'PO_ACK_FORBIDDEN',
      pg_catalog.format('需要角色 executor/admin，当前角色 %s', array_to_string(v_roles, '/')),
      pg_catalog.jsonb_build_object('actual', to_jsonb(v_roles))
    );
  end if;
  return v_uid;
end
$$;

-- ----------------------------------------------------------------------------
-- 6) ACK 接收入口（真实 API：PostgREST RPC）
--    POST /rest/v1/rpc/tj_po_ack_ingest
--    Authorization: Bearer <JWT>
--    apikey: <anon key>
--    Content-Profile: tj_preview
--    body: { "p_payload": { ...TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1... } }
--
--    硬错误（鉴权/结构）→ raise（非 2xx）；业务拒绝 → HTTP 200 + rejected:true，
--    审计已落库（同事务提交，绝不回滚掉审计）。调用方必须查 accepted/rejected。
-- ----------------------------------------------------------------------------
create or replace function tj_preview.tj_po_ack_ingest(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_event_id text;
  v_fp text;
  v_queue_done_ack boolean;
  v_business_po_id text;
  v_po_id text;
  v_source_sha256 text;
  v_queue_done_sha256 text;
  v_irs_po_number text;
  v_verification text;
  v_ledger_state text;
  v_po tj_preview.tj_po_headers%rowtype;
  v_intent tj_preview.tj_po_push_intents%rowtype;
  v_receipt tj_preview.tj_po_ack_receipts%rowtype;
  v_owner record;
  v_state text;
  v_code text;
begin
  v_uid := tj_preview.tj_po_ack_require_worker();

  if (p_payload ->> 'schema') is distinct from 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_INVALID_SCHEMA', 'schema 必须是 TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1');
  end if;

  v_event_id := p_payload ->> 'event_id';
  if v_event_id is null or v_event_id !~ '^tj\.po\.queue\.done\.v1\.[0-9a-fA-F]{8,}$' then
    perform tj_preview.tj_po_ack_fail('PO_ACK_INVALID_EVENT_ID', 'event_id 必须是 tj.po.queue.done.v1.<hex>（确定性幂等 ID）');
  end if;

  v_queue_done_ack := (pg_catalog.jsonb_typeof(p_payload -> 'queue_done_ack') = 'boolean')
                      and (p_payload -> 'queue_done_ack') = 'true'::jsonb;

  v_business_po_id := nullif(btrim(p_payload ->> 'business_po_id'), '');
  v_po_id          := nullif(btrim(p_payload ->> 'po_id'), '');
  v_source_sha256  := nullif(btrim(p_payload ->> 'source_sha256'), '');
  v_queue_done_sha256 := nullif(btrim(p_payload ->> 'queue_done_sha256'), '');
  v_irs_po_number  := nullif(btrim(p_payload ->> 'irs_po_number'), '');
  v_verification   := nullif(btrim(p_payload ->> 'verification'), '');
  v_ledger_state   := nullif(btrim(p_payload ->> 'ledger_state'), '');

  -- 幂等指纹（与 JS ackFingerprintSource 逐字节一致；易变字段不参与）
  v_fp := tj_preview.tj_po_ack_sha256(
    coalesce(v_business_po_id,'') || '|' ||
    coalesce(v_po_id,'') || '|' ||
    coalesce(v_source_sha256,'') || '|' ||
    coalesce(v_queue_done_sha256,'') || '|' ||
    coalesce(v_irs_po_number,'') || '|' ||
    coalesce(v_verification,'') || '|' ||
    case when v_queue_done_ack then '1' else '0' end || '|' ||
    coalesce(p_payload ->> 'queue_folder','') || '|' ||
    coalesce(v_ledger_state,'')
  );

  -- 幂等 / 冲突：同一 event_id 已有回执
  select * into v_receipt from tj_preview.tj_po_ack_receipts where event_id = v_event_id;
  if found then
    if v_receipt.content_sha256 = v_fp then
      insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
      values (v_event_id, 'replay', 'PO_ACK_REPLAY', v_uid,
              pg_catalog.jsonb_build_object('receipt_id', v_receipt.id, 'state', v_receipt.state));
      return pg_catalog.jsonb_build_object(
        'accepted', (v_receipt.state = 'accepted'),
        'replayed', true,
        'rejected', false,
        'state', v_receipt.state,
        'code', 'PO_ACK_REPLAY',
        'receipt_id', v_receipt.id,
        'po_id', v_receipt.po_id,
        'irs_po_number', v_receipt.irs_po_number
      );
    end if;

    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', 'PO_ACK_CONFLICT', v_uid,
            pg_catalog.jsonb_build_object('receipt_id', v_receipt.id, 'prev_state', v_receipt.state));
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'replayed', false, 'rejected', true,
      'state', 'rejected', 'code', 'PO_ACK_CONFLICT', 'receipt_id', v_receipt.id
    );
  end if;

  -- 业务 ID 与 PO ID 若同时存在必须一致
  if v_business_po_id is not null and v_po_id is not null and v_business_po_id <> v_po_id then
    v_state := 'needs_review';
    v_code := 'PO_ACK_PO_NOT_FOUND';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, null, v_po_id, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', 'business_po_id 与 po_id 不一致'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid,
            pg_catalog.jsonb_build_object('business_po_id', v_business_po_id, 'po_id', v_po_id));
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  -- 未给 Done ACK → needs_review
  if not v_queue_done_ack then
    v_state := 'needs_review';
    v_code := 'PO_ACK_DONE_ACK_MISSING';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, null, v_po_id, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', 'queue_done_ack 不是 JSON boolean true'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid, '{}'::jsonb);
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  -- 必须找到 Website 同一 PO（已清理 → needs_review，绝不自动重建）
  if v_po_id is null then
    v_state := 'needs_review';
    v_code := 'PO_ACK_PO_NOT_FOUND';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, null, null, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', '缺少 po_id / business_po_id'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid, '{}'::jsonb);
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  select * into v_po from tj_preview.tj_po_headers where po_id = v_po_id limit 1;
  if not found then
    v_state := 'needs_review';
    v_code := 'PO_ACK_PO_NOT_FOUND';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, null, v_po_id, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', 'Website PO 记录不存在（可能已清理），不自动重建'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid, pg_catalog.jsonb_build_object('po_id', v_po_id));
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  -- 必须有该 PO 的 delivered 投递意图（未见可信 Push 交付 → 拒绝）
  select * into v_intent from tj_preview.tj_po_push_intents
   where po_header_id = v_po.id
   order by updated_at desc limit 1;
  if not found or v_intent.state <> 'delivered' then
    v_state := 'needs_review';
    v_code := 'PO_ACK_NO_PUSH_DELIVERY';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, v_po.id, v_po.po_id, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', '未见该 PO 的 delivered 投递意图'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid, pg_catalog.jsonb_build_object('po_id', v_po.po_id));
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  -- XLSX 文件哈希对齐：source_sha256 必须等于投递清单的 xlsx_sha256
  if v_source_sha256 is null
     or v_source_sha256 !~ '^[0-9a-fA-F]{64}$'
     or v_intent.xlsx_sha256 is null
     or lower(v_source_sha256) <> lower(v_intent.xlsx_sha256) then
    v_state := 'needs_review';
    v_code := 'PO_ACK_SHA_MISMATCH';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, v_po.id, v_po.po_id, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', 'source_sha256 与投递清单 xlsx_sha256 不一致（或缺失）'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid, pg_catalog.jsonb_build_object('po_id', v_po.po_id));
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  -- queue_done_sha256（若有）必须与 source_sha256 一致（同一份导出文件）
  if v_queue_done_sha256 is not null and lower(v_queue_done_sha256) <> lower(v_source_sha256) then
    v_state := 'needs_review';
    v_code := 'PO_ACK_SHA_MISMATCH';
    insert into tj_preview.tj_po_ack_receipts
      (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
    values (v_event_id, v_fp, v_po.id, v_po.po_id, v_state, v_code, v_irs_po_number,
            pg_catalog.jsonb_build_object('reason', 'queue_done_sha256 与 source_sha256 不一致'), v_uid);
    insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
    values (v_event_id, 'reject', v_code, v_uid, pg_catalog.jsonb_build_object('po_id', v_po.po_id));
    return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
      'state', v_state, 'code', v_code);
  end if;

  -- ERP 号唯一性：irs_po_number 不能被另一张 PO 占用（header 或已 accepted 回执）
  if v_irs_po_number is not null then
    select h.id, h.po_id into v_owner from tj_preview.tj_po_headers h
     where h.irs_po_no = v_irs_po_number and h.id <> v_po.id limit 1;
    if not found then
      select r.po_header_id, r.po_id into v_owner from tj_preview.tj_po_ack_receipts r
       where r.irs_po_number = v_irs_po_number and r.state = 'accepted'
         and r.po_header_id is distinct from v_po.id limit 1;
    end if;
    if found then
      v_state := 'needs_review';
      v_code := 'PO_ACK_IRS_NUMBER_CONFLICT';
      insert into tj_preview.tj_po_ack_receipts
        (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
      values (v_event_id, v_fp, v_po.id, v_po.po_id, v_state, v_code, v_irs_po_number,
              pg_catalog.jsonb_build_object('reason', 'IRS PO 号已被另一张 Website PO 占用',
                'owner_po_id', v_owner.po_id), v_uid);
      insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
      values (v_event_id, 'reject', v_code, v_uid,
              pg_catalog.jsonb_build_object('po_id', v_po.po_id, 'irs_po_number', v_irs_po_number,
                'owner_po_id', v_owner.po_id));
      return pg_catalog.jsonb_build_object('accepted', false, 'replayed', false, 'rejected', true,
        'state', v_state, 'code', v_code);
    end if;
  end if;

  -- 全部通过 → 写回 PO + 记录 accepted 回执。
  -- 隔离预览适配：tj_preview 有 trg_tj_po_irs_guard（写 irs_po_no 必须带验证证据），
  --   ACK accepted 本身即「保存后人工核对」证据，故同时写 verified_at / verified_by。
  update tj_preview.tj_po_headers
     set irs_po_no = v_irs_po_number,
         irs_po_no_verified_at = now(),
         irs_po_no_verified_by = 'po-ack:' || v_uid::text,
         erp_status = 'saved_verified_queue_done',
         updated_at = now()
   where id = v_po.id;

  insert into tj_preview.tj_po_ack_receipts
    (event_id, content_sha256, po_header_id, po_id, state, reject_code, irs_po_number, evidence, actor)
  values (v_event_id, v_fp, v_po.id, v_po.po_id, 'accepted', null, v_irs_po_number,
          p_payload, v_uid)
  returning id into v_receipt;

  insert into tj_preview.tj_po_ack_audit (event_id, action, code, actor, detail)
  values (v_event_id, 'accept', null, v_uid,
          pg_catalog.jsonb_build_object('po_id', v_po.po_id, 'irs_po_number', v_irs_po_number,
            'ledger_state', v_ledger_state, 'verification', v_verification));

  return pg_catalog.jsonb_build_object(
    'accepted', true, 'replayed', false, 'rejected', false,
    'state', 'accepted', 'code', null,
    'receipt_id', v_receipt.id,
    'po_id', v_po.po_id,
    'irs_po_number', v_irs_po_number
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 7) 权限：ACK 入口仅 authenticated 可执行；辅助函数仅内部（撤销 PUBLIC）。
--    后端 worker 用 Supabase Auth JWT 调用；anon 无权限。
-- ----------------------------------------------------------------------------
revoke all on function tj_preview.tj_po_ack_ingest(jsonb) from public;
grant execute on function tj_preview.tj_po_ack_ingest(jsonb) to authenticated;

revoke all on function tj_preview.tj_po_ack_sha256(text) from public;
revoke all on function tj_preview.tj_po_ack_fail(text, text, jsonb) from public;
revoke all on function tj_preview.tj_po_ack_worker_roles() from public;
revoke all on function tj_preview.tj_po_ack_require_worker() from public;

-- ----------------------------------------------------------------------------
-- 回滚（需要时手动执行）
-- ----------------------------------------------------------------------------
-- drop function if exists tj_preview.tj_po_ack_ingest(jsonb);
-- drop function if exists tj_preview.tj_po_ack_require_worker();
-- drop function if exists tj_preview.tj_po_ack_worker_roles();
-- drop function if exists tj_preview.tj_po_ack_fail(text, text, jsonb);
-- drop function if exists tj_preview.tj_po_ack_sha256(text);
-- drop table if exists tj_preview.tj_po_ack_audit;
-- drop table if exists tj_preview.tj_po_ack_receipts;
-- drop table if exists tj_preview.tj_po_ack_workers;
-- drop table if exists tj_preview.tj_po_push_intents;
