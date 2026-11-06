# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-06 08:33

## 1 当前焦点与下一步
- 当前焦点：首次接入 IRS POS 入货自动化；目标机已现场确认。
- 环境已现场确认（用户在新机器跑检查）：Windows Server 2022 Standard 64 位；C:\scan 存在、内有 2 个 PDF；未安装 node/npm/agent-desktop/ssh（工具检查全空）。
- 样本性质已确认：2 个 PDF 都是送货单 DO、无价格 → 属「缺价」情形，价格须另查 MyInvois e-Invoice。
- 接入方式已确认：用户直接坐在机器前（console 交互会话，非 RDP）→ agent-desktop 必须在同一交互会话内运行（SSH 服务跑在 Session 0，看不到桌面）。
- 授权已变更：用户已口头批准「需要什么装什么 + 建立 VPS→本地连接」，具体每步安装仍逐项确认。
- agent-desktop 界面字段映射完成（详见 docs/irs-pos-ui.md）：收货单 frmGoodsReceive 表头字段 + 明细表 18 列。
- 反向隧道已通并验证：VPS→Windows 桥接（scripts/tunnel/bridge.js + start.bat，端口 9000）可用，VPS 可远程驱动 agent-desktop（list-apps 实测可见 irsPOS.exe）。
- 下一步：读用户提供的「进货处理」文档（业务流程／字段口径／缺价处理），据此设计 PDF→POS 录入自动化；C:\scan 的 2 个 DO 样本待读。
- 已排除/勿重试：不把当前电脑当目标机；不把登录 VPS 当成桌面已接通；不操作真实库存、不自动登录税务、不启动旧 worker；SSH 连进 Windows 不当作已能读到交互桌面。

## 2 交接上下文
- REQUIRED: docs/handoffs/stock-setup.md

## 3 未归档缓冲池
- [PROGRESS] 现场确认目标机 Windows Server 2022、C:\scan 2 个 PDF、无 node/npm/agent-desktop/ssh。
- [PROGRESS] 样本为送货单 DO 无价格；用户坐机器前(console 会话)；已授权装软件+建远程连接。
- [PROGRESS] node/npm/agent-desktop 均已装好(nodejs + AppData\Roaming\npm)；之前检查空白是 PATH 未加载，只缺远程连接。
- [PROGRESS] agent-desktop 本地验证通过：node v26.13.0、agent-desktop 1.2.0、accessibility granted、可见 irsPOS.exe(pid 10540)。
- [PROGRESS] 反向隧道已通并验证（VPS:9000→Windows 桥→agent-desktop，list-apps 实测可见 irsPOS.exe）。
