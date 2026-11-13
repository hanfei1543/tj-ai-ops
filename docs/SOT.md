# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-13 员工界面中文化 + 投递恢复只读原型

## 1 当前焦点与下一步
- **接续锚点**：进入 /home/hermes/worktrees/TJ-AI-Ops-integration（integration/po-date-gr-v2，HEAD 66c246e），先读 docs/handoffs/NEW_CHAT_START_HERE.md；下一项需单独授权的真实 tj_preview 应用 + Preview 构建发布，不从头审计。
- **当前焦点**：员工界面中文化 + PO Push 人工恢复只读原型 + Preview 验收准备文档已完成并提交；本轮新增 Goods Receive Date 业务规则审计（结论：收货日期已正确实现、与 PO/Invoice/DO/系统时间严格区分、进 hash/快照/任务/回调，无需修复，缺口为 DO 日期字段/作废 RPC/未来日期护栏）。npm test 269/269、tsc + vite build 通过。
- **下一步**：① 单独授权后真实应用 20261113_gr_unified_preview.sql + 20261114_gr_po_save_website_date.sql 到 tj_preview（读回验证）② 发布指向 tj_preview 的 Preview 前端构建并取得 URL ③ 采购员/收货员工/审批人三角色浏览器交互验收 ④ public 旧表权限收紧另行授权。
- **已排除/勿重试**：不 push、不 merge 正式分支、不真实 migration、不部署生产、不接生产 Bridge/Queue/PAD/IRS、不调真实 task_claim/task_result；不在隔离 worktree 做真实库查询；不伪造 UI 截图（需真实登录）；不重跑 Windows Stage16/18 离线测试。
- **对外简报**：员工界面改中文、收货日期业务规则已核对无误、投递恢复只读工具已做好；Preview 验收环境还没建起来，等你授权应用数据库和发布预览站。

## 2 交接上下文
- REQUIRED: docs/handoffs/NEW_CHAT_START_HERE.md（本轮最新接续入口，含 Goods Receive Date 审计 + Preview 状态 + migration 顺序 + 分类清单）。
- 历史：docs/handoffs/po-date-gr-integration.md、docs/handoffs/preview-acceptance-prep.md、docs/ui-simplification.md、docs/handoffs/combined-po-prelaunch.md；旧 IRS POS docs/handoffs/stock-setup.md，均不扩大批准边界。

## 3 未归档缓冲池
- [PROGRESS] Goods Receive Date 业务规则审计（六问，确认已正确实现 + 缺口 DO 日期字段/作废 RPC/未来日期护栏）+ NEW_CHAT_START_HERE 接续检查点落盘。
