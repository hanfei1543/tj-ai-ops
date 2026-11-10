# TJ-AI-Ops 历史归档

仅追加已完成的项目进展；当前状态见 SOT.md。

## 2026-11-06 08:33 — IRS POS 首次接入准备

- 已建立项目规则、首次接入交接和项目记忆入口；用户提供 IRS POS 离线版、C:\scan、MyInvois 地址；均未在目标机实查。尚未建立远程控制连接或实现业务 skill。

## 2026-11-06 13:11 — IRS POS 接通与输入兼容排障交接

- 本轮建立反向 SSH+本机桥，验证 agent-desktop 读界面及读取 SOP/PDF；早期“未安装/未接通/可完整驱动”结论已纠正，实际是读通但键盘写入未通。
- 本轮用控件翻页选中 ING HAN 4000/I01；供应商弹窗 HWND 未被工具清单识别、主窗禁用，输入框语义赋值/键盘输入未通过实测。本机同样失败，未发送失败命令对应物理按键。
- 用户亲测空 txt 没反应；空有效 xlsx 报 external table is not in the expected format。停在获取真实导入模板/导出数据样本，不再猜格式。
- 交接更新批准范围、货号更正、ING HAN 以 DO 代发票号、MyInvois 匹配规则、GOLD HARVEST 的 Z 位值及安全债。联合启动器、Flash 对照、真实保存/查回、防重账本均未完成。大脑层已核对，本轮无配置/规则变更，不做双层归档。

## 2026-11-09 22:13 — PO 采购单独立上线 + Git 集成自动部署

- PO 采购单独立完成：新建 web/ Vite app（从 DYT-TCM-SAAS 拆出 /tj-po-system），build 通过；部署 tj-ai-ops.pages.dev（Supabase 读写验证 30654 商品/供应商可读）；建 GitHub 仓库 hanfei1543/tj-ai-ops + CF Git 集成（root_dir=web，push main 自动部署）；推送器 tj-po-push.mjs 迁入 scripts/，cron 包装路径已更新。中医站已删 PO 并重新部署。

## 2026-11-10 22:16 — PO 推送器依赖修复 + 隧道 Hidden 修复

- 推送器依赖修复：tj-po-push.mjs 从 DYT-TCM-SAAS 迁到 TJ-AI-Ops 后 exceljs 未随迁，cron 每分钟报 ERR_MODULE_NOT_FOUND，PO-000011 卡 pending_push。已在 TJ-AI-Ops 根 npm install exceljs，手动 --once 推 PO-000011 成功；查回目标机 Pending 有 PO-000011.xlsx(6870B)、Supabase 状态 exported。
- 跨仓库迁移脚本时 node 依赖必须在新仓库根重装，否则 cron no_agent 静默失败（教训已入 windows-tunnel-bridge skill）。
- 隧道 Hidden 修复已部署验证：TJ-AI-Ops.bat 隧道 WindowStyle Minimized→Hidden + 参数改数组（修 PowerShell 引号 bug）+ StrictHostKeyChecking 改 accept-new。用户已替换并重启，VPS 侧 9000 监听在线、桥 version 返回正常。
