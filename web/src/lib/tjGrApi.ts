// 统一收货 service：唯一允许调用 tj_gr_api 的地方（页面/组件不直接拼 RPC）。
// 返回直接 JSON；每个写动作都读回 event 并校验关键字段，避免「界面成功、库里没动」。
import { callGrApi } from './grRpc'
import { normalizeRoles } from './core/gr-form.js'
import type { ReceiptSavePayload } from './core/gr-form.js'
import type { GrReceiptEvent, GrRole, GrSessionInfo, GrTask } from '@/types/tjGr'

function fail(action: string, detail: string): never {
  throw new Error(`${action} 返回格式异常：${detail}`)
}

function asEvent(res: unknown, action: string): GrReceiptEvent {
  const ev = (res as { event?: GrReceiptEvent })?.event ?? (res as GrReceiptEvent)
  if (!ev || typeof ev !== 'object') fail(action, '缺少 event 对象')
  if (typeof ev.id !== 'string' || !ev.id) fail(action, 'event 缺少 id')
  if (typeof ev.status !== 'string' || !ev.status) fail(action, 'event 缺少 status')
  return ev
}

/** 读登录后的角色（staff / approver / executor / admin） */
export async function getSessionInfo(): Promise<GrSessionInfo> {
  const res = await callGrApi<GrSessionInfo>('session')
  if (!res || typeof res !== 'object' || !Array.isArray(res.roles)) {
    fail('session', '缺少 roles 数组')
  }
  return {
    roles: normalizeRoles(res.roles) as GrRole[],
    email: res.email ?? null,
    user_id: res.user_id ?? null,
  }
}

/** 收货事件列表（receipt_list → event 数组） */
export async function listReceipts(input: { po_id?: string } = {}): Promise<GrReceiptEvent[]> {
  const data: Record<string, unknown> = {}
  if (input.po_id) data.po_id = input.po_id
  const res = await callGrApi<GrReceiptEvent[]>('receipt_list', data)
  if (!Array.isArray(res)) fail('receipt_list', '期望 event 数组')
  return res.map((ev) => asEvent(ev, 'receipt_list'))
}

/** 事件详情（receipt_get {id} → event 带 lines / tasks） */
export async function getReceipt(id: string): Promise<GrReceiptEvent> {
  const res = await callGrApi<GrReceiptEvent>('receipt_get', { id })
  const ev = asEvent(res, 'receipt_get')
  if (ev.lines !== undefined && !Array.isArray(ev.lines)) fail('receipt_get', 'lines 不是数组')
  if (ev.tasks !== undefined && !Array.isArray(ev.tasks)) fail('receipt_get', 'tasks 不是数组')
  return ev
}

/**
 * 保存草稿/更新（receipt_save）。
 * payload 由 buildReceiptSavePayload 生成：decimal string + 完整来源 UUID，不做 Number 化。
 */
export async function saveReceipt(payload: ReceiptSavePayload): Promise<GrReceiptEvent> {
  return asEvent(await callGrApi('receipt_save', { ...payload }), 'receipt_save')
}

/** 提交（receipt_submit {id, revision}）：revision 必须是服务端当前版本 */
export async function submitReceipt(input: { id: string; revision: number }): Promise<GrReceiptEvent> {
  const ev = asEvent(await callGrApi('receipt_submit', { id: input.id, revision: input.revision }), 'receipt_submit')
  if (ev.revision === undefined || ev.revision === null) {
    // 服务端必须返回新版本，否则下一次提交无法防并发
    fail('receipt_submit', 'event 缺少 revision')
  }
  return ev
}

/** 审批（receipt_approve {id, revision, allow_exceptions, review_note}） */
export async function approveReceipt(input: {
  id: string
  revision: number
  allow_exceptions: boolean
  review_note: string
}): Promise<GrReceiptEvent> {
  return asEvent(
    await callGrApi('receipt_approve', {
      id: input.id,
      revision: input.revision,
      allow_exceptions: input.allow_exceptions,
      review_note: input.review_note,
    }),
    'receipt_approve',
  )
}

/** 放行（receipt_release {id}）：{event, tasks, missing_mappings}；waiting_mapping 不是错误 */
export async function releaseReceipt(input: {
  id: string
}): Promise<{ event: GrReceiptEvent; tasks: GrTask[]; missing_mappings: string[] }> {
  const res = await callGrApi<{
    event?: GrReceiptEvent
    tasks?: GrTask[]
    missing_mappings?: string[]
  }>('receipt_release', { id: input.id })
  const event = asEvent(res, 'receipt_release')
  const tasks = Array.isArray(res?.tasks) ? res.tasks : Array.isArray(event.tasks) ? event.tasks : []
  const missing = Array.isArray(res?.missing_mappings)
    ? res.missing_mappings
    : Array.isArray(event.missing_mappings)
      ? event.missing_mappings
      : []
  return { event, tasks, missing_mappings: missing }
}

// ---------------------------------------------------------------------------
// PO / 映射 / 合并（Preview 旧 PO 修复路径）
// ---------------------------------------------------------------------------

export interface PoSaveLineInput {
  id?: string | null
  line_no: number
  item_code: string
  description: string
  uom: string | null
  qty: string
  unit_price: string
}

export interface PoSaveInput {
  id?: string | null
  request_id: string
  supplier_code: string
  supplier_name: string
  notes: string | null
  created_by: string
  lines: PoSaveLineInput[]
}

/** po_save：事务内保存表头+明细，稳定行 id（不删行重插），保留原 PO id */
export async function poSave(input: PoSaveInput): Promise<unknown> {
  return callGrApi('po_save', { ...input })
}

/**
 * po_get {id}：Preview 读 PO 的唯一入口（不直读旧表）。
 * 返回完整 header + decimal string 明细；结构校验在 tjPoApi.getPo 内完成。
 */
export async function poGet(id: string): Promise<unknown> {
  return callGrApi('po_get', { id })
}

/** po_push：Preview 禁止（服务端同样应拒绝）；保留给未来生产受控路径 */
export async function poPush(input: { id: string; request_id: string }): Promise<unknown> {
  return callGrApi('po_push', { id: input.id, request_id: input.request_id })
}

/** mapping_set：登记 IRS PO 编号 + 证据（无证据不得当已映射） */
export async function setPoMapping(input: {
  po_header_id: string
  irs_po_no: string
  evidence: Record<string, unknown>
}): Promise<unknown> {
  return callGrApi('mapping_set', { ...input })
}

export interface CombineLineInputDto {
  item_code: string
  description: string
  uom: string | null
  qty: number
  unit_price: number
  original_qty: number
  accepted_qty: number
  note: string | null
  source_refs: Array<{
    po_id: string
    po_number: string
    line_id: string
    qty: number | string
  }>
}

export async function combineCreate(input: {
  request_id: string
  source_ids: string[]
  website_po_date: string
  created_by: string
  lines: CombineLineInputDto[]
}): Promise<unknown> {
  return callGrApi('combine_create', { ...input })
}

export async function combineSubmit(input: {
  id: string
  checked_by: string
  delivery_order_no?: string | null
}): Promise<unknown> {
  return callGrApi('combine_submit', {
    id: input.id,
    checked_by: input.checked_by,
    delivery_order_no: input.delivery_order_no ?? null,
  })
}

export async function combineApprove(input: { id: string; approved_by: string }): Promise<unknown> {
  return callGrApi('combine_approve', { id: input.id, approved_by: input.approved_by })
}

export async function combineCancel(input: { id: string }): Promise<unknown> {
  return callGrApi('combine_cancel', { id: input.id })
}
