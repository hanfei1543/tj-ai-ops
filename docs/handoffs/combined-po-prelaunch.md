# Combined PO 上线前修正与分阶段开放

## 目标及完成标准
- 完成 feature/combined-po 上线前日期与独立冻结修正，保留普通单流程；以真实隔离数据库、浏览器、Excel 读回、自动测试和独立审查验收，以本地 commit 保存，不以正式部署为完成标准。

## 下一步
- 接续锚点：先复核本交接单与 docs/SOT.md 当前状态及剩余风险，等待用户明确下一步授权；未经用户确认，不 merge/push main、不部署生产、不执行真实 Windows Queue 测试。本轮本地提交以 git log 为准。

## 已定结论与理由
用户明确选择方案 A：Website PO Date 是 Combined PO 的正式采购单业务日期，由开单人或核对人在提交审批前明确选择。不得默认当天，不从 created_at、received_at、approved_at 推算。缺日期不得提交最终审批、批准或推送。批准后日期与商品明细一起冻结。PO_Lines 保留原 7 列并在 Combined PO 末尾追加 Website PO Date，文本格式 yyyy-MM-dd；IRS 画面转换以后交 PAD。
普通单张 PO 的建单、审批、Push、Queue、Bridge 保持既有行为，不能因 Combined PO 冻结而一并停用。

已冻结的 tj_preview PO-000003 不能直接补日期或重写已批准资料；如需有日期的测试，另建隔离测试单并完整重新审批。用户确认 GR 编号 5 来自模拟脚本，不是真实数据库错误，不为此清改生产资料。

允许：本分支修正、隔离 Preview 验证、内部样本、本地 commit、准备部署与回滚方案。不代表允许 main merge/push、正式网站部署、真实 IRS 写入或生产数据清洗。

## 批准边界
- Combined PO Push：前台、API、后台推送器与数据库防绕过应共同拦截；来源单不能改状态后单独推送。等 Windows PAD 完成 IRS PO 录入、防重复、保存后回查及错误恢复验收，再由用户明确授权开放。
- GR 正式 Push／IRS 过账：不启用。等独立 GRN 与收货事件防重复验收通过，再另行授权。内部 Excel 不代表允许过账。
- Add New Item：暂停开发与启用，保留代码，隐藏或禁用入口及直链；等 IRS Item Master 字段验收后，再决定继续开发。
三项分别授权，不能随网站上线自动开放，也不能一起解除冻结。

## 当前事实与证据
2026-11-12 只读快照：public 7 张 PO 全为 standard（14 明细、7 导出记录、0 新商品申请）；tj_preview 4 张 PO（8 明细、0 导出、0 新商品申请）。Preview PO-000001/2 是合并来源，PO-000003 confirmed/frozen，另有普通测试单 PO-000005。PO-000003 的 irs_po_no、irs_grn_no 均为 null，DO No 原值为空，不得捏造补齐。
public identity last_value=12/is_called=false；tj_preview=5/true，独立序列。Preview 外键指向 tj_preview，不跨 public。service_role 经 REST 访问 tj_preview 返回 403。
Cloudflare production_branch=main；Preview schema=tj_preview，Production 无该变量（走 public）。当时线上 Preview 为 2aa55ab，正式为 5dab554；这只是当时快照，后续必须读回核对，不当成当前已部署本轮修正。
现有推送 cron 的包装器读取当前仓库 scripts/tj-po-push.mjs；更新推送器源文件可能在下一 tick 生效，不能把本地脚本改动说成完全未影响运行端。禁止以真实 --once 做回归。

## 按需读取
- 当前状态 docs/SOT.md；回滚 docs/migration-rollback-20261112.md；数据库回归 supabase/tests/20261112_preview_integration.sql；旧 IRS 任务 docs/handoffs/stock-setup.md。以下备份与样本仅在需要核对或恢复时读取，不默认通读商业数据。
本轮变更前 TJ PO 逻辑备份已保存于 /home/hermes/backups/TJ-AI-Ops/20261112T065718Z/tj-prelaunch-backup.json（权限 0600）。含两 schema 四张 PO/申请表、序列状态、约束和触发器定义；不含凭据，不含商品/供应商主数据，不是全库 pg_dump，也不是异机灾备。原始快照与商业数据不入 Git。
回滚以停用新增功能、回退网站显示为先，保留冻结安全护栏、日期和来源数据。不能把旧可推 Combined 的脚本恢复成生产推送器；网站回滚不代表解除三项冻结。任何生产数据库恢复、删列、重置序列、生产推送器替换都需用户明确授权及真实现场复核。

### 已执行验收与内部样本
主脑最终实跑 npm test：110 passed / 0 failed，前端 tsc + Vite build 成功（已有大 chunk 提示，不阻断构建）。Preview 日期／冻结／推送总闸及 nullable approval_snapshot_version 迁移已单独应用并读回；supabase/tests/20261112_preview_integration.sql 在真实数据库执行通过，事务测试全部回滚。另用 anon REST 验证新测试单改日期／推送、来源单推送及 Preview 普通单推送均 400/23514 拒绝，并读回确认目标无变化。
独立首审提出的日期／顺序摘要覆盖及后台来源分页风险已修：v2 摘要由数据库读回的正式日期及批准明细计算，正式导出重算比对；后台按当前 PO 服务端 contains+limit=1 定向查来源，无全量第一页截断（包含大规模 mock 测试，拒绝路径 bridge 零调用）。提交／批准条件更新 0 行不再当成功。
浏览器测试使用本地 Preview 页面连接真实 tj_preview：日期初值空、缺日期不能提交；人工明确选择测试日期 2026-11-09，调顺序与实收数量后提交审批，审批前后显示日期，批准后无可编辑日期输入。新标准来源 PO-000007/8 经普通 createPo API 实际建单，合并为 PO-000009，并由新 API 批准及读回复核 v2 成功。日期只是测试值，不代表真实业务日期。
PO-000009 批准顺序：同一测试货号 00101，UNIT/2.50 订购 5、实收 4；UNIT/3.00 订购／实收 4；BOX/25.00 订购／实收 1。不同 UOM、单价保持独立。DO 为 DO-PRELAUNCH-V2-001；receipt_event_id 由程序生成。内部 PO／GR Excel 已逐行与数据库读回核对；后台格式生成器同样输出 7 原栏 + Website PO Date，但不解除推送。
早期浏览器样本来源 PO-00-901/902 与 PO-000006 保留为旧摘要回归资料，不回填版本。原 PO-000003 的既有批准字段和明细不动，日期仍空；旧摘要与缺日期单只允许内部 review，不作为可正式导入的文件。
最终读回：生产原 7 headers / 14 lines / 7 exports / 0 item_requests 全部内容未变；public 序列仍 12/is_called=false。Preview 原有 4 张单及明细未改；新增测试后 headers=10、lines=22、exports=0、item_requests=0，Preview 序列自然推进到 9，不回收、不重置。service_role 访问 Preview 仍 403。普通 public PO-000009 推送入口只读可见且启用（未点击），普通单 7 列及 mock Queue/Bridge 通过；未向真实 Windows Queue 写文件。
交付内部样本目录：/home/hermes/backups/TJ-AI-Ops/20261112-prelaunch-samples/；推荐 REVIEW_INTERNAL_NOT_FOR_PAD_PO-000009.xlsx 与 REVIEW_INTERNAL_NOT_FOR_PAD_GR_PO-000009.xlsx，均为测试审阅资料。pad-format-internal-only/ 内另保留无审阅页的 PAD 格式验证文件，绝不能放入 Windows Queue。verification.json 保存逐行核对与文件 hash，不入 Git。
没有 push 任一分支、部署本轮托管 Preview 或生产网站；本轮“Preview 回归”指本地页面 + 真实隔离 schema，不等于旧 Cloudflare Preview 已包含修正。二次独立核心逻辑复核 passed=true／logic_errors=[]，同样实跑 110 项测试，已知未应用 public 迁移、非原子／竞态及严格冻结等风险保留并非生产安全放行。随后按其建议补强来源数量缺失不猜 0 与 Preview 版本列读回断言，再由主脑完整回归全通过；证据自动记录在样本目录 evidence/verification.json。本地提交以 git log 为准，不自动 push 或部署。

## 阻塞与避坑
日期缺失的旧冻结样本只能内部审阅，不能冒充可供 PAD 正式导入的样本。IRS 编号必须有独立核对证据，不能因字段里有数字即导出。生产 anon 写权限较宽，数据库护栏未应用前不能声称真实生产端已实现数据库防绕过；本轮生产迁移须另行授权。先完成修正、隔离回归，再提交给用户决定是否上线核心功能；三个冻结继续保持。
本轮有意保留数据库“已冻结表头整行不可修改”的严格限制，因此批准后也不能后补 IRS 验证编号。这符合当前 GR／IRS 写入停用边界，但不是完整可用的未来过账流程。日后经独立授权开放 GR／IRS 时，需要另行设计受控验证结果写入／独立关联记录，再验收回查、防重复与恢复；不能只把开关改为 true 就称已开放。
创建／取消合并仍是多次请求，尚非数据库原子事务；多用户并发与推送／合并竞态未做生产端到端验收，现有匿名写权限不是防恶意客户端的完整权限体系。正式上线核心功能前应确认这些遗留风险及生产护栏部署；不能因本次 mock 和隔离验收通过就宣称 IRS 录入、防重复及恢复已通过。待审批页面关闭后的恢复入口仍需后续完善，当前只验收同一页面内完整提交／批准链路。
