# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-13 13:32 整合

## 1 当前焦点与下一步
- **接续锚点**：进入 /home/hermes/worktrees/TJ-AI-Ops-integration（integration/po-date-gr-v2），先读 docs/handoffs/po-date-gr-integration.md，继续 PO Date + Unified GR 整合，不从头审计。
- **当前焦点**：隔离分支已完成 tj_gr_po_save website_po_date 写入/读回修复 + 统一 createPo/updatePo 签名 + normalizeDecimal 精度修复 + 保留 PO Push 投递幂等；npm test 209/0 fail、tsc + vite build 通过、PGlite smoke ALL PASS。
- **下一步**：① 真实应用两条 20261114 migration（单独授权）并补 integration SQL 日期参数 ② 并入 pad-date po-lines.js 8 列 + legacy-standard ③ 重生成 public prepared RPC ④ PO Push 人工恢复 UI/CLI ⑤ 真实 Preview 应用后浏览器验收。
- **已排除/勿重试**：不 push、不 merge 正式分支、不真实 migration、不部署生产、不接生产 Bridge/Queue/PAD/IRS、不调真实 task_claim/task_result；不重跑已通过的 PO Excel / Windows Stage16 离线测试。
- **对外简报**：采购单日期和统一收货的代码整合在独立分支做完了，本地提交、测试全绿；还没应用到真实数据库，等你授权。

## 2 交接上下文
- REQUIRED: docs/handoffs/po-date-gr-integration.md
- 历史入口：docs/handoffs/combined-po-prelaunch.md；旧 IRS POS docs/handoffs/stock-setup.md，均不扩大批准边界。

## 3 未归档缓冲池
- (空)
