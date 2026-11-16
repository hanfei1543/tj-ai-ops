# Stage28B — Windows GR Worker 安全修复与最终部署包（交接）

> 本轮按 ChatGPT 对 `TJ_STAGE28_GR_WORKER.zip` 的安全审查修复六类问题，保留 b500de0、
> canonical COLLATE 修复、Website GR API 与 Bridge 投递成果；未重做 Stage26/27，未创建新 PO/GRN，
> 未执行真实 IRS Save/Post，未改 main/public。

## 一、修改文件清单（相对 b500de0）

- `scripts/windows/gr-worker/pad-adapter.mjs`（改）—— 新增 `isReady()` 真实就绪检查 + `commitSave()` 实际保存接口；
  明确 `isConnected()`（环境开关）≠ `isReady()`（真实接口就绪）。
- `scripts/windows/gr-worker/ledger.mjs`（新增）—— JSONL 持久化状态机：`task_id → 最新状态 + payload_sha256 绑定 + terminal 标志`。
  latest-wins，跨重启可重载；非终态记录绝不把任务当「已处理」。
- `scripts/windows/gr-worker/worker-core.mjs`（改）—— 七步状态机 + SHA 冲突阻断 + 保存顺序 + allowReal 门控。
- `scripts/windows/gr-worker/worker.mjs`（改）—— 改用 `createLedger`；Processing 崩溃恢复；终态路由；RPC 超时/401/HTTP 异常处理。
- `scripts/windows/gr-worker/config.example.env`（改）—— 新增 `TJ_GR_ALLOW_REAL` / `TJ_GR_RPC_TIMEOUT_MS`，澄清 PAD 语义。
- `scripts/windows/gr-worker/verify-deploy.ps1`（新增）—— 部署只读检查（单次，不起常驻）。
- `tests/gr-worker.test.mjs`（改，23 条）+ `tests/gr-ledger.test.mjs`（新增，6 条）。
- `scripts/tunnel/bridge.js` —— 本轮无改动（Stage28 已加 `GR_Queue\Pending` 白名单；见下方安全审查）。

## 二、六类问题的修复

### 1) Ledger / Queue 状态机（审查项一）
原缺陷：`ledger.record()` 对任何状态都 `_seen.add(task_id)`，导致 `waiting_pad` 第二次扫描被当作 `duplicate_skipped` 移入 Done。
修复：账本改成持久化状态机，只 `terminal:true` 的状态才视为关闭。`waiting_pad`（PAD 未就绪）、`claimed`、
`claim_leased`、`draft_failed`、`reconcile_failed` 都是**非终态**，放回 Pending 重试，绝不 Done。
同一 task_id 换不同 payload_sha256 → `sha_conflict` 阻断（不当重复跳过）。Processing 里崩溃残留文件在启动时放回 Pending 重试。

### 2) Save Intent 顺序（审查项二）
拆成六步：未保存录入（`saveEntry`）→ 完整核对（`reconcileDraft`，逐行比对 scope）→ 持久化 Save Intent（回报
`save_attempted`）→ 实际 Save 一次（`commitSave`）→ 保存成功状态（回报 `saved`）→ 独立回查（`readBack` + 回报 `verified`）。
关键不变式：
- 实际 Save **之前**必须先持久化 `save_attempted`（不可逆尝试记录）。
- `commitSave` 超时/断线/结果不明 → `needs_review`（绝不标可安全重试）。
- 没有真实保存证据（`commitSave.saved!==true`）不回报 `saved`；没有真实 GRN 独立回查证据不回报 `verified`。

### 3) RPC 与 PAD 接入保护（审查项三）
- `worker.mjs` 的 RPC 层：HTTP 200 才解析业务 JSON；业务拒绝以 `{rejected:true,code}` 区分；HTTP 401 → 清 token 强制重登；
  HTTP 非 2xx（PostgREST 抛 GR_* 异常）→ 抛 `GR_RPC_REJECTED`；超时 → `GR_RPC_TIMEOUT`。均**不推进状态**。
- `claim` 被拒 `GR_TASK_LEASED`（lease 被占）→ 非终态 `claim_leased`；`GR_TASK_STALE_REVIEW`（已尝试保存）→ 终态 `needs_review`。
- PAD 就绪检查：`TJ_GR_PAD_CONNECTED=true` 只表示已配置，不等于真实就绪。`isReady()` 在
  `saveEntry/commitSave/readBack` 三者都实现前返回 false，此时 worker **不领取**（不 claim）。
- 保存后回查失败 → `needs_review`（回报 `needs_review` 给 DB），不是简单移 Failed 后允许重过账。

### 4) Bridge 与 Windows 部署（审查项四）
见下方「bridge.js 安全审查」与「Windows 部署步骤」。

### 5) 真实业务接口（审查项五）
不另建 GR Schema。正式（非 mock）任务复用同一 `tj.gr.v1` 契约与 `tj.gr.dispatch.v1` 信封，仅 `mode='real'` /
`task.mock_only=false`。Worker 新增 `allowReal` 门控（环境变量 `TJ_GR_ALLOW_REAL`，默认 false）：默认只接受 mock；
只有显式 `TJ_GR_ALLOW_REAL=true` 才放行 real 信封。真实收货审批、事件授权、冻结 SHA 仍是 DB `tj_gr_receipt_approve`/
`tj_gr_receipt_release` 的职责；PAD SaveGuard（commitSave 门控真实 IRS Save）仍是 PAD 适配器接入后的职责。
本轮**不启用真实 IRS Save/Post**（`TJ_GR_ALLOW_REAL` 保持 false + PAD `isReady()` 恒 false）。

### 6) 最终交付（审查项六）
见文末「测试结果」「能/不能做什么」与本 ZIP。

## 三、PAD 接口合同（saveEntry / commitSave / readBack）

```
isReady(): boolean                      真实就绪：三接口都已实现且可连通才 true
saveEntry(task): Promise<draft>         未保存录入（草稿，不提交）
  draft = { draft_id, lines: [{ line_id, item_code, uom, qty, unit_price,
                                sources: [{ po_line_id, accepted_qty }] }] }
commitSave(task, draft): Promise<result>  实际 Save 一次（只能一次）
  成功 { saved: true, irs_grn_no?, saved_at? }
  明确失败 { saved: false, error }
  超时/断线/结果不明 → 抛错（worker 转 needs_review，绝不重试）
readBack(task): Promise<evidence>         保存后独立回查（真实读回 IRS 单据）
```

`readBack` 返回的 `verified` evidence（与 DB `tj_gr_verify_evidence` 逐项比对）：
```
{
  bridge_ok: true,                 // 必须是 JSON boolean true
  irs_po_no,                       // 必须等于 task.irs_po_no
  irs_grn_no,                      // 非空（真实 GRN 号）
  evidence_ref | source,           // 非空（回查证据来源，如 IRS 截图/读回记录）
  saved_at,                        // timestamptz
  receive_date, invoice_date,      // 与批准快照一致
  irs_invoice_no, supplier_code, invoice_no, delivery_order_no,
  lines: [{ line_id, line_no, item_code, uom, qty, unit_price,
            sources: [{ po_line_id, accepted_qty }] }]   // 逐行、无重复 line_id、来源逐条匹配
}
```

## 四、bridge.js 安全审查（现状，本轮未改）

- 写白名单：`WRITE_ALLOW` 含 `PO_Queue\Pending` 与 `GR_Queue\Pending`，仅允许写白名单目录或其子目录；写入走
  `.part` 再原子改名，20MB 上限。**GR_Queue\Pending 已在 Stage28 加入。**
- `read` / `list`：**无路径白名单**——任何能连上 127.0.0.1:9000 的进程可读/列任意路径。这是既有 Auto-PO 桥的
  历史行为，为不破坏既有 PO 机制本轮**未收紧**；风险与边界见下。
- 命令执行（`args`）：执行 `agent-desktop.cmd` 并传任意参数（Auto-PO snapshot 机制），超时 120s。
- 访问边界：只监听 `127.0.0.1:9000`，不对外网开放；VPS→Windows 走 SSH 隧道（SSH 密钥认证）是主安全边界。
  **残余风险**：Windows 本机任意进程也可直连 127.0.0.1:9000（无额外鉴权）。正式投产前建议：为 bridge 加
  一次性 token/共享密钥头校验，并考虑收紧 read/list 到白名单目录——这两项留待后续独立授权，本轮不动以免
  影响 Auto-PO Bridge。

## 五、Windows 目标机安全部署步骤（备份 → 替换 → 重启 → 验证 → 回滚）

1. **只读检查（先跑这个，不起常驻、不开自启）**：把 ZIP 解压到本机，`powershell -ExecutionPolicy Bypass -File verify-deploy.ps1`。
   确认 node/.env/队列目录/bridge 版本/Pending 数量；全程只读。
2. **备份当前 bridge**：`copy C:\irs\bridge.js C:\irs\bridge.js.bak-<日期>`。
3. **确认实际启动入口**：当前 bridge 由谁拉起（计划任务/`start bridge.js`/SSH 会话内 `node bridge.js`）。查
   `C:\irs\bridge.log` 末尾 `STARTED v3.1` 与运行方式，替换前先停掉旧进程。
4. **替换 bridge.js**：用 ZIP 内 `scripts/tunnel/bridge.js` 覆盖 `C:\irs\bridge.js`（它含 GR_Queue 白名单）。
5. **重启 bridge**：用原启动方式拉起，`bridge.log` 出现 `STARTED`。
6. **验证 GR_Queue\Pending**：从 VPS 跑一次 dispatcher 或手动 `write` 一个 `GR_Queue\Pending\task-*.json`，
   Windows 侧 `list` 能读到该文件即为通。
7. **验证旧 PO Queue 仍正常**：确认 `PO_Queue\Pending` 的既有 Auto-PO 流程未被影响（write/list/read 仍可用）。
8. **失败回滚**：停 bridge，`copy /Y C:\irs\bridge.js.bak-<日期> C:\irs\bridge.js`，重启旧 bridge，PO 流程恢复。
9. **本轮只跑单次**：Worker 用 `node worker.mjs --once`（或 `run-worker.bat --once`）单轮验证；**不启用 `--loop`、
   不配任务计划、不开机自启**。

## 六、测试结果

- `npm test`（`node --test tests/*.test.mjs`）：**229 通过 / 0 失败**（210 既有 + 19 新增：worker 七步/SHA 冲突/
  保存顺序/超时转 needs_review/readBack 失败转 needs_review/处理中断 23 条 + 账本持久化 6 条，替换旧 10 条 worker 测试）。
- 针对性覆盖（审查项要求的异常分支）：PAD 未就绪连续扫两次不 Done；Worker 重启/处理中断重试；重复 Task；
  不同 SHA 冲突；commitSave 超时/失败→needs_review；readBack 失败→needs_review；save_attempted RPC 超时→needs_review；
  claim lease/stale；allowReal 门控。
- 未执行：真实 Preview 端到端投递（Stage28 已验）、真实 IRS Save/Post、真实 GRN 回查。

## 七、当前能安全执行 / 仍不能执行

能（安全）：
- VPS 侧 dispatcher 投递 mock 任务到 Windows GR Queue（离线 SHA 校验 + 白名单写）。
- Windows Worker 对 mock 任务跑 `--once`：claim/六步保存流程/账本落盘/终态路由（PAD 未就绪时只记 waiting_pad 不 claim）。
- 部署只读检查、bridge 替换与回滚（不影响既有 PO 桥）。

仍不能（待独立授权/接入）：
- 真实（非 mock）IRS Save/Post（`TJ_GR_ALLOW_REAL` 默认 false + PAD 未接入）。
- PAD `saveEntry/commitSave/readBack` 真实实现与真实 GRN 回查证据。
- `TJ_GR_ALLOW_REAL=true`、常驻 `--loop`、任务计划/开机自启。
- 生产 `main/public`、bridge read/list 收紧与鉴权加固。
