# NEW_CHAT_START_HERE — 接续检查点（TJ-AI-Ops 隔离 Preview 验收准备）

> 本文件是换会话后的第一接续入口。结论按「已完成代码 / 本地测试 / 未部署 / 未验证 / 待授权」区分；
> 会变状态以真实现场为准，不猜测。下一轮不从头审计，直接决定安全 Preview 验收步骤。

## 0. 立即接续入口（30 秒）

- **工作区**：`/home/hermes/worktrees/TJ-AI-Ops-integration`（git worktree，非主 cwd）
- **分支**：`integration/po-date-gr-v2`（本地，无 upstream，未 push）
- **HEAD**：`66c246e docs(SOT)+docs: 员工界面中文化 + 投递恢复原型 + Preview 验收准备文档`
- **工作区状态**：clean（仅 `node_modules` 符号链接 untracked，gitignore 已覆盖，不提交）
- **第一动作**：读本文件 + 项目 `docs/SOT.md` + `docs/handoffs/preview-acceptance-prep.md`，然后决定是否授权真实 tj_preview 迁移。

**commit 链（自上而下）**：
```
66c246e docs(SOT)+docs: 员工界面中文化 + 投递恢复原型 + Preview 验收准备文档
88c2e36 feat(po-push): 人工恢复只读原型（dry-run 决策矩阵 + 只读检查器）
c384a24 feat(ui): 员工界面中文化 — 状态标签唯一真相源 + 四页业务化
324688a feat(po-date+gr): 并入 pad-date 8 列 standard + legacy-standard + requestPush 日期门禁  ← 整合基线
b9a0e6b docs(SOT): 档三归档 PO Date + Unified GR 整合并指向 integration/po-date-gr-v2 交接单
d6562f0 / cec972c / 5fb547b / cf98caa / e417a84 / 6d02d60 …（历史）
```

---

## 1. Goods Receive Date 业务规则 —— 审计结论（六问，均为代码/迁移源事实）

审计对象：`web/src/lib/core/receipt-core.js`、`supabase/migrations/20261113_gr_unified_preview.sql`（tj_gr_receipt_save/submit/approve/release/task_result、tj_gr_event_kv、快照、回调核对）、`web/src/pages/ReceiptFormPage.tsx`、`web/src/lib/core/receipt-tasks.js`。**结论：收货日期（Actual Goods Receive Date）已正确实现，与其它日期严格区分，且已有测试覆盖。本轮无需修复，仅记录缺口。**

**Q1 员工能否明确填写实际收货日期？—— 能。**
- 前端：`ReceiptFormPage.tsx` 有「收货日期（必选，不用提交时间代替）」`type=date`，初值来自 DB 或空，不默认当天。
- 后端：`tj_gr_receipt_save` 强制 `receive_date` 必填且 `yyyy-MM-dd`，缺/非法 → `GR_VALIDATION`（不猜、不自动用当天/创建时间/提交时间）。

**Q2 保存/提交/审批/合并收货/分批收货是否保留日期？—— 保留。**
- 保存：INSERT/UPDATE 写入 `receive_date`（header 列，`date not null`）。
- 提交：`tj_gr_receipt_submit` 只改 `status/submitted_by/submitted_at` + 重算 hash，不碰 `receive_date`。
- 审批：`tj_gr_receipt_approve` 只改 `status/approved_by/approved_at/allow_exceptions/review_note`，不碰 `receive_date`。
- 合并收货：`combine_submit` **不创建收货**（审计 `receipt_event_id_untouched: true`，集成测试断言「不伪造 receipt_event_id/received_at」）；收货（含 receive_date）由员工单独 `receipt_save` 建立。
- 分批收货：每个收货事件（`receipt_event_id`）有自己独立的 `receive_date`；短收走 `short_receipt` warning + 累计余额校验，不合并日期。

**Q3 审批后能否防未经授权改日期？修改有无审计？—— 锁定 + 有审计，但无作废 RPC。**
- `tj_gr_receipt_save` 仅允许 `status in ('draft','needs_review')`（非此状态 → `GR_STATE`）；已释放/已建任务的事件硬拒绝再编辑（需「作废 + 按新事件重新收货」）。
- 提交/审批后 `receive_date` 不可被 `receipt_save` 覆盖。save/submit/approve 各写 `tj_gr_audit` 行。
- **缺口**：契约写明「作废 + 新事件」为更正路径，但「完整人工修订/作废恢复 UI」仍是**未完成**（gr-contract-v1-preview.md §迁移、验收、回退与剩余阻塞）。当前无 `receipt_void`/作废 RPC。

**Q4 日期是否进入 approved snapshot / Task payload / Canonical SHA / 回调核对？—— 全部进入。**
- Canonical SHA：`eventKeyValues` 含 `event.receive_date`（JS receipt-core.js + SQL `tj_gr_event_kv`），`tj_gr_event_hash` 覆盖它。
- approved snapshot：快照含 `event.receive_date`（SQL 快照 select + `approved_event_snapshot`）。
- Task payload：`receipt-tasks.js` 的 canonicalTaskPayload 含 `event.receive_date`。
- 回调核对：`tj_gr_task_result` 证据里 `receive_date` 必须与快照一致，`distinct from` 即 mismatch（含缺字段）。

**Q5 PAD/IRS GRN 需要哪个日期？网站如何保留真实收货日期并标记差异？—— 已分离，不冒充一致。**
- 业务真相：`receive_date`（`date`）= 实际货物收货日期，进 hash/快照/任务/回调。
- 系统真相：`saved_at`（`timestamptz`）= IRS 实际保存的系统时间戳（tj_gr_tasks 列）。
- 回执证据同时要求 `receive_date`（核对快照）+ `saved_at`（timestamp）两字段，二者独立、不合并。**代码不因 IRS GRN 已保存就声称两日期一致**——GRN 号（irs_grn_no）+ saved_at 是 IRS 侧引用，receive_date 是网站侧业务日期。

**Q6 跨天/补录/分批/DO 日期 vs 收货日期？**
- 跨天登记：`receive_date` 显式、无当天默认 → 支持。
- 补录（回填过去日期）：显式日期、无未来日期校验 → 支持过去日期。
- 分批：各自事件各自 `receive_date` → 支持。
- DO 日期 vs 收货日期：**缺口**——当前 schema 无「DO 日期」字段（只有 `delivery_order_no` 文本号），仅 `receive_date` + `invoice_date`。若业务需单独记录 DO 日期，需 schema 新增（未建，需授权迁移）。
- 未来日期护栏：当前无「receive_date 不得晚于今天」校验，属业务决策，本轮未擅自加（补录/时区边界可能合法）。

**既有测试覆盖（已通过，无需重写）**：`receipt-core.test.mjs`（缺/非法日期拒绝、receive_date 进 hash、改日期改 hash）、`gr-ui.test.mjs`（表单空/非法日期拒绝、payload 保留日期）、`receipt-tasks.test.mjs`（task 规范化含 receive_date）。

---

## 2. Preview 部署状态

| 项 | 状态 | 依据 |
|---|---|---|
| 独立 Preview URL | **NOT DEPLOYED**（无独立站点；`tj_preview` 是 schema 隔离，不等于独立网站） | supabaseClient.ts（VITE_SUPABASE_SCHEMA 构建期开关）、本机 worktree 无任何 Preview 发布 |
| 生产网站 | 已部署 `tj-ai-ops.pages.dev/tj-po-system`（CF Pages，main 自动部署） | docs/tj-po-system.md |
| Supabase | 与生产 **DYT 共用同一 Supabase 实例**；`tj_preview` 是隔离 schema，非独立库/实例 | docs/gr-contract-v1-preview.md §边界 |
| 生产隔离关系 | 共用实例、不同 schema；GR 只写 `tj_preview`，不碰 DYT 数据/权限；生产 cron 读 public | 同上 |
| 真实 tj_preview 迁移现状 | 20261112 receipt_event_dedup **已应用**（SOT-full）；20261113_gr_unified_preview **疑似已应用**（有真实生成器跑通 tj_preview 证据），需读回确认；20261114 两条 **未应用** | docs/SOT-full.md、docs/handoffs/po-date-gr-integration.md |

---

## 3. Preview 需要的 migration（按顺序，不含 public 生产 PO Push）

目标 schema 均为 `tj_preview`：
1. `20261112_prelaunch_guards_preview.sql`（应用/读回确认）
2. `20261112_receipt_event_dedup_preview.sql`（**已应用**，SOT-full 记录 receipt_event_id 唯一索引）
3. `20261113_gr_unified_preview.sql`（主 GR schema/RPC/RLS，需读回确认）
4. `20261114_gr_po_save_website_date.sql`（website_po_date 落库修复，**未应用**）

**不属于 Preview**：`20261114_po_push_intents.sql` 目标是 `public`（生产推送器投递幂等真相源），Preview 的 PO Push 走硬拒，**不需要**该表；`gr_unified_public_prepared.sql` 是 public 版（PREPARED，未应用）。

---

## 4. 迁移前检查 / 备份 / 回滚 / 权限 / Bridge 隔离方案

- **迁移前检查**：读回当前 tj_preview 已应用的函数/表/RLS/FK（`information_schema`、`pg_policies`、`pg_proc`），与迁移源 diff，确认无遗漏/漂移。
- **备份**：apply 前导出将改动的函数体（`tj_gr_po_save` 等）与表结构，存 rollback 片段。
- **回滚**：`tj_gr_po_save` 是 `create or replace` 幂等，回滚 = 重应用旧版函数体；不 `DROP SCHEMA CASCADE`；不撤 service_role 的 public/DYT 权限。
- **权限**：apply 后读回确认——tj_preview 新表只读、写走 definer RPC、内部 helper 全 revoke、service_role 无 tj_preview USAGE（代码事实，需真实库读回）。
- **Bridge/Queue 隔离**：Preview 的 `po_push` 硬拒、GR 走 mock_dispatcher（只写本地模拟目录，拒 Windows/Bridge/HTTP）；生产 `scripts/tj-po-push.mjs` 只允许 public schema（createSupabaseRest 拒绝非 public）。**需真实环境确认**：VPS 无 cron 在跑推送器、无 9000 Bridge 隧道常驻、tj_preview 无 outbox worker。

---

## 5. UI 浏览器验收 —— NOT VERIFIED

四页（采购单列表/新建/收货列表/收货详情审批）的 UI 中文化改动**已提交**（c384a24，269 项测试 + tsc + vite build 通过），但**真实浏览器三角色验收未做**（页面需真实 Supabase Auth 过门禁）。等授权部署 Preview 后再提供真实截图，不伪造。

---

## 6. 人工恢复工具 —— 只读，真实恢复未完成

`scripts/lib/po-push-recovery.mjs` + CLI 只做 **dry-run**：查询意图状态、展示证据、输出恢复决策（不解除 intent、不删除、不重投）。真实恢复动作（记录 delivered / 解除旧意图后重投）**仍未实现**，列为上线前待办。

---

## 7. 分类清单

**已完成代码（本地 commit，已验证测试）**
- 员工界面中文化（ui-labels 唯一真相源 + 四页 + 门禁）— c384a24
- PO Push 人工恢复只读原型 — 88c2e36
- Goods Receive Date 业务规则（本就正确，本轮仅审计确认，未改动）

**本地测试（通过）**
- `npm test` 269/269；`tsc -b` + `vite build` 通过
- receive_date 相关既有测试全绿（receipt-core / gr-ui / receipt-tasks）

**未部署**
- Preview 独立站点 NOT DEPLOYED；无 Preview 前端构建发布；本分支未 push、未 merge、未部署任何环境

**未验证**
- 真实 tj_preview 的 20261113 源 + 20261114 迁移应用状态（未读回）
- 四页浏览器三角色交互验收（NOT VERIFIED）
- 真实 RLS/权限是否与迁移源一致

**待授权（下一轮决定安全 Preview 验收的具体步骤）**
- ① 真实应用 20261113_gr_unified_preview.sql + 20261114_gr_po_save_website_date.sql 到 tj_preview（读回验证）
- ② 发布指向 tj_preview 的 Preview 前端构建并取得 URL
- ③ 三角色浏览器交互验收（含收货日期必填/拒绝、8 列导出、短收/分批中文提示）
- ④ public 旧表 anon 权限收紧（生产上线阻塞，独立授权）
- ⑤ 如需：DO 日期字段（schema 新增）、未来日期护栏、作废/更正 RPC（业务决策）
