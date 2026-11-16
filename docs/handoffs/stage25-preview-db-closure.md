# Stage25 Preview 数据库修复包（tj_preview only）

> 分支：`task/stage25-preview-db` · 迁移：`supabase/migrations/20261116_stage25_preview_closure.sql`
> 状态：**PREPARED**（离线 PGlite 真实 SQL 全部通过）；未应用任何真实数据库、未动 public、未动 SOT。

## 1. 这个包解决什么

| 块 | 解决的问题 |
|---|---|
| A. 网站推送请求 | 网站「请求推送到电脑」不再靠改 `header.status=pending_push`（那会撞 Preview 推送总闸），改为独立请求表 + 受控 RPC。 |
| B. 投递证据链 | 区分「旧本地投递（无证据）」和「VPS bridge 投递（Windows 收到证据）」，`delivered` 不再能凭一句 JSON 自证。 |
| C. 人工历史对账 | 已人工保存但当时没有 bridge 证据的历史单，走独立、可审计、postgres-only 的补录通道，**与标准 ACK 账本完全独立**。 |
| D. 标准 ACK 强化 | 校验真实 Stage23 确定性 `event_id`（不只 hex 格式）、IRS 格式、`MANUAL_POSTSAVE_VERIFIED`/`Done`/`SAVED_VERIFIED_QUEUE_DONE`、SHA 一致性、windows_bridge_v1 收件证据、禁止覆盖已保存 IRS。 |

## 2. 应用顺序（主脑）

```bash
# 1) 前置：ACK v1 已部署（20261116_po_done_ack_preview.sql）
# 2) 本包（事务内可先试用）
psql "$PREVIEW_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20261116_stage25_preview_closure.sql
# 3) 只读回读校验（无写语句）
psql "$PREVIEW_DB_URL" -f supabase/tests/20261116_stage25_closure_readback.sql
```

- 迁移 `additive + 可重入`：重复执行安全（`IF NOT EXISTS` / `CREATE OR REPLACE` / 受保护 `RENAME`）。
- **顺序敏感**：本文件把 `tj_po_ack_ingest` 改名为 `tj_po_ack_ingest_v1_internal` 并新建同名 wrapper。
  若之后**再次**执行 ACK v1 迁移，它会用旧主体覆盖 wrapper → 重新执行本文件即可恢复（RENAME 有
  `prosrc like '%v_business_po_id%'` 保护，不会把 wrapper 误改名）。
- 不需要改 PostgREST 的 `db_schema`、不需要新 JWT、不需要 service_role。

## 3. 接口契约

### 3.1 网站请求推送（authenticated + GR staff/approver/admin）

```js
// supabase-js: schema 客户端指向 tj_preview
const { data, error } = await supabase.rpc('tj_po_preview_request_push', {
  p_po_header_id: '<uuid>',
  p_request_id: '<客户端幂等 id，<=200 字符>',
})
// data: { id, po_id, state, request_id, replayed, duplicate }
```

- 成功：`state='requested'`，写入 `tj_preview.tj_po_preview_push_requests`。
- 同 `request_id` + 同 PO：`replayed=true`，不新增行。
- 同 `request_id` + 不同 PO：`PO_PUSH_REQUEST_ID_CONFLICT`。
- 同 PO + 不同 `request_id`：`duplicate=true`，返回既有行，**不重复 dispatch**。
- 资格闸门（全部在写之前，任一不满足即拒）：standard PO、`status='confirmed'`、未 frozen、
  `website_po_date` 非空、无 `source_po_ids`、未被任何 combined 单引用、无历史 push intent、
  无 ERP 保存记录（`irs_po_no`/`erp_status`/accepted ACK 回执）。
- **不改 `header.status`**（绝不写 `pending_push`），Preview 推送总闸原样保留。
- 拒绝码：`PO_PUSH_AUTH_REQUIRED`、`PO_PUSH_FORBIDDEN`、`PO_PUSH_INVALID_INPUT`、
  `PO_PUSH_INVALID_REQUEST_ID`、`PO_PUSH_PO_NOT_FOUND`、`PO_PUSH_NOT_STANDARD`、
  `PO_PUSH_PO_FROZEN`、`PO_PUSH_PO_NOT_CONFIRMED`、`PO_PUSH_NO_WEBSITE_DATE`、
  `PO_PUSH_COMBINED_SOURCE`、`PO_PUSH_INTENT_EXISTS`、`PO_PUSH_ERP_SAVED`、
  `PO_PUSH_REQUEST_ID_CONFLICT`。（均为 `raise`，即非 2xx；业务码在 `message` JSON 内。）

### 3.2 投递证据链（VPS dispatcher / Management API 写）

- `tj_preview.tj_po_push_intents` 新增 `delivery_channel text NOT NULL DEFAULT 'legacy_local_unverified'`
  （取值仅 `legacy_local_unverified` / `windows_bridge_v1`；**旧数据不改**）。
- `tj_preview.tj_po_push_delivery_evidence(id, intent_id, stage, xlsx_sha256, byte_count, target_path, evidence, created_at)`
  - `stage ∈ (server_prepared, windows_received)`，`UNIQUE(intent_id, stage)`。
  - 追加式：`UPDATE` / `DELETE` / `TRUNCATE` 一律拒绝（**owner 也拒**）。
  - 证据只能挂在 `windows_bridge_v1` 意图上（legacy 意图补证据会被拒，旧记录不能洗白）。
  - 证据哈希必须与意图 `xlsx_sha256` 一致。
- 新意图进入 `delivered` 必须有 `windows_received` 证据且哈希与 `xlsx_sha256` 一致；若同时有
  `server_prepared`，两者哈希也必须一致（防投递中途替换）。
- **推荐的写序**：插入意图（`dispatch_started`，`delivery_channel='windows_bridge_v1'`，带 `xlsx_sha256`）
  → 插 `server_prepared` 证据 → VPS 收到后再插 `windows_received` 证据 → `update state='delivered'`。
  （不要直接插 `delivered`：证据必须先存在。）

### 3.3 人工历史对账 `tj_po_manual_reconcile(p_payload jsonb)`

**只允许 postgres 管理通道**（`revoke execute from public/anon/authenticated/service_role`；
带 JWT claim 的会话在函数内二次拒绝 `MANUAL_RECONCILE_FORBIDDEN`）。

```jsonc
{
  "outbox_raw":         "<_WebsiteOutbox 原始 JSON 字节按 UTF-8 解码后的文本，保留 CRLF>",
  "ledger_raw":         "<Windows ledger 原始 JSON 文本，保留 CRLF>",
  "screenshot_sha256":  "<保存后截图 PNG 的 sha256 hex>",
  "source_sha256":      "<导出 XLSX 的 sha256 hex（与 outbox.source_sha256 同一值）>",
  "reviewer":           "<人工核验人>",
  "reason":             "<为什么走人工补录>",
  "expected_total_rm":  "57.56"
}
```

核验项（任一不符即 `raise`，不写入）：
1. `outbox`/`ledger` 是合法 JSON 对象；`outbox.schema = TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1`。
2. `outbox` 与 `ledger` 同一 `po_id`、同一 IRS（`^PO[0-9]{8}$`）、`ledger.queue_commit_event_id = outbox.event_id`。
3. `outbox.queue_folder = 'Done'`；`outbox.ledger_state = 'SAVED_VERIFIED_QUEUE_DONE'`；
   `outbox.verification = 'MANUAL_POSTSAVE_VERIFIED'`；`ledger.state` 同值（若给出）。
4. `outbox.source_sha256 = outbox.queue_done_sha256 = payload.source_sha256`；`ledger.source_sha256` 同值（若给出）。
5. `ledger.postsave_evidence_sha256 = payload.screenshot_sha256`，且 64hex。
6. `event_id = 'tj.po.queue.done.v1.' + sha256('TJ_QUEUE_DONE_V1|po_id|UPPER(source_sha256)|irs_po_number')`
   （与 Windows 客户端逐字节一致，客户端给大写 hash）。
7. `tj_po_headers + tj_po_lines 合计 = expected_total_rm = ledger.expected_total(_rm)`，
   且 `ledger.expected_lines[].amount_rm` 求和一致。
8. 该 PO 无标准 ACK `accepted` 回执、`erp_status` 不是 `saved_verified_*`、header 无不同 IRS
   （标准账本优先，人工通道不覆盖）。
9. 锁：`pg_advisory_xact_lock(event)` + `pg_advisory_xact_lock(irs)` + `SELECT ... FOR UPDATE` header 行锁。

落库与副作用：
- `tj_preview.tj_po_manual_reconciliations`（追加式，`event_id` / `po_header_id` / `irs_po_no` 三唯一）：
  原始 `outbox_raw`/`ledger_raw`（含 CRLF 逐字保留）、两者原始字节 sha256、`source_sha256`、
  `screenshot_sha256`、`expected_total_rm`、`classification='manual_delivery_historical_import'`、
  原 push intent 快照（`id/state/xlsx_sha256/content_sha256`）、`reviewer`、`reason`、`actor`、
  `verified_by='manual-reconciliation:<receipt-id>'`。
- header 写回：`irs_po_no`、`irs_po_no_verified_at`、`irs_po_no_verified_by='manual-reconciliation:<id>'`、
  `erp_status='saved_verified_manual_reconciliation'`。
- **不改** push intent、**不写** `tj_po_ack_receipts`/`tj_po_ack_audit`。
- 幂等：同 event + 同内容 → `replayed=true`；同 event + 内容变化 → `MANUAL_RECONCILE_CONFLICT`；
  不同 event 撞同 PO/IRS → `MANUAL_RECONCILE_ALREADY_RECONCILED`。

拒绝码：`MANUAL_RECONCILE_FORBIDDEN`、`_INVALID_PAYLOAD`、`_MISSING_FIELD`、`_INVALID_JSON`、
`_INVALID_SHA`、`_INVALID_TOTAL`、`_SCHEMA`、`_IRS_INVALID`、`_IRS_MISMATCH`、`_PO_MISMATCH`、
`_SHA_MISMATCH`、`_QUEUE_NOT_DONE`、`_LEDGER_STATE`、`_VERIFICATION`、`_SCREENSHOT_MISMATCH`、
`_LEDGER_EVENT_MISMATCH`、`_EVENT_MISMATCH`、`_TOTAL_MISMATCH`、`_LEDGER_TOTAL_MISMATCH`、
`_PO_NOT_FOUND`、`_NO_LINES`、`_CONFLICT`、`_ALREADY_RECONCILED`、`_ALREADY_SAVED`、
`_STANDARD_ACK_EXISTS`、`_IRS_CONFLICT`。

### 3.4 标准 ACK wrapper

`tj_preview.tj_po_ack_ingest(p_payload jsonb)`（**路径不变**，Windows worker 照旧调用）：
1. worker 身份（沿用 `tj_po_ack_workers`，executor/admin）。
2. schema / event_id 结构。
3. `event_id` 必须等于确定性推导值，否则 `PO_ACK_EVENT_ID_MISMATCH`（**不再只看 hex 格式**）。
4. `irs_po_number ~ ^PO[0-9]{8}$` → 否则 `PO_ACK_INVALID_IRS`。
5. `verification=MANUAL_POSTSAVE_VERIFIED`、`queue_folder=Done`、`ledger_state=SAVED_VERIFIED_QUEUE_DONE`
   → 否则 `PO_ACK_VERIFICATION_REQUIRED` / `PO_ACK_QUEUE_FOLDER_REQUIRED` / `PO_ACK_LEDGER_STATE_REQUIRED`。
6. `source_sha256`/`queue_done_sha256` 均 64hex 且相等 → 否则 `PO_ACK_SHA_MISMATCH`。
7. 该 PO 已人工对账 → 业务拒绝 `PO_ACK_MANUAL_RECONCILED`。
8. 已保存 IRS 且与本次不同 → 业务拒绝 `PO_ACK_IRS_OVERWRITE`；相同且有 accepted 回执 → replay。
9. 投递意图必须 `windows_bridge_v1` + `delivered` + `windows_received` 证据哈希一致
   → 否则 `PO_ACK_NO_WINDOWS_RECEIPT`；意图未 delivered → 委派 v1 主体按既有语义拒绝
   （`PO_ACK_NO_PUSH_DELIVERY`）。
10. 其余（SHA 对意图、IRS 占用、PO 不存在、落库、header 写回）委派
    `tj_po_ack_ingest_v1_internal`。

前 6 类是**硬错误**（非 2xx，不写账本，改好后可用同一确定性 event 重试）；
7–9 与 v1 既有拒绝是**业务拒绝**（HTTP 200 + `rejected:true` + needs_review 回执 + 审计）。

### 3.5 权限矩阵（回读）

| 函数 / 表 | anon | authenticated | service_role | postgres |
|---|---|---|---|---|
| `tj_po_preview_request_push(uuid,text)` | ✗ | ✓（函数内再查 GR 角色） | ✗ | ✓ |
| `tj_po_ack_ingest(jsonb)` | ✗ | ✓（函数内再查 worker） | ✗ | ✓ |
| `tj_po_ack_ingest_v1_internal(jsonb)` | ✗ | ✗ | ✗ | ✓（只能由 wrapper 调） |
| `tj_po_manual_reconcile(jsonb)` | ✗ | ✗ | ✗ | ✓ |
| 本包 helper / trigger 函数 | ✗ | ✗ | ✗ | ✓ |
| 三张新表 | 无策略、无 GRANT（RLS 开启） | 同左 | 同左 | ✓ |

## 4. 验证证据（离线、可复现）

```bash
npm i --prefix /tmp/stage25-pg @electric-sql/pglite     # 仓库不带这个依赖
STAGE25_PGLITE_ENTRY=/tmp/stage25-pg/node_modules/@electric-sql/pglite/dist/index.js \
  node scripts/stage25-local-smoke.mjs                  # 真实 Postgres(WASM) 全流程
STAGE25_PGLITE_ENTRY=... node --test tests/stage25-closure-sql.test.mjs
```

- fixture（复刻 tj_preview 既有表/守卫/权限）→ ACK v1 → 本包迁移 → **再跑一次**（可重入）
  → `supabase/tests/20261116_stage25_closure_integration.sql` 全事务内断言后 `rollback`。
- 当前结果：**140 条 SQL 断言全部通过**（A 结构/权限、B 请求推送、C 证据链、D 标准 ACK、E 人工对账）。
- 变异测试：故意破坏 11 处关键判定，10 处被测试抓住；1 处（wrapper 的 legacy 通道分支）与
  「证据缺失」分支产出同一拒绝码，属纵深防御、单独不可达，已保留。
- 跨语言：SQL `tj_po_ack_event_id` 与 JS/Node `crypto` 对同一 canonical 串逐字节一致；
  另用真实 PO26 实据离线核对过（SQL 推导值 = Windows outbox 的 event_id，
  `queue_commit_event_id`/截图 sha/XLSX sha/合计 57.56 全部吻合）——真实值不入库、不入 Git。
- `tests/po-ack-preview.test.mjs` 等既有测试未改动；仓库内 8 个既有测试因本 worktree 缺
  `node_modules/exceljs` 失败（与本次改动无关，属环境缺依赖）。

## 5. 主脑上线步骤（本包不代做）

1. 应用本迁移到 tj_preview（见 §2），跑 readback 核对 §3.5 权限矩阵。
2. 为每个待推 PO 建 `windows_bridge_v1` 意图 + `server_prepared` / `windows_received` 证据
   （Management API，postgres 身份；按 §3.2 写序），再更新 `state='delivered'`。
3. 网站侧接线：`tj_po_preview_request_push`（`p_po_header_id`, `p_request_id`）；不再改 header.status。
4. 人工历史对账：用真实 PO26 实据调 `tj_po_manual_reconcile`（§3.3 payload），
   `expected_total_rm='57.56'`；拿到返回的 `id`/`verified_by` 后回读 header 与对账表。
5. Windows ACK worker 端不需要改路径，但**必须**用客户端确定性 `event_id`（大小写 hash 均可，
   服务端按 `UPPER(source)` 归一），否则会被 `PO_ACK_EVENT_ID_MISMATCH` 拒。
6. public 生产迁移不在本包范围（本文件只含 tj_preview 语句）。

## 6. 已知限制 / 注意

- `tj_po_ack_ingest_v1_internal` 里 `returning id into v_receipt`（`%rowtype` 变量）实测可用：
  PostgreSQL 把单列结果赋给行变量第一个字段，而 `tj_po_ack_receipts` 的第一列正是 `id`。
  **如果以后调整该表列顺序（`id` 不在首位），这段会静默错位** —— 已用断言锁定
  「返回的 receipt_id 指向真实 accepted 回执」，改列顺序会立刻红灯。
- 证据表/对账表的追加式守卫是行级 + TRUNCATE 语句级触发器；`session_replication_role='replica'`
  或 `ALTER TABLE ... DISABLE TRIGGER` 仍可绕过，那是超级用户权限行为，不在本包防护范围。
- Preview 推送总闸未改动：`pending_push`/`exported` 仍一律拒绝；本包的请求表是唯一新入口。
