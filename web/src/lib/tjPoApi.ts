// TJ PO 系统数据访问层：独立 Supabase client（内部工具，匿名访问，RLS 已放行 anon）
import { createClient } from '@supabase/supabase-js'
import type { Item, PoExportRecord, PoHeader, PoLine, PoWithLines, Supplier } from '@/types/tjPo'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 独立 client，不套用 DYT 的 Database 泛型（tj_* 表不在其中）
const db = createClient(supabaseUrl, supabaseAnonKey)

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
  // 分词模糊匹配：每个词都要命中（code 或 description 包含），
  // 支持「np 1001 weatherbond」这种缺中间尺寸词的情况（原来整串匹配会搜不到）
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
  return (data ?? []).map((d: any) => ({
    id: d.id,
    po_id: d.po_id,
    supplier_code: d.supplier_code,
    supplier_name: d.supplier_name,
    status: d.status,
    notes: d.notes,
    created_by: d.created_by,
    created_at: d.created_at,
    updated_at: d.updated_at,
    line_count: d.tj_po_lines?.[0]?.count ?? 0,
  }))
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

export async function deletePo(id: string): Promise<void> {
  const { error } = await db.from('tj_po_headers').delete().eq('id', id).limit(1)
  if (error) throw error
}

export async function markExported(id: string, poId: string, filename: string): Promise<void> {
  // 记录导出历史 + 更新状态为 exported
  await db.from('tj_po_exports').insert({ po_header_id: id, po_id: poId, filename })
  await db.from('tj_po_headers').update({ status: 'exported', updated_at: new Date().toISOString() }).eq('id', id).limit(1)
}

/** 请求 VPS 推送到目标电脑：状态 confirmed -> pending_push（VPS 推送器轮询后生成 Excel 经桥写入目标机） */
export async function requestPush(id: string): Promise<void> {
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
