# Stage28 — Website GR Task → Windows Bridge 正式集成（交接）

> 本次只补齐 Website → Windows 的实际连接，未重新创建 PO/GRN，未重复 Stage26/27 测试，
> 未执行真实 IRS Save/Post，未改 main/public（public 迁移仍是 PREPARED 未应用）。

## 交付内容（代码 + 迁移 + 测试 + 传输证据）

新增/修改文件（分支 `feature/stage28-gr-dispatch`，基线 `feature/unified-gr-preview`）：

- `scripts/gr-dispatch-core.mjs`（新增）—— VPS 侧 Preview Task Dispatcher 核心：纯逻辑、依赖注入。
  只投递 `environment=preview / schema=tj.gr.v1 / type=GOODS_RECEIVE / mock_only=true`，
  投递前离线复算 `payload_sha256` + `event_payload_sha256`（JS==SQL），不符即拒绝；不 claim、不 result。
- `scripts/tj-gr-dispatch.mjs`（新增）—— Dispatcher CLI 入口：Management API（PAT）读/写 tj_preview outbox，
  bridge 投递到 Windows GR Queue，标 outbox `mock_dispatched`。
- `scripts/windows/gr-worker/worker-core.mjs`（新增）—— Windows Worker 核心：五阶段严格区分
  （delivery→claim→save_attempt→saved→verified），重复阻断、PAD 未接入不 claim、SHA 校验、事件账本。
- `scripts/windows/gr-worker/worker.mjs`（新增）—— Windows Worker 入口：本地文件队列 + Supabase Auth RPC + JSONL 账本。
- `scripts/windows/gr-worker/pad-adapter.mjs`（新增）—— PAD 接口（saveEntry 未保存录入 / readBack 独立回查），当前**待接入**。
- `scripts/windows/gr-worker/config.example.env` + `run-worker.bat` + `run-worker.ps1`（新增）—— 运行配置与启动脚本（无凭据）。
- `scripts/tunnel/bridge.js`（修改）—— write 白名单新增 `operation\GR_Queue\Pending`（独立 GR Queue，与 PO_Queue 分离）。
- `supabase/migrations/20261113_gr_unified_preview.sql`（修改）—— 两个 canonical 函数排序改 `collate "C"`（见下）。
- `supabase/migrations/20261116_gr_canonical_collate.sql`（新增）—— 增量迁移：修正 canonical 排序为字节序，已应用到 tj_preview。
- `supabase/migrations/gr_unified_public_prepared.sql`（重新生成）—— public 版同步 COLLATE "C"（仍未应用）。
- `tests/gr-dispatch-core.test.mjs` + `tests/gr-worker.test.mjs` + `tests/helpers/gr-task-fixture.mjs`（新增）。

## 关键发现并修复：JS/SQL canonical SHA 分叉（COLLATE）

Dispatcher 对真实 outbox 做 SHA 复算时发现 4 条历史任务 `payload_sha256` 与 JS 复算不一致。
定位：SQL `tj_gr_task_canonical` 的 `order by k` 用数据库默认 collation（Supabase 为 locale/ICU），
把 `event_payload_sha256`（下划线）排在 `event.*`（点）之前；而 JS `.sort()` 是字节序（`.` < `_`）。
PGlite(WASM) 默认 C collation，所以本地 smoke 一直没暴露；真实 Supabase 才暴露。

修复：两个 canonical 函数排序改 `order by … collate "C"`（字节序，对齐 JS）。**只改排序 collation，不改任何语义。**
已验证：修复后 SQL 复算 == JS 复算（`c8e418b4…` 一致）。

影响：历史 4 条 QA mock 任务（`QA-NOT-REAL-*` / `QA-MAP-*`，Nov 13 释放）的存储 hash 是旧 collation 口径，
现在被 Dispatcher 正确拒绝（SHA 校验在起作用）。**未修改这 4 条（尊重「不重复已通过测试」）；新任务走新口径。**

## 端到端 Task Delivery 证据（真实）

用 `scripts/insert_delivery_fixture.mjs` 在 tj_preview 插入一条 QA-STAGE28 投递夹具（irs_po_no=`QA-STAGE28-DELIVERY`），
跑 `node scripts/tj-gr-dispatch.mjs --once`：

- 5 条 pending outbox：4 条历史 stale hash 被正确拒绝（`GR_DISPATCH_HASH_MISMATCH`），1 条夹具投递成功。
- Windows 侧（bridge list）出现 `task-a5000000-…json`（4023B）；bridge read 读回信封
  `schema=tj.gr.dispatch.v1 / mode=mock / payload_sha256=40374b66… / irs_po_no=QA-STAGE28-DELIVERY`。
- outbox 读回状态 = `mock_dispatched`，`dispatched_at` 已写。

即：Website（tj_preview outbox）→ Dispatcher → bridge → Windows GR Queue → 读回核对 → outbox 标已投，闭环。

## 运行配置（不含凭据）

Dispatcher（VPS）依赖环境变量：`SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF`（读/写 tj_preview 用 Management API，
因为 tj_preview 故意不授 service_role USAGE）、可选 `GR_QUEUE_DIR`（默认 `…\operation\GR_Queue\Pending`）、`GR_BRIDGE_URL`。

Worker（Windows）依赖 `.env`（模板见 `scripts/windows/gr-worker/config.example.env`）：
`TJ_SUPABASE_URL` / `TJ_SUPABASE_ANON_KEY` / `TJ_GR_EXECUTOR_EMAIL` / `TJ_GR_EXECUTOR_PASSWORD`
（executor 成员 Supabase Auth 登录，用于 claim/result）/ `TJ_GR_QUEUE_DIR` / `TJ_GR_LEDGER_FILE` / `TJ_GR_PAD_CONNECTED`。

注意：当前运行中的 bridge 仍是旧版（白名单只有 PO_Queue\Pending），因此本轮真实投递用的是
`…\PO_Queue\Pending\GR_Queue\` 子目录。**最终独立 `…\GR_Queue\Pending` 需在 Windows 端替换
`C:\irs\bridge.js`（Worker ZIP 内含更新版），替换后 Dispatcher 默认路径即生效。**

## 待 PAD 接入的明确接口清单

1. `pad-adapter.mjs` 的 `saveEntry(task)` —— PAD 未保存录入（把 `task.scope.lines` 录入 IRS Goods Receive）。
   **待接入**：目前 `isConnected()=false`，Worker 不 claim（不污染 DB）。
2. `pad-adapter.mjs` 的 `readBack(task)` —— 保存后独立回查（真实读回 IRS 单据，逐行核对 GRN/数量/单价），
   返回 verified 的 `evidence`。**待接入**：没有真实 GRN 回查证据前，Worker 停在 `saved`，绝不伪造 `verified`。
3. 保存结果不明（超时/断线）→ 回报 `needs_review`，不重发。当前无真实 PAD 回查，此路径同样未实际触发。

接入时：实现 `saveEntry`/`readBack`，`isConnected()` 返回 true，并据真实 IRS 返回填 evidence；
`TJ_GR_PAD_CONNECTED=true` 才会走完整 claim→save→verified 流程。

## 测试结果

- `npm test`：210 通过 / 0 失败（191 既有 + 19 新增：dispatcher 幂等/SHA/恢复 9 条 + worker 五阶段/重复/阻断 10 条）。
- `scripts/gr-local-smoke.mjs`（PGlite）：ALL PASS（迁移可重入 + JS==SQL canonical + public 门禁）。
- 区分：Mock 隔离（Dispatcher/Worker 单测 + PGlite）已测；真实 Preview 端到端投递已测（见上）；
  **真实 IRS Save/Post 与真实 GRN 回查未执行（待 PAD 接入 + 授权）。**

## 未做 / 待授权

- 未 push / merge / deploy；未改 main/public；未执行真实 IRS Save/Yes/Post。
- public 迁移（`gr_unified_public_prepared.sql`）仍是 PREPARED 未应用，本轮仅重新生成以同步 COLLATE 修复。
- 真实（非 mock）GR 任务授权、真实 Windows Worker 凭据交接、PAD 录入与回查，均待后续独立授权。
