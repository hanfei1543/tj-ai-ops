# PO Save/Queue Done ACK —— Windows→Website 契约（Stage24）

> 本文档是 Stage24「PO Done ACK」的对外契约。与 GR 收货回调（`tj_gr_task_result`）**完全不同**，
> 处理对象是 Website→Windows Push 的 XLSX 保存回执，不是收货事件。
> 状态：代码 + 迁移候选 + 单测已交付在分支 `feature/po-done-ack`；迁移**未应用**到 production。

## 1. 真实 API 路径与 method

- 路径：`POST https://<ref>.supabase.co/rest/v1/rpc/tj_po_ack_ingest`
- method：`POST`
- 头：`Authorization: Bearer <worker JWT>`、`apikey: <anon key>`、`Content-Type: application/json`
- body：`{ "p_payload": { ... } }`（见 §2）

调用方式（supabase-js）：
```js
const { data, error } = await supabase.rpc('tj_po_ack_ingest', { p_payload: ackPayload })
```

## 2. 请求体（Stage23 原始 outbox schema，逐字沿用）

```json
{
  "schema": "TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1",
  "event_id": "tj.po.queue.done.v1.<hex>",
  "business_po_id": "PO-123456",
  "po_id": "PO-123456",
  "source_sha256": "<SHA256_OF_EXACT_EXPORTED_XLSX_BYTES>",
  "irs_po_number": "PO########",
  "verification": "MANUAL_POSTSAVE_VERIFIED",
  "queue_done_ack": true,
  "queue_done_sha256": "<same file SHA>",
  "queue_folder": "Done",
  "ledger_state": "SAVED_VERIFIED_QUEUE_DONE",
  "callback_state": "OUTBOX_NOT_SENT"
}
```

- `event_id` 是**确定性幂等 ID**（`tj.po.queue.done.v1.<hex>`），不是鉴权签名；鉴权由 §3 的 JWT 承担。
- `source_sha256` / `queue_done_sha256` 是**导出 XLSX 精确字节的 sha256**（与投递清单 `xlsx_sha256` 同一算法同一字节）。
- 非关键字段 `queue_done_verified_at` / `transport` / `warning` 可接受并安全忽略；`callback_state` 会随重试变化，不参与幂等指纹。

## 3. 认证方案

- 复用 Supabase Auth（password 登录）+ 角色成员表 `public.tj_po_ack_workers(user_id, role, active)`。
- 可信 Windows worker 用一个 Auth 用户登录，`role='executor'`（管理员可另建 `admin`）。
- RPC 为 `security definer`，内部 `tj_po_ack_require_worker()` 校验 `auth.uid()` 非空 + 是该表 active 成员。
- `anon` 无 EXECUTE 权限；`service_role` 不经此通道（会绕过 `auth.uid()`，不用于 ACK）。
- 单看 JSON 不能证明真实 Done：它必须来自携带该 JWT 的可信 worker 认证通道。

## 4. 响应体与拒绝语义

成功 / 幂等 / 业务拒绝 → **HTTP 200**（审计同事务提交，绝不回滚掉审计）：

```json
{ "accepted": true,  "replayed": false, "rejected": false,
  "state": "accepted", "code": null, "receipt_id": "<uuid>",
  "po_id": "PO-123456", "irs_po_number": "PO26000783" }
```

- 幂等 replay：`{ "replayed": true, "state": "<原状态>", "code": "PO_ACK_REPLAY", ... }`
- 业务拒绝：`{ "accepted": false, "rejected": true, "state": "needs_review", "code": "<code>", ... }`

硬错误（鉴权 / 结构）→ **非 2xx**（PostgREST 返回错误，message 是 JSON）：
- `PO_ACK_AUTH_REQUIRED`（401，未登录）、`PO_ACK_FORBIDDEN`（403，非 worker）、
  `PO_ACK_INVALID_SCHEMA`（400，schema 不符）、`PO_ACK_INVALID_EVENT_ID`（400，event_id 非法）。

拒绝码（`code`，业务拒绝均在 HTTP 200 内，审计已落库）：

| code | 含义 |
|---|---|
| `PO_ACK_REPLAY` | 同 event_id + 同指纹 → 幂等 replay，不再写入 |
| `PO_ACK_CONFLICT` | 同 event_id + 不同指纹 → 显式拒绝 |
| `PO_ACK_DONE_ACK_MISSING` | `queue_done_ack` 不是 JSON boolean true |
| `PO_ACK_PO_NOT_FOUND` | Website PO 已清理/找不到 → 绝不自动重建 |
| `PO_ACK_NO_PUSH_DELIVERY` | 该 PO 没有 `delivered` 投递意图 |
| `PO_ACK_SHA_MISMATCH` | `source_sha256` 与投递清单 `xlsx_sha256` 不一致（或缺失/非 64hex） |
| `PO_ACK_IRS_NUMBER_CONFLICT` | `irs_po_number` 已被另一张 Website PO 占用 |

## 5. XLSX SHA 证据链

1. 推送器 `scripts/lib/po-push-core.mjs` 在 `buildXlsx` 后算 `computeXlsxSha256(buf)`（**导出文件的精确字节 sha256**）。
2. 落库到 `public.tj_po_push_intents.xlsx_sha256`（与 `content_sha256` 并存）。
3. **关键**：`content_sha256` 是**业务 JSON 摘要**（`computePushContentSha256`），**不是** XLSX 二进制哈希；
   二者算法不同、字节不同，**绝不互比**。ACK 的 `source_sha256` 只与 `xlsx_sha256` 比较。
4. ACK 接收时：`source_sha256` 必须 = 该 PO delivered 投递意图的 `xlsx_sha256`（缺失/不一致 → `PO_ACK_SHA_MISMATCH`）。

关系：`business PO (po_id) --1:1--> push intent (content_sha256=业务JSON, xlsx_sha256=文件字节) <--ACK source_sha256==xlsx_sha256--> Windows Queue Done`。

## 6. 如何从 Stage23 `_WebsiteOutbox` POST

Windows worker 侧（离线完成后）：
1. 用 executor 账号 `supabase.auth.signInWithPassword(email, password)` 拿 JWT（可复用会话/刷新 token）。
2. 从 `_WebsiteOutbox` 取一条 `TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1` 记录，原样作为 `p_payload`。
3. `supabase.rpc('tj_po_ack_ingest', { p_payload })`。
4. 检查返回：`accepted=true` → 标记 `_WebsiteOutbox` 为已发送；`rejected=true` → 记录 code、保留待人工；
   HTTP 非 2xx（鉴权/结构）→ 不重试盲发，先核对凭据与 payload。
5. 重试安全：同 `event_id` + 同 payload 幂等 replay；`event_id` 由 Windows 侧确定性生成（同一事件恒同 ID）。

## 7. 与 GR / PO 状态隔离

- PO ACK 写 `public.tj_po_headers.irs_po_no` + `erp_status='saved_verified_queue_done'`（accepted）。
- 它与 GR 的 `tj_gr_tasks.verified` / 收货事件 `verified` **无关**：GR 的 verified 不代表 PO 已保存；
  PO 的「已保存并核对」只由本 ACK 的 `erp_status` / `tj_po_ack_receipts.state='accepted'` 表达。
- 普通 PO 与合并 PO 共用同一 ACK 入口（都按 `po_id` 定位 `tj_po_headers`，不区分 po_type）。
- 创建 PO 不自动触发 GR；GR 正式 push/post 仍永久停用（`GR_PUSH_ENABLED=false`）。

## 8. 幂等与审计落库

- `tj_po_ack_receipts`：`UNIQUE(event_id)` 硬拦重复 accepted；`content_sha256` 指纹用于 replay vs conflict。
- `tj_po_ack_audit`：追加式，每次 ingest 记 `accept`/`replay`/`reject`（含拒绝审计，不因 reject 回滚）。
- 幂等指纹源（JS 与 SQL 逐字节一致）：`business_po_id|po_id|source_sha256|queue_done_sha256|irs_po_number|verification|(queue_done_ack?1:0)|queue_folder|ledger_state` 的 sha256。

## 9. 尚需授权才能执行的部署步骤

1. 应用 `supabase/migrations/20261114_po_push_intents.sql`（投递意图表）到 public。
2. 应用 `supabase/migrations/20261115_po_done_ack.sql`（xlsx_sha256 列 + ACK 表/RPC/鉴权）到 public。
3. 为可信 Windows worker 的 Auth 用户插入 `tj_po_ack_workers` 行（role='executor'）。
4. 部署含 `scripts/lib/po-push-core.mjs` 改动（记录 xlsx_sha256）的推送器，重启生产 cron。
5. 均不执行：旧 PO 清理 SQL、po_seq 重置、GR/IRS/Windows 改动、merge/push main、生产 delete。

> 历史保护：`PO-878329 → PO26000783` 是真实 IRS 保存但 synthetic Windows 来源，绝不写回 production PO；
> `PO-000005`、`PO-000011`、`PO-900003` 同样历史保护；ACK 对已清理 PO 只 needs_review，不自动重建。
