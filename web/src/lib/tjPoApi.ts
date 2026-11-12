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
import { ADD_ITEM_WRITES_ENABLED } from './featureFlags'
import {
  approveCombinedPoFlow,
  submitCombinedForApprovalFlow,
} from './core/approve-flow.js'
import { formatWebsitePoDate } from './core/po-lines.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 独立 client，不套用 DYT 的 Database 泛型（tj_* 表不在其中）
// VITE_SUPABASE_SCHEMA 仅 Preview 隔离环境设置（=tj_preview）；生产不设则走 public。
const DB_SCHEMA = import.meta.env.VITE_SUPABASE_SCHEMA || 'public'
const db = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: DB_SCHEMA },
})

/** 预览隔离环境（tj_preview）：禁止任何推送动作，推送只允许生产 public 发起 */
export const IS_PREVIEW_SCHEMA = DB_SCHEMA !== 'public'

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

/** 请求 VPS 推送到目标电脑：status confirmed -> pending_push（VPS 推送器轮询后生成 Excel 经桥写入目标机）
 *
 * 上线前冻结口径（与推送器 scripts/lib/po-push-core.mjs 同源规则）：
 *   * 合并单（po_type=combined）永久拒绝，不看 frozen/status。
 *   * 已并入某合并单的来源单永久拒绝——按来源关系判定，状态被改回 confirmed 也不能绕过。
 *   * 普通 standard 单保持原有 queue/bridge 路径。
 */
export async function requestPush(id: string): Promise<void> {
  if (IS_PREVIEW_SCHEMA) {
    throw new Error('预览环境（tj_preview）禁止推送：推送只允许在生产 public 环境发起')
  }
  const { data: hdr, error: he } = await db
    .from('tj_po_headers')
    .select('po_id, po_type, status, frozen')
    .eq('id', id)
    .single()
  if (he) throw he
  if (hdr?.po_type === 'combined') {
    throw new Error('合并单永久冻结推送（po_type=combined），只能在内部核对/导出 Excel')
  }
  // 关系拦截：该单是否被任一合并单引用为来源单
  const { data: owners, error: ce } = await db
    .from('tj_po_headers')
    .select('po_id')
    .eq('po_type', 'combined')
    .contains('source_po_ids', [hdr?.po_id])
    .limit(5)
  if (ce) throw ce
  if (owners && owners.length > 0) {
    const list = owners.map((o: { po_id: string }) => o.po_id).join(', ')
    throw new Error(`该采购单已并入合并单 ${list}，不能单独推送`)
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

/** 批量把来源 PO 置为指定状态（combining / combined / 恢复 confirmed）；返回实际更新行数 */
async function setSourcePosStatus(
  poNumbers: string[],
  status: string,
  onlyFrom?: string[]
): Promise<{ updated: number }> {
  if (!poNumbers.length) return { updated: 0 }
  let q = db
    .from('tj_po_headers')
    .update({ status, updated_at: new Date().toISOString() })
    .in('po_id', poNumbers)
  if (onlyFrom?.length) q = q.in('status', onlyFrom)
  const { data, error } = await q.select('po_id')
  if (error) throw error
  return { updated: (data ?? []).length }
}

/** 数据库是否已有 website_po_date 列（迁移未应用时为 false；缓存结果，避免每次写库都探测） */
let websitePoDateColumnSupported: boolean | null = null
export async function probeWebsitePoDateColumn(): Promise<boolean> {
  if (websitePoDateColumnSupported !== null) return websitePoDateColumnSupported
  const { error } = await db.from('tj_po_headers').select('website_po_date').limit(1)
  websitePoDateColumnSupported = !error
  return websitePoDateColumnSupported
}

/** 创建合并单：header po_type=combined + status=draft，明细带来源追溯；来源 PO 置 combining 锁定
 *
 * website_po_date 为开单/核对人显式选择的业务日期（yyyy-MM-dd），提交审批必需。
 * 日期缺失、格式非法、或数据库尚未启用该列时一律 fail closed 抛错——绝不静默跳过日期继续建单，
 * 也绝不回退成 created_at / received_at / approved_at 或默认当天。
 */
export async function createCombinedPo(
  supplier: Supplier,
  sourceHeaders: PoHeader[],
  lines: CombinedLineInput[],
  createdBy: string,
  websitePoDate?: string | null
): Promise<PoHeader> {
  // 先做纯校验（格式非法直接抛出，不触碰数据库）
  const date = formatWebsitePoDate(websitePoDate)
  if (!date) {
    throw new Error(
      'Website PO Date 必填：必须由开单/核对人显式选择业务日期后才能提交审批；' +
        '系统不默认当天，也不用创建/收货/审批时间代替。'
    )
  }
  // 迁移未应用时不能保存日期：直接阻止合并，不允许"跳过日期继续审批"
  if (!(await probeWebsitePoDateColumn())) {
    throw new Error(
      '数据库未启用 website_po_date 列（迁移待应用）：无法保存 Website PO Date，合并已阻止。' +
        '请先由管理员应用迁移，不能无日期继续提交审批。'
    )
  }

  const sourcePoNumbers = sourceHeaders.map((p) => p.po_id)
  const row: Record<string, unknown> = {
    supplier_code: supplier.code,
    supplier_name: supplier.name,
    status: 'draft',
    po_type: 'combined',
    source_po_ids: sourcePoNumbers,
    created_by: createdBy,
    website_po_date: date,
  }

  const { data: header, error: he } = await db
    .from('tj_po_headers')
    .insert(row)
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

/**
 * 合并单提交/批准的真实 IO（全部条件更新，命中 0 行即失败）。
 *
 * PostgREST 里 `update ... where` 更新 0 行不是错误，所以必须
 * `.select().single()` 读回确认；否则会出现「界面已提交/已批准、库里没动」的假成功。
 */
const combinedApproveIo = {
  async readHeader(id: string): Promise<PoHeader> {
    const { data, error } = await db.from('tj_po_headers').select('*').eq('id', id).single()
    if (error) throw error
    return data as PoHeader
  },
  async readLines(id: string): Promise<PoLine[]> {
    const { data, error } = await db
      .from('tj_po_lines')
      .select('*')
      .eq('po_header_id', id)
      .order('line_no')
    if (error) throw error
    return (data ?? []) as PoLine[]
  },
  async updateHeaderConditional({
    id,
    expectStatus,
    expectFrozen,
    patch,
  }: {
    id: string
    expectStatus: string
    expectFrozen: boolean
    patch: Record<string, unknown>
  }): Promise<PoHeader | null> {
    const { data, error } = await db
      .from('tj_po_headers')
      .update(patch)
      .eq('id', id)
      .eq('status', expectStatus)
      .eq('frozen', expectFrozen)
      .select('*')
      .single()
    if (error) {
      // PGRST116：条件不匹配、0 行受影响 —— 由编排层判定为失败（绝不当作成功）
      if ((error as { code?: string }).code === 'PGRST116') return null
      if (/approval_snapshot_version/.test(error.message ?? '')) {
        throw new Error(
          '数据库未启用 approval_snapshot_version 列（迁移待应用）：不能写入 v2 批准快照，批准已阻止。'
        )
      }
      throw error
    }
    return data as PoHeader
  },
  updateSourceStatuses({
    poNumbers,
    status,
    onlyFrom,
  }: {
    poNumbers: string[]
    status: string
    onlyFrom: string[]
  }): Promise<{ updated: number }> {
    return setSourcePosStatus(poNumbers, status, onlyFrom)
  },
}

/** 前台确认完成，提交审批：draft -> pending_approval，记录核对人、送货单号、收货事件 ID
 *
 * 日期双校验 1/2：提交前从数据库读回 website_po_date（不信任调用方传参），
 * 缺失/非法直接拒绝，绝不允许"跳过日期继续审批"。
 * 条件更新 status=draft 且 frozen=false，命中 0 行直接失败（不假成功）。
 */
export async function submitCombinedForApproval(
  id: string,
  checkedBy: string,
  deliveryOrderNo?: string
): Promise<void> {
  await submitCombinedForApprovalFlow({
    io: combinedApproveIo,
    id,
    checkedBy,
    deliveryOrderNo: deliveryOrderNo ?? null,
  })
}

/** 审批人批准并冻结：pending_approval -> confirmed(frozen=true)；来源 PO 置 combined
 *
 * 批准摘要（v2）由 DB 读回的 header + lines 计算 —— 不接受调用方 hash。
 * 日期双校验 2/2：批准前再次从数据库读回 website_po_date 并校验。
 * 流程：条件更新成功 → 读回重算校验 → 通过后才推进来源单状态；
 * 读回失败/摘要不一致/来源单 0 行一律报错，绝不当成功。
 */
export async function approveCombinedPo(id: string, approvedBy: string): Promise<void> {
  await approveCombinedPoFlow({ io: combinedApproveIo, id, approvedBy })
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

/** Add New Item 写操作总闸：功能停用期间 API 直接拒绝，避免产生半成品申请 */
function assertAddItemWritable(action: string): void {
  if (!ADD_ITEM_WRITES_ENABLED) {
    throw new Error(
      `Add New Item 已停用：${action} 被拒绝（IRS Item Master 字段未验收，写入通道关闭）`
    )
  }
}

export async function createItemRequest(input: ItemRequestInput): Promise<ItemRequest> {
  assertAddItemWritable('新建商品申请')
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
  assertAddItemWritable('批准商品申请')
  const { error } = await db
    .from('tj_item_requests')
    .update({ status: 'approved', approved_by: approvedBy, approved_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function rejectItemRequest(id: string): Promise<void> {
  assertAddItemWritable('拒绝商品申请')
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
  assertAddItemWritable('回写商品申请状态')
  const { error } = await db
    .from('tj_item_requests')
    .update({ status, erp_status: erpStatus, erp_result: erpResult ?? null })
    .eq('id', id)
  if (error) throw error
}
