# 任务交接单：PO Date + Unified GR 整合（integration/po-date-gr-v2）

## 目标及完成标准
- 接续锚点：进入 /home/hermes/worktrees/TJ-AI-Ops-integration（分支 integration/po-date-gr-v2），继续 PO Date + Unified GR 整合；先读本交接单，不从头审计。
- 目标：在 Unified GR 底座上补回 PO Date 修复的每一条安全规则，修复 tj_gr_po_save 不写 website_po_date 的缺口，统一 createPo/updatePo 签名，并保留 PO Push 投递幂等。
- 当前完成的是隔离分支的本地代码整合 + 离线验证，不是真实库迁移或生产部署。

## 已定结论与理由
- 底座 = Unified GR（feature/unified-gr-preview，5fb547b），其 Stage16 已 36/36 通过；PO Push 投递幂等（integration/po-push-idempotency 723a773）已 cherry-pick 进来。
- tj_gr_po_save 之前 INSERT/UPDATE 均不写 website_po_date（读回 tj_gr_po_json 已有日期），导致 Preview 普通单保存后日期恒 NULL——已修。
- 统一签名（已实施）：
  createPo(supplier, lines, createdBy, websitePoDate, notes, requestId)
  updatePo(id, supplier, lines, websitePoDate, notes, requestId, createdBy)
  websitePoDate 必填；preview 走 po_save（带 website_po_date + 读回），生产 REST 写日期 + 读回 + 冻结/合并/已推送守卫。
- normalizeDecimal 纯字符串归一：大数(>2^53)/6 位小数不丢精度，字符串绝不经过 Number。
- PO Push 投递幂等：dispatch_started 先于 bridge 持久化；bridge 已调用但 delivered 未可靠记录 → delivery_uncertain 停轮询不重发；同 PO 即使 sha 不同也不得重投（UNIQUE(po_header_id)）；不因 Pending 不存在而重投。

## 批准边界
- 用户批准：独立分支本地修改、测试、commit。
- 不批准：push、merge 正式分支、真实 DB migration、生产部署、连接生产 Bridge/Queue/PAD/IRS、调用真实 task_claim/task_result。
- 本地 commit 不等于 push/部署/功能开放。PRODUCTION_DEPLOYED=false 维持。

## 当前事实与证据
- 分支 integration/po-date-gr-v2，两个 commit：cec972c（cherry-pick PO push 幂等）、d6562f0（本轮整合）。
- 本轮改动 7 文件：20261114_gr_po_save_website_date.sql（新 migration，未应用）、gr-po-save-date-smoke.mjs、tjGrApi.ts、tjPoApi.ts、TjPoSystemPage.tsx、po-push-core.mjs（normalizeDecimal）、tests/normalize-decimal.test.mjs。
- 离线验证（本轮实跑）：npm test 209/0 fail；tsc -b + vite build 通过；gr-po-save-date-smoke.mjs（PGlite）ALL PASS（可重入 + 写入/读回一致 + 缺日期/非法格式 GR_VALIDATION + 零残留）。
- 未重跑 Windows Stage16（未受改动影响）。

## 阻塞与避坑
- 两条新 migration（20261114_gr_po_save_website_date.sql、20261114_po_push_intents.sql）均未应用到真实 tj_preview/public，需单独授权。
- pad-date 的 po-lines.js 8 列标准单口径未并入（本轮统一了 API 层，但 po-lines.js 仍是 unified-gr 基线 7 列 standard）。下一阶段做。
- 20261113_gr_preview_integration.sql 里旧 po_save 用例缺 website_po_date 参数，真实应用 20261114 后会 GR_VALIDATION 失败，需同步补。
- gr-gen-public-prepared.mjs --check 会因 preview 版改动失同步，需重新生成 public prepared。
- 不要重跑已通过的 PO Excel / Stage16 离线测试，除非整合改动影响其合约。

## 下一步
- ① 真实应用两条 20261114 migration（单独授权后），并同步补 integration SQL 的 po_save 日期参数。
- ② 并入 pad-date 的 po-lines.js：standard 8 列 + legacy-standard + po_type/mode 自洽校验，回归推送器 8 列输出。
- ③ 重新生成 public prepared RPC（gr-gen-public-prepared.mjs）。
- ④ 实现 PO Push 人工恢复 UI/CLI（delivery_uncertain/needs_review 后人工核对 + 解除留痕）。
- ⑤ 真实 tj_preview 应用后浏览器交互验收（日期必填拒绝 / 8 列导出 / 收货 / 合并）。

## 按需读取
- 代码工作区：/home/hermes/worktrees/TJ-AI-Ops-integration；分支 integration/po-date-gr-v2。
- 关键文件：web/src/lib/tjPoApi.ts、web/src/lib/tjGrApi.ts、web/src/pages/TjPoSystemPage.tsx、supabase/migrations/20261114_gr_po_save_website_date.sql、scripts/lib/po-push-core.mjs。
- 测试：tests/normalize-decimal.test.mjs、tests/po-push-idempotency.test.mjs、scripts/gr-po-save-date-smoke.mjs。
- 第一轮审计与整合蓝图见上一会话（git log / docs/SOT-full.md 历史）。
