# Preview PO 投递契约（tj_preview → Windows Pending）

> 范围：隔离预览 schema `tj_preview` 的「请求预览投递」链路。
> 生产 `public` 的 PO Push（cron `scripts/tj-po-push.mjs`）**不变**，本链路不读/不改 public。
> 迁移不在此分支创建：`tj_po_preview_push_requests` / `tj_po_push_intents.delivery_channel` /
> `tj_po_push_delivery_evidence` 由另一执行器负责；本文只描述代码依赖的契约。

## 1. 状态机

`tj_preview.tj_po_preview_push_requests.state`

| 状态 | 含义 | 允许再次投递 |
|---|---|---|
| `requested` | 网站已请求（RPC 写入） | 是（仅一次成功抢单） |
| `dispatch_started` | 抢单成功，bridge 窗口进行中 | 否；重跑 → `delivery_uncertain` |
| `delivered` | Windows read 回字节/hash 一致 + 证据已落库 | 否（重跑直接返回 already_delivered） |
| `delivery_uncertain` | 结果不明（bridge 失败/超时/读回不一致/落库失败/同名已存在/旧 intent） | 否，必须人工核对 Windows Queue |

`tj_preview.tj_po_push_intents` 仍是「一个 PO 一生一次投递」的真相源：
`UNIQUE(po_header_id)`，新发 `delivery_channel='windows_bridge_v1'`，旧本地投递为
`legacy_local_unverified`。抢单 SQL 用 `ON CONFLICT (po_header_id) DO NOTHING`，**绝不覆盖旧 intent**。

## 2. 一次投递的固定顺序

1. 读请求（只读）→ 已 `delivered` 直接返回；`dispatch_started/uncertain` 拒绝。
2. 读 PO + lines（`tj_preview`，按 `line_no`）→ 业务门禁（standard/confirmed/未冻结/非合并/有行）。
3. **8 列 + Website PO Date fail closed**：`buildPoLineRows(..., EXPORT_MODE_STANDARD)`；
   缺日期/非法日期在任何状态变更之前拒绝（请求保持 `requested`）。
4. 原子抢单（单条 data-modifying CTE = 单事务）：
   `UPDATE ... WHERE request_id=? AND state='requested' AND NOT EXISTS(intent)` +
   `INSERT intent ... ON CONFLICT DO NOTHING`；返回空 → 拒绝并 `delivery_uncertain`。
5. 生成 XLSX（`buildWorkbook`）→ 算 **文件字节 sha256**（`xlsx_sha256`）。
6. 永久 artifact：`private/preview-deliveries/<request_id>/<PO>.xlsx`（gitignored、非 scratch），
   写后读回校验；同名不同字节拒绝覆盖。
7. 写 `server_prepared` 证据（`unique(intent_id,stage)`），读回校验 sha/bytes/path。
8. **只读**预检各 Queue 目录（Pending/Processing/Done/Failed/NeedsReview）：同 PO 同名文件
   已存在 → 拒绝覆写（旧 bridge 会覆盖），`delivery_uncertain`，不 write。
9. `POST {write:{path,b64}}` **一次**；`ok:true`、路径与字节数一致才继续。
10. `POST {read:path}` 读回→ 与原件**逐字节**一致且 sha 相同。
11. 单条语句同时：insert `windows_received` 证据 + intent→delivered + request→delivered，
    返回 `evidence_rows/intent_state/request_state`，三项全部符合才声称 delivered。

任何第 8–11 步失败 → `delivery_uncertain`，进程退出码 2，不自动重试。

## 3. 证据链

| stage | 何时写 | 内容 |
|---|---|---|
| `server_prepared` | 永久原件落盘并读回后、bridge 之前 | `xlsx_sha256`（文件字节）、`byte_count`、`target_path`、artifact 路径 |
| `windows_received` | bridge `read` 回完全一致后，与 delivered 同事务 | 同上 + `readback_sha256`、bridge 报告大小 |

`content_sha256`（业务 JSON 摘要，`computePushContentSha256`，精度安全）与
`xlsx_sha256`（文件字节）**分开存放、绝不互比**。ACK 的 `source_sha256` 只与 `xlsx_sha256` 比较。

## 4. 唯一运行方式

```
node scripts/preview-po-dispatch.mjs --request-id <request_id>
```

- 必须显式 `--request-id`；不提供 runall / poll / once / 常驻 / cron；不 import 生产 `startPusher`。
- 数据库只走 Supabase Management API `POST /v1/projects/<ref>/database/query`
  （PostgREST service_role 对 `tj_preview` 无 USAGE）。
- 凭据来自 `~/.hermes/.env`（`SUPABASE_PAT` 或 `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`
  或可解析的 `SUPABASE_URL`）；不打印。
- 可选：`--artifact-root`、`--bridge-url`、`--target-dir`（只接受 Pending 常量）。
- 退出码：0 delivered/already；2 uncertain/业务拒绝；1 参数/配置/意外错误。

## 5. 代码位置

| 文件 | 作用 |
|---|---|
| `scripts/lib/preview-dispatch-core.mjs` | 状态机、SQL 生成（全部 `tj_preview`）、artifact store、bridge 客户端 |
| `scripts/preview-po-dispatch.mjs` | CLI 装配（request-id / Management API / 单次运行） |
| `web/src/lib/core/preview-push.js` | 预览状态文案 + RPC 响应校验（纯逻辑） |
| `web/src/lib/tjPoApi.ts` | `requestPreviewPush`（RPC，不设 pending_push）、`listPreviewPushRequests` |
| `web/src/pages/TjPoSystemPage.tsx` | 预览「请求预览投递」按钮 + request/state 读回 |
| `scripts/windows/Stage25_PO_ACK_Worker_Preview_V2.ps1` | Windows ACK 预览 V2（独立目录、tj_preview、DPAPI、回执判定修复） |
| `docs/windows-stage25-preview-handoff.md` | 无密钥 Windows 交接说明 |

## 6. 尚未完成 / 由主脑执行

- 上述 tj_preview 表/RPC 迁移由另一执行器应用；本分支不建迁移、不连真实库。
- Preview 前端部署分支由主脑决定（不新建 Pages 项目）。
- Windows 实测：只运行 `03_SelfTest.cmd`（离线）；`Configure/Login/SendOne` 由用户在真实
  Windows 手动执行；只验证**新 PO**，绝不对旧 `PO-000025/26` 重投。
- 本链路不会显示 ACK「已保存」状态：预览 UI 只显示 request/state；若后续要显示 ACK
  saved manual，需新增独立 label，不能混同标准 ACK。
