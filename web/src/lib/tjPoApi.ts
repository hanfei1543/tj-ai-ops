// TJ PO 系统数据访问层：独立 Supabase client（内部工具，匿名访问，RLS 已放行 anon）
import { createClient } from '@supabase/supabase-js'
import type {
  CombinedLineInput,
  Item,
  ItemRequest,
  PoExportRecord,
  PoHeader,
  PoLine,
  PoWithLines,
  Supplier,
} from '@/types/tjPo'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 独立 client，不套用 DYT 的 Database 泛型（tj_* 表不在其中）
// VITE_SUPABASE_SCHEMA 仅 Preview 隔离环境设置（=tj_preview）；生产不设则走 public。
const db = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: import.meta.env.VITE_SUPABASE_SCHEMA || 'public' },
})

/** 去掉 ilike 通配符/转义字符，防止用户输入破坏查询 */
function clean(q: string): string {
  return q.replace(/[%_\\]/g, '').trim()
}

export async function searchSuppliers(query: string, limit = 20): Promise<Supplier[]> {
  const q = clean(query)
  if (!q) return []
  const { data, error } = await db
    .from('tj_suppliers')
    .select('id, code, name')
    .or(`code.ilike.${q}%,name.ilike.%${q}%`)
    .order('code')
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Supplier[]
}

export async function searchItems(query: string, limit = 20): Promise<Item[]> {
  const q = clean(query)
  if (!q) return []
  // 分词模糊匹配：每个词都要命中（code 或 description 包含）
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[%_\\()*,.']/g, ''))
    .filter(Boolean)
  if (tokens.length === 0) return []
  const filter = `and(${tokens.map((t) => `or(code.ilike.%${t}%,description.ilike.%${t}%)`).join(',')})`
  const { data, error } = await db
    .from('tj_items')
    .select('id, code, description, uom, cost, selling_price')
    .or(filter)
    .order('code')
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Item[]
}

export async function getItemByCode(code: string): Promise<Item | null> {
  const { data, error } = await db
    .from('tj_items')
    .select('id, code, description, uom, cost, selling_price')
    .eq('code', code)
    .limit(1)
  if (error) throw error
  return data && data.length ? (data[0] as Item) : null
}

export async function listPos(): Promise<PoHeader[]> {
  const { data, error } = await db
    .from('tj_po_headers')
    .select('*, tj_po_lines(count)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return (data ?? []).map((d: any) => {
    const { tj_po_lines, ...rest } = d
    return { ...rest, line_count: tj_po_lines?.[0]?.count ?? 0 } as PoHeader
  })
}

export async function getPo(id: string): Promise<PoWithLines> {
  const { data: header, error: he } = await db
    .from('tj_po_headers')
    .select('*')
    .eq('id', id)
    .single()
  if (he) throw he

  const { data: lines, error: le } = await db
    .from('tj_po_lines')
    .select('*')
    .eq('po_header_id', id)
    .order('line_no')
  if (le) throw le

  return { ...(header as PoHeader), lines: (lines ?? []) as PoLine[] }
}

/** 按 uuid id 批量取 PO（合并画面用） */
export async function getPosByIds(ids: string[]): Promise<PoWithLines[]> {
  const result: PoWithLines[] = []
  for (const id of ids) {
    const po = await getPo(id)
    result.push(po)
  }
  return result
}

/** 新建 PO：写表头 + 明细（单事务由两次写入组成；MVP 接受，失败靠前端重试） */
export async function createPo(
  supplier: Supplier,
  lines: PoLine[],
  createdBy: string
): Promise<PoHeader> {
  const { data: header, error: he } = await db
    .from('tj_po_headers')
    .insert({
      supplier_code: supplier.code,
      supplier_name: supplier.name,
      status: 'confirmed',
      po_type: 'standard',
      created_by: createdBy,
    })
    .select()
    .single()
  if (he) throw he

  const poHeaderId = (header as PoHeader).id
  const rows = lines.map((l, i) => ({
    po_header_id: poHeaderId,
    line_no: i + 1,
    item_code: l.item_code,
    description: l.description,
    uom: l.uom,
    qty: l.qty,
    unit_price: l.unit_price,
  }))
  const { error: le } = await db.from('tj_po_lines').insert(rows)
  if (le) throw le

  return header as PoHeader
}

/** 更新 PO：替换明细（删旧行 + 插新行） */
export async function updatePo(
  id: string,
  supplier: Supplier,
  lines: PoLine[]
): Promise<PoHeader> {
  const { error: he } = await db
    .from('tj_po_headers')
    .update({
      supplier_code: supplier.code,
      supplier_name: supplier.name,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (he) throw he

  const { error: del } = await db.from('tj_po_lines').delete().eq('po_header_id', id)
  if (del) throw del

  const rows = lines.map((l, i) => ({
    po_header_id: id,
    line_no: i + 1,
    item_code: l.item_code,
    description: l.description,
    uom: l.uom,
    qty: l.qty,
    unit_price: l.unit_price,
  }))
  const { error: le } = await db.from('tj_po_lines').insert(rows)
  if (le) throw le

  const { data, error } = await db.from('tj_po_headers').select('*').eq('id', id).single()
  if (error) throw error
  return data as PoHeader
}

/** 拖曳/上移下移后立即持久化顺序：按给定 line id 顺序重写 line_no（原地更新，不删行） */
export async function reorderLines(poHeaderId: string, orderedLineIds: string[]): Promise<void> {
  const updates = orderedLineIds.map((lineId, i) =>
    db
      .from('tj_po_lines')
      .update({ line_no: i + 1 })
      .eq('id', lineId)
      .eq('po_header_id', poHeaderId)
  )
  const results = await Promise.all(updates)
  for (const r of results) {
    if (r.error) throw r.error
  }
}

export async function deletePo(id: string): Promise<void> {
  const { error } = await db.from('tj_po_headers').delete().eq('id', id).limit(1)
  if (error) throw error
}

export async function markExported(id: string, poId: string, filename: string): Promise<void> {
  await db.from('tj_po_exports').insert({ po_header_id: id, po_id: poId, filename })
  await db
    .from('tj_po_headers')
    .update({ status: 'exported', updated_at: new Date().toISOString() })
    .eq('id', id)
    .limit(1)
}

/** 请求 VPS 推送到目标电脑：status confirmed -> pending_push（VPS 推送器轮询后生成 Excel 经桥写入目标机） */
export async function requestPush(id: string): Promise<void> {
  // 合并单必须已批准冻结才能推送；普通单保持现有流程
  const { data: hdr, error: he } = await db
    .from('tj_po_headers')
    .select('po_type, frozen')
    .eq('id', id)
    .single()
  if (he) throw he
  if (hdr?.po_type === 'combined' && !hdr?.frozen) {
    throw new Error('合并单尚未批准冻结，不能推送')
  }
  const { error } = await db
    .from('tj_po_headers')
    .update({ status: 'pending_push', updated_at: new Date().toISOString() })
    .eq('id', id)
    .limit(1)
  if (error) throw error
}

export async function listExports(poId: string): Promise<PoExportRecord[]> {
  const { data, error } = await db
    .from('tj_po_exports')
    .select('*')
    .eq('po_id', poId)
    .order('exported_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return (data ?? []) as PoExportRecord[]
}

// ---------------------------------------------------------------------------
// Combined PO（合并采购单）
// ---------------------------------------------------------------------------

/** 批量把来源 PO 置为指定状态（combining / combined / 恢复 confirmed） */
async function setSourcePosStatus(poNumbers: string[], status: string, onlyFrom?: string[]): Promise<void> {
  if (!poNumbers.length) return
  let q = db.from('tj_po_headers').update({ status, updated_at: new Date().toISOString() }).in('po_id', poNumbers)
  if (onlyFrom?.length) q = q.in('status', onlyFrom)
  const { error } = await q
  if (error) throw error
}

/** 创建合并单：header po_type=combined + status=draft，明细带来源追溯；来源 PO 置 combining 锁定 */
export async function createCombinedPo(
  supplier: Supplier,
  sourceHeaders: PoHeader[],
  lines: CombinedLineInput[],
  createdBy: string
): Promise<PoHeader> {
  const sourcePoNumbers = sourceHeaders.map((p) => p.po_id)
  const { data: header, error: he } = await db
    .from('tj_po_headers')
    .insert({
      supplier_code: supplier.code,
      supplier_name: supplier.name,
      status: 'draft',
      po_type: 'combined',
      source_po_ids: sourcePoNumbers,
      created_by: createdBy,
    })
    .select()
    .single()
  if (he) throw he

  const poHeaderId = (header as PoHeader).id
  const rows = lines.map((l, i) => ({
    po_header_id: poHeaderId,
    line_no: i + 1,
    item_code: l.item_code,
    description: l.description,
    uom: l.uom,
    qty: l.qty,
    unit_price: l.unit_price,
    original_qty: l.original_qty,
    accepted_qty: l.accepted_qty,
    note: l.note ?? null,
    source_refs: l.source_refs,
    source_po_id: l.source_refs?.[0]?.po_id ?? null,
    source_line_id: l.source_refs?.[0]?.line_id ?? null,
  }))
  const { error: le } = await db.from('tj_po_lines').insert(rows)
  if (le) throw le

  await setSourcePosStatus(sourcePoNumbers, 'combining', ['confirmed'])
  return header as PoHeader
}

/** 更新合并单明细（draft 阶段可反复调整顺序/数量；删旧行重插，来源追溯自包含） */
export async function updateCombinedPoLines(id: string, lines: CombinedLineInput[]): Promise<void> {
  const { error: del } = await db.from('tj_po_lines').delete().eq('po_header_id', id)
  if (del) throw del
  const rows = lines.map((l, i) => ({
    po_header_id: id,
    line_no: i + 1,
    item_code: l.item_code,
    description: l.description,
    uom: l.uom,
    qty: l.qty,
    unit_price: l.unit_price,
    original_qty: l.original_qty,
    accepted_qty: l.accepted_qty,
    note: l.note ?? null,
    source_refs: l.source_refs,
    source_po_id: l.source_refs?.[0]?.po_id ?? null,
    source_line_id: l.source_refs?.[0]?.line_id ?? null,
  }))
  const { error: le } = await db.from('tj_po_lines').insert(rows)
  if (le) throw le
}

/** 前台确认完成，提交审批：draft -> pending_approval，记录核对人、送货单号、收货事件 ID */
export async function submitCombinedForApproval(
  id: string,
  checkedBy: string,
  deliveryOrderNo?: string
): Promise<void> {
  const receiptEventId = crypto.randomUUID()
  const { error } = await db
    .from('tj_po_headers')
    .update({
      status: 'pending_approval',
      checked_by: checkedBy,
      delivery_order_no: deliveryOrderNo ?? null,
      receipt_event_id: receiptEventId,
      received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error
}

/** 审批人批准并冻结：pending_approval -> confirmed(frozen=true)；来源 PO 置 combined */
export async function approveCombinedPo(
  id: string,
  approvedBy: string,
  sourceSha256: string
): Promise<void> {
  const { error } = await db
    .from('tj_po_headers')
    .update({
      status: 'confirmed',
      frozen: true,
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      source_sha256: sourceSha256,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error

  const { data: hdr } = await db.from('tj_po_headers').select('source_po_ids').eq('id', id).single()
  await setSourcePosStatus((hdr?.source_po_ids as string[]) ?? [], 'combined', ['combining'])
}

/** 取消合并（仅未批准前）：删除合并单 + 恢复来源 PO 为 confirmed */
export async function cancelCombinedPo(id: string): Promise<void> {
  const { data: hdr, error: he } = await db
    .from('tj_po_headers')
    .select('status, frozen, source_po_ids')
    .eq('id', id)
    .single()
  if (he) throw he
  if (hdr?.status === 'confirmed' && hdr?.frozen) {
    throw new Error('已批准冻结的合并单不能取消')
  }
  await setSourcePosStatus((hdr?.source_po_ids as string[]) ?? [], 'confirmed', ['combining'])
  const { error } = await db.from('tj_po_headers').delete().eq('id', id).limit(1)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Add New Item Master 申请
// ---------------------------------------------------------------------------

export interface ItemRequestInput {
  item_code: string
  barcode?: string | null
  description: string
  uom?: string | null
  category?: string | null
  supplier_code?: string | null
  purchase_cost?: number | null
  selling_price?: number | null
  tax_rate?: number | null
  sst_info?: string | null
  created_by?: string | null
}

export async function createItemRequest(input: ItemRequestInput): Promise<ItemRequest> {
  const { data, error } = await db
    .from('tj_item_requests')
    .insert({ ...input, status: 'pending', erp_status: 'none' })
    .select()
    .single()
  if (error) throw error
  return data as ItemRequest
}

export async function listItemRequests(): Promise<ItemRequest[]> {
  const { data, error } = await db
    .from('tj_item_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return (data ?? []) as ItemRequest[]
}

/** 查重：是否已存在商品 + 是否有待处理申请 */
export async function checkItemCodeDuplicate(
  code: string
): Promise<{ in_items: boolean; pending_request: boolean }> {
  const [item, req] = await Promise.all([
    getItemByCode(code),
    db
      .from('tj_item_requests')
      .select('id')
      .eq('item_code', code)
      .in('status', ['pending', 'approved'])
      .limit(1),
  ])
  return { in_items: !!item, pending_request: !!(req.data && req.data.length) }
}

export async function approveItemRequest(id: string, approvedBy: string): Promise<void> {
  const { error } = await db
    .from('tj_item_requests')
    .update({ status: 'approved', approved_by: approvedBy, approved_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function rejectItemRequest(id: string): Promise<void> {
  const { error } = await db.from('tj_item_requests').update({ status: 'rejected' }).eq('id', id)
  if (error) throw error
}

/** 回写 ERP/IRS 建立结果：status 终态 + needs_review 标记（失败/不确定不盲目重试） */
export async function updateItemRequestStatus(
  id: string,
  status: string,
  erpStatus: string,
  erpResult?: string
): Promise<void> {
  const { error } = await db
    .from('tj_item_requests')
    .update({ status, erp_status: erpStatus, erp_result: erpResult ?? null })
    .eq('id', id)
  if (error) throw error
}
