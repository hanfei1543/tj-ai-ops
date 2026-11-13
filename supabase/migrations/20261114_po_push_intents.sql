-- PO Push 投递意图表：消除旧 PO Push 的不确定投递窗口（幂等）。
--
-- 状态：本文件尚未应用（需单独授权后由主脑执行）。当前仅为 schema 定义。
-- 目标 schema：public（推送器 scripts/lib/po-push-core.mjs 只允许 public，
--   createSupabaseRest 拒绝非 public 注入）。
--
-- 设计要点（对应 scripts/lib/po-push-core.mjs 的投递状态机）：
--   * 调用 bridge 之前先持久化 dispatch_started（本表是投递唯一真相源）。
--   * bridge 已调用但 delivered 未可靠记录 → 一律 delivery_uncertain / needs_review，
--     绝不自动再次发送。
--   * UNIQUE(po_header_id)：一个 PO 一生只允许一条投递意图。即使 content_sha256
--     不同（PO 内容被改过）也不得凭新唯一键再投递——必须在应用层按 po_header_id
--     查历史意图后拒绝。
--   * 不得因为 Windows Pending 文件不存在就允许重投；本表状态是判定依据。
--   * 人工恢复：投递进入 delivery_uncertain / needs_review 后，需人工核对 Windows
--     Queue 实况，再决定是否（并如何）解除——禁止任何自动重投。

create table if not exists public.tj_po_push_intents (
  id uuid primary key default gen_random_uuid(),
  po_header_id uuid not null references public.tj_po_headers (id) on delete restrict,
  po_id text not null,
  content_sha256 text not null,
  state text not null default 'dispatch_started'
    check (state in ('dispatch_started', 'delivered', 'delivery_uncertain', 'needs_review')),
  filename text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 一个 PO 一生只允许一条投递意图（覆盖规则 3：同 PO 即使内容 sha 不同也不得重投）。
create unique index if not exists uq_tj_po_push_intents_po_header
  on public.tj_po_push_intents (po_header_id);

create index if not exists idx_tj_po_push_intents_state
  on public.tj_po_push_intents (state);
