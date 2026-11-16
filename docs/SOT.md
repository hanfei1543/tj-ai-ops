# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-13 员工界面中文化 + 投递恢复只读原型

## 1 当前焦点与下一步
- **接续锚点**：Worker密码已按用户授权轮换；本人可用既有SSH SHOW读取新密码，再在Windows重新运行02_Login_Once.cmd。旧会话及refresh已撤销；旧access JWT不保证立即失效，当前配置寿命1小时。本次不发送ACK。
- **当前焦点**：Stage25最终代码主脑回归353/353及Preview build通过，closure最终修正在tj_preview真实应用并查回，现有台账/证据未变。PO-000026独立人工历史核验生效；PO-000028已真实Windows Pending收件，6855字节与服务器原件逐字节一致；完整IRS保存/Done/ACK仍未发生。
- **下一步**：本人Windows使用原SSH命令输入SHOW读取新密码；已Configure者直接运行02_Login_Once.cmd，未Configure者先配置URL/anon key/email。本次到Login为止，不操作IRS/Queue/ACK，无需重新下载V2。
- **已排除/勿重试**：不重投25/26/28、不改历史SHA/Done/Ledger/Outbox、不重做IRS保存、不碰public/main/生产调度/序列；不把本地回归或API验证说成网页点击或真实WindowsACK完成。legacy人工差异核验保留双摘要，bridge新单只能标准ACK。
- **对外简报**：修复与数据库读回完成，旧单已独立核验、新单已到电脑且文件一致；还需电脑实际保存、核对并发送新单回执，网页尚未发布本轮版本。

## 2 交接上下文
- REQUIRED: docs/handoffs/stage25-preview-final.md
- Windows操作：docs/windows-stage25-preview-handoff.md；只读回查：docs/evidence/stage25-preview-final-readback.sql。旧GR/中文化历史入口保留于docs/handoffs/NEW_CHAT_START_HERE.md，不启动其它队列。

## 3 未归档缓冲池
- [PROGRESS] Worker安全轮换：Auth新强密码登录通过、旧密码拒绝；两个既有私有worker配置均同步且保持0600，SHOW内存解析确认读取新密码。单用户global注销HTTP204，旧refresh实际被拒，目标auth.sessions及未撤销refresh均0，其他用户会话/refresh记录摘要不变。旧access JWT无法由注销立即撤销，现配置有效期3600秒；未改全局签名/认证设置。非敏感状态证据在原仓private/stage25-evidence/worker-password-rotation-status.json；无凭据入Git，无业务API/Windows/ACK操作，无V2部署。用户已报告真实SSH SHOW成功，Windows新密码Login待本人执行。
- [PROGRESS] 凭据交接根因已核实：路径及UTF8/键值解析正常，实际TJ_六字段齐全，旧脚本无别名映射并误要求QUEUE_ROOT。仅修VPS helper：显式映射、已确认Queue默认值、Preview schema/RPC约束、别名冲突只报字段名。真实私有配置仅内存解析后输出布尔校验，env字节/mtime/权限与WindowsV2脚本均未变；TTY/SHOW保护未绕过。全量354/354通过（含7条Python夹具回归），未打印/捕获真实显示分支、未连DB/Windows/ACK。
- [PROGRESS] Goods Receive Date业务规则审计及旧接续检查点已落盘；旧阶段结论以实际实现与本次交接边界为准。
- [PROGRESS] Stage25整合推送器、网站受控状态RPC、8列日期XLSX、Windows V2；主脑独立复核真实桥协议与两级证据。最终补齐时序拒绝只写审计、legacy来源锁、NULL单价拒绝、manual bridge禁入和权限撤销；353/353回归和Preview build通过，142条真实SQL断言通过。最终closure SHA256=9cd8ada054e8b0d9630605abe1e1e5b4604e10a84df4ed729b4520123e0ae2a7已真实应用tj_preview并读回。
- [PROGRESS] PO-000026人工对账id=a4e6434b-80c8-444b-8752-e529bc01f70a，IRS=PO26000784，分类manual_delivery_historical_import，旧证据保留；PO-000028真实收件SHA256=2d8f5d3d7be40803233989b65e24377b5fd1d1c63bcd0441ed2df8910f0f68ca，禁止重新投递。新单尚无IRS/Done/ACK，不称全链路完成。私有证据路径在交接单。
