# Windows Stage25 Preview V2 交接说明（无密钥）

> 对象：目标 Windows（离线 IRS POS 机）上的操作员。
> 范围：**仅隔离预览环境 `tj_preview`** 的 PO Done ACK 回执发送。不碰生产 `public`、
> 不创建 IRS 采购单、不移动 Queue、不登记收货。
> 本文件不含任何 URL、key、JWT 或密码明文；凭据只通过下面的真实交互终端手动取得。

## 1. 这套脚本是什么

| 文件 | 用途 |
|---|---|
| `Stage25_PO_ACK_Worker_Preview_V2.ps1` | Preview V2 主体（独立配置目录，不覆盖 V1） |
| `01_Configure.cmd` | 输入 Supabase URL / anon key / worker email；schema 固定 `tj_preview` |
| `02_Login_Once.cmd` | 输入 worker 密码（`-AsSecureString`），会话以 DPAPI 保存 |
| `03_SelfTest.cmd` | 离线自检：event_id 公式 + 响应判定表（不联网、不需要配置） |
| `04_SendOne_POID.cmd` | 单张 PO 发送（必须传入 `PO-######`，没有硬编码单号） |

V1（`Stage25_PO_ACK_Worker_V1.ps1`）**不再发送、不再使用**；V2 使用独立目录
`%LOCALAPPDATA%\TJ_PO_ACK_STAGE25_PREVIEW_V2`，不会改动旧配置、旧会话或 Queue。

## 2. 必须手动输入的六项（不要经聊天/Telegram/邮件传递）

| # | 值 | 输入位置 |
|---|---|---|
| 1 | `SUPABASE_URL`（`https://<ref>.supabase.co`） | `01_Configure.cmd` 提示符 |
| 2 | `SUPABASE_ANON_KEY`（publishable/anon key） | `01_Configure.cmd` 提示符 |
| 3 | `SUPABASE_SCHEMA` = **`tj_preview`** | 脚本已写死并 fail closed，无需输入 |
| 4 | `WORKER_EMAIL`（专用 Auth worker 账号） | `01_Configure.cmd` 提示符 |
| 5 | `WORKER_PASSWORD` | `02_Login_Once.cmd` 的 `-AsSecureString` 提示符 |
| 6 | `QUEUE_ROOT`（Windows Queue 根目录） | 默认 `C:\Users\Administrator\Desktop\operation\PO_Queue`，必要时 `-QueueRoot` 显式指定 |

取得方式：在 Windows 打开 PowerShell，通过既有 SSH 隧道在**自己的终端**运行（`-t` 保证交互 TTY）：

```
ssh -t -i "$env:USERPROFILE\.ssh\hermes-xeon" hermes@167.104.103.163 "python3 /home/hermes/worktrees/TJ-AI-Ops-stage25-final/scripts/show-preview-connection.py"
```

该脚本只在 stdin/stdout 都是真实终端时运行，必须手动输入确认词才显示；管道、重定向、
自动化采集一律拒绝。它不写文件、不写日志、不联网。**不要把输出复制到聊天或工单**。

## 3. 执行顺序

本轮唯一新测试单为 `PO-000028`，已在真实 Pending 收到；不要重新下载/生成其 XLSX，
不要再投递旧单25/26。Windows V2在目标机的SelfTest/Configure/Login仍待执行。
只有用户完成该新单真实IRS保存、人工回查和Stage23 Done/Ledger/Outbox后，才运行
`04_SendOne_POID.cmd PO-000028`。这份包不负责IRS保存，也不代表网页已部署。

1. `03_SelfTest.cmd`（无需配置，先证明判定逻辑正常）
   期望最后一行包含：`STAGE25_PREVIEW_V2_OFFLINE_PASS=True | ACK_VERDICT_TABLE=True | ... | NO_NETWORK=True`
2. `01_Configure.cmd` → 依次输入第 1、2、4 项；看到 `SCHEMA_FIXED=tj_preview`
3. `02_Login_Once.cmd` → 密码以 `-AsSecureString` 输入；看到 `JWT_NOT_PRINTED=True`
4. `04_SendOne_POID.cmd PO-000123` → 人工确认后才发送一次；无自动重试

## 4. 关键安全事实

- 脚本**不会自动读取 VPS 的 env 文件**，也没有环境变量凭据后门；所有值必须人工输入。
- JWT / refresh token 仅以 Windows DPAPI（当前用户）保存；不打印、不落明文。
- 不创建、不接收含密码或 JWT 的文件，也不生成任何压缩包；本交接只有源码 + 本说明。
- Preview 的 RPC 必须带 `Content-Profile: tj_preview` / `Accept-Profile: tj_preview`；
  V2 已内置并 fail closed，配置 schema 不是 `tj_preview` 直接拒绝。
- 成功回执必须同时满足 `accepted=true` 且 `state=accepted`；`replayed=true` 是合法重放，
  但 `accepted=false` 一律按拒绝处理。返回的 PO / IRS 编号必须与本机 ACK 一致。
- 发送结果不明（网络/HTTP 异常、拒绝、身份不符）→ 记录为需要人工核对，**不盲目重试**。

## 5. 不要做

- 不要对历史/已处理的 `PO-000025`、`PO-000026` 或其它旧单重投；本次只验证**新 PO**。
- 不要把 URL/key/密码写进 `.cmd`、`.ps1`、文本文件或压缩包。
- 不要修改 `public`、不要改成生产 schema、不要安装常驻服务或计划任务。
