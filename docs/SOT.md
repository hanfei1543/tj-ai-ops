# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-13 员工界面中文化 + 投递恢复只读原型

## 1 当前焦点与下一步
- **接续锚点**：进入 /home/hermes/worktrees/TJ-AI-Ops-integration（integration/po-date-gr-v2），先读 docs/handoffs/po-date-gr-integration.md + docs/handoffs/preview-acceptance-prep.md；下一项需单独授权的真实 tj_preview 应用 + Preview 构建发布，不从头审计。
- **当前焦点**：员工界面中文化（ui-labels 唯一真相源 + 四页业务化，commit c384a24）与 PO Push 人工恢复只读原型（dry-run 决策矩阵，commit 88c2e36）已完成并提交；Preview 验收准备文档 docs/handoffs/preview-acceptance-prep.md 已落盘。npm test 269/269、tsc + vite build 通过。
- **下一步**：① 单独授权后真实应用 20261113_gr_unified_preview.sql + 两条 20261114 迁移到 tj_preview（读回验证）② 发布指向 tj_preview 的 Preview 前端构建并取得 URL ③ 真实浏览器交互验收（采购员/收货员工/审批人三角色）④ public 旧表权限收紧另行授权。
- **已排除/勿重试**：不 push、不 merge 正式分支、不真实 migration、不部署生产、不接生产 Bridge/Queue/PAD/IRS、不调真实 task_claim/task_result；不在隔离 worktree 做真实库查询；不伪造 UI 截图（需真实登录）；不重跑 Windows Stage16/18 离线测试。
- **对外简报**：员工界面改成中文业务系统，PO Push 人工恢复只读工具已做好；但 Preview 验收环境还没真正建起来，等你授权应用数据库和发布预览站。

## 2 交接上下文
- REQUIRED: docs/handoffs/po-date-gr-integration.md
- 本轮新增：docs/handoffs/preview-acceptance-prep.md（Preview 部署状态/迁移回滚方案/权限审查/测试 SOP）、docs/ui-simplification.md（四页变更说明 + 旧版→新版对照表）。
- 历史入口：docs/handoffs/combined-po-prelaunch.md；旧 IRS POS docs/handoffs/stock-setup.md，均不扩大批准边界。

## 3 未归档缓冲池
- [PROGRESS] 员工界面中文化（ui-labels + 四页 + 门禁，commit c384a24）+ PO Push 人工恢复只读原型（commit 88c2e36）+ Preview 验收准备文档 + UI 对照文档。
