# IRS POS 界面地图（逐步补全）

> 供未来「入货自动化」skill 使用；只记录界面事实，业务口径另行确认。

## 应用身份
- 公司：THIONG JOO HARDWARE & MACHINERY S/B（五金／机械）
- 版本：POS Standard v26.05-1（状态栏）
- 技术栈：.NET WinForms + DevExpress（Ribbon／NavBar 控件）
- 进程：irsPOS.exe；主窗口 automation_id = frmMain
- 数据库：本机 SQL（状态栏 "SERVER IP: 127.0.0.1"）
- 会计桥接：Link_to_SQL.exe「Transfer IRS Pos Data To SQL Account v26.07」（到期 2026-12-31）
- e-Invoice：Ribbon 有 e-Invoice tab（内置集成；是否用它还是 MyInvois 查价，待业务确认）

## 主窗口 frmMain 结构（2026-11-06 skeleton snapshot）
- NavBarControl1（左侧导航）：My Favourite Menu / My Screen Colour / My Language
- 内容区：frmGoodsReceive「Goods Received Note」收货单窗口 → SplitContainerControl1 + PanelControl2
- RibbonControl_Main（The Ribbon）：
  - Quick Access Toolbar
  - Ribbon Tabs（tablist）：Home（选中）／General Setup／Item／Customer／Vendor／Branch／Staff／Message／Utility／e-Invoice
  - Lower Ribbon（Home 下有 15 个子控件，待展开）
- RibbonStatusBar：SERVER IP 127.0.0.1、POS Standard 26.05-1、SQL File Size、IES Sync Done 等
- TitleBar：frmMain

## 自动化可读性
- agent-desktop 可完整读 UIA tree，控件带 automation_id（frmGoodsReceive、SplitContainerControl1、PanelControl2、RibbonControl_Main、RibbonStatusBar 等），字段可读可驱动。
- 待办：完整 snapshot 收货表单字段（供应商／货品／数量／网格列），映射缺价→MyInvois 查询→录入的字段对应。

## 变更记录
- 2026-11-06 首次 skeleton snapshot 确认以上结构；full snapshot 待补。
