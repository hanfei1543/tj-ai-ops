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

## 收货单 frmGoodsReceive 字段映射（2026-11-06 full snapshot，ref 131 项）

### 表单字段（PanelControl1 内）
- txtCode：供应商/货品代码输入（可写）；btnCodeList(F11) 打开代码列表
- txtCompany：公司名（只读，随 code 自动带出）
- txtInvoiceNo：发票号（可写）
- gbReceiveInformation 收货信息组：ceSelfBill(Self-Billed 勾选)、meRemark(备注 memo)
- gridcInvoiceDTL：明细表（table，18 列；F7 sbBarcode 条码录入、sbMoveNext/Prev 翻记录）
- txtBarcode：条码录入（F7）
- beDiscount：折扣(0.00)；txtPurchaseTax：进项税(只读 0.00)；txtSubTotal：小计(只读)；txtRounding：舍入(只读)
- cbViewPO：View PO 按钮；sbMoreInformation：More Info；ceTotalRounding：Activate Total Rounding 勾选
- PanelControl2（右侧）：Navigator 组 = Print Barcode / Import-Text / Import-Excel / Validate e-Invoice + View Grid Option

### 明细表 gridcInvoiceDTL 的 18 列（左→右）
No · Item No. · Description · Qty · UOM · Price · Discount · G/R Price · G/R Price(EX) · Amount · Base Cost · New Base Cost · Remark · PO · Min. Price · Amt(Tax) · Taxable Amt · eInv Tax Class
- 关键列：Price（单价）、Qty、UOM、Item No.、Description、Discount、eInv Tax Class（e-Invoice 税类）
- 「缺价」＝Price／成本列空，须从 MyInvois e-Invoice 查单价回填。

### Home 顶栏快捷键（Lower Ribbon）
- Ctrl+I Item · Ctrl+U Customer Master · Ctrl+F2 · F1 Clear · F8 Save · F12 Delete(禁用) · F4 Exit · Re-Order(BASIC) · Ctrl+F10 Subtotal · Print/Preview · Ctrl+L · F9 · Ctrl+Z · F3 Report · Ctrl+O Log Off

### 关键推论
- 入货录入流程：选供应商(txtCode→txtCompany 自动带出) → 填发票号(txtInvoiceNo) → 明细表加货品(gridcInvoiceDTL，条码 txtBarcode 或逐行) → 折扣/税/舍入 → 保存(F8)。
- 「缺价」：DO 只有货品+数量无价，需查 MyInvois e-Invoice 单价后填入明细表成本列（列名待确认）。

## Item Master frmItemMaster 字段映射（2026-11-06 实测）

### SOP 九字段 ↔ 界面字段（General tab）
| SOP 字段 | 界面标签 | automation_id | 输入框 aid |
|---|---|---|---|
| Item Code | Item No. | txtCode | 55970740 |
| Unit Cost | Unit Cost | txtUnitCost | 27921008 |
| Min. Price | Min. Price | txtMinPrice | 8783720 |
| Color Code | Colour | beColour | 1313010 |
| List Price | LIST PRICE | txtPrice1 | 789874 |
| SP1 | SP 1 | txtPrice2 | 855398 |
| SP2 | SP 2 | txtPrice3 | 13043354 |
| SP3 | SP 3 | txtPrice4 | 2493428 |
| INV Price 1 | INV PRICE 1 | txtPrice5 | 16189612 |
| INV Price 2 | INV PRICE 2 | txtPrice6 | 32246844 |

### 售价字段视觉顺序（上→下）
LIST PRICE(txtPrice1) → SP1(txtPrice2) → SP2(txtPrice3) → SP3(txtPrice4) → INV PRICE1(txtPrice5) → INV PRICE2(txtPrice6) → Min.Price(txtMinPrice)
注意：UIA tree 里这些字段按倒序出现（txtMinPrice→txtPrice6→…→txtPrice1），程序按 automation_id 定位、不依赖顺序。

### 其他关键字段
- 货品编号 Item No. = txtCode（F7 btnCodeList 打开列表）；描述 txtDescription1/2；尺寸 txtSize
- Item Type cboItemType（STOCK ITEM）；Discontinue ceDiscontinue；保修 seWarrantyDays
- 导航 btnMoveFirst/Previous/Next/Last
- XtraTabControl1 有 15 个 tab（General/UOM/Sales Volume/Vendor/…/e-Invoice）

## 变更记录
- 2026-11-06 skeleton snapshot 确认顶层结构；full snapshot 确认收货单字段映射。
- 2026-11-06 实测 Item Master 字段映射（九字段 + Item No. 的 automation_id）。
