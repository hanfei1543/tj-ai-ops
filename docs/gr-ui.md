# 统一收货 UI 与 Preview RPC 接线（task/unified-gr-ui）

本分支只改前端 UI 层与旧 PO 的 Preview 写路径，不改 DB（见 `docs/gr-contract.md`，
由 DB 分支产出）、不改 public 生产行为、不部署。

## 1. 开关与环境

| 环境 | `VITE_SUPABASE_SCHEMA` | 行为 |
|---|---|---|
| 生产 | 未设（=public） | 旧界面照常；所有「登记本次收货」硬 disabled；GR 路由显示「预览环境专用」；旧 API（含推送）保持原样 |
| 预览 | `tj_preview` | 显示收货登录/列表/表单/详情；保存 PO、合并、收货走 `tj_gr_api` RPC |

- `IS_PREVIEW_SCHEMA` 是唯一开关（`web/src/lib/supabaseClient.ts`）。业务代码没有第二套环境判断。
- RPC 统一入口：`web/src/lib/grRpc.ts` → `POST rpc/tj_gr_api {p_action, p_data}`；
  生产环境调用 `callGrApi` 直接抛错（`assertGrRpcEnabled`），不会误发到 public。
- 错误：合同 `message` 是 JSON 文本，`grRpc` 解析 `{code,message,detail}` 并翻成中文
  （`GR_AUTH_REQUIRED` / `GR_REVISION_CONFLICT` / `GR_EXCEPTION_NOT_ALLOWED` / `GR_MAPPING_REQUIRED` 等）。

## 2. 路由与文件

| 路由 | 页面 | 说明 |
|---|---|---|
| `/tj-po-system/receipts` | `ReceiptListPage` | 事件列表，刷新=从 DB 重读（不依赖本地缓存） |
| `/tj-po-system/receipts/new?po_ids=<uuid>` | `ReceiptFormPage` | 从已确认 PO（含已批准合并单）登记本次收货 |
| `/tj-po-system/receipts/:id/edit` | `ReceiptFormPage` | 草稿/needs_review 恢复编辑（沿用服务端 UUID/revision） |
| `/tj-po-system/receipts/:id` | `ReceiptDetailPage` | 事件详情、行/来源分配、任务状态、审批/放行/映射登记 |
| `/tj-po-system/combine?id=<uuid>` | `CombinePoPage` | 已有合并单按 ID 恢复/查看（冻结字段只读） |

页面外壳：`web/src/components/GrAuthGate.tsx`（生产硬禁用 → Supabase Auth 密码登录 → 身份条 + 角色）。

- **普通 PO 页面**（`/tj-po-system`、`/new`、`/:poId`、`/combine`、`/items`）在 Preview 也套
  `PreviewAuthGate`：`tj_preview` 下旧表 anon 读写已撤销，列表/保存/合并必须带真实登录身份；
  **生产 public 直接渲染 children**，普通采购页面不会被 GR gate 禁用。
- 收货页面继续用 `GrAuthGate`（生产显示「预览环境专用」）。

- `web/src/lib/grAuth.ts`：`signInWithPassword` / `signOut` / `useGrIdentity`；角色取自
  `tj_gr_api('session')`，前端不含凭据、不含 `service_role`。
- `web/src/lib/tjGrApi.ts`：唯一允许调 RPC 的 service（session / receipt_* / mapping_set /
  po_save / po_push / combine_*）。
- `web/src/lib/core/gr-form.js`：纯 JS 规则（校验、decimal 字符串、payload、草稿身份、状态/角色文案）。
  TS 侧声明在 `gr-form.d.ts`（未触碰 DB 分支拥有的 `core/receipt-*`）。

## 3. 表单（员工只填必要字段）

必填/可填：`Invoice No`（IRS 发票号）、`Delivery Order No`、**收货日期（显式选择）**、发票日期（可空）、
`备注`；`核对人` 自动来自登录，只读。行上只需 `实收数量` + 差异备注。

- **Invoice No. 与 Delivery Order No. 至少一项**即可提交/放行（可只开发票或只开送货单）；
  两项都空只能保存草稿。编号是业务文本：原样保存（不 trim、不改写前导零/大小写/空格），
  trim 只用于判空。
- 收货日期必须显式 `yyyy-MM-dd`，不用提交时间戳/当天默认值；发票日期只在显式填写时保存。
- 数量/单价全程 decimal string（`web/src/lib/core/gr-form.js` 定点 BigInt 加法），
  空白 / 负数 / `1e3` / `1,5` 一律中文报错，**绝不静默当 0**。
- 多来源行（合并单常见）：编辑每个 `source_allocations` 的实收，行实收=分配合计；
  普通单单一来源时行实收自动同步到该来源。
- 超收（`accepted > ordered`）与额外行（无来源分配）是「例外」：允许保存/提交，
  但标 `requires_exception_approval`，审批必须勾选「确认例外」且写 `review_note`。
- 零行允许 **保存草稿**，但不形成正式 GR、不能提交。
- 保存后回读服务端 `event.revision`；显示「余量以服务端为准」；`review_required` / 保存未读回
  都用中文提示，不宣称成功。
- **非首批收货**：按服务端 `receipt_list {po_id}` 判定该 PO（含合并单来源原始 PO）已有事件时，
  实收**不预填满额**（留空，必须逐行确认）；零实收就是 0，不会被静默改成全收。
- 保存遇到「会话已有草稿 / 版本冲突」时，从服务端读回真实草稿 `id/revision`（`adoptDraft`）
  后重试一次，不新建第二张草稿。

## 4. 草稿身份与防重复

`createReceiptDraftSession`（`core/gr-form.js`）：

- key = `tj_gr_draft:` + 排序后的 selected PO UUID（顺序无关），**初次保存前**就写入
  `sessionStorage`（内容含 `receipt_id` / `revision` / `status`）。
- 刷新/重开同一批未提交草稿 → 复用同一 receipt UUID + revision（不重复建单）。
- `receipt_submit` 返回非 draft 状态后立即删除绑定：同一 PO 的下一批收货必须换新 UUID，
  绝不把同一 PO 的所有分批永久绑在一个 ID 上。
- `begin('save'|'submit')` 拒第二次（防双击）；提交期间按钮 disabled。
- 从 DB 恢复的草稿（详情页「继续编辑」）用 `seed` 沿用服务端 UUID/revision。

## 5. 旧 PO / 合并修复（仅 Preview）

`web/src/lib/tjPoApi.ts`：

- `createPo/updatePo(..., notes, requestId, createdBy?)`：Preview 走 `po_save`
  - `request_id` 幂等（PoEditor 一次编辑会话一个 UUID，重试不重复建单）
  - 已保存行带原 `line.id`（事务内 upsert，不删行重插 → 行 id 稳定）
  - 返回 id 必须存在且等于原 id（`updatePo`），否则报错，不 map 丢弃原 id
  - `notes` 落库；生产旧路径不写 notes、不改写，保持原两次写入
  - **数量/单价全程 decimal string**（`core/po-input.js` → `po_save`），不在保存前 `parseFloat`；
    旧生产路径（旧表/Excel 需要 number）只在 `tjPoApi` 内显式 `legacyNumber()` 转换
  - `getPo` 在 Preview 只走 `po_get {id}`（不直读旧表），校验返回 id 与 lines 完整；
    行数量/单价按服务端 decimal string 原样保留
  - Preview 不直写 `line_no` 排序（旧表直写已撤销），顺序随下一次 `po_save` 落库
- `createCombinedPo/submit/approve/cancel`：Preview 走 `combine_create/submit/approve/cancel`；
  后端不足直接抛错，**不做多 REST 不安全回退**。Website PO Date、行序/extra/source_refs、
  v2 冻结语义保持。
- **合并来源资格 = `standard` + `confirmed` + `frozen=false`**（列表勾选与合并页校验；
  后端拒绝时原样显示 `GR_STATE`）。合并行 `source_refs` 保留全部原始 PO 行（`po_id/po_number/
  line_id/qty`，qty 原文十进制字符串）；来源缺 id/编号直接失败，不伪造来源。
- 收货表单对合并单只展开 `source_refs` 里的原始 PO 行 UUID，**绝不会**把合并单自身合成行 id
  当来源；没有 refs = 额外行（fail closed）。
- `requestPush`：Preview 仍抛错（禁发）；生产旧路径不变。
- Preview 不支持直接 `deletePo`（旧表 delete 已撤销，给出明确提示，不做假成功）。
- 列表按钮文案：`发送采购 PO 到电脑`（明确不是 GR）；空状态/合并来源判定不变。
- 员工界面不再有 GR Excel 下载入口（`downloadGrExcel` 已从 CombinePoPage 移除；
  `buildGrWorkbook/downloadGrExcel` 内部函数仍保留在 `lib/tjPoExcel.ts`）。
- 列表点击已批准的合并单 → `combine?id=` 只读查看；普通编辑器对冻结合并单禁止保存。

## 6. 状态与角色（镜像合同，权限由服务器强制）

- 收货状态中文：`draft / submitted / approved / waiting_mapping / released / in_progress /
  saved_unverified / verified / needs_review / failed_unsaved / cancelled`；未知状态显示原始码，
  不冒充成功。**不虚构 `blocked` 状态**（服务端没有该事件状态）。
- 列表/详情只用服务端真实字段：`review_required`、`warnings`、`exceptions`、`exception_count`；
  不读 `needs_review`（布尔）、`po_numbers`、`status_reason`、表头旧 `irs_po_no/irs_grn_no`。
- **IRS 实际编号只来自任务回报** `tasks[].irs_po_no / irs_grn_no`，并标注仍需人工核对过账；
  表头历史 IRS 值不是放行/过账结果。
- 任务状态（`ready/claimed/save_attempted/saved_unverified/verified/needs_review/...`）全部
  标「未推送 IRS / 未经确认 / 不是 IRS 过账」，绝不出现 IRS 成功。
- 角色能力（仅控制按钮显示）：
  - `staff/approver/admin` 可保存/提交；`approver/admin` 可批准、放行、登记映射；
  - `executor` 只做 `task_result`，本 UI **不暴露** executor 回执/模拟执行按钮。
- 「提交并放行」= save → submit → approve → release 一次完成；缺 IRS PO 映射时服务端返回
  `waiting_mapping` + `missing_mappings`，页面显示待登记映射并可调用 `mapping_set`。
  evidence 必须由审批人给出**可核查证据**（`evidence_ref`）+ **核验方式**（`method`）+
  明确勾选已核对，才写 `checked_by/checked_at`；只写「页面登记」+ 当前时间不算证据。
- 放行前置：`Invoice No` 或 `Delivery Order No` **至少一项**（不是必须 DO）。
- **不可重做**：`released_at` 非空或已生成任务（含 `needs_review`）的事件，不能再
  approve/submit/release/edit；`verified` 为终态。页面显示「人工核对，不可重做」。
- 额外行（无可核实原 PO 来源）：审批可保留，但 release 会被服务端
  `GR_EXTRA_ASSIGNMENT_REQUIRED` 阻止，页面明确提示需人工指定来源，不把漏行当作成功。

## 7. 验证

```bash
node --test tests/gr-ui.test.mjs tests/gr-ui-fixes.test.mjs   # 本轮修复回归（行为测试）
npm test                                                      # 全量 151 项
cd web && npm run build                                       # tsc -b + vite build
```

未做：真实 tj_preview 迁移/集成、浏览器截图、部署、push。主脑负责真实 DB 集成与验收。

## 8. 待主脑确认的接线点

1. `po_save` 返回形状按 `{...header}` / `{po|po_header|header|data}` 兼容；若合同实现返回其它包装
   需对齐（id 已强校验）。
2. `receipt_get` 输出行字段是 `sources`（输入是 `source_allocations`），UI 已按此映射。
3. `combine_create` 来源资格已按修复口径改为 `standard + confirmed + frozen=false`
   （旧合同写的 `frozen=true` 是错的，DB 分支同步修改）；UI 先筛选，后端拒绝时显示 `GR_STATE`。
4. 首批收货按来源行订购量初始化；已存在历史收货时实收留空必须人工确认。多来源分配需逐条
   调整，合计必须等于实收。
5. `po_get` 返回形状按 `{...header, lines}` / `{po|header|data, lines}` 兼容并强校验 id/lines；
   DB 契约落地后按实际字段最终对齐。
6. 本轮未做：真实 tj_preview 集成、浏览器截图、部署/推送；后端契约与 DB 由 fix agent 负责。
