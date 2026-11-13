# TJ 统一收货实际契约 — tj.gr.v1（安全修正版）

此文取代 `gr-contract.md` 第一版设计。以实际 SQL/RPC、共享模块和验收证据为准，不表示允许生产执行。

## 边界

- 共用 Supabase，但只操作 TJ 隔离 schema `tj_preview`；不改 DYT 数据及权限。
- 开发 worktree 独立，生产 cron 仍读 `/home/hermes/projects/TJ-AI-Ops` 的脚本及 public。
- GR 任务硬限制 `GOODS_RECEIVE / tj.gr.v1 / preview / mock_only=true`。不写 Windows PO Pending，不接真实 Bridge/PAD/IRS。
- public migration 仅 PREPARED，文件名及 SQL 授权双门禁；不能本轮应用。
- PO_Lines 旧七列、旧 PO Queue 格式保留；Preview 所有真实 PO Push 拒绝。

## 真实 API / 身份

`POST <SUPABASE_URL>/rest/v1/rpc/tj_gr_api`

Headers：apikey=公开 anon key；Authorization=Bearer 真实 Supabase Auth JWT；Content-Profile=tj_preview；Content-Type=application/json。

Body：`{"p_action":"receipt_get","p_data":{"id":"<UUID>"}}`。
响应为直接 JSON 对象/数组。PostgREST 异常 message 是 JSON 文本 `{code,message,detail}`。

角色：`tj_gr_memberships(user_id,role,active)`，身份只取 auth.uid()，不信任请求体姓名授权。

- staff/approver/admin：登记/提交收货、事务保存普通 PO、建立/提交/取消合并。
- approver/admin：批准合并、批准/释放收货、登记已核对 IRS PO 映射。
- executor/admin：领取任务、提交回执；普通员工不能伪造执行结果。
- 有效成员可读本 TJ Preview 单据；非成员不能借 DYT 登录读取。

仅 api/is_member/roles 可供 authenticated 执行，内部 helper 撤 PUBLIC/anon/authenticated EXECUTE。新表及 Preview 旧表撤客户端直写，RLS 限 TJ membership。service_role 仍无 tj_preview USAGE；public/DYT 既有权限保持。

## 实际表（均在 tj_preview）

- tj_gr_memberships：可信角色。
- tj_gr_receipt_events：稳定 UUID id（即 receipt_event_id）、event_no、revision、供应商、po_ids、Invoice/DO、收货/发票日期、操作者、审批/释放信息、完整事件 hash、warnings/exceptions、结构化结果。
- tj_gr_receipt_lines：稳定行 UUID、顺序、item/UOM/price、ordered/accepted、备注。
- tj_gr_line_sources：每条来源 PO/line UUID 与订购/本次分配；FK RESTRICT 保护旧 PO 来源。
- tj_gr_po_mappings：独立 IRS PO 映射及核对证据，不解冻旧表头。
- tj_gr_tasks：事件按原始 PO 拆分的任务、payload/hash、lease/attempt、保存/核验状态、GRN/证据。
- tj_gr_outbox：持久化投递意图，request_id 唯一。
- tj_gr_task_callbacks：回执内容指纹、接受/拒绝/重放及证据。
- tj_gr_requests：PO/合并请求幂等。
- tj_gr_audit：操作、拒绝与人工核对记录。

历史 PO 字段不删，不把 exported 当 ERP 完成，不自动生成历史收货，不覆盖旧批准快照。

## 收货输入、规则与动作

数量/价格均为精确十进制字符串，numeric(20,6)，最多 6 位小数，超出拒绝不四舍五入；编码始终文本。空白/负数/指数/NaN 不静默转零。

receipt_save 示例（占位类型示意，不是真实任务）：
```
{
 "id":"<stable event UUID>","revision":0,"po_ids":["<original PO UUID>"],
 "invoice_no":"INV-TEST","delivery_order_no":null,
 "receive_date":"2026-11-13","invoice_date":null,
 "checked_by":"<employee label>","note":"<optional>",
 "lines":[{
   "id":"<stable receipt-line UUID>","line_no":1,
   "item_code":"00001","description":"<text>","uom":"UNIT",
   "unit_price":"2.5","ordered_qty":"5","accepted_qty":"2","note":"<difference>",
   "source_allocations":[{"po_header_id":"<original PO UUID>",
                          "po_line_id":"<original line UUID>","accepted_qty":"2"}]
 }]
}
```

输入 source_allocations，读回 sources。创建前持久化稳定 UUID，使用读回 revision。相同内容断线重放返回既有事件，不新建第二份。

- receive_date 显式确认，非提交时刻；invoice_date 可 null，不猜今天或 PO Date。
- Invoice 非空优先，否则用 DO，选择结果进入任务/hash。两者均空可草稿，不可释放任务。
- 零收可草稿；整单无正数实收不能提交/批准。零数量来源不建空任务。
- 来源只能原始 standard PO 行，状态 confirmed/exported/combined；拒绝未定来源、pending_push/combining/draft/cancelled 和 combined 合成行。
- 同事件同一原始来源行不能重复分配；item/UOM/price/ordered 与真实 PO 一致。批准锁来源行并重新检查所有批准/在途累计，避免两连接同时超收。
- 超收、累计超余额、无来源 extra 必须授权审查及 review_note；相同 Invoice/DO 标疑似重复，不直接禁止合法分批。
- 无来源正数 extra 审查后仍不能静默丢任务：release 返回 GR_EXTRA_ASSIGNMENT_REQUIRED，保持阻塞、不建任务。该自动分配尚未实现。

动作与实际响应：
- session {}：返回 user_id/roles/is_admin/active/can。
- receipt_list {status?,limit<=200?,po_id?}：事件摘要数组；当前有上限，不是无上限全量接口。
- receipt_get {id}：事件、lines/sources、tasks、missing_mappings、warnings/exceptions、review_required。
- receipt_save：草稿及当前版本修改；已批准不可静默改原业务；已释放/已有任务不能编辑。
- receipt_submit {id,revision}：创建人 draft -> submitted。
- receipt_approve {id,revision,allow_exceptions,review_note}：可信角色一步批准正常草稿或批准 submitted，写审批信息后重算完整 hash。
- receipt_release {id}：缺映射返回 {event:waiting_mapping,tasks:[],missing_mappings:[...]}；成功返回 {event,tasks,missing_mappings:[]}。按每个正数来源原始 PO 一个任务；重复释放不重建。已释放后重新批准/提交只返回现状，不改 hash/revision/审批记录。
- mapping_set {po_header_id,irs_po_no,evidence}：可信角色登记核实映射。UI 要证据引用、方法、明确确认。不能把搜索无结果当不存在后重建 PO。

事件流：draft -> submitted（可信批准人可正常草稿一步批准）-> approved -> waiting_mapping/released -> in_progress -> saved_unverified -> verified；异常 needs_review。已释放异常不能自动重新批准再 Save。

## 旧 PO 与合并动作

- po_get {id}：完整表头及 decimal-string 明细、source_refs、批准快照，避免先转 JSON number 丢精度。
- po_save {id?,request_id,supplier_code,supplier_name,notes,created_by,lines}：事务、notes 落库、稳定行 UUID；已引用行的业务字段/供应商不许改，引用行不许删。冻结表头不可普通修改。
- po_push {id,request_id,po_revision?}：Preview 硬拒。public prepared CAS/outbox 不等于已修复运行中旧推送器的全部投递幂等。
- combine_create {request_id,source_ids,website_po_date,created_by,lines}：>=2 张同供应商 standard+confirmed+frozen=false；锁来源、检查占用，全部原始行恰好覆盖一次，每 ref qty 等于真实原订购，商品/UOM/price 精确；已有收货引用来源不再合并。
- combine_submit {id,checked_by,delivery_order_no?}：不伪造旧表头 receipt_event_id/received_at，新 Receipt 独立建立。
- combine_approve {id}：可信角色、v2 摘要冻结、来源状态必须全更新。
- combine_cancel {id}：只取消未批准合并，恢复来源并留痕。

## 实际 GR 任务 payload

```
{
 "task":{"id":"<task UUID>","type":"GOODS_RECEIVE","schema":"tj.gr.v1",
         "environment":"preview","mock_only":true,"event_revision":1,
         "po_header_id":"<UUID>","po_id":"<display PO>","irs_po_no":"<mapped PO>"},
 "mapping":{"po_header_id":"<UUID>","po_id":"<display PO>",
            "irs_po_no":"<mapped PO>","irs_invoice_no":"<invoice else DO>",
            "evidence_sha256":"<hash>"},
 "event_payload_sha256":"<full event hash>",
 "approved_event_snapshot":{"id":"<receipt UUID>","revision":1,
    "supplier_code":"<text>","invoice_no":"<text or null>","delivery_order_no":null,
    "receive_date":"YYYY-MM-DD","invoice_date":null,"checked_by":"<label>",
    "approved_by":"<trusted UUID>","approved_at":"<UTC>",
    "lines":["<all event lines and complete sources>"]},
 "scope":{"po_header_id":"<UUID>","po_id":"<display PO>",
          "lines":["<this PO allocations: line_id,ordered/accepted,price,note,sources>"]},
 "source_refs":["<complete original PO/line display and UUID references for this task>"]
}
```

任务/outbox 另存 payload_sha256。完整事件 hash 不复用旧合并 source_sha256。SQL event_kv/event_canonical 与 JS eventKeyValues 对齐；任务用 SQL tj_gr_task_canonical(jsonb) 与 JS canonicalTaskPayloadFromPayload，键按字节序、文本转义、十进制归一、UTC 秒时间统一。任务文件自带完整批准快照，可离线重算，hash覆盖供商/单据/日期/全部行及来源/审批/选定IRSInvoice/任务范围和映射。

scripts/gr-mock-dispatcher.mjs：只接受 preview/mock/type/schema 正确、双 hash 自复算和来源覆盖完整的 outbox；只写允许 root 内的本地模拟目录；拒 Windows 路径/Bridge/HTTP 出队线索。不是数据库常驻 outbox worker，也不是已部署 Windows dispatcher。旧 PO Runner 不能消费 GR JSON。

## 受认证执行回执

同一真实 HTTP RPC：p_action=task_claim 或 task_result，不虚构 /api/grn。

claim 输入 {task_id,executor_id}：原子领取、绑定身份、lease；保存已尝试或保存未核验超时进入 needs_review，禁止重领自动重做。

result 输入：
```
{
 "task_id":"<UUID>","receipt_event_id":"<UUID>","payload_sha256":"<task hash>",
 "callback_id":"<stable callback UUID>","event_type":"verified",
 "evidence":{
  "bridge_ok":true,"irs_po_no":"<mapped PO>","irs_grn_no":"<GRN>",
  "irs_invoice_no":"<selected invoice/DO>","supplier_code":"<supplier>",
  "invoice_no":"<value or null>","delivery_order_no":null,
  "receive_date":"YYYY-MM-DD","invoice_date":null,"saved_at":"<ISO timestamp>",
  "evidence_ref":"<protected readback reference>",
  "lines":[{"line_id":"<receipt-line UUID>","line_no":1,"item_code":"00001",
    "uom":"UNIT","qty":"2","unit_price":"2.5",
    "source_allocations":[{"po_line_id":"<original UUID>","accepted_qty":"2"}]}]
 }
}
```

状态：ready -> claimed -> save_attempted -> saved_unverified -> verified；旁路 failed_unsaved/needs_review。Save 后未回读不能 verified；verified 是终态，不可旧回执降级。证据要求 GRN、引用、保存时间、供应商/IRS PO/选定Invoice、日期及完整行/来源精确匹配；Invoice Date 可空但不能猜值。任一拆分任务未通过，事件不能全部通过。

同 callback ID 同内容幂等；同ID不同内容、乱序、错hash等拒绝并留审计。需要提交拒绝审计时返回 HTTP200 + rejected:true/code，调用者必须检查，不能只看200。其它权限/校验可返回PostgREST非2xx。

## 迁移、验收、回退与剩余阻塞

仅应用20261113_gr_unified_preview.sql，读回函数/表/RLS/FK及权限，再跑真实Supabase事务回滚SQL及Auth REST两连接测试。public prepared 未应用；不得撤 service_role public/DYT 权限。旧公开写权限仍为生产上线阻塞。

回退先回退Preview前端、保留已批准/执行证据。不可为了旧Preview无登录可用而重开anon写，不可DROP SCHEMA CASCADE。public未来应用/回退均需独立授权。

未完成：无来源extra执行分配；保存不确定后的完整人工修订/作废恢复UI；真实Windows传输worker/Bridge权限加固/PAD保存后真回读；生产员工制度与public旧匿名写/旧PO投递不确定窗口。当前安全阻塞，不自动重发。本地模拟verified不是Windows真实verified，更不是已有GN26006923回调成功。
