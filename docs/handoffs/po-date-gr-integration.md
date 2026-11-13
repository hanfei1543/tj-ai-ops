# 任务交接单：PO Date + Unified GR 整合（integration/po-date-gr-v2）

## 目标及完成标准
- 接续锚点：进入 /home/hermes/worktrees/TJ-AI-Ops-integration（分支 integration/po-date-gr-v2），先读本交接单；下一项是真实 tj_preview 应用与人工恢复 UI/CLI，均需单独授权，不从头审计。
- 目标：在 Unified GR 底座上补回 PO Date 修复的每一条安全规则，修复 tj_gr_po_save 不写 website_po_date 的缺口，统一 createPo/updatePo 签名，并入 pad-date 8 列 standard + legacy-standard，并保留 PO Push 投递幂等。
- 当前完成的是隔离分支的本地代码整合 + 离线验证，不是真实库迁移或生产部署。

## 已定结论与理由
- 底座 = Unified GR（feature/unified-gr-preview，5fb547b），其 Stage16 已 36/36 通过；PO Push 投递幂等（integration/po-push-idempotency 723a773）已 cherry-pick 进来。
- tj_gr_po_save 之前 INSERT/UPDATE 均不写 website_po_date，已修（20261114 migration + 已折回 20261113 源，使 public prepared 同步）。
- 统一签名（已实施）：
  createPo(supplier, lines, createdBy, websitePoDate, notes, requestId)
  updatePo(id, supplier, lines, websitePoDate, notes, requestId, createdBy)
  websitePoDate 必填；preview 走 po_save（带 website_po_date + 读回），生产 REST 写日期 + 读回 + 冻结/合并/已推送守卫。
- requestPush 加日期门禁：读不到 website_po_date 列（42703 / message 含列名）或日期缺失/非法一律拒绝入队，绝不退回 7 列。
- po-lines.js 已并入 pad-date 8 列口径：standard 固定 8 列（原 7 列 + Website PO Date，日期必填）；legacy-standard 仅显式用于非 PAD 历史兼容（网页导出拒绝）；po_type/mode 自洽校验（合并单不能用 standard/legacy 绕过审批快照）。
- normalizeDecimal 纯字符串归一：大数(>2^53)/6 位小数不丢精度，字符串绝不经过 Number。
- PO Push 投递幂等：dispatch_started 先于 bridge 持久化；bridge 已调用但 delivered 未可靠记录 → delivery_uncertain 停轮询不重发；同 PO 即使 sha 不同也不得重投（UNIQUE(po_header_id)）；不因 Pending 不存在而重投。

## 批准边界
- 用户批准：独立分支本地修改、测试、commit。
- 不批准：push、merge 正式分支、真实 DB migration、生产部署、连接生产 Bridge/Queue/PAD/IRS、调用真实 task_claim/task_result。
- 本地 commit 不等于 push/部署/功能开放。PRODUCTION_DEPLOYED=false 维持。

## 当前事实与证据
- 分支 integration/po-date-gr-v2，commit 链：cec972c（PO push 幂等）→ d6562f0（首轮整合）→ 本轮（并入 pad-date 8 列 + requestPush 门禁 + integration SQL 补日期 + 重生成 public prepared）。
- 本轮并入 pad-date 文件（po-lines.js/.d.ts、approved-snapshot.js、tjPoExcel.ts、gen_po_excel/preview-sample/tj-po-push.mjs 注释、po-lines/preview-sample/approved-snapshot/prelaunch-guards 测试、新增 po-api-date/tjpo-excel-standard-mode/web-po-date-wiring/api-harness 测试）。
- 手工合并冲突文件：po-push-core.mjs（注释 7→8 列）、pusher/pusher-entry/pusher-source-owners/po-push-idempotency 测试（补 website_po_date fixture + 8 列断言 + 缺日期 fail closed 负例）。
- requestPush 日期门禁已补；web-po-date-wiring.test.mjs 断言更新为统一签名（websitePoDate 必填非可选）。
- integration SQL：20261113_gr_preview_integration.sql 的 po_save 用例补 website_po_date，新增 po_save 缺日期/非法格式 GR_VALIDATION 真实回归块。
- 20261114 po_save 修复已折回 20261113_gr_unified_preview.sql 源，重生成 gr_unified_public_prepared.sql（public.tj_gr_po_save 同步写 website_po_date），--check 通过。
- 离线验证（本轮实跑）：npm test 252/0 fail；tsc -b + vite build 通过；gr-po-save-date-smoke.mjs（PGlite）ALL PASS。
- 未重跑 Windows Stage16（未受改动影响）；PO-878329 的 8 列读取成功是 Windows/PAD 实测，本轮 VPS 未代跑 Windows。

## 阻塞与避坑
- 两条新 migration（20261114_gr_po_save_website_date.sql、20261114_po_push_intents.sql）均未应用到真实 tj_preview/public，需单独授权；public prepared 文件无版本前缀、带 SQL 手工门禁，迁移工具不会自动套用。
- RLS/权限：tj_preview 侧新表只读策略 + 写走 definer RPC + 内部 helper 全 revoke（含 service_role 禁入 schema）已在迁移源里；public 侧旧表仍是 anon 宽松权限（已知生产阻塞，本轮不收敛，需单独授权收紧）。这些是代码事实，不等于真实库已应用。
- PO Push 人工恢复：状态机 + stopPollingForReview（拉回 confirmed）+ 意图表阻断重投已实现并被测试覆盖；但「人工恢复 UI/CLI」（delivery_uncertain/needs_review 后人工核对 + 解除留痕）尚未实现，needs_review 状态无代码路径进入/解除 → 保持 UNKNOWN，不冒充已上线。
- 真实 Preview 未应用，浏览器交互验收（日期必填拒绝 / 8 列导出 / 收货 / 合并）尚未做。
- 不要重跑已通过的 PO Excel / Stage16 离线测试，除非整合改动影响其合约。

## 下一步
- ① 单独授权后真实应用两条 20261114 migration 到 tj_preview，再补 20261113_gr_preview_integration.sql 的真实回归（本地 PGlite 已先验）。
- ② 实现 PO Push 人工恢复 UI/CLI（delivery_uncertain/needs_review 后人工核对 + 解除留痕）——当前是 UNKNOWN/未实现。
- ③ 真实 tj_preview 应用后浏览器交互验收（日期必填拒绝 / 8 列导出 / 收货 / 合并）。
- ④ public 版真实迁移、旧表 anon 权限收紧、旧 7 列消费者切换，均需单独授权与读回核验。

## 按需读取
- 代码工作区：/home/hermes/worktrees/TJ-AI-Ops-integration；分支 integration/po-date-gr-v2。
- 关键文件：web/src/lib/tjPoApi.ts、web/src/lib/tjGrApi.ts、web/src/pages/TjPoSystemPage.tsx、web/src/lib/core/po-lines.js、supabase/migrations/20261114_gr_po_save_website_date.sql、supabase/migrations/gr_unified_public_prepared.sql、scripts/lib/po-push-core.mjs。
- 测试：tests/normalize-decimal.test.mjs、tests/po-push-idempotency.test.mjs、tests/tjpo-excel-standard-mode.test.mjs、tests/po-api-date.test.mjs、tests/web-po-date-wiring.test.mjs、scripts/gr-po-save-date-smoke.mjs。
- 第一轮审计与整合蓝图见上一会话（git log / docs/SOT-full.md 历史）。
