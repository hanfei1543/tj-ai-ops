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

## 2026-11-12 06:01 — Combined PO / 拖曳排序 / Add New Item 实现 + Preview 隔离部署

- Combined PO / 拖曳排序 / Add New Item 三功能 + GR 收货导出实现完成；隔离测试 14/14 通过，单张 PO 建单/导出/推送未破坏。
- Preview 隔离：同一 Supabase 项目内单独 schema tj_preview（service_role 不授权=生产推送器天然隔离），VITE_SUPABASE_SCHEMA=tj_preview；生产 public 未受影响（仍 PO-000011 最新，序号 reset 回 12）。
- 部署 feature/combined-po 到 CF Pages Preview；用户实测合并 PO-000001+PO-000002 → PO-000003 批准冻结（来源单标 combined，拖曳顺序/实收数量调整验证通过）。
- 拖曳 UX 优化：拖曳时整行弹起（shadow+scale+ring，去掉半透明）；样例 PO/GR Excel 已发用户 Telegram。

## 2026-11-12 09:06 — Combined PO 上线前修正验收与分阶段冻结交接

- 用户要求档三归档：本轮代码已本地提交，Git 状态已复核干净；回归证据、内部样本、备份与回滚入口均在当前交接单。临时本地测试服务器已停止；未 push 任一分支、未 merge main、未正式部署，生产迁移尚未应用。下次先读当前交接单并等待用户明确授权，三项冻结分别保持。
- 用户批准方案 A：正式采购业务日期人工选取、不默认当天，缺日期不能提交审批／批准，日期与明细批准后冻结。Preview 迁移及事务集成验收、浏览器新单审批冻结、Excel 逐行读回和摘要复算已通过，最终自动记录为 110 项测试全通过、构建通过；后台来源改定向查询防分页漏拦，二次独立核心逻辑复核通过。旧冻结单保持原状，生产数据／序号不变，三项功能分别停用；遗留非原子创建／并发／权限和待审批恢复入口风险已列交接，未推送或部署，等用户另行授权。详情见当前交接单。

## 2026-11-13 02:28 — Website 内部 Excel 测试 + PO_Lines Qty 口径修正 + 收货事件防重复

- Website 内部 Excel 测试（PO-000009）：receipt_event_id 唯一索引已加（public PREPARED / tj_preview 已应用），真实生成器产出 WEBSITE_PO_TEST.xlsx + WEBSITE_GR_TEST.xlsx，verify_website_test.mjs 逐行核对 15/15 通过，114 项测试 + 构建通过。待用户验收。
- PO_Lines Qty 口径修正（PAD 合约核对）：Qty 改为 original_qty（订购数量），与 GR Ordered Qty 对齐；原误用 accepted_qty 导致 PO Qty=4 vs GR Ordered=5。逐行严格核对升级到 16/16，115 项测试通过，重新生成两份 WEBSITE_* 文件。待 PAD 复审。

## 2026-11-13 05:19 — 统一收货第一版里程碑（数据库+UI+两轮审查+B1修复+浏览器验收+构建）

- [机器铁证] 文件写入 14 次（仓库内改动由 git 兜底）
- [机器铁证] terminal: cd /home/hermes/worktrees/TJ-AI-Ops-unified-gr && git add docs/gr-contract.md...
- [机器铁证] terminal: cd /home/hermes/worktrees/TJ-AI-Ops-unified-gr && git commit -q -m "fix(gr): ...
- [机器铁证] terminal: cd /home/hermes/projects/TJ-AI-Ops && git checkout docs/SOT.md && echo "===原仓...
- [机器铁证] terminal: cd /home/hermes/worktrees/TJ-AI-Ops-unified-gr && git add docs/SOT.md && git ...
- [机器铁证] terminal: cd /home/hermes/worktrees/TJ-AI-Ops-unified-gr && git add docs/SOT.md && git ...
