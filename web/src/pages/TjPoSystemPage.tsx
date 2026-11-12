import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  Loader2,
  Lock,
  Merge,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  createPo,
  deletePo,
  getPo,
  IS_PREVIEW_SCHEMA,
  listPos,
  reorderLines,
  requestPush,
  searchItems,
  searchSuppliers,
  updatePo,
} from '@/lib/tjPoApi'
import type { Item, PoHeader, PoLine, Supplier } from '@/types/tjPo'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let uid = 0
function nextKey(): string {
  uid += 1
  return `k${Date.now()}_${uid}`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`
}

/** PO 状态徽章：区分普通单 / 合并单 / 合并占用 / 已合并 */
function poStatusBadge(status: string, poType: string): { label: string; cls: string } {
  if (poType === 'combined') {
    if (status === 'pending_approval') return { label: '合并单·待审批', cls: 'bg-amber-100 text-amber-700' }
    if (status === 'exported') return { label: '合并单·已导出', cls: 'bg-emerald-100 text-emerald-700' }
    if (status === 'pending_push') return { label: '合并单·推送中', cls: 'bg-blue-100 text-blue-700' }
    return { label: '合并单', cls: 'bg-violet-100 text-violet-700' }
  }
  switch (status) {
    case 'exported':
      return { label: '已导出', cls: 'bg-emerald-100 text-emerald-700' }
    case 'pending_push':
      return { label: '推送中…', cls: 'bg-blue-100 text-blue-700' }
    case 'combining':
      return { label: '合并中', cls: 'bg-blue-100 text-blue-700' }
    case 'combined':
      return { label: '已合并', cls: 'bg-slate-200 text-slate-600' }
    case 'pending_approval':
      return { label: '待审批', cls: 'bg-amber-100 text-amber-700' }
    default:
      return { label: '未导出', cls: 'bg-amber-100 text-amber-700' }
  }
}

interface EditableLine {
  key: string
  lineId?: string // 已保存行的 uuid id（拖曳排序持久化用）
  item: Item | null
  itemQuery: string
  qty: string
  unitPrice: string
}

function emptyLine(): EditableLine {
  return { key: nextKey(), item: null, itemQuery: '', qty: '', unitPrice: '' }
}

/** 订货方（朋友五金店）署名 */
const ORDER_FROM = 'THIONG JOO (M) SDN BHD'

/** 开单人员名单（保存时选择记录谁开的单） */
const CREATED_BY_OPTIONS = ['Ms Toh', 'Ngam Cheng Jye', 'Keh Lee', 'Ms Teow', 'Ah Huat']

/** 把 PO 内容格式化成可复制的订货单（给供应商）：只写商品名 + 数量 + 单位，不写编号和单价 */
function buildCopyText(lines: EditableLine[]): string {
  const parts: string[] = [`Order (${ORDER_FROM})`, '']
  lines.forEach((l, i) => {
    if (!l.item) return
    const qty = parseFloat(l.qty) || 0
    const uom = l.item.uom ? ` ${l.item.uom}` : ''
    parts.push(`${i + 1}. ${l.item.description} - ${qty}${uom}`)
  })
  return parts.join('\n')
}

/** 复制到剪贴板（带 fallback） */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// 供应商选择器
// ---------------------------------------------------------------------------

function SupplierPicker({
  value,
  onPicked,
  autoFocus,
}: {
  value: Supplier | null
  onPicked: (s: Supplier) => void
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Supplier[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setOpen(false)
      return
    }
    if (value && q === value.name) return
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await searchSuppliers(q)
        setResults(r)
        setOpen(r.length > 0)
        setHighlight(0)
      } catch {
        /* 忽略搜索错误 */
      }
      setLoading(false)
    }, 250)
    return () => clearTimeout(t)
  }, [query, value])

  function pick(s: Supplier) {
    onPicked(s)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(results[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // 已选中：显示名字 + 清除按钮
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-800">{value.name}</div>
          <div className="text-xs text-slate-500">{value.code}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            onPicked(null as unknown as Supplier)
            inputRef.current?.focus()
          }}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-100 hover:text-slate-600"
          aria-label="更换供应商"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-100">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="搜索供应商（编号或名称）…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
        />
        {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
      </div>
      {open && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {results.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(s)
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left ${
                  i === highlight ? 'bg-emerald-50' : ''
                }`}
              >
                <span className="truncate text-sm text-slate-800">{s.name}</span>
                <span className="shrink-0 text-xs text-slate-400">{s.code}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && !loading && (
            <li className="px-4 py-3 text-sm text-slate-400">没有匹配的供应商</li>
          )}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

export default function TjPoSystemPage() {
  const { poId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  const isNew = location.pathname.endsWith('/new')

  if (poId || isNew) {
    return (
      <PoEditor
        poId={isNew ? undefined : poId}
        onBack={() => navigate(-1)}
        onSaved={() => navigate(-1)}
      />
    )
  }
  return (
    <PoList
      onCreate={() => navigate('/tj-po-system/new')}
      onEdit={(id) => navigate(`/tj-po-system/${id}`)}
      onCombine={(ids) => navigate(`/tj-po-system/combine?ids=${ids.join(',')}`)}
    />
  )
}

// ---------------------------------------------------------------------------
// PO 列表
// ---------------------------------------------------------------------------

function PoList({
  onCreate,
  onEdit,
  onCombine,
}: {
  onCreate: () => void
  onEdit: (id: string) => void
  onCombine: (ids: string[]) => void
}) {
  const [pos, setPos] = useState<PoHeader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exportingId, setExportingId] = useState('')
  const [combineMode, setCombineMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Add New Item 暂停：界面不显示入口，旧快捷键入口也已移除（直链进入只看到停用说明，
  // 写 API 同样被拒绝），避免任何隐藏路径绕过暂停。
  // 合并单来源单集合（按 source_po_ids 关系，不依赖 status）：来源单不显示推送按钮。
  const combinedSourcePoNumbers = new Set(
    pos.flatMap((p) => (p.po_type === 'combined' ? (p.source_po_ids ?? []) : []))
  )

  useEffect(() => {
    let mounted = true
    const load = () => {
      listPos()
        .then((r) => mounted && setPos(r))
        .catch((e) => mounted && setError(e.message))
        .finally(() => mounted && setLoading(false))
    }
    load()
    // 每 5 秒轮询刷新：VPS 推送完成后「推送中…」自动变「已导出」，无需手动刷新
    const timer = setInterval(load, 5000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])

  async function handleExportPo(p: PoHeader) {
    setExportingId(p.id)
    setError('')
    try {
      await requestPush(p.id)
      const r = await listPos()
      setPos(r)
    } catch (e: any) {
      setError(e.message || '推送请求失败')
    } finally {
      setExportingId('')
    }
  }

  // 合并勾选：只允许 confirmed；强制相同 Supplier Code
  function toggleSelect(p: PoHeader) {
    if (selected.has(p.id)) {
      const next = new Set(selected)
      next.delete(p.id)
      setSelected(next)
      return
    }
    const already = pos.find((x) => selected.has(x.id))
    if (already && already.supplier_code !== p.supplier_code) {
      setError('只能合并相同 Supplier Code 的采购单')
      return
    }
    const next = new Set(selected)
    next.add(p.id)
    setSelected(next)
    setError('')
  }

  function handleCombine() {
    if (selected.size < 2) {
      setError('请至少勾选两张尚未推送的采购单')
      return
    }
    onCombine(Array.from(selected))
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold leading-tight text-slate-900">采购单</h1>
            <p className="text-sm font-medium text-slate-500">Purchase Order</p>
            <p className="mt-1 text-sm text-slate-500">建立采购单、导出 Excel 交给 PAD 录入 IRS</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setCombineMode((v) => !v)
                setSelected(new Set())
                setError('')
              }}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-xl border px-3 py-2.5 text-sm font-semibold ${
                combineMode
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Merge className="h-4 w-4" /> 合并采购单
            </button>
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700"
            >
              <Plus className="h-4 w-4" /> 新建采购单
            </button>
          </div>
        </header>

        {combineMode && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <span className="text-sm text-emerald-800">合并模式：勾选两张以上相同 Supplier、尚未推送的采购单</span>
            <button
              type="button"
              onClick={handleCombine}
              disabled={selected.size < 2}
              className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              合并 ({selected.size})
            </button>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : pos.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
            <p className="text-slate-500">还没有采购单</p>
            <button
              type="button"
              onClick={onCreate}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              <Plus className="h-4 w-4" /> 建立第一张采购单
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {pos.map((p) => {
              const s = poStatusBadge(p.status, p.po_type)
              const notCombinable = combineMode && p.status !== 'confirmed'
              return (
                <li
                  key={p.id}
                  className={`flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-4 transition-colors hover:border-emerald-300 ${
                    notCombinable ? 'opacity-50' : ''
                  }`}
                >
                  {combineMode && (
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p)}
                      disabled={p.status !== 'confirmed'}
                      className="h-4 w-4 shrink-0 accent-emerald-600 disabled:opacity-30"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => (combineMode ? toggleSelect(p) : onEdit(p.id))}
                    disabled={notCombinable}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-900">{p.po_id}</span>
                      {p.created_by && (
                        <span className="rounded-md bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-700">[{p.created_by}]</span>
                      )}
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
                    </div>
                    <div className="mt-1 truncate text-sm text-slate-700">{p.supplier_name}</div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {p.supplier_code} · {p.line_count ?? 0} 项 · {fmtDate(p.created_at)}
                      {p.source_po_ids && p.source_po_ids.length > 0 && (
                        <span className="ml-1 text-slate-300">← 来源 {p.source_po_ids.join(', ')}</span>
                      )}
                    </div>
                  </button>
                  {!combineMode && p.po_type === 'combined' && p.status === 'confirmed' && (
                    <span
                      className="shrink-0 rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-500"
                      title="合并单永久冻结推送：只能在内部核对/导出 Excel"
                    >
                      已冻结·不可推送
                    </span>
                  )}
                  {!combineMode && p.status === 'confirmed' && p.po_type !== 'combined' && !combinedSourcePoNumbers.has(p.po_id) && !IS_PREVIEW_SCHEMA && (
                    <button
                      type="button"
                      onClick={() => handleExportPo(p)}
                      disabled={exportingId === p.id}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {exportingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      推送到电脑
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PO 编辑器
// ---------------------------------------------------------------------------

function PoEditor({
  poId,
  onBack,
  onSaved,
}: {
  poId?: string
  onBack: () => void
  onSaved: () => void
}) {
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [lines, setLines] = useState<EditableLine[]>([emptyLine()])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(!!poId)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [savedPoId, setSavedPoId] = useState<string | undefined>(poId)
  const [createdBy, setCreatedBy] = useState<string | null>(null)
  const [showPersonPicker, setShowPersonPicker] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const lineRefs = useRef<Record<string, { item: HTMLInputElement | null; qty: HTMLInputElement | null; price: HTMLInputElement | null }>>({})

  // 始终指向最新 lines，供拖曳排序读取（避免闭包陈旧）
  const linesRef = useRef(lines)
  useEffect(() => {
    linesRef.current = lines
  }, [lines])

  // 加载已有 PO
  useEffect(() => {
    if (!poId) return
    getPo(poId)
      .then((po) => {
        setSupplier({ id: '', code: po.supplier_code, name: po.supplier_name })
        setNotes(po.notes ?? '')
        setLines(
          po.lines.map((l) => ({
            key: nextKey(),
            lineId: l.id,
            item: { id: '', code: l.item_code, description: l.description, uom: l.uom, cost: l.unit_price, selling_price: null },
            itemQuery: l.item_code,
            qty: String(l.qty),
            unitPrice: String(l.unit_price),
          }))
        )
        setCreatedBy(po.created_by ?? null)
        setFrozen(!!po.frozen)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [poId])

  const focusItem = useCallback((key: string) => {
    // 等下一帧，确保新行已渲染
    requestAnimationFrame(() => lineRefs.current[key]?.item?.focus())
  }, [])

  const focusQty = useCallback((key: string) => {
    requestAnimationFrame(() => lineRefs.current[key]?.qty?.focus())
  }, [])

  const focusPrice = useCallback((key: string) => {
    requestAnimationFrame(() => lineRefs.current[key]?.price?.focus())
  }, [])

  function updateLine(key: string, patch: Partial<EditableLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function addLine() {
    const nl = emptyLine()
    setLines((ls) => [...ls, nl])
    focusItem(nl.key)
  }

  function removeLine(key: string) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))
  }

  // 拖曳/上移下移排序：更新本地顺序，已保存的 PO 立即持久化 line_no
  function moveLine(from: number, to: number) {
    const ls = linesRef.current
    if (from < 0 || to < 0 || from >= ls.length || to >= ls.length || from === to) return
    const next = [...ls]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setLines(next)
    if (savedPoId && next.every((l) => l.lineId)) {
      reorderLines(savedPoId, next.map((l) => l.lineId!)).catch((e) =>
        setError(e.message || '排序保存失败')
      )
    }
  }

  function handleDragStart(index: number) {
    if (frozen) return
    setDragIndex(index)
  }

  function handleDragOver(index: number) {
    if (dragIndex === null || frozen) return
    if (index !== dropIndex) setDropIndex(index)
  }

  function handleDrop(index: number) {
    if (dragIndex === null || frozen) return
    moveLine(dragIndex, index)
    setDragIndex(null)
    setDropIndex(null)
  }

  function handleDragEnd() {
    setDragIndex(null)
    setDropIndex(null)
  }

  // 商品行内选中商品
  function pickItem(key: string, item: Item) {
    updateLine(key, {
      item,
      itemQuery: item.code,
      unitPrice: item.cost != null ? String(item.cost) : '',
    })
    focusQty(key)
  }

  function buildLines(): PoLine[] | null {
    if (!supplier) {
      setError('请先选择供应商')
      return null
    }
    const valid = lines.filter((l) => l.item)
    if (valid.length === 0) {
      setError('请至少加入一个商品')
      return null
    }
    for (const l of valid) {
      const qty = parseFloat(l.qty)
      if (!l.qty || Number.isNaN(qty) || qty <= 0) {
        setError('每个商品的数量必须大于 0')
        return null
      }
      const price = parseFloat(l.unitPrice)
      if (l.unitPrice === '' || Number.isNaN(price) || price < 0) {
        setError('每个商品的单价必须 ≥ 0')
        return null
      }
    }
    return valid.map((l, i) => ({
      line_no: i + 1,
      item_code: l.item!.code,
      description: l.item!.description,
      uom: l.item!.uom,
      qty: parseFloat(l.qty),
      unit_price: parseFloat(l.unitPrice),
    }))
  }

  async function doSave(by?: string): Promise<PoHeader | null> {
    const parsed = buildLines()
    if (!parsed) return null
    setSaving(true)
    setError('')
    try {
      if (savedPoId) {
        const po = await updatePo(savedPoId, supplier!, parsed)
        setSavedPoId(po.id)
        return po
      }
      const po = await createPo(supplier!, parsed, by ?? createdBy ?? '')
      setSavedPoId(po.id)
      return po
    } catch (e: any) {
      setError(e.message || '保存失败')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    // 新建单：先选开单人
    if (!savedPoId && !createdBy) {
      setShowPersonPicker(true)
      return
    }
    const po = await doSave()
    if (po) onSaved()
  }

  function pickPerson(name: string) {
    setCreatedBy(name)
    setShowPersonPicker(false)
    doSave(name).then((po) => {
      if (po) onSaved()
    })
  }

  async function handleCopy() {
    if (!supplier) {
      setError('请先选择供应商')
      return
    }
    const text = buildCopyText(lines)
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      setError('复制失败，请手动复制')
    }
  }

  async function handleDelete() {
    if (!savedPoId) return
    if (!window.confirm('确定删除这张采购单吗？此操作不可恢复。')) return
    try {
      await deletePo(savedPoId)
      onSaved()
    } catch (e: any) {
      setError(e.message || '删除失败')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        {/* 顶部栏 */}
        <div className="mb-6 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
          <h1 className="whitespace-nowrap text-lg font-bold text-slate-900">
            {savedPoId ? `编辑 ${savedPoId}` : '新建采购单'}
          </h1>
          <div className="w-16" />
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* 供应商 */}
        <section className="mb-5">
          <label className="mb-1.5 block text-sm font-medium text-slate-600">供应商</label>
          <SupplierPicker
            value={supplier}
            autoFocus={!poId}
            onPicked={(s) => {
              setSupplier(s)
              if (s && lines.length === 1 && !lines[0].item) {
                focusItem(lines[0].key)
              }
            }}
          />
        </section>

        {/* 商品行 */}
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-600">商品明细</label>
            <span className="text-xs text-slate-400">Tab 移动 · Enter 确认/下一行</span>
          </div>

          {/* 表头（桌面） */}
          <div className="hidden grid-cols-[28px_1fr_1.6fr_80px_90px_90px_40px] gap-2 px-2 pb-1 text-xs text-slate-400 md:grid">
            <span />
            <span>商品编号</span>
            <span>描述</span>
            <span className="text-right">数量</span>
            <span className="text-right">单价(RM)</span>
            <span className="text-right">单位</span>
            <span />
          </div>

          <div className="space-y-2">
            {lines.map((l, idx) => (
              <LineRow
                key={l.key}
                line={l}
                index={idx}
                frozen={frozen}
                dragging={dragIndex === idx}
                dropTarget={dropIndex === idx && dragIndex !== idx}
                refs={lineRefs.current[l.key] ?? (lineRefs.current[l.key] = { item: null, qty: null, price: null })}
                onPickItem={(item) => pickItem(l.key, item)}
                onChange={(patch) => updateLine(l.key, patch)}
                onRemove={() => removeLine(l.key)}
                onQtyEnter={() => focusPrice(l.key)}
                onPriceEnter={() => {
                  const isLast = idx === lines.length - 1
                  if (isLast) {
                    addLine()
                  } else {
                    focusItem(lines[idx + 1].key)
                  }
                }}
                canRemove={lines.length > 1}
                onDragStart={() => handleDragStart(idx)}
                onDragOver={() => handleDragOver(idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                onMoveUp={() => moveLine(idx, idx - 1)}
                onMoveDown={() => moveLine(idx, idx + 1)}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={addLine}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-emerald-600 hover:bg-emerald-50"
          >
            <Plus className="h-4 w-4" /> 加一行商品
          </button>
        </section>

        {/* 备注 */}
        <section className="mb-6">
          <label className="mb-1.5 block text-sm font-medium text-slate-600">备注（可选）</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="例如：本月补货"
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </section>

        {/* 底部操作 */}
        <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-b-2xl">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {copied ? '已复制' : '复制给Supplier'}
            </button>
            {savedPoId && (
              <button
                type="button"
                onClick={handleDelete}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" /> 删除
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            保存
          </button>
        </div>
      </div>

      {/* 开单人选择 */}
      {showPersonPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="mb-3 text-base font-semibold text-slate-900">谁开的单？</h3>
            <div className="space-y-2">
              {CREATED_BY_OPTIONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => pickPerson(name)}
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:border-emerald-300 hover:bg-emerald-50"
                >
                  {name}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowPersonPicker(false)}
              className="mt-3 w-full rounded-xl px-4 py-2 text-sm text-slate-500 hover:bg-slate-100"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 商品行
// ---------------------------------------------------------------------------

function LineRow({
  line,
  index,
  frozen,
  dragging,
  dropTarget,
  refs,
  onPickItem,
  onChange,
  onRemove,
  onQtyEnter,
  onPriceEnter,
  canRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveUp,
  onMoveDown,
}: {
  line: EditableLine
  index: number
  frozen: boolean
  dragging: boolean
  dropTarget: boolean
  refs: { item: HTMLInputElement | null; qty: HTMLInputElement | null; price: HTMLInputElement | null }
  onPickItem: (item: Item) => void
  onChange: (patch: Partial<EditableLine>) => void
  onRemove: () => void
  onQtyEnter: () => void
  onPriceEnter: () => void
  canRemove: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [results, setResults] = useState<Item[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    const q = line.itemQuery.trim()
    if (!q || line.item) {
      setResults([])
      setOpen(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await searchItems(q)
        setResults(r)
        setOpen(r.length > 0)
        setHighlight(0)
      } catch {
        /* 忽略 */
      }
      setSearching(false)
    }, 250)
    return () => clearTimeout(t)
  }, [line.itemQuery, line.item])

  function pick(item: Item) {
    onPickItem(item)
    setResults([])
    setOpen(false)
  }

  function onItemKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && line.item) {
      // 已选中商品时按 Enter → 跳到数量
      e.preventDefault()
      onQtyEnter()
      return
    }
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(results[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div
      className={`relative flex rounded-xl border bg-white transition-all ${
        dragging
          ? 'z-10 scale-[1.02] border-emerald-400 shadow-xl ring-2 ring-emerald-400'
          : dropTarget
            ? 'border-emerald-400 ring-2 ring-emerald-100'
            : 'border-slate-200'
      }`}
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
    >
      {/* 左把手栏：拖曳 + 上移/下移 */}
      <div className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 rounded-l-xl border-r border-slate-100 bg-slate-50 py-2">
        {frozen ? (
          <Lock className="h-4 w-4 text-slate-300" aria-label="已批准冻结，不可重新排序" />
        ) : (
          <>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                onDragStart()
              }}
              onDragEnd={onDragEnd}
              className="cursor-grab rounded p-0.5 text-slate-300 hover:text-slate-500 active:cursor-grabbing"
              aria-label="拖曳排序"
              title="拖曳排序"
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onMoveUp}
              disabled={index === 0}
              className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500 disabled:opacity-30"
              aria-label="上移"
              title="上移"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500"
              aria-label="下移"
              title="下移"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* 商品行 */}
      <div className="grid flex-1 grid-cols-[1fr_1fr_auto_auto] gap-2 p-3 md:grid-cols-[1fr_1.6fr_80px_90px_90px_40px] md:items-center">
        {/* 商品编号 / 搜索 */}
        <div className="relative col-span-4 md:col-span-1">
          <input
            ref={(el) => {
              refs.item = el
            }}
            value={line.item ? line.item.code : line.itemQuery}
            onChange={(e) => {
              if (line.item) return
              onChange({ itemQuery: e.target.value })
            }}
            onKeyDown={onItemKeyDown}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder={line.item ? '' : '搜商品（名称或编号）…'}
            className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 ${
              line.item
                ? 'border-emerald-200 bg-emerald-50 font-medium text-slate-800'
                : 'border-slate-300 bg-white focus:border-emerald-500 focus:ring-emerald-100'
            }`}
          />
          {searching && <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-slate-400" />}
          {open && (
            <ul className="absolute z-20 mt-1 max-h-64 w-72 overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg md:w-96">
              {results.map((it, i) => (
                <li key={it.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(it)
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={`w-full px-3 py-2 text-left ${i === highlight ? 'bg-emerald-50' : ''}`}
                  >
                    <div className="text-xs font-semibold text-slate-800">{it.code}</div>
                    <div className="truncate text-xs text-slate-500">{it.description}</div>
                  </button>
                </li>
              ))}
              {results.length === 0 && !searching && (
                <li className="px-3 py-2 text-xs text-slate-400">没有匹配的商品</li>
              )}
            </ul>
          )}
        </div>

        {/* 描述 */}
        <div className="col-span-4 md:col-span-1">
          <div className="truncate px-1 py-1 text-sm text-slate-600 md:py-2">{line.item?.description ?? ''}</div>
        </div>

        {/* 数量 */}
        <div>
          <input
            ref={(el) => {
              refs.qty = el
            }}
            value={line.qty}
            onChange={(e) => onChange({ qty: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onQtyEnter()
              }
            }}
            placeholder="数量"
            inputMode="decimal"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-right text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </div>

        {/* 单价 */}
        <div>
          <input
            ref={(el) => {
              refs.price = el
            }}
            value={line.unitPrice}
            onChange={(e) => onChange({ unitPrice: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onPriceEnter()
              }
            }}
            placeholder="单价"
            inputMode="decimal"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-right text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />
        </div>

        {/* 单位 */}
        <div>
          <div className="px-1 py-2 text-center text-xs text-slate-500 md:text-right">{line.item?.uom ?? ''}</div>
        </div>

        {/* 删除 */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
            aria-label="删除此行"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
