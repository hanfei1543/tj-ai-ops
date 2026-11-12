import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Plus,
  X,
} from 'lucide-react'
import {
  approveItemRequest,
  checkItemCodeDuplicate,
  createItemRequest,
  listItemRequests,
  rejectItemRequest,
  updateItemRequestStatus,
} from '@/lib/tjPoApi'
import { downloadItemMasterExcel } from '@/lib/tjPoExcel'
import type { ItemRequest } from '@/types/tjPo'

const CREATED_BY_OPTIONS = ['Ms Toh', 'Ngam Cheng Jye', 'Keh Lee', 'Ms Teow', 'Ah Huat']

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审批', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: '已批准', cls: 'bg-blue-100 text-blue-700' },
  exported: { label: '已导出', cls: 'bg-emerald-100 text-emerald-700' },
  created: { label: '已建立', cls: 'bg-green-100 text-green-700' },
  needs_review: { label: '需复核', cls: 'bg-red-100 text-red-700' },
  rejected: { label: '已拒绝', cls: 'bg-slate-200 text-slate-600' },
}

interface FormState {
  item_code: string
  barcode: string
  description: string
  uom: string
  category: string
  supplier_code: string
  purchase_cost: string
  selling_price: string
  tax_rate: string
  sst_info: string
}

const emptyForm = (): FormState => ({
  item_code: '',
  barcode: '',
  description: '',
  uom: '',
  category: '',
  supplier_code: '',
  purchase_cost: '',
  selling_price: '',
  tax_rate: '',
  sst_info: '',
})

function numOrNull(s: string): number | null {
  const v = s.trim()
  if (v === '') return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

export default function AddItemPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState<FormState>(emptyForm())
  const [requests, setRequests] = useState<ItemRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [createdBy, setCreatedBy] = useState(CREATED_BY_OPTIONS[0])
  const [dup, setDup] = useState<{ in_items: boolean; pending_request: boolean } | null>(null)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    let mounted = true
    listItemRequests()
      .then((r) => mounted && setRequests(r))
      .catch((e) => mounted && setError(e.message))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  async function checkDup(code: string) {
    const c = code.trim()
    if (!c) {
      setDup(null)
      return
    }
    try {
      setDup(await checkItemCodeDuplicate(c))
    } catch {
      /* 忽略 */
    }
  }

  async function handleSubmit() {
    if (!form.item_code.trim() || !form.description.trim()) {
      setError('Item Code 和 Description 为必填')
      return
    }
    setSaving(true)
    setError('')
    try {
      await createItemRequest({
        item_code: form.item_code.trim(),
        barcode: form.barcode.trim() || null,
        description: form.description.trim(),
        uom: form.uom.trim() || null,
        category: form.category.trim() || null,
        supplier_code: form.supplier_code.trim() || null,
        purchase_cost: numOrNull(form.purchase_cost),
        selling_price: numOrNull(form.selling_price),
        tax_rate: numOrNull(form.tax_rate),
        sst_info: form.sst_info.trim() || null,
        created_by: createdBy,
      })
      setForm(emptyForm())
      setDup(null)
      setShowForm(false)
      setRequests(await listItemRequests())
    } catch (e: any) {
      setError(e.message || '提交失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleApprove(r: ItemRequest) {
    setError('')
    try {
      await approveItemRequest(r.id, createdBy)
      setRequests(await listItemRequests())
    } catch (e: any) {
      setError(e.message || '批准失败')
    }
  }

  async function handleReject(r: ItemRequest) {
    if (!window.confirm('确定拒绝此商品申请？')) return
    try {
      await rejectItemRequest(r.id)
      setRequests(await listItemRequests())
    } catch (e: any) {
      setError(e.message || '操作失败')
    }
  }

  async function handleExport(rs: ItemRequest[]) {
    setError('')
    try {
      await downloadItemMasterExcel(rs)
      // 导出后标记 exported（独立数据包交给 Windows/PAD 侧处理）
      for (const r of rs) {
        await updateItemRequestStatus(r.id, 'exported', 'none')
      }
      setRequests(await listItemRequests())
    } catch (e: any) {
      setError(e.message || '导出失败')
    }
  }

  async function handleMarkResult(r: ItemRequest, status: 'created' | 'needs_review', result?: string) {
    setError('')
    try {
      await updateItemRequestStatus(r.id, status, status === 'created' ? 'irs_created' : 'failed', result)
      setRequests(await listItemRequests())
    } catch (e: any) {
      setError(e.message || '更新失败')
    }
  }

  const approved = requests.filter((r) => r.status === 'approved')

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 md:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('/tj-po-system')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
          <h1 className="whitespace-nowrap text-lg font-bold text-slate-900">新增商品（Item Master）</h1>
          <div className="w-16" />
        </div>

        <p className="mb-4 text-sm text-slate-500">
          当 Supplier 有新商品、IRS 尚未建立 Item Code 时，先在此提交申请。审批通过后导出独立 Item Master 数据包，由 Windows/PAD 核对 IRS 后建立。与「把已有商品加进采购单」是两个独立流程。
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* 操作栏 */}
        <div className="mb-4 flex items-center gap-3">
          {!showForm && (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              <Plus className="h-4 w-4" /> 新增商品申请
            </button>
          )}
          {approved.length > 0 && (
            <button
              type="button"
              onClick={() => handleExport(approved)}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              <Download className="h-4 w-4" /> 导出已批准 ({approved.length})
            </button>
          )}
        </div>

        {/* 表单 */}
        {showForm && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">商品资料</h2>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Item Code *">
                <input
                  value={form.item_code}
                  onChange={(e) => {
                    setForm({ ...form, item_code: e.target.value })
                    checkDup(e.target.value)
                  }}
                  placeholder="前导零安全，如 1050006000025"
                  className={inputCls}
                />
                {dup && (dup.in_items || dup.pending_request) && (
                  <p className="mt-1 text-xs text-red-600">
                    {dup.in_items ? 'IRS 已存在此 Item Code' : '已有待处理申请'}——请勿重复提交
                  </p>
                )}
              </Field>
              <Field label="Barcode">
                <input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className={inputCls} />
              </Field>
              <Field label="Description *">
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} />
              </Field>
              <Field label="UOM（单位）">
                <input value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} placeholder="如 PCS / SET / BOX" className={inputCls} />
              </Field>
              <Field label="Category / Item Group">
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls} />
              </Field>
              <Field label="Supplier Code">
                <input value={form.supplier_code} onChange={(e) => setForm({ ...form, supplier_code: e.target.value })} className={inputCls} />
              </Field>
              <Field label="Purchase Cost (RM)">
                <input value={form.purchase_cost} onChange={(e) => setForm({ ...form, purchase_cost: e.target.value })} inputMode="decimal" className={inputCls} />
              </Field>
              <Field label="Selling Price (RM)">
                <input value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} inputMode="decimal" className={inputCls} />
              </Field>
              <Field label="Tax Rate (%)">
                <input value={form.tax_rate} onChange={(e) => setForm({ ...form, tax_rate: e.target.value })} inputMode="decimal" className={inputCls} />
              </Field>
              <Field label="SST 资料">
                <input value={form.sst_info} onChange={(e) => setForm({ ...form, sst_info: e.target.value })} className={inputCls} />
              </Field>
            </div>

            <div className="mt-4">
              <label className="mb-1.5 block text-sm font-medium text-slate-600">建立人</label>
              <select value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-emerald-500 md:w-64">
                {CREATED_BY_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving || !!(dup && (dup.in_items || dup.pending_request))}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                提交申请
              </button>
            </div>
          </div>
        )}

        {/* 申请列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : requests.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-12 text-center text-slate-500">
            还没有商品申请
          </div>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => {
              const meta = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-slate-100 text-slate-600' }
              return (
                <li key={r.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-900">{r.item_code}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-slate-600">{r.description}</div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        {r.uom && <span>{r.uom} · </span>}
                        {r.supplier_code && <span>{r.supplier_code} · </span>}
                        建立 {r.created_by ?? '—'}
                        {r.approved_at && <span> · 审批 {r.approved_by ?? '—'}</span>}
                      </div>
                      {r.erp_result && <div className="mt-0.5 text-xs text-slate-500">IRS 回写：{r.erp_result}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {r.status === 'pending' && (
                        <>
                          <button type="button" onClick={() => handleApprove(r)} className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                            批准
                          </button>
                          <button type="button" onClick={() => handleReject(r)} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100">
                            拒绝
                          </button>
                        </>
                      )}
                      {r.status === 'approved' && (
                        <button type="button" onClick={() => handleExport([r])} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                          <Download className="h-3.5 w-3.5" /> 导出
                        </button>
                      )}
                      {r.status === 'exported' && (
                        <>
                          <button type="button" onClick={() => handleMarkResult(r, 'created', 'IRS 已建立并核对一致')} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                            <Check className="h-3.5 w-3.5" /> 标记已建立
                          </button>
                          <button type="button" onClick={() => handleMarkResult(r, 'needs_review', 'IRS 建立失败或结果不确定')} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50">
                            需复核
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-600">{label}</label>
      {children}
    </div>
  )
}
