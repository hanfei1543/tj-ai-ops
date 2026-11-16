# Stage25 Preview 最终修复与 Windows 交付

接续锚点
仅处理新单 PO-000028；先核对本交接状态，禁止重复投递、重跑旧单 IRS 保存或发送 PO-000026 标准 ACK。当前网页版本未发布，Windows V2 未在目标机执行，完整闭环未验收。

## 目标及完成标准
目标为新单真实收件、保存回查和标准ACK闭环；完成标准是Windows真实Done/Outbox与数据库accepted/IRS/SHA/event一致。当前仅收件及服务端修复验收，真实保存与ACK待用户执行。

## 批准边界
原用户授权：修复网站请求/真实 Windows 收件/隔离 ACK、追加 PO-000026 人工历史对账、准备新单并本地提交。仅 tj_preview；不改 public、main、历史 SHA/Done/Ledger/Outbox，不操作 IRS。自动接续明确不自动 push/部署。Windows 后续保存与发送由用户执行。

## 当前事实与证据
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
详见 docs/windows-stage25-preview-handoff.md。只需一次交付包，不要运行旧V1。
1. 下载并解压无密钥V2包到独立新目录；不覆盖Queue/旧配置。
2. 先运行03_SelfTest.cmd；此步骤尚未在Windows实测，必须如实回报结果。
3. 01_Configure.cmd及02_Login_Once.cmd按提示交互输入；通过本人SSH终端执行show-preview-connection.py取得既有资料。禁止截图或发聊天，不自动读VPS env。
4. 用户以既有已验证流程处理PO-000028：真实IRS保存、人工回查、Stage23 Queue Done/Ledger/Outbox。不得猜IRS号或生成假ACK。
5. 只有第4步完成并核对原件SHA后，运行04_SendOne_POID.cmd PO-000028，人工确认一次发送。结果不明先查库，不盲目重试。
6. 主脑执行docs/evidence/stage25-preview-final-readback.sql，核对header/receipt/evidence/IRS号/确定性event；如需验证幂等，先查真实accepted再安排受控重放，不重复IRS保存。

## 按需读取
原仓私有目录 /home/hermes/projects/TJ-AI-Ops/private/stage25-evidence/：po-000028-independent-readback.json、stage25-final-migration-applied-readback.json、stage25-resume-windows-worker-check.json、stage25-historical-windows-unchanged.json、stage25-final-production-isolation.json。原始单据/截图/凭据不入Git。
主脑测试日志 /home/hermes/.hermes/cache/scratch/stage25-parent-final-tests.log、stage25-parent-preview-build.log；RED/GREEN过程在stage25-tdd目录。服务器永久XLSX在原仓private/preview-deliveries/req.preview.stage25.f7e0b4daeaec4e74b5db32416475cc11/，不重新生成。
生产PO/序列/三个入口脚本/托管生产deployment与基线相同；cron jobs.json包含动态运行状态，全文件hash已变化，不宣称全文件未变。当前TJ任务仍enabled/every1m，入口仍原仓，本轮未启停调度。

## 阻塞与避坑
- Windows V2目标机SelfTest/Configure/Login、用户真实IRS保存/回查、Stage23与真实ACK均待执行。
- 本轮网页未部署，浏览器点击未验收；REST创建/请求验证不等于托管网页点击。要发布仅tj_preview的非main Preview，需按当前用户边界取得明确部署指令，不能自动push或部署。
- 完整Website→Windows→IRS→Queue Done→Website ACK尚未验收；当前可交付的是修复代码、真实历史核验、新单真实收件及无密钥操作包。
