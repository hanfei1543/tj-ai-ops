-- ============================================================================
-- TJ-AI-Ops — 收货事件（receipt_event_id）防重复入账（生产 public）
-- 文件名：20261112_receipt_event_dedup.sql
--
-- 【状态：PREPARED ONLY，未应用】
--   * 本文件只针对 public（生产）schema，不碰 tj_preview。
--   * 生产迁移必须由用户单独授权后才能应用；当前只准备、不执行。
--   * 幂等：CREATE UNIQUE INDEX IF NOT EXISTS。
--
-- 为什么需要：receipt_event_id 是 GR / IRS 入账防重复的全局唯一键。
--   同一收货事件只允许对应一张 PO；若同一 receipt_event_id 出现在两张 PO，
--   说明收货事件被重复入账。用部分唯一索引在数据库层硬拦（应用层/直连 REST 都绕不过）。
--   部分索引：receipt_event_id IS NULL（未收货的普通单）不受约束，
--   只有已生成收货事件 ID 的行才要求唯一。
-- ============================================================================

create unique index if not exists uq_tj_po_headers_receipt_event_id
  on public.tj_po_headers (receipt_event_id)
  where receipt_event_id is not null;
