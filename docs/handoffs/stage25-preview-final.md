# Stage25 Preview 最终修复与 Windows 交付

接续锚点
新会话先读本交接，确认用户是否已通过SSH SHOW读取轮换后的新密码并完成Windows Login；未完成则只指导本人交互登录，不自动再轮换、不发送ACK、不操作IRS/Queue。用户已报告V2安装、Windows离线SelfTest及真实SSH六项显示成功；密码因误贴聊天已完成单用户安全轮换。完整新单闭环仍未验收。

## 目标及完成标准
目标为新单真实收件、保存回查和标准ACK闭环；完成标准是Windows真实Done/Outbox与数据库accepted/IRS/SHA/event一致。当前仅收件及服务端修复验收，真实保存与ACK待用户执行。

## 批准边界
原用户授权：修复网站请求/真实 Windows 收件/隔离 ACK、追加 PO-000026 人工历史对账、准备新单并本地提交。仅 tj_preview；不改 public、main、历史 SHA/Done/Ledger/Outbox，不操作 IRS。自动接续明确不自动 push/部署。最新授权仅处理Worker凭据交接与安全轮换，明确禁止IRS/Queue/ACK；不得拿早前整体目标扩大当前执行权，后续真实保存/发送须按用户新指示推进。

## 当前事实与证据
- 本次代码与状态提交：ba3bbd8（最终服务端闭合修复）、ce53758（VPS配置字段兼容）、876be93（轮换非敏感状态）；提交与文件现状引用前用git核对，不自动push。
- 最新回归：配置兼容修复后主脑354/354通过；独立审查10/10针对性回归通过，Python合成字段/约束/TTY保护7/7。Windows安装/SelfTest与SSH SHOW成功为用户本人实测报告，不冒称主脑远控验证。
- 2026-11-16 09:23 UTC Worker轮换已验证：新密码登录成功、旧密码拒绝；两个既有私有env同步并保持0600；SHOW纯解析确认读新密码，未执行/采集敏感显示分支。仅此Worker的global注销HTTP204，旧refresh实际被拒；当时目标sessions=0、有效refresh=0，其他用户会话/refresh摘要一致。旧access JWT不能由注销立即撤销，轮换当时项目有效期配置3600秒；不能把refresh撤销说成所有JWT即时失效。未更改全局认证配置/签名，也未连业务API。
- 最终代码主脑全量回归353/353通过、0 skip；真实PGlite集成142条断言。无PGlite默认回归由独立执行器验证335通过/18明确skip/0失败。Preview build通过（仅包体大小警告），不是托管部署。
- 20261114_gr_po_save_website_date.sql 与 20261116_stage25_preview_closure.sql 已在 tj_preview 应用；最后closure SHA256=9cd8ada054e8b0d9630605abe1e1e5b4604e10a84df4ed729b4520123e0ae2a7，2026-11-16 08:31 UTC最终版先事务试跑回滚，再正式应用并独立读回。未重跑旧ACK基础迁移。
- 最终closure读回：pending helper接线、NULL明细门禁、legacy快照锁均存在，客户端不能调用pending helper，service_role不能直接写收件证据；迁移前后现有manual/intents/evidence/receipts逐项相同。
- PO-000026：人工对账id=a4e6434b-80c8-444b-8752-e529bc01f70a，IRS=PO26000784，总额RM57.56，erp_status=saved_verified_manual_reconciliation，classification=manual_delivery_historical_import。Windows原件与legacy intent不同SHA分别保留；不是标准ACK，不重发Outbox。
- PO-000028：header=70a04f2b-bb5a-4b2d-a607-ae10f42a10f1，request=req.preview.stage25.f7e0b4daeaec4e74b5db32416475cc11，intent=9f97ba9b-6c01-4eab-a3fe-84e20a2ed787。两级证据server_prepared/windows_received已落库；request/intent=delivered，delivery_channel=windows_bridge_v1。
- Windows Pending路径：C:\Users\Administrator\Desktop\operation\PO_Queue\Pending\PO-000028.xlsx；6855字节，SHA256=2d8f5d3d7be40803233989b65e24377b5fd1d1c63bcd0441ed2df8910f0f68ca。主脑经现有桥独立读取，服务器永久原件与Windows文件逐字节一致，没有重新写入。
- 新单尚无IRS号、Processing/Done/Ledger/Outbox或accepted receipt，不能称真实ACK已通。
- worker登录成功，active executor；authenticated具备schema USAGE/RPC EXECUTE，anon无EXECUTE。配置与密码只经本人SSH交互取得，不进入本包。

## 已定结论与理由
- 真实桥协议{list:路径字符串}，网页状态经受控RPC读取；delivered更新依赖收件证据。
- 请求或intent任一存在即锁业务来源；ACK/人工核验字段可由受控通道更新。
- 新时序拒绝只追加audit、不写唯一receipt墓碑，证据齐后同event可接受；旧needs_review不自动复活；SHA冲突仍持久拒绝。
- 人工核验要求JSON boolean queue_done_ack=true、business_po_id一致、IRS不可复用、明细不能缺数量/单价。
- 不采纳审查中“所有manual SHA必须等于intent SHA”：与用户批准的legacy差异核验相反。legacy双摘要合法；windows_bridge_v1禁止绕人工通道。
- V2固定tj_preview、独立DPAPI目录、正确refresh/schema头、accepted=false重放不算成功，并阻断PO-000025/26。

## 下一步
1. 先确认用户是否已完成轮换后Windows Login；本人用既有SSH SHOW读取新密码，真实TTY及人工SHOW保留。不要通过工具采集密码，不要请求用户贴回。
2. 已Configure者直接运行02_Login_Once.cmd输入新密码；未Configure者才先运行01_Configure.cmd填URL/anon/email。无需重下V2、重装或重跑已通过SelfTest。
3. 当前到Login为止，随后等待用户指示。PO-000028的IRS保存/回查、Stage23、真实ACK是未完成业务目标，不在本次接续自动执行范围。
4. 用户将来明确推进新单后，先只读核实当时Windows/数据库现状，避免重复保存/投递/发送；真实ACK后用docs/evidence/stage25-preview-final-readback.sql核对IRS/SHA/event/accepted。不能构造新单ACK冒充真实保存。

## 按需读取
- 最新轮换非敏感机器证据：原仓private/stage25-evidence/worker-password-rotation-status.json；只有布尔/计数/时间，无密码/Token。现有私有配置位于原仓credentials/windows-preview-config.env及credentials/tj-po-ack-worker.env，禁止显示/入Git/打包；后者仅同一Worker别名副本，不是另一个账户。
- 凭据交接脚本：final工作区scripts/show-preview-connection.py，固定读取原仓windows-preview-config.env；仅映射TJ_字段/default Queue，强制tj_preview/tj_po_ack_ingest并拒绝别名冲突。
原仓私有目录 /home/hermes/projects/TJ-AI-Ops/private/stage25-evidence/：po-000028-independent-readback.json、stage25-final-migration-applied-readback.json、stage25-resume-windows-worker-check.json、stage25-historical-windows-unchanged.json、stage25-final-production-isolation.json。原始单据/截图/凭据不入Git。
主脑测试日志 /home/hermes/.hermes/cache/scratch/stage25-parent-final-tests.log、stage25-parent-preview-build.log；RED/GREEN过程在stage25-tdd目录。服务器永久XLSX在原仓private/preview-deliveries/req.preview.stage25.f7e0b4daeaec4e74b5db32416475cc11/，不重新生成。
生产PO/序列/三个入口脚本/托管生产deployment与基线相同；cron jobs.json包含动态运行状态，全文件hash已变化，不宣称全文件未变。当前TJ任务仍enabled/every1m，入口仍原仓，本轮未启停调度。

## 阻塞与避坑
- V2安装、SelfTest及SSH SHOW已获用户成功报告，不能再当阻塞重做；轮换后Windows新密码Login尚无用户成功报告。新单真实IRS保存/Stage23/ACK以最近一次只读证据为准，本次未重新查询或执行。
- 本轮网页未部署，浏览器点击未验收；REST创建/请求验证不等于托管网页点击。要发布仅tj_preview的非main Preview，需按当前用户边界取得明确部署指令，不能自动push或部署。
- 完整Website→Windows→IRS→Queue Done→Website ACK尚未验收；当前可交付的是修复代码、真实历史核验、新单真实收件及无密钥操作包。
