# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-06 08:33

## 1 当前焦点与下一步
- 当前焦点：首次接入 IRS POS 入货自动化；目标机已现场确认。
- 环境已现场确认（用户在新机器跑检查）：Windows Server 2022 Standard 64 位；C:\scan 存在、内有 2 个 PDF；未安装 node/npm/agent-desktop/ssh（工具检查全空）。
- 下一步：先摸清 2 个 PDF 样本（供应商／发票或送货单／有无单价），不需装机；再经用户批准安装 Node.js + agent-desktop 并建立安全远程通道（SSH），且核实交互桌面（RDP 会话）可被 agent-desktop 读取。
- 已排除/勿重试：不把当前电脑当目标机；不把登录 VPS 当成桌面已接通；不操作真实库存、不自动登录税务、不启动旧 worker；未经批准不装软件、不开远程服务。

## 2 交接上下文
- REQUIRED: docs/handoffs/stock-setup.md

## 3 未归档缓冲池
- [PROGRESS] 现场确认目标机 Windows Server 2022、C:\scan 2 个 PDF、无 node/npm/agent-desktop/ssh。
