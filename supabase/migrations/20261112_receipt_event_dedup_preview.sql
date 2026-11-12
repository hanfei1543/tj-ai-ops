-- ============================================================================
-- TJ-AI-Ops — 收货事件（receipt_event_id）防重复入账（隔离预览 tj_preview）
-- 文件名：20261112_receipt_event_dedup_preview.sql
--
-- 【状态：PREPARED，由主脑在 tj_preview 单独应用；绝不动 public】
--   * 本文件没有任何 public.* 语句；只操作 tj_preview。
--   * 与 public 版相同语义，仅作用于隔离预览 schema。
--   * 幂等：CREATE UNIQUE INDEX IF NOT EXISTS。
--   * 部分唯一索引：receipt_event_id IS NULL 不受约束；
--     已生成收货事件 ID 的行必须全局唯一，重复收货事件在数据库层被硬拦。
-- ============================================================================

create unique index if not exists uq_tj_po_headers_receipt_event_id
  on tj_preview.tj_po_headers (receipt_event_id)
  where receipt_event_id is not null;
