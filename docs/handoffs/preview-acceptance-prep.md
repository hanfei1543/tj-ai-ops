# 隔离 Preview 验收准备（审计 / 迁移方案 / 回滚 / 权限 / 测试 SOP）

> 本文是「隔离 Preview 验收准备」的记录，只做盘点与方案，不实际应用任何真实数据库 migration。
> 会变状态（URL、部署 commit、真实库是否已应用）以真实现场为准；本文如实标注 UNKNOWN，不猜测。

## 一、Preview 真实部署状态（任务四·1、2）

已核实的代码/文档事实（本机 worktree + 已落盘文档，非真实库查询）：

| 项 | 事实 | 来源 | 可信度 |
|---|---|---|---|
| 生产网站 | `tj-ai-ops.pages.dev/tj-po-system`，Cloudflare Pages Git 集成（hanfei1543/tj-ai-ops，root_dir=web，push main 自动部署） | docs/tj-po-system.md、AGENTS.md | 已记录 |
| Supabase 实例 | 复用 DYT 同一个 Supabase（VPS `.env` 有 SUPABASE_URL / SUPABASE_PROJECT_REF / SERVICE_ROLE / ANON） | /home/hermes/.hermes/.env | 已配置（未在本轮调用） |
| tj_preview schema | 真实库中已存在，且部分迁移已应用（receipt_event_id 唯一索引「public PREPARED / tj_preview 已应用」） | docs/SOT-full.md | 已记录（历史） |
| Preview 网站是否独立部署 | `tj_preview` 是 schema 隔离（VITE_SUPABASE_SCHEMA=tj_preview 构建期开关），**不等于独立站点**；文档称「Preview 已部署可测」但未记录独立 URL | docs/tj-po-system.md:98、web/src/lib/supabaseClient.ts | 未独立验证 |
| 两条 20261114 migration | 未应用到真实 tj_preview/public | docs/handoffs/po-date-gr-integration.md | 已记录 |

**UNKNOWN（本轮未验证，需真实环境访问 + 授权）**：
- Preview 的实际可访问 URL 与部署版本 commit（本轮在隔离 worktree，未发布任何 Preview 构建）。
- 真实 tj_preview 里 20261113_gr_unified_preview.sql 是否已完整应用（历史只记录 receipt_event_id 索引已应用）。
- 真实 tj_preview 的 RLS/权限是否与迁移源一致（「代码事实」≠「真实库已应用」）。
- 生产 public 侧旧表 anon 宽松权限的当前真实状态。

结论：**「有独立可用的 Preview 验收环境」尚未成立**。当前只有（a）生产 public 网站 +（b）真实库里的 tj_preview schema（部分迁移已应用）。要申请隔离 Preview 验收，需先真实应用 20261113 源 + 两条 20261114 迁移到 tj_preview，再发布一个指向 tj_preview 的 Preview 前端构建，并读回验证。以上均需单独授权。

## 二、两条 20261114 migration 的 Preview 应用 / 备份 / 回滚方案（任务四·3）

### 2.1 20261114_gr_po_save_website_date.sql（目标 tj_preview）
- 内容：`create or replace function tj_preview.tj_gr_po_save`，补写 website_po_date + 缺日期/非法格式 GR_VALIDATION 必填校验。
- 幂等：create or replace，重复 apply 安全。
- 只影响 tj_preview，不碰 public、不碰 DYT。
- 备份：apply 前导出当前函数体（`select prosrc from pg_proc where proname='tj_gr_po_save'` 或 Supabase SQL 编辑器取定义），存为 rollback 片段。
- 回滚：把 20261113_gr_unified_preview.sql 源里旧版 tj_gr_po_save 的函数体重新 apply（create or replace 覆盖回旧版）。
- 权限验证（apply 后读回）：函数仍是 security definer + search_path=''；`revoke execute on function ... from public/anon/authenticated` 保持；service_role 仍无 tj_preview USAGE。

### 2.2 20261114_po_push_intents.sql（目标 public）
- 内容：`create table public.tj_po_push_intents` + UNIQUE(po_header_id) + state 索引。
- **注意：这不是 Preview 迁移**——推送器 scripts/lib/po-push-core.mjs 只允许 public，且 Preview 里 po_push 硬拒（GR 契约：Preview 不写 Windows Queue）。该表是**生产推送器**的投递幂等真相源，属于 public 生产迁移，需单独授权，不归 Preview 验收。
- Preview 侧结论：Preview 不需要也不应创建该表；Preview 的 PO Push 走「硬拒」，无需投递意图表。
- 若误在 tj_preview 建该表：无意义（推送器拒绝非 public schema，不会读它）。
- public 侧回滚（未来授权后）：`drop table if exists public.tj_po_push_intents cascade`（表空时安全；有投递意图数据时禁止回滚，需先人工处理各 intent）。

## 三、Preview 能否严格关闭生产链路（任务四·4）

代码层已保证（契约内，非真实库验证）：

| 链路 | Preview 状态 | 依据 |
|---|---|---|
| PO Push → Windows Queue | 硬拒（po_push 一律拒绝） | docs/gr-contract-v1-preview.md §旧 PO 动作 |
| Bridge 写 Windows | 不接（Preview mock_only，不写 Windows 路径） | 同上 §边界 |
| GR Dispatcher 出队 | gr-mock-dispatcher.mjs 只写本地模拟目录，拒 Windows/Bridge/HTTP | 同上 §实际 GR 任务 payload |
| 真实 Bridge/Queue/PAD/IRS | 不接 | 权限边界（本轮禁止） |
| 生产推送器 cron | 只读 public，createSupabaseRest 拒绝非 public 注入 | scripts/lib/po-push-core.mjs |

**UNKNOWN（需真实环境确认，非代码可证）**：
- VPS 上是否仍有 cron 在跑 `scripts/tj-po-push.mjs`（若跑，它只读 public，不会碰 tj_preview，但要确认无 Preview 数据经任何路径进入 public）。
- 是否仍有 Bridge 隧道（9000）常驻指向 Windows 目标机。
- 真实 tj_preview 是否配置了任何 outbox worker / dispatcher 常驻。

## 四、权限 / RLS 审查（任务四·6）

迁移源里的设计（代码事实，非真实库已应用）：

- **tj_preview 侧**：新表只读策略；写走 security definer RPC（tj_gr_api / tj_gr_po_save 等）；内部 helper 全部 revoke public/anon/authenticated EXECUTE；service_role 无 tj_preview USAGE（防 service_role 绕过 RLS 直读写）。
- **public 侧**：旧表（tj_po_headers/tj_po_lines/tj_po_exports 等）仍是 anon 宽松权限——**已知生产上线阻塞**，本轮未收敛，需单独授权收紧。
- 信任边界：身份只取 auth.uid()（tj_gr_memberships），不信任请求体姓名。

**UNKNOWN**：真实 tj_preview 是否已按上述设计 apply RLS/revoke；真实 public 旧表当前权限。均需 apply 后读回 `information_schema` / `pg_policies` / `pg_proc` 确认，本轮未做（禁止真实库操作）。

## 五、测试账号 / 数据 / 安全操作顺序（任务四·7，草案）

角色（真实后端 tj_gr_memberships）：staff / approver / executor / admin。

建议准备（apply 后创建，本轮不建）：
- 采购员（staff）账号：用于新建采购单、登记收货、提交收货。
- 收货员工（staff）账号：登记收货、填 Invoice/DO、确认少收/分批。
- 审批人（approver）账号：批准采购单/合并单、批准收货、登记 IRS PO 映射。
- 管理员（admin）账号：排障、看技术详情/审计、人工恢复投递。

测试数据：用真实已存在的 sample PO（如 PO-878329 已在 Windows/PAD 实测 8 列读取成功），不重放历史 GRN、不自动创建 PO、不自动 Save/Yes。

安全操作顺序（验收时）：
1. 先读回确认 tj_preview 已 apply 迁移 + RLS/权限正确。
2. 采购员新建普通 PO → 显式填「采购日期 *」→ 缺日期必须字段级拒绝。
3. 审批人批准 → 收货员工登记收货 → 审批人批准收货 → 释放 → 观察状态流（草稿→等待审批→已审批→系统处理→IRS 已核对）。
4. 异常路径：少收（short_receipt）→ 中文解释 + 不误报；重复单据 → duplicate_document 提示。
5. PO Push 在 Preview 必须硬拒（不产生 Windows Queue 文件）。
6. 投递恢复只读工具：对 delivery_uncertain 样本 dry-run 出建议，不解除不重投。

## 六、本轮未验证 / 待单独授权清单

- 真实应用 20261113_gr_unified_preview.sql + 两条 20261114 迁移（读回验证）→ 需授权。
- 发布指向 tj_preview 的 Preview 前端构建并取得可访问 URL → 需授权。
- public 旧表 anon 权限收紧 + public 真实迁移 → 需授权（生产，独立边界）。
- 真实 Windows worker / Bridge 权限加固 / PAD 保存后真回读 → 需授权（不属本轮）。
