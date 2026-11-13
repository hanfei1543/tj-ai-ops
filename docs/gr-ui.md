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

- `web/src/lib/grAuth.ts`：`signInWithPassword` / `signOut` / `useGrIdentity`；角色取自
  `tj_gr_api('session')`，前端不含凭据、不含 `service_role`。
- `web/src/lib/tjGrApi.ts`：唯一允许调 RPC 的 service（session / receipt_* / mapping_set /
  po_save / po_push / combine_*）。
- `web/src/lib/core/gr-form.js`：纯 JS 规则（校验、decimal 字符串、payload、草稿身份、状态/角色文案）。
  TS 侧声明在 `gr-form.d.ts`（未触碰 DB 分支拥有的 `core/receipt-*`）。

## 3. 表单（员工只填必要字段）

必填/可填：`Invoice No`、`Delivery Order No`、**收货日期（显式选择）**、发票日期（可空）、
`备注`；`核对人` 自动来自登录，只读。行上只需 `实收数量` + 差异备注。

- 收货日期必须显式 `yyyy-MM-dd`，不用提交时间戳/当天默认值；发票日期只在显式填写时保存。
- 数量/单价全程 decimal string（`web/src/lib/core/gr-form.js` 定点 BigInt 加法），
  空白 / 负数 / `1e3` / `1,5` 一律中文报错，**绝不静默当 0**。
- 多来源行（合并单常见）：编辑每个 `source_allocations` 的实收，行实收=分配合计；
  普通单单一来源时行实收自动同步到该来源。
- 超收（`accepted > ordered`）与额外行（无来源分配）是「例外」：允许保存/提交，
  但标 `requires_exception_approval`，审批必须勾选「确认例外」且写 `review_note`。
- 零行允许 **保存草稿**，但不形成正式 GR、不能提交。
- 保存后回读服务端 `event.revision`；显示「余量以服务端为准」；`needs_review` / 保存未读回
  都用中文提示，不宣称成功。

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
- `createCombinedPo/submit/approve/cancel`：Preview 走 `combine_create/submit/approve/cancel`；
  后端不足直接抛错，**不做多 REST 不安全回退**。Website PO Date、行序/extra/source_refs、
  v2 冻结语义保持。
- `requestPush`：Preview 仍抛错（禁发）；生产旧路径不变。
- 列表按钮文案：`发送采购 PO 到电脑`（明确不是 GR）；空状态/合并来源判定不变。
- 员工界面不再有 GR Excel 下载入口（`downloadGrExcel` 已从 CombinePoPage 移除；
  `buildGrWorkbook/downloadGrExcel` 内部函数仍保留在 `lib/tjPoExcel.ts`）。
- 列表点击已批准的合并单 → `combine?id=` 只读查看；普通编辑器对冻结合并单禁止保存。

## 6. 状态与角色（镜像合同，权限由服务器强制）

- 收货状态中文：`draft / submitted / approved / waiting_mapping / released / in_progress /
  saved_unverified / verified / needs_review / failed_unsaved / cancelled`；未知状态显示原始码，
  不冒充成功。
- 任务状态（`ready/claimed/save_attempted/saved_unverified/verified/needs_review/...`）全部
  标「未推送 IRS / 未经确认 / 不是 IRS 过账」，绝不出现 IRS 成功。
- 角色能力（仅控制按钮显示）：
  - `staff/approver/admin` 可保存/提交；`approver/admin` 可批准、放行、登记映射；
  - `executor` 只做 `task_result`，本 UI **不暴露** executor 回执/模拟执行按钮。
- 「提交并放行」= save → submit → approve → release 一次完成；缺 IRS PO 映射时服务端返回
  `waiting_mapping` + `missing_mappings`，页面显示待登记映射并可调用 `mapping_set`
  （evidence: `checked_by` + `checked_at`）。
- 放行前要求 `Delivery Order No` 非空（合同 release 前置）。

## 7. 验证

```bash
node --test tests/gr-ui.test.mjs   # 新增 21 项（先失败后实现）
npm test                           # 全量 136 项
cd web && npm run build            # tsc -b + vite build
```

未做：真实 tj_preview 迁移/集成、浏览器截图、部署、push。主脑负责真实 DB 集成与验收。

## 8. 待主脑确认的接线点

1. `po_save` 返回形状按 `{...header}` / `{po|po_header|header|data}` 兼容；若合同实现返回其它包装
   需对齐（id 已强校验）。
2. `receipt_get` 输出行字段是 `sources`（输入是 `source_allocations`），UI 已按此映射。
3. `combine_create` 合同要求来源单 `frozen=true`；现网普通单 frozen=false，UI 不预判，服务端拒绝时
   显示 `GR_STATE`。
4. 多来源分配默认按各来源行订购量初始化；员工可在表单逐条调整，合计必须等于实收。
