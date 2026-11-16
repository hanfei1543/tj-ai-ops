# TJ-AI-Ops 状态面板

> 最后归档: 2026-11-16 10:38 员工界面中文化 + 投递恢复只读原型

## 1 当前焦点与下一步
- **接续锚点**：先读docs/handoffs/stage25-preview-final.md，确认用户是否已用轮换后的新密码完成Windows Login；未完成仅指导本人SSH SHOW→Login，不自动再轮换或发送ACK。
- **当前焦点**：凭据交接已由Windows本人实测成功；因密码误贴已完成单Worker安全轮换，09:23 UTC机器验证新密码可登录、旧密码/旧refresh拒绝、目标sessions/有效refresh均0，其他用户会话未变。新密码Login在Windows尚待用户确认；服务端修复及新单真实收件已完成，完整保存/ACK闭环未验收。
- **下一步**：先读交接并确认轮换后Windows Login状态；已Configure者直接02_Login_Once.cmd，未配置者才先Configure。随后等待用户指示，当前不操作IRS/Queue/ACK，不push/部署；无需重下V2或重跑已通过SelfTest。
- **已排除/勿重试**：不重投25/26/28、不重做IRS保存、不改历史证据/生产/main/调度；不把refresh注销说成JWT即时失效（轮换时JWT配置3600秒）；不采集SHOW完整输出、不索取密码、不自动重复轮换。
- **对外简报**：凭据交接已修好，泄露密码已更换、旧登录已注销；换会话后只需确认电脑是否用新密码登录成功，不会自动发回执或重做采购单。

## 2 交接上下文
- REQUIRED: docs/handoffs/stage25-preview-final.md
- Windows操作：docs/windows-stage25-preview-handoff.md；只读回查：docs/evidence/stage25-preview-final-readback.sql。旧GR/中文化历史入口保留于docs/handoffs/NEW_CHAT_START_HERE.md，不启动其它队列。

## 3 未归档缓冲池
- (空)
