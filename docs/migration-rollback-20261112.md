# 数据库迁移 / 备份 / 回滚方案（2026-11-12 Combined PO 三功能）

## 一、本次改了什么（两处，均 additive）

### A. 生产 `public` schema（上一轮已应用，additive）
- `tj_po_headers` 加列：po_type、source_po_ids、po_revision、source_sha256、delivery_order_no、receipt_event_id、checked_by、approved_by、approved_at、received_at、frozen、erp_status、irs_po_no、irs_grn_no。
- `tj_po_lines` 加列：source_po_id、source_line_id、original_qty、accepted_qty、source_refs、note。
- 新表 `tj_item_requests`（Add New Item Master 申请）。
- 脚本：`supabase/migrations/20261112_combined_po.sql`（可重复执行，IF NOT EXISTS 安全）。
- 影响：仅加列/加表，未删改任何现有列、未动现有数据、未重置 PO 序号（已手动 reset 回 12）。

### B. 隔离测试 schema `tj_preview`（本轮，独立于生产数据）
- 新建 schema `tj_preview`，复制了 suppliers(556)/items(30654) 只读参照 + 两张测试 PO（PO-000001、PO-000002）。
- PostgREST `db_schema` 由 `public,graphql_public` → `public,graphql_public,tj_preview`（append，public 仍在首位）。
- 授权：anon/authenticated 可读写 tj_preview；**service_role 刻意不授权 tj_preview**，因此生产推送器（走 service_role）永远看不到 tj_preview 数据，不可能误推。
- Preview 环境变量：`VITE_SUPABASE_SCHEMA=tj_preview`（生产无此变量 → 走 public）。

## 二、备份方案

迁移是纯 additive（不删列、不改现有数据、不重写行），理论上无需备份即安全。但为稳妥，后续任何涉及数据变更的迁移前执行：

1. Supabase 后台 → Project Settings → Database → Backups，手动创建一次备份（PITR 若已开启）。
2. 或用 `pg_dump`：
   `pg_dump "$SUPABASE_URL" -U postgres -Fc -f tj_ai_ops_backup.dump`（连接串在 Supabase Dashboard → Connect）。
3. 生产 PO 序号（po_seq）是 identity，任何测试写库后必须 reset 回 `max(po_seq)+1`：
   `SELECT max(po_seq) FROM tj_po_headers;` → `ALTER TABLE tj_po_headers ALTER COLUMN po_seq RESTART WITH <max+1>;`

## 三、回滚方案（按需回滚，不互相影响）

### 回滚 B（隔离测试 schema，最安全、随时可做）
```sql
-- 1) PostgREST 恢复
--    Supabase Management API: PATCH /v1/projects/{ref}/postgrest
--    body: {"db_schema": "public,graphql_public"}
-- 2) 删除测试 schema
DROP SCHEMA tj_preview CASCADE;
```
- 效果：Preview 部署失去数据源（会报错），生产完全不受影响。

### 回滚 A（生产 public schema 的新列/新表，仅在「连前端一起回退」时做）
先回退前端到上一个 commit，再执行：
```sql
ALTER TABLE tj_po_headers
  DROP COLUMN IF EXISTS po_type, DROP COLUMN IF EXISTS source_po_ids,
  DROP COLUMN IF EXISTS po_revision, DROP COLUMN IF EXISTS source_sha256,
  DROP COLUMN IF EXISTS delivery_order_no, DROP COLUMN IF EXISTS receipt_event_id,
  DROP COLUMN IF EXISTS checked_by, DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS received_at,
  DROP COLUMN IF EXISTS frozen, DROP COLUMN IF EXISTS erp_status,
  DROP COLUMN IF EXISTS irs_po_no, DROP COLUMN IF EXISTS irs_grn_no;
ALTER TABLE tj_po_lines
  DROP COLUMN IF EXISTS source_po_id, DROP COLUMN IF EXISTS source_line_id,
  DROP COLUMN IF EXISTS original_qty, DROP COLUMN IF EXISTS accepted_qty,
  DROP COLUMN IF EXISTS source_refs, DROP COLUMN IF EXISTS note;
DROP TABLE IF EXISTS tj_item_requests;
```
- 注意：新列是 nullable 或有默认值，直接 DROP 不会丢任何旧数据；唯一风险是若已用新功能写入数据（合并单/申请），回退会丢这些新数据（需先确认无正式合并单/申请）。

## 四、隔离验证结果（已实测）
- 生产 public 仍返回 PO-000011/009/006，未受影响。
- tj_preview（Accept-Profile: tj_preview）返回 PO-000001/002，序号独立。
- service_role 访问 tj_preview 报 403 permission denied（= 生产推送器天然隔离）。
- Preview 页面运行时列表显示测试 PO，非生产 PO（浏览器实测通过）。
