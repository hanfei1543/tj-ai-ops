# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-13 02:28

## 1 当前焦点与下一步
- **接续锚点**：已交付 Website 内部 Excel 测试文件（WEBSITE_PO_TEST.xlsx / WEBSITE_GR_TEST.xlsx，来自真实生成器 + PO-000009），核对 15/15 通过；待用户验收并决定是否继续（托管 Preview 更新／生产迁移／main merge/push 均未做）。
- **当前焦点**：feature/combined-po 新增收货事件防重复唯一索引（receipt_event_id，public 仅 PREPARED、tj_preview 已应用并 DB 断言通过）；Website 内部 PO/GR Excel 用真实生成器产出 WEBSITE_* 测试文件并逐行严格核对通过。已修 PO_Lines Qty 口径：改为订购数量 original_qty（原误用实收 accepted_qty，导致 PO Qty=4 与 GR Ordered Qty=5 不一致），逐行核对 16/16 通过，115 项测试 + tsc/vite 构建通过。普通单 7 列与单张 PO Push 路径不变。
- **下一步**：① 等用户验收两份文件与报告 ② 是否更新托管 Preview、是否应用 public 迁移／main merge/push／生产部署均待单独授权 ③ 三项冻结保持；各自验收后才各自申请解除。
- **已排除/勿重试**：Combined 及来源单 Push、GR 正式 Push／IRS 过账、Add New Item 分别冻结，网站上线不解除；不改旧冻结日期／摘要，不为模拟编号 5 清生产数据，不执行真实 Queue 推送或重置生产序号；不新增员工前台 Excel Export/Download 按钮。旧 IRS POS 任务仍暂停，以 stock-setup 交接为入口。
- **对外简报**：收货防重复和内部表格已生成并核对通过，正式数据没动、没有推送，等你验收。

## 2 交接上下文
- REQUIRED: docs/handoffs/combined-po-prelaunch.md
- 旧 IRS POS 暂停任务：docs/handoffs/stock-setup.md，原批准边界不扩大。

## 3 未归档缓冲池
- (空)
