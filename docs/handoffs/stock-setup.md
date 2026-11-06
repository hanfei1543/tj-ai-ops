# IRS POS 入货自动化 — 首次接入

## 目标及完成标准
云端 Hermes 指挥另一台 Windows 上的 Vercel agent-desktop，识别 C:\scan 中的 PDF，判断需入货单据并提取资料，缺价时查询对应 MyInvois e-Invoice，核对后录入离线 IRS POS。目标是可重复执行的项目专用 skill。
完成须有真实样本验证、明确价格口径、防重复处理记录、已批准的库存写入及保存后查回证据；当前仅完成准备记录。

## 已定结论与理由
- 用户确认目标是 Windows 软件 IRS POS 的 offline 版本。
- PDF 来源路径：C:\scan。
- 税务网站：myinvois.hasil.gov.my。
- 目标电脑不是目前使用的电脑；用户必要时会到那台电脑连接 VPS 做首次 setup。
- 沿用 DYT-AI-Ops 的项目管理习惯，不复制业务配置。
- agent-desktop 通过运行主机的本地可访问性接口操作桌面；云端安装本身不等于能控制 Windows，须单独接通目标机的交互桌面执行端。

## 批准边界
已批准：保存需求及接续资料、建立当前项目的管理底座；用户已口头批准安装所需软件并建立 VPS→本地连接（2026-11-06），但具体每步安装仍逐项确认后执行。
未批准及未执行：目标机凭据配置、税务登录、任何真实库存写入、GitHub 建仓或 push。
用户到目标机并连接 VPS 不自动扩大授权；先说明必要本人步骤及最小接入范围。

## 当前事实与证据
用户在本次对话直接提供软件、路径、网站和目标电脑关系；上述为用户提供信息，不是现场验证。
现场确认（2026-11-06）：目标机 Windows Server 2022 Standard 64 位；C:\scan 存在、内有 2 个 PDF。首次 Get-Command 检查显示 node/npm/agent-desktop/ssh 全空，后经完整检查证实是 PATH 未加载——实际均已装好：node v26.13.0 / npm 11.20.0 / agent-desktop 1.2.0（C:\Program Files\nodejs 与 AppData\Roaming\npm）。ssh 仍未装。
agent-desktop 已本地验证可运行：accessibility 权限 granted；list-apps 看到 irsPOS.exe（pid 10540）前台运行，另有 Link_to_SQL.exe（疑似 POS 的 SQL 后端，暂只记录、不直接查库）。
Windows Server 交互桌面（console 会话 vs SSH Session 0）仍是远程接入前必须核实的关键点——SSH 登录成功不等于能读到交互桌面。
当前工作目录为 /home/hermes/projects/TJ-AI-Ops。
尚未读取任何 PDF，未访问登录后的税务数据，未看过 IRS POS 界面；未创建或验收可执行业务 skill。
Vercel 官方项目参考：https://github.com/vercel-labs/agent-desktop 。已读取官方 README 确认 Windows UI Automation 与本机运行架构；安装与跨机连接尚未测试。

## 阻塞与避坑
- 目标电脑未接通，不能声称云端能读取 C:\scan 或操作 POS。
- 未知 Windows 环境、安装权限、交互桌面可用性、IRS POS 界面及可访问性、备份和试验条件。
- 尚缺有价/无价样本、入货筛选规则、货品编码与单位映射，以及含税/折扣/运费/免费赠品的成本口径。
- MyInvois 登录、企业身份及发票匹配方式尚未验证；不要索取明文密码或 OTP。
- 不在网络上公开桌面控制端口；不因 SSH 登录成功便假定可进入交互桌面。
- 开发部署技能 dev-deploy-rules 在当前平台返回 unsupported；不声称已加载其规则。

## 下一步
目标机环境已现场确认（Windows Server 2022，C:\scan 2 个 PDF，无 node/npm/agent-desktop/ssh）。
先摸清 2 个 PDF 样本（供应商／发票或送货单／有无单价）——不需装机；等用户描述或提供文件。
再经用户批准后：安装 Node.js + agent-desktop、建立安全远程通道（SSH）、核实交互桌面（RDP 会话）可被 agent-desktop 读取。以上属软件安装／远程连接，须逐项批准，未经批准不执行。
接通后只读检查软件界面及文件夹；挑选用户同意的有价/无价单据各一张，提取和匹配但不提交库存。
确认字段、价格口径和人工审核方式后，再单独申请一次样本写入；成功查回后才整理可重复 skill 和机械防重账本。

## 按需读取
- AGENTS.md
- docs/SOT.md
- docs/irs-pos-ui.md（IRS POS 界面地图，逐步补全）
- docs/Goods-Receive-SOP.md（业务规则 SOP：GOLD HARVEST 编码 + 九字段变价规则）
- /home/hermes/project-memory/TJ-AI-Ops/MEMORY.md
- /home/hermes/project-memory/TJ-AI-Ops/stock-workflow.md
- https://github.com/vercel-labs/agent-desktop
