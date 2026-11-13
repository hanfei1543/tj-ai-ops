# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-13 02:28

## 1 当前焦点与下一步
- **接续锚点**：托管 Preview 一次性发布（待用户单独授权）；发布前无需再做代码改动。
- **当前焦点**：统一收货第二轮审查 B1（release 覆盖断言 0 数量来源卡死）已修并红→绿验证；浏览器已实测通过登录保护、收货列表、详情、审批放行全流程（映射登记→放行→锁定防重做）和普通收货表单（保存草稿→提交→锁定）；191 测试 + PGlite smoke 全绿，最终构建通过。已 commit 3b04aa4 + 6d02d60。
- **下一步**：① 等用户授权发布托管 Preview ② 合并收货表单浏览器端到端补测（SQL §9c + 152 项单测已覆盖来源展开/合成行拒绝）③ 交付报告 + 迁移差异/rollback 清单 + 最终生产基线比较。
- **已排除/勿重试**：不执行 public migration、不推 main、不部署生产、不解除 GR/Combined/Add Item 三项冻结、不接真实 Windows/Queue/IRS；不把合成 mock verified 当真实 IRS；不回 PAD Stage 12 排障；不恢复员工前台 Excel 下载按钮。
- **对外简报**：统一收货两遍审查都过了，放行 bug 修好、网页实测走通、构建通过，就等你点头发布预览版。

## 2 交接上下文
- REQUIRED: docs/handoffs/combined-po-prelaunch.md
- 旧 IRS POS 暂停任务：docs/handoffs/stock-setup.md，原批准边界不扩大。

## 3 未归档缓冲池
- (空)
