-- TJ-AI-Ops Combined PO / Drag-Drop 排序 / Add New Item — 增量迁移
-- 全部 additive：不删列、不改现有列类型、不动现有数据。现有 PO/Excel/PAD 流程不受影响。
-- 执行后即可回滚（DROP 新增列/表不影响旧数据），但业务上新增列应保留。

-- ============================================================
-- 1) tj_po_headers 扩展：合并单 / 审批冻结 / 收货 / ERP 状态
-- ============================================================
ALTER TABLE tj_po_headers
  ADD COLUMN IF NOT EXISTS po_type text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS source_po_ids text[],
  ADD COLUMN IF NOT EXISTS po_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS delivery_order_no text,
  ADD COLUMN IF NOT EXISTS receipt_event_id text,
  ADD COLUMN IF NOT EXISTS checked_by text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS erp_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS irs_po_no text,
  ADD COLUMN IF NOT EXISTS irs_grn_no text;

-- ============================================================
-- 2) tj_po_lines 扩展：来源追溯 / 原订数量 / 实收数量 / 例外备注
-- ============================================================
ALTER TABLE tj_po_lines
  ADD COLUMN IF NOT EXISTS source_po_id uuid,
  ADD COLUMN IF NOT EXISTS source_line_id uuid,
  ADD COLUMN IF NOT EXISTS original_qty numeric,
  ADD COLUMN IF NOT EXISTS accepted_qty numeric,
  ADD COLUMN IF NOT EXISTS source_refs jsonb,
  ADD COLUMN IF NOT EXISTS note text;

CREATE INDEX IF NOT EXISTS idx_tj_po_lines_source_po ON tj_po_lines(source_po_id);

-- ============================================================
-- 3) 新表 tj_item_requests：Add New Item Master 申请（独立于「加商品进 PO」）
--    状态：pending -> approved -> exported -> created / needs_review / rejected
-- ============================================================
CREATE TABLE IF NOT EXISTS tj_item_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code text NOT NULL,
  barcode text,
  description text NOT NULL,
  uom text,
  category text,
  supplier_code text,
  purchase_cost numeric,
  selling_price numeric,
  tax_rate numeric,
  sst_info text,
  status text NOT NULL DEFAULT 'pending',
  created_by text,
  approved_by text,
  approved_at timestamptz,
  erp_status text NOT NULL DEFAULT 'none',
  erp_result text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tj_item_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_item_requests ON tj_item_requests;
CREATE POLICY anon_all_item_requests ON tj_item_requests
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_tj_item_requests_status ON tj_item_requests(status);
CREATE INDEX IF NOT EXISTS idx_tj_item_requests_item_code ON tj_item_requests(item_code);
