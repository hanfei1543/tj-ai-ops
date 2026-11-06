# IRS POS 入货自动化 — 接续交接

## 目标及完成标准
VPS 指挥目标 Windows 上的 Vercel agent-desktop，读取 C:\scan 单据、核对货号/价格/单位，录入离线 IRS POS。保存后查回、防重账本及九字段变价验证通过才算业务自动化完成。当前未完成真实入货。

## 已定结论与理由
- 用户坚持使用 agent-desktop，不采用截图找坐标操作；截图仅曾用于诊断/读单。已允许键盘鼠标操作，目标机平时无人使用。
- MyTax/MyInvois 用户指同一业务入口；当前实际 Chrome 页面为 MyInvois Portal Documents / Search All Documents。搜索公司名前段，去掉 SDN. BHD. 等带点尾缀；日期为 DO 当天或之后，最终按商品描述匹配，不能仅按日期或公司确认。显示行项目价格的步骤尚未走通。
- ING HAN 没有 invoice number 时，以 DO number 填 Invoice No.；本次为 D-021660。
- GOLD HARVEST 补充 Z=千；GZGSY 的含义由用户确认为 RM1010。例子及未验证组合见 docs/gold-harvest-encoding.md。不能把示例外的裸位值输出规则当作已完全确认。
- 用户确认本轮货号：ING HAN 门锁 1050006000025；FORTUNE 木门 1030033000054；钻孔 1030033000068。不得沿用视觉误读值。钻孔是单独录入还是分摊成本仍未明确回答。

## 批准边界
- 已批准软件/连接准备、读取 SOP/PDF、agent-desktop 键鼠操作；仅试走 ING HAN D-021660 和 FORTUNE DOORS I-107612，其他单据不动。
- 本轮约定第一次保存前停下核对；尚未保存、过账或修改 Item Master。不得把“试走/输入”扩大为批量保存或九字段变价授权。
- 用户亲自选择导入探测文件；未批准后台猜格式导入真实数据。不登录/代输密码或 OTP，不直接查写数据库，不 push。
- 仅维护本项目接续；本轮大脑配置/规则无变化，不做双层归档。

## 当前事实与证据
- 目标 Windows Server 2022 x64，node/npm/agent-desktop 已存在且能运行；OpenSSH 客户端可用（scp 成功）。最初 Get-Command 空白不能证明没安装，PATH 原因未独立证实。
- Windows 的 C:\irs\start.bat 启动 bridge.js 与反向 SSH，VPS 127.0.0.1:9000 到目标机 localhost:9000；本轮远程 version/list-apps/snapshot/read/list 成功。会话关闭后连接是否仍存活必须重新测试，不能当常驻服务。
- VPS 客户端：/home/hermes/.hermes/scripts/irs.py。桥源码 scripts/tunnel/bridge.js（v2，args/read/list），Windows 开机入口尚未改成一键联合启动。
- 目标启动器 C:\Users\Administrator\Desktop\operation\TJ-AI-Ops.bat 用 hermes-xeon 密钥登录 VPS；希望同时启动 C:\irs\start.bat，但尚未实施。SOP 原文同目录 Goods_Receive_AI_SOP_V1.txt；已读存 docs/Goods-Receive-SOP.md。
- C:\scan 本轮列到四个 PDF：20261106162415.pdf、20261106162513.pdf、20261106194641.pdf、20261106200436.pdf。后者四页合扫。扫描无文字层，视觉提取只为候选；不能声称所有货号已核对。
- 本轮选择单：ING HAN D-021660 门锁 30 SET，印刷价 18.00；FORTUNE I-107612 木门 10 PCS 印刷价 62.00、钻孔 5 PCS 印刷价 2.00。进入前还需价格口径、重复单查询和单位核对，不能直接保存。
- 成功用 agent-desktop 语义点击 Vendor tab → Goods Received → F11 Vendor List → Next Page 翻页 → ING HAN 行 → OK，查回供应商 ING HAN ENTERPRISE SDN BHD / 4000/I01。此时未填写 Invoice No.，明细未录入。
- agent-desktop status 为 1.2.0。UIA 字段地图见 docs/irs-pos-ui.md，仅观察映射，不证明可输入/保存；数字型 automation_id、ref、HWND 均需刷新，不硬编码。

## 阻塞与避坑
- Vendor List 搜索框 set-value 返回后值仍空；匿名重复输入框报 AMBIGUOUS_TARGET。headed type/focus-window 报 Target window did not become foreground before headed delivery，未发送物理输入；本机 PowerShell 同样复现，排除仅远程桥问题。
- 用户 Get-Process 输出 explorer/irsPOS/node 都在 SessionId 1；不再让用户重复核对 SessionId，也不能据此证明同 desktop。
- 用户原生 Win32 只读检查：MainWindow=15011528、MainEnabled=False、LastPopup=18876518，Foreground=10095678（检查时 PowerShell 前台）。agent-desktop snapshot --window-id w-18876518 报 WINDOW_NOT_FOUND。证实主窗禁用且工具未识别真实 popup；具体过滤条件/完整根因尚未验证。
- 已读官方 v1.2.0 源码 window_ops.rs / headed_focus.rs：清单排除 tool window，headed 绑定 source_window_id，要求指定 HWND 前台。官方 latest 仍 v1.2.0，main 同样过滤。不要宣称已有可用补丁。
- 供应商选好后发票号框 type 报 lost focus，set-value 后查回空。focus 命令报该 textfield 不支持 SetFocus。find txtInvoiceNo 的外层 group 没有可操作 ref。键盘兼容问题未解决。
- 不采用截图坐标绕过，也不继续无效循环。此前声称“完整可驱动/自动化完全可行”已被实测推翻。
- Import - Text：用户选零字节空探测 txt 后“没反应”。不证明接受任何业务格式或导入成功。
- Import - Excel：用户选空 Sheet1 的有效 .xlsx 后报 external table is not in the expected format。只证明该文件不被接受；可能旧 .xls/特定布局/读取器等，尚不能归因 Excel 未安装。
- View Grid Option 本轮点击只改变右栏展示，未找到明确 Export；下次刷新界面，不假定右栏仍同布局。
- 探测文件在 VPS cache/scratch/irs-import-format-probe.txt 与 .xlsx；可过期，需时重建。本地由 scp 下载到 C:\irs；不包含真实货品。
- 桥 v2 尚有安全加固债：无鉴权/目录白名单，args 经 shell 拼接；SSH key restrict,port-forwarding 不等于禁止 shell。不要继续声称“只隧道、不能登录”或认为本地监听等同完整安全隔离；不得利用 shell 拼接执行任意命令。后续受控加固，勿悄悄扩大权限。

## 下一步
1. 先读本交接和 SOT，测试现存桥 version/status，检查当前窗口，不能重放保存/导入。
2. 优先拿 IRS POS 自带的导入模板、厂家文档或软件导出的数据样本（.xls/.xlsx/.txt）；用户最后提议下载一个 note 看格式，尚不知导出入口。打印 PDF 只反映版面，且导出表格也未必等于导入模板。
3. 导出入口未知时找安装目录内说明/示例或询问用户知道的入口；不继续拿真货号猜分隔符、字段顺序、伪装扩展名试导入，不因 xlsx 错误盲装 Excel。
4. 若无格式证据，应明确报告兼容阻塞，与用户决定是否做 agent-desktop Windows 适配；不把排障无限拖成“即将入库”。
5. 录入路径走通后先查重、核对三货号/数量/单位/单价及钻孔处理；第一次保存停给用户确认，保存后真实查回。Item Master 变价另核对旧值、固定利润率联动、授权及保存结果。

## 按需读取
- AGENTS.md；docs/SOT.md；docs/irs-pos-ui.md（旧推论需复核）
- docs/Goods-Receive-SOP.md；docs/gold-harvest-encoding.md；docs/do-samples.md（旧视觉值以本交接更正为准）
- /home/hermes/project-memory/TJ-AI-Ops/MEMORY.md
- 官方：https://github.com/vercel-labs/agent-desktop
- 开发铁律技能 dev-deploy-rules 本平台 unsupported；不声称加载成功。
