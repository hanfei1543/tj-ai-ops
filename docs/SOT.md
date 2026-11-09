# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-09 22:13

## 1 当前焦点与下一步
- PO 采购单（业务一，已独立上线）：web/ 独立 Vite app，部署 tj-ai-ops.pages.dev/tj-po-system；GitHub hanfei1543/tj-ai-ops + CF Git 集成（push main 自动部署）；复用 DYT 同一 Supabase 的 tj_* 表（anon 读写）。真相源 docs/tj-po-system.md。
- 当前焦点（业务二 IRS POS）：IRS POS 入货试走暂停于导入格式/输入兼容调查；仅选中 ING HAN 供应商 4000/I01，尚未录入明细、保存、过账或修改 Item Master。
- 下一步（IRS POS）：先读交接并复核桥/窗口现状；找厂家导入模板或软件导出数据样本，确认 Text/Excel 格式。不要把打印 PDF 当导入规范，导出文件也不保证能导回。
- 已排除/勿重试：node/npm/agent-desktop/SSH 客户端均可运行；explorer/irsPOS/node 同在 Session 1，本机同样复现前台失败，不再重复让用户点搜索框或核对 SessionId。空 txt 无反应、空有效 xlsx 报 external table is not in the expected format，均不代表格式已确定；不盲装 Excel、不猜格式导真货品。
- 批准边界：用户允许 agent-desktop 键鼠操作，拒绝截图坐标点击；只试 ING HAN D-021660 与 FORTUNE I-107612。首次保存前停给用户确认；无任何已保存业务成果。
- 接续关键：三货号以用户确认为准 1050006000025 / 1030033000054 / 1030033000068；ING HAN 无 invoice number 用 DO number。MyInvois 按公司名前段检索、DO 当天或之后、最终按货品描述匹配；查价步骤尚未跑通。

## 2 交接上下文
- REQUIRED: docs/handoffs/stock-setup.md

## 3 未归档缓冲池
- (空)
