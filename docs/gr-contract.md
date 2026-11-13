# GR（统一收货）第一版设计档案 — 已被安全修正版取代

本文件以下正文保留为第一版设计历史，不再是可执行契约。尤其旧文中的 DO 必填、combine 来源 frozen=true、helper 权限、回执字段和 public 权限描述不得使用。实际实现契约请先读 `docs/gr-contract-v1-preview.md`，以当前 SQL/RPC、共享生成器和真实验收证据为准。

> 状态：**PREPARED（仅 tj_preview 实现；public 版本只准备、需人工门禁）**。
> 以下为已取代的设计历史；实际 UI/数据库契约见安全修正版文档。
> 数据库实现：`supabase/migrations/20261113_gr_unified_preview.sql`；
> public 版本：`supabase/migrations/gr_unified_public_prepared.sql`（未带版本号，
> Supabase CLI 不会自动套用；另有 SQL 门禁，见 §13）。
> 纯 JS 契约实现（校验/规范化/哈希/任务状态机）：`web/src/lib/core/receipt-core.js`、
> `web/src/lib/core/receipt-tasks.js`。两侧哈希算法必须逐字节一致（§7）。

## 0. 边界（不因本契约解除）

- 只在隔离 schema `tj_preview` 运行；`public` 需单独授权后手工应用同一迁移。
- GR 任务 **不真实出队**：`task_type='GOODS_RECEIVE'`、`schema='tj.gr.v1'`、
  `environment='preview'`、`mock_only=true`，数据库 CHECK 硬约束；真实 bridge /
  Windows Queue / IRS 一律不接。模拟 dispatcher 只写本地 scratch 目录。
- 不修改 `tj_po_headers` / `tj_po_lines` 的原始订购字段（`qty`、`original_qty`、
  7 列导出字段），不覆盖任何已批准快照，不改 `public`，不改 DYT。
- `receipt_event_id` 唯一索引（`uq_tj_po_headers_receipt_event_id`）保持不动。

## 1. 调用方式

```http
POST {SUPABASE_URL}/rest/v1/rpc/tj_gr_api
apikey / Authorization: <JWT>            -- 必须是真实登录用户，anon 无 EXECUTE
Content-Profile: tj_preview              -- 或 Accept-Profile，取决于 PostgREST 版本
Content-Type: application/json
{"p_action": "receipt_save", "p_data": { ... }}
```

单入口、单事务：任何 `raise` 都会整笔回滚。

### 1.1 返回值

**直接业务 JSON**（没有 `{ok, data}` 包装）。数组动作返回 JSON 数组；单个对象动作
返回该对象；`receipt_release` 返回 `{event, tasks, missing_mappings}`。

### 1.2 失败

数据库抛 `raise_exception`，`message` 是 **JSON 文本**（PostgREST 原样返回在
`message` 字段）。解析方式：

```js
const e = JSON.parse(err.message) // {code, message, detail}
```

| code | 含义 | UI 处理 |
|---|---|---|
| `GR_AUTH_REQUIRED` | 没有 JWT / `auth.uid()` 为空 | 跳登录 |
| `GR_FORBIDDEN` | 角色不足 | 隐藏按钮/提示无权限 |
| `GR_NOT_MEMBER` | 无 tj_preview 有效 membership | 提示等待授权 |
| `GR_NOT_FOUND` | 单据/任务不存在 | 刷新列表 |
| `GR_REVISION_CONFLICT` | `revision` 与库中不一致（他人已改） | 刷新后重填 |
| `GR_STATE` | 当前状态不允许该动作 | 刷新；禁止本地猜测状态 |
| `GR_VALIDATION` | 字段/结构非法（detail.field 指明） | 就地标红 |
| `GR_INVALID_DECIMAL` | 数量/单价不是十进制字符串 | 就地标红 |
| `GR_DECIMAL_SCALE` | 小数位 > 6 | 就地标红，不四舍五入 |
| `GR_QTY_MISMATCH` | 行 `accepted_qty ≠ Σ sources`、`ordered_qty` 与来源不符 | 就地标红 |
| `GR_SOURCE_MISMATCH` | item_code/UOM/单价与来源 PO 行不一致 | 就地标红 |
| `GR_QTY_EXCEEDED` | 超过来源行剩余可收（累计，含已批准/在途） | 提示剩余量 |
| `GR_EXCEPTION_NOT_ALLOWED` | 存在超收/额外行异常但未显式确认 | 弹出异常确认 |
| `GR_MAPPING_REQUIRED` | 未验证 IRS PO 映射就 release | 走映射登记 |
| `GR_TASK_STALE` | 任务 lease 过期且已开始保存 | 转人工 review |
| `GR_CALLBACK_CONFLICT` | 相同 callback_id 内容不同 | **不 raise**：返回 `rejected:true` + `code`，审计已落库 |
| `GR_CALLBACK_OUT_OF_ORDER` | 回调状态倒退/跳过前置状态 | **不 raise**：返回 `rejected:true` + `code`，状态不变 |
| `GR_PUSH_BLOCKED` | preview 内任何 push/出队 | 硬失败，不可重试 |
| `GR_IDEMPOTENCY_CONFLICT` | 同一 `request_id` 参数不同 | 提示重复提交 |

## 2. 身份与角色

- 身份只来自 `auth.uid()`（真实 JWT）。**不信任**请求体里的任何人名/uuid。
- 角色来自 `tj_preview.tj_gr_memberships(user_id, role, active)`，`role ∈
  {staff, approver, executor, admin}`；无记录或 `active=false` = 无权限。
- `session` 返回：`{user_id, roles:[], is_admin, active}`；`roles` 按字典序。

权限矩阵（数据库 `tj_gr_require_role` 强制，前端只是镜像）：

| action | staff | approver | executor | admin |
|---|:--:|:--:|:--:|:--:|
| session / receipt_list / receipt_get | ✅ | ✅ | ✅ | ✅ |
| receipt_save / receipt_submit | ✅ | ✅ | — | ✅ |
| receipt_approve / receipt_release / mapping_set | — | ✅ | — | ✅ |
| task_claim / task_result | — | — | ✅ | ✅ |
| po_save / combine_create / combine_submit / combine_cancel | ✅ | ✅ | — | ✅ |
| po_push | ✅(preview 必失败) | ✅ | — | ✅ |
| combine_approve | — | ✅ | — | ✅ |

`task_result` 必须由该任务的领取者执行（`claimed_by = auth.uid()`），admin 例外。

## 3. 数量/价格：精确十进制字符串

- 输入：`"12.5"`、`"0.125"`、`"1000"`。也接受 JSON number，但**输出永远是字符串**。
- 禁止：指数形式（`1e3`）、空串、NaN/Infinity、负数、> 6 位小数。
- 数据库列 `numeric(20,6)`；输出统一 `trim_scale` 规范：`"12.500"` → `"12.5"`，
  `"0.00"` → `"0"`。
- `item_code` / `uom` / 供应商代码 / 单号 **保持文本原样**（前导零、大小写、
  空格都不 trim、不转换）。
- 任何"看起来像 0"的缺失值都是错误，**绝不静默转 0**。

## 4. 事件状态机（`tj_gr_receipt_events.status`）

```
draft ──submit──▶ submitted ──approve──▶ approved
  │                  ▲                     │
  └──(approver 一步 approve)──────────────┘
  approved ──release（映射缺失）──▶ waiting_mapping ──mapping_set+release──▶ released
  released/task 回调 ──▶ in_progress ──▶ saved_unverified ──▶ verified
  任意任务 failed_unsaved / needs_review ──▶ needs_review（人工修，可回 draft 重存）
  任意未批准状态 ──cancel──▶ cancelled
```

- `revision` 是乐观锁：`receipt_save` 首次返回 `0`；之后必须传**当前返回值**，
  保存成功后 `revision+1`。**只有 save 会递增**；submit/approve 只校验，不递增
  （状态机本身是幂等屏障：状态变了第二次就会被 `GR_STATE` 拒绝）。
- `approved` 之后行/来源/日期一律不可改（只能 `needs_review → save` 在任务未开始
  且未 release 时回 draft；已 release 的事件不再允许编辑）。
- `waiting_mapping` 不是错误：`receipt_release` 正常返回 `missing_mappings`，
  UI 显示"待登记 IRS PO 映射"。

## 5. 动作与字段

### 5.1 `session`
输入 `{}`。输出见 §2。

### 5.2 `receipt_list`
输入 `{status?: string|string[], limit?: int(<=200, 默认50), po_id?: uuid}`。
输出：事件摘要数组（无 lines）：
`{id, event_no, revision, status, supplier_code, supplier_name, po_ids, invoice_no,
  delivery_order_no, receive_date, invoice_date, checked_by, approved_by, approved_at,
  released_at, warnings, exception_count, created_at, updated_at}`。

### 5.3 `receipt_get {id}`
输出完整事件：
```
{ ...摘要, note, submitted_by, submitted_at, allow_exceptions, review_note,
  payload_sha256, warnings:[], exceptions:[],
  lines:[{ id, line_no, item_code, description, uom,
           unit_price, ordered_qty, accepted_qty, note,
           sources:[{ po_header_id, po_line_id, ordered_qty, accepted_qty }] }],
  tasks:[{ id, status, po_header_id, irs_po_no, payload_sha256,
           claimed_by, lease_expires_at, save_attempted_at, saved_at, verified_at,
           bridge_ok, last_error }],
  missing_mappings:[po_header_id...] }
```
（`missing_mappings` 每次读都会按当前映射表重新计算，不依赖上次 release 的结果。）

### 5.4 `receipt_save`
输入（UI 稳定 UUID；新建时 `revision:0`）：
```json
{
  "id": "<uuid>", "revision": 0,
  "po_ids": ["<uuid>", "..."],
  "invoice_no": "INV-1", "delivery_order_no": "DO-1",
  "receive_date": "2026-11-13", "invoice_date": null,
  "checked_by": "Ah Huat", "note": "",
  "lines": [{
    "id": "<uuid>", "line_no": 1, "item_code": "00101",
    "description": "HINGE", "uom": "UNIT",
    "unit_price": "2.50", "ordered_qty": "5", "accepted_qty": "4",
    "note": "短收 1",
    "source_allocations": [
      {"po_header_id": "<uuid>", "po_line_id": "<uuid>", "accepted_qty": "3"},
      {"po_header_id": "<uuid>", "po_line_id": "<uuid>", "accepted_qty": "1"}
    ]
  }]
}
```
服务端规则（全部强制）：
1. `po_ids` 非空、去重、**同一供应商**、存在且未取消；`receive_date` 必填；
   `invoice_date` 只在显式提供时保存（**不猜、不用收货日期代替**）。
2. 每行 `accepted_qty` 必须恰好等于该行所有 `source_allocations.accepted_qty` 之和
   （空来源 = `extra_line` 异常，不是 0）。
3. 每个 allocation 的来源行必须属于 `po_ids`、供应商一致，且
   `item_code`/`uom`/`unit_price` 与该 `tj_po_lines` 行严格相等（文本精确，
   unit_price 十进制相等）。
4. `ordered_qty` 由服务端按来源行的 `coalesce(original_qty, qty)` 求和后**校验**：
   客户端提供但不符 → `GR_QTY_MISMATCH`；未提供 → 服务端填。
   **不允许自造订购量**：一次事件里同一来源行只能分配一次，`ordered_qty` = Σ 该行
   所有来源行的订购量（分批收货时每批都会显示该来源行的完整订购量作为参照，
   `accepted_qty` 才是本批实收；累计余额在批准时按来源行核对）。
5. 同一 `line_no` / 同一 `line.id` / 同一 `(line, po_line)` 重复 → `GR_VALIDATION`。
6. 保存时**不**因超收/短收而拒绝（记录 warning/exception 供审批确认）；
   但结构错误、来源不匹配、分配不平一律拒绝。
7. 保存会重写该事件的行与来源（事件未批准，行 id 由客户端稳定提供）。
输出：同 `receipt_get`。

### 5.5 `receipt_submit {id, revision}`
`draft|needs_review → submitted`，重算 `payload_sha256` 与 warnings/exceptions。
输出事件。

### 5.6 `receipt_approve {id, revision, allow_exceptions, review_note}`
- 允许 `submitted`，或由 approver/admin **一步** `draft → approved`（轻量正常收货）。
- 存在 exceptions 且 `allow_exceptions !== true` → `GR_EXCEPTION_NOT_ALLOWED`
  （detail 列出每条 exception，UI 必须逐条展示后才能重试）。
- 事务内：锁事件行 → 锁**全部来源 `tj_po_lines` 行**（`order by id for update`）→
  重新校验累计余额（含所有已批准/在途事件）→ 写 `approved_by/approved_at`。
- 并发：两个事件同时批准同一来源行时，后到者被行锁串行化后看到累计超余额并拒绝。
输出事件。

### 5.7 `receipt_release {id}`
前置：`approved`（或 `waiting_mapping`）。对 `po_ids` 每个 PO：
- `tj_gr_po_mappings` 必须有该 PO 的已验证映射（`irs_po_no` + evidence）。
- `delivery_order_no` 非空、`receive_date` 非空、`payload_sha256` 非空。
- 缺失 → 事件转 `waiting_mapping`，返回 `{event, tasks:[], missing_mappings:[...]}`（不 raise）。
- 齐全 → 按 §8 拆任务 + 写 outbox（`mock_only=true`），事件转 `released`。
输出 `{event, tasks, missing_mappings:[]}`。重复 release（已 released）幂等返回现有任务。

### 5.8 `mapping_set {po_header_id, irs_po_no, evidence}`
approver/admin。`irs_po_no` 非空文本（原样保存，不校验数字格式——编号内容不是规则）；
`evidence` 必须是非空对象，且含非空 `checked_by` 与可解析 `checked_at`；
若给 `irs_po_no` 字段则必须与入参一致。覆盖写会更新 `verified_at/by`。
输出映射行。

### 5.9 `task_claim {task_id, executor_id}`
`executor` 或 admin。条件更新（`status='ready'` 或 lease 已过期且**从未**开始保存）
→ `claimed`，绑定 `claimed_by/executor_id`，lease 5 分钟。lease 过期但
`save_attempted_at` 非空 → 置 `needs_review` 并抛 `GR_TASK_STALE`（**不重发**）。
输出任务。

### 5.10 `task_result`
输入：
```json
{
  "task_id": "<uuid>", "receipt_event_id": "<uuid>",
  "payload_sha256": "<64hex>", "callback_id": "cb-1",
  "event_type": "save_attempted|saved|verified|failed|needs_review",
  "evidence": {
    "bridge_ok": true, "irs_po_no": "5", "irs_grn_no": "7",
    "supplier_code": "4000/A01", "invoice_no": "INV-1",
    "delivery_order_no": "DO-1", "saved_at": "2026-11-13T01:02:03Z",
    "lines": [{"line_id": "...", "item_code": "00101", "uom": "UNIT",
               "qty": "4", "unit_price": "2.50"}]
  },
  "error": null
}
```
规则见 §9。输出：
```json
{"task": {...}, "event_status": "in_progress", "mismatches": [],
 "replayed": false, "rejected": false}
```
`rejected:true` 时 `code` 为 `GR_CALLBACK_CONFLICT` / `GR_CALLBACK_OUT_OF_ORDER`，
**HTTP 仍成功、事务提交**（否则审计会被一起回滚），但任务状态绝不改变；
调用方必须检查 `rejected`/`code`，不能只看 HTTP 200。

### 5.11 `po_save`
输入 `{id, request_id, supplier_code, supplier_name, notes, created_by, lines:[{id?, line_no,
item_code, description, uom, qty, unit_price}]}`。
- `request_id` 幂等（同 id 同参返回首次结果，不同参数 → `GR_IDEMPOTENCY_CONFLICT`）。
- 事务内 upsert 明细（有 `id` 按 id 更新，无 `id` 插入），`notes` 落库。
- **安全限制**：已被收货引用（`tj_gr_line_sources`）或已冻结的明细，禁止改
  `item_code/uom/unit_price/qty`（`GR_STATE`）；允许新增未被引用的行；禁止删除已引用行。
- 冻结 header 无法更新（既有 `tj_po_header_frozen_guard` 会拒绝，原样冒泡）。
- 不改 7 列导出字段语义（`qty` 仍是订购数量，`original_qty` 不被覆盖）。
输出 header + lines。

### 5.12 `po_push {id, request_id}`
- preview：**一律** `GR_PUSH_BLOCKED`（不写 outbox、不改状态）。
- public（PREPARED 版）：严格 CAS（`status='confirmed' and frozen=false and po_revision=...`），
  命中 0 行 → `GR_STATE`；按 `request_id` 幂等写 outbox（`kind='po_push'`）；
  **不修改** `tj_po_lines` 任何列，不改 7 列业务字段。
输出 `{po_id, status, outbox_id, request_id}`。

### 5.13 `combine_create {request_id, source_ids, website_po_date, created_by, lines}`
- 事务内 `select ... for update` 锁来源单；必须 ≥2 张、同一 suppliers、
  `status='confirmed' and frozen=true`、未被其他 combined 占用、未取消。
- `request_id` 幂等；同一 request_id 重放返回同一张合并单。
- 行必须覆盖所有来源行（按 `item_code+uom+unit_price` 分组），`source_refs` 保留
  `{po_id, po_number, line_id, qty}`，`original_qty` = 累计订购，`accepted_qty` 默认
  = `original_qty`（可下调）。
- `website_po_date` 必填（既有 CHECK/trigger 保证；缺 → `GR_VALIDATION`）。
- 来源单标 `combining`（既有状态机），**不覆盖**其已批准字段。
输出合并单 header + lines。

### 5.14 `combine_submit {id, checked_by, delivery_order_no?}`
`draft → pending_approval`，写 `checked_by / receipt_event_id / received_at`（与既有
approve-flow 口径一致），条件更新命中 0 行 → `GR_STATE`。

### 5.15 `combine_approve {id}`
approver/admin。`pending_approval → confirmed + frozen`，`source_sha256` = §7 的
**v2 快照**（`approval_snapshot_version=2`），来源单标 `combined`。**不覆盖任何
既有批准**（其他单的 approved_* 原样）。冻结后任何 update 由既有 guard 拒绝。

### 5.16 `combine_cancel {id}`
`draft|pending_approval → cancelled`，来源单恢复 `confirmed`。已 confirmed/frozen 拒绝。

## 6. 异常与 warning

存储于事件：`warnings jsonb[]`（字符串数组）、`exceptions jsonb[]`（对象数组
`{code, line_id?, po_line_id?, detail}`）。

| 类型 | code | 级别 | 触发 |
|---|---|---|---|
| 超收 | `over_receipt` | exception | 行 accepted > 行 ordered |
| 累计超余额 | `over_balance` | exception | Σ 已批准/在途 + 本次 > 来源行订购 |
| 额外行 | `extra_line` | exception | 行没有任何 source allocation |
| 零收 | `zero_receipt` | warning | accepted = 0 |
| 短收 | `short_receipt` | warning | accepted < ordered |
| 单据疑似重复 | `duplicate_document` | warning + `review_required` | 同供应商同 Invoice/DO 已有非取消事件 |
| 未登记映射 | `mapping_missing` | warning（release 前） | 来源 PO 无已验证映射 |

`over_receipt` / `over_balance` / `extra_line` 只有 `allow_exceptions=true` 才可批准，
且必须写 `review_note`（非空）。合法分批（同一 DO/Invoice 多次收货）**不禁止**，
只标 warning。

## 7. 规范化与哈希（跨语言逐字节一致）

规范文本（`GRPAYLOAD/1`）：
```
schema\t<...>\nkind\tgoods_receive\n...
```
- 每条 `key<TAB>value`，行间 `\n`（最后一行后**没有**换行）。
- 全部行按 `key` 的**字节序**排序（键只用 ASCII）。
- 值编码：
  - `null` → `\N`
  - bool → `true` / `false`
  - 十进制 → 规范十进制串（`trim_scale` 语义：去尾随 0、无指数、`0`）
  - 日期 → `YYYY-MM-DD`；时间戳 → UTC `YYYY-MM-DDTHH:MM:SSZ`（秒精度）
  - 文本 → 转义 `\` → `\\`、TAB → `\t`、LF → `\n`、CR → `\r`
- 键（事件，`%04d` 为 0 起、4 位补零的序号；行按 `line_no, id` 排序，
  来源按 `po_header_id, po_line_id` 文本序排序——SQL 与 JS 必须一致）：
  `schema, kind, environment, event.{id,revision,supplier_code,supplier_name,po_ids,
  invoice_no,delivery_order_no,receive_date,invoice_date,checked_by,approved_by,approved_at}`,
  `lines.%04d.{id,line_no,item_code,description,uom,unit_price,ordered_qty,accepted_qty,note}`,
  `lines.%04d.sources.%04d.{po_header_id,po_line_id,ordered_qty,accepted_qty}`
  - `event.po_ids` = 排序后的 uuid 用 `,` 连接。
- `event_payload_sha256 = sha256(规范文本)`，64 位小写 hex（`extensions.digest(...,'sha256')`）。
  该哈希**覆盖供商、单据号、收货/发票日期、核对人、审批人、全部行、全部来源分配**，
  即 IRS 字段的完整内容。
- 哈希只在**写入之后**重算（批准人/批准时间也进哈希；同一条 UPDATE 里 `SET` 表达式
  看到的是 OLD 行，所以批准分两步写）。任何读回后的重算必须与存储值相等。
- 任务规范文本 = 事件全部键 + 以下键（同一排序）：
  `task.{id,type,schema,environment,po_header_id}`、
  `mapping.{po_header_id,irs_po_no,evidence_sha256}`、
  `event_payload_sha256`、
  `scope.lines.%04d.{...同上字段}`、`scope.lines.%04d.sources.%04d.{...}`
  （scope = 该任务对应 PO 的行与来源切片）。
  因此**任何一行/一个来源变化都会改变全部任务哈希**，并且任务哈希还绑定映射证据。

实现对照：SQL `tj_preview.tj_gr_event_kv()` / `tj_gr_canonical()`；
JS `eventKeyValues()` / `canonicalFromKeyValues()`。二者由本地 harness 交叉验证同值。

## 8. 事件 → 任务拆分

- 任务粒度：**(receipt_event_id, revision, po_header_id)** —— 每个来源 PO（= 一个 IRS PO
  映射）一个任务；一个收货事件可拆多个任务（多 IRS PO 事件）。
- 任务 `payload`（JSONB）含：`task` 元信息、`mapping`、`event_payload_sha256`、
  `event` 摘要（供商、单据号、日期、核对/审批）、`scope.lines`（该 PO 的行与来源）。
  任务 `payload_sha256` 按 §7 计算。
- 唯一约束 `(receipt_event_id, event_revision, po_header_id)`：同一版本不重复建任务。
- 任务状态：`ready → claimed → save_attempted → saved_unverified → verified`；
  旁路 `failed_unsaved` / `needs_review` / `cancelled`。
- outbox 每任务一行（`request_id = 'gr:'||task_id`，`kind='gr_task_dispatch'`，
  `mock_only=true`），释放后**持久化**再允许模拟 dispatch。

## 9. 回调语义（`task_result`）

1. `callback_id` 幂等：相同 `callback_id` + 相同 `content_sha256` → `replayed:true`，
   返回既有结果并记 replay 审计；相同 id + 不同内容/hash → 返回
   `rejected:true, code='GR_CALLBACK_CONFLICT'` + **已提交**的拒绝审计。
   为什么不是 raise：PostgreSQL 里 raise 会把同事务的审计行一起回滚，审计就没了；
   因此「拒绝」在这一层用 `rejected` 表达，任务状态不变。
2. `receipt_event_id` 必须等于任务事件的 id；`payload_sha256` 必须等于任务存的值，
   否则 `GR_VALIDATION`（防串任务/串版本）。
3. 迁移（`nextTaskStatus`）：
   - `save_attempted`：`ready|claimed → save_attempted`（写 `save_attempted_at`，
     之后**永不自动重做**）。
   - `saved`：要求已是 `save_attempted`；`bridge_ok !== true` 视为失败：
     已开始保存 → `needs_review`，否则 `failed_unsaved`；正常 → `saved_unverified`。
   - `verified`：要求 `saved_unverified` 且 evidence **逐行严格比对**通过（§10）；
     任何不一致 → `needs_review`（不是 verified），并返回 mismatches。
   - `failed`：从未 `save_attempted` → `failed_unsaved`；已开始 → `needs_review`。
   - `needs_review`：直接置 `needs_review`（保留证据）。
4. 乱序/倒退：目标状态 rank < 当前 rank（`ready<claimed<save_attempted<saved_unverified<verified`）
   → `rejected:true, code='GR_CALLBACK_OUT_OF_ORDER'`（同样提交审计、状态不变）；
   `verified` 为终态。
5. lease 超时且已 `save_attempted` → `needs_review`，**绝不盲发**。
6. 其他硬错误（`task_id`/`payload_sha256` 不匹配、权限、任务不存在）仍然 raise。

## 10. verified 证据（严格逐行，不是布尔）

`verified` 时 `evidence` 必须给出并可被数据库逐项比对（任何缺项 = 不通过）：

- `bridge_ok=true`
- `supplier_code` == 任务 payload 的 supplier_code
- `invoice_no` == 事件 invoice_no（事件有值时）
- `delivery_order_no` == 事件 delivery_order_no（事件有值时）
- `irs_po_no` == 映射表该 PO 的已验证编号
- `lines[]`：数量与任务 scope 行**完全一致**（不多不少），每项
  `item_code`/`uom` 文本相等、`qty`/`unit_price` 十进制相等
- `saved_at` 可解析
返回 mismatch 列表（`{kind, line_id?, field, expected, actual}`）并转 `needs_review`。

## 11. 并发与锁（服务端）

- `receipt_save`：`select ... for update` 事件行（若存在）。
- `receipt_submit`：条件更新 `where revision=$1 and status in (...)`，命中 0 行 → `GR_REVISION_CONFLICT|GR_STATE`。
- `receipt_approve`：锁事件 → 锁所有来源 `tj_po_lines`（`order by id for update`）→
  重新计算累计余额 → 写批准。**所有**已批准/在途事件计入累计，避免并发超余额。
- `task_claim`：单条 `update ... where id=$1 and (status='ready' or lease 过期) returning`，
  lease 原子。
- `combine_create`：`for update` 锁来源单，防同单被并两次。
- `po_save` / `po_push`：`request_id` 唯一键幂等 + CAS 状态。

## 12. 安全模型（数据库）

- RPC：`security definer`，`set search_path = ''`，所有对象**全 schema 限定**
  （`tj_preview.*` / `extensions.digest`），`revoke all on function from public, anon`，
  只 `grant execute to authenticated`；`service_role` 不获 schema USAGE。
- 新表：`enable row level security`；只加 `for select to authenticated` 且
  `tj_gr_is_member()` 的读策略；**没有** insert/update/delete 策略 → 直接写被拒；
  权限层面 `revoke insert,update,delete from anon, authenticated`，只 `grant select`。
- tj_preview 旧 6 表：新增 `for select to authenticated using (tj_gr_is_member())`；
  撤销 `authenticated` 的直写（insert/update/delete/truncate/references/trigger），
  写只走 RPC。（public 版本不做这一步，见 §13。）
- `auth.uid()` 真实 JWT；不创建 auth 用户，membership fixtures 只在 tj_preview。

## 13. 迁移顺序（主脑执行）

1. **先** `supabase/migrations/20261113_gr_unified_preview.sql`（tj_preview，可重入，
   不动 public、不关既有 freeze guards、不删 receipt_event 唯一索引）。
2. 读回校验：表/函数/策略存在；`has_schema_privilege('service_role','tj_preview','USAGE')=false`；
   `anon` 无 `tj_gr_api` EXECUTE。
3. **再** 跑 `supabase/tests/20261113_gr_preview_integration.sql`（事务内全回滚；
   合成 uuid 只写 tj_preview membership，不建 auth 用户，不耗 `po_seq`）。
4. `public` 版 `supabase/migrations/gr_unified_public_prepared.sql` **只准备**：
   由 `node scripts/gr-gen-public-prepared.mjs` 从预览版生成（`--check` 校验同步）；
   文件名无版本前缀，CLI 不会自动应用；文件内还有 SQL 门禁——
   必须在同一事务先 `select set_config('tj.gr.apply_public','AUTHORIZED_MANUAL','true')`，
   否则第一条 DDL 之前就 `raise` 中止。**未获单独授权前不得执行**。
   public 版**不**收敛旧表 authenticated 直写（生产旧表仍是 anon 宽松权限），
   也不 drop/关闭任何既有 freeze/push/IRS guard 与 `receipt_event_id` 唯一索引。
5. 回滚：见迁移文件末尾注释（只 DROP 本轮新对象；不 DROP 旧表/列/索引）。

## 14. 本地验证（非真实 DB 验收）

```bash
npm test                                   # 纯 JS 契约/状态机/哈希/幂等
node scripts/gr-local-smoke.mjs            # 需 @electric-sql/pglite：真实 Postgres
                                           # (WASM) 跑迁移 + 集成 SQL + JS/SQL 哈希对照
node scripts/gr-mock-dispatcher.mjs --in <outbox.json> --outdir <scratch>
node scripts/gr-gen-public-prepared.mjs --check   # public 版与预览版同步校验
```
本地 harness 只证明 SQL 可执行与语义一致；**真实 tj_preview 应用与验收由主脑执行**。
