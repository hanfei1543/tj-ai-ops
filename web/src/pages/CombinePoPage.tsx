import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  approveCombinedPo,
  cancelCombinedPo,
  createCombinedPo,
  getItemByCode,
  getPo,
  getPosByIds,
  submitCombinedForApproval,
} from '@/lib/tjPoApi'
import { downloadGrExcel } from '@/lib/tjPoExcel'
import type { PoWithLines, SourceRef } from '@/types/tjPo'

const CREATED_BY_OPTIONS = ['Ms Toh', 'Ngam Cheng Jye', 'Keh Lee', 'Ms Teow', 'Ah Huat']

let uid = 0
function nextKey(): string {
  uid += 1
  return `c${Date.now()}_${uid}`
}

interface CombineLine {
  key: string
  item_code: string
  description: string
  uom: string | null
  unit_price: number
  ordered_qty: number // 原订购（多来源合计）
  accepted_qty: string // 实收/批准数量（可编辑）
  note: string // 短缺/损坏/替代/分批等例外备注
  source_refs: SourceRef[]
  is_extra?: boolean // 额外/替代行
}

/** 把多张来源 PO 的明细按 item_code + uom + 单价 合并；不同 UOM/单价分开 */
function buildCombinedLines(sourcePos: PoWithLines[]): CombineLine[] {
  const groups = new Map<string, CombineLine>()
  for (const po of sourcePos) {
    for (const l of po.lines) {
      const key = `${l.item_code}|${l.uom ?? ''}|${Number(l.unit_price)}`
      const ref: SourceRef = {
        po_id: po.id,
        po_number: po.po_id,
        line_id: l.id ?? '',
        qty: Number(l.qty),
      }
      const existing = groups.get(key)
      if (existing) {
        existing.ordered_qty += Number(l.qty)
        existing.accepted_qty = String(existing.ordered_qty)
        existing.source_refs.push(ref)
      } else {
        groups.set(key, {
          key: nextKey(),
          item_code: l.item_code,
          description: l.description,
          uom: l.uom,
          unit_price: Number(l.unit_price),
          ordered_qty: Number(l.qty),
          accepted_qty: String(Number(l.qty)),
          note: '',
          source_refs: [ref],
        })
      }
    }
  }
  return Array.from(groups.values())
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export default function CombinePoPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean), [params])

  const [sourcePos, setSourcePos] = useState<PoWithLines[]>([])
  const [lines, setLines] = useState<CombineLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 阶段：building（核对调整）→ pending_approval（待审批）→ confirmed（已冻结）
  const [phase, setPhase] = useState<'building' | 'pending_approval' | 'confirmed'>('building')
  const [combinedPoId, setCombinedPoId] = useState<string | null>(null)
  const [combinedPoNumber, setCombinedPoNumber] = useState('')

  const [deliveryOrderNo, setDeliveryOrderNo] = useState('')
  const [checkedBy, setCheckedBy] = useState('')

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const [showApproverPicker, setShowApproverPicker] = useState(false)
  const [showCreatorPicker, setShowCreatorPicker] = useState(false)

  const linesRef = useRef(lines)
  useEffect(() => {
    linesRef.current = lines
  }, [lines])

  useEffect(() => {
    let mounted = true
    if (ids.length === 0) {
      setError('未选择要合并的采购单')
      setLoading(false)
      return
    }
    getPosByIds(ids)
      .then((pos) => {
        if (!mounted) return
        // 校验相同供应商
        const codes = new Set(pos.map((p) => p.supplier_code))
        if (codes.size !== 1) {
          setError('只能合并相同 Supplier Code 的采购单')
          setLoading(false)
          return
        }
        // 校验均为可合并状态（未 ERP Push）
        const bad = pos.filter((p) => p.status !== 'confirmed')
        if (bad.length) {
          setError(`采购单 ${bad.map((p) => p.po_id).join('、')} 状态不可合并（仅 confirmed 可合并）`)
          setLoading(false)
          return
        }
        setSourcePos(pos)
        setLines(buildCombinedLines(pos))
      })
      .catch((e) => mounted && setError(e.message))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [ids])

  const supplierName = sourcePos[0]?.supplier_name ?? ''
  const supplierCode = sourcePos[0]?.supplier_code ?? ''

  function updateLine(key: string, patch: Partial<CombineLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function moveLine(from: number, to: number) {
    const ls = linesRef.current
    if (from < 0 || to < 0 || from >= ls.length || to >= ls.length || from === to) return
    const next = [...ls]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setLines(next)
  }

  function removeLine(key: string) {
    setLines((ls) => ls.filter((l) => l.key !== key))
  }

  function addExtraLine() {
    setLines((ls) => [
      ...ls,
      {
        key: nextKey(),
        item_code: '',
        description: '',
        uom: null,
        unit_price: 0,
        ordered_qty: 0,
        accepted_qty: '',
        note: '',
        source_refs: [],
        is_extra: true,
      },
    ])
  }

  // 额外/替代行：输入 item code 后自动查商品带出描述/UOM/成本
  async function lookupExtraLine(key: string, code: string) {
    if (!code.trim()) return
    const item = await getItemByCode(code.trim()).catch(() => null)
    if (item) {
      updateLine(key, {
        item_code: item.code,
        description: item.description,
        uom: item.uom,
        unit_price: item.cost != null ? Number(item.cost) : 0,
      })
    }
  }

  function validLines(): { input: Parameters<typeof createCombinedPo>[2]; ok: boolean } {
    const bad = lines.filter((l) => !l.item_code.trim() || !l.description.trim())
    if (bad.length) {
      setError('存在缺少商品编号或描述的行，请补全或删除')
      return { input: [], ok: false }
    }
    const input = lines.map((l) => {
      const acc = parseFloat(l.accepted_qty)
      return {
        item_code: l.item_code,
        description: l.description,
        uom: l.uom,
        qty: Number.isFinite(acc) && acc >= 0 ? acc : 0,
        unit_price: Number(l.unit_price),
        original_qty: l.ordered_qty,
        accepted_qty: Number.isFinite(acc) && acc >= 0 ? acc : 0,
        note: l.note || null,
        source_refs: l.source_refs,
      }
    })
    return { input, ok: true }
  }

  async function handleSubmitForApproval(creator: string) {
    setShowCreatorPicker(false)
    const { input, ok } = validLines()
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const supplier = { id: '', code: supplierCode, name: supplierName }
      const header = await createCombinedPo(supplier, sourcePos, input, creator)
      await submitCombinedForApproval(header.id, checkedBy || creator, deliveryOrderNo)
      setCombinedPoId(header.id)
      setCombinedPoNumber(header.po_id)
      setPhase('pending_approval')
    } catch (e: any) {
      setError(e.message || '提交审批失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleApprove(approver: string) {
    setShowApproverPicker(false)
    if (!combinedPoId) return
    // source_sha256 = 冻结时来源行数据的摘要（不可篡改对照）
    const canonical = JSON.stringify(
      lines
        .map((l) => ({
          code: l.item_code,
          original_qty: l.ordered_qty,
          accepted_qty: parseFloat(l.accepted_qty) || 0,
          price: l.unit_price,
          uom: l.uom,
          sources: l.source_refs.map((r) => [r.po_number, r.line_id, r.qty]),
        }))
        .sort((a, b) => a.code.localeCompare(b.code))
    )
    const hash = await sha256Hex(canonical)
    setBusy(true)
    setError('')
    try {
      await approveCombinedPo(combinedPoId, approver, hash)
      setPhase('confirmed')
    } catch (e: any) {
      setError(e.message || '批准失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (!combinedPoId) {
      navigate('/tj-po-system')
      return
    }
    if (!window.confirm('确定取消合并吗？来源采购单将恢复为可单独推送。')) return
    setBusy(true)
    setError('')
    try {
      await cancelCombinedPo(combinedPoId)
      navigate('/tj-po-system')
    } catch (e: any) {
      setError(e.message || '取消失败')
      setBusy(false)
    }
  }

  // 导出 GR 收货数据包（receipt_event_id + DO No + 批准快照 + 实收明细）
  async function handleExportGr() {
    if (!combinedPoId) return
    setBusy(true)
    setError('')
    try {
      const po = await getPo(combinedPoId)
      await downloadGrExcel(po, po.lines)
    } catch (e: any) {
      setError(e.message || '导出收货单失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    )
  }

  if (error && phase === 'building' && sourcePos.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-6 md:px-8">
        <div className="mx-auto max-w-3xl">
          <button
            type="button"
            onClick={() => navigate('/tj-po-system')}
            className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        </div>
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
            onClick={() => navigate('/tj-po-system')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
          <h1 className="whitespace-nowrap text-lg font-bold text-slate-900">合并采购单</h1>
          <div className="w-16" />
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* 汇总头 */}
        <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-800">{supplierName}</div>
              <div className="text-xs text-slate-400">{supplierCode}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-400">来源采购单</div>
              <div className="font-mono text-sm font-semibold text-slate-700">
                {sourcePos.map((p) => p.po_id).join(' + ')}
              </div>
            </div>
          </div>
          {combinedPoNumber && (
            <div className="mt-2 border-t border-slate-100 pt-2 text-sm">
              合并单编号：<span className="font-mono font-semibold text-emerald-700">{combinedPoNumber}</span>
              {phase === 'confirmed' && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">已批准冻结</span>}
              {phase === 'pending_approval' && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">待审批</span>}
            </div>
          )}
        </div>

        {/* 明细表 */}
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-600">合并明细（可调整顺序与实收数量）</label>
            {phase === 'building' && (
              <button
                type="button"
                onClick={addExtraLine}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50"
              >
                <Plus className="h-3.5 w-3.5" /> 加一行（替代/额外）
              </button>
            )}
          </div>

          <div className="hidden grid-cols-[28px_1fr_1.6fr_70px_80px_80px_90px_1.2fr_36px] gap-2 px-2 pb-1 text-xs text-slate-400 md:grid">
            <span />
            <span>商品编号</span>
            <span>描述</span>
            <span className="text-right">单价</span>
            <span className="text-right">订购</span>
            <span className="text-right">实收</span>
            <span>来源 PO</span>
            <span>备注</span>
            <span />
          </div>

          <div className="space-y-2">
            {lines.map((l, idx) => {
              const shortage = l.ordered_qty - (parseFloat(l.accepted_qty) || 0)
              return (
                <div
                  key={l.key}
                  className={`relative flex rounded-xl border bg-white transition-all ${
                    dragIndex === idx
                      ? 'z-10 scale-[1.02] border-emerald-400 shadow-xl ring-2 ring-emerald-400'
                      : dropIndex === idx && dragIndex !== idx
                        ? 'border-emerald-400 ring-2 ring-emerald-100'
                        : 'border-slate-200'
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (dragIndex !== null) setDropIndex(idx)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIndex !== null) {
                      moveLine(dragIndex, idx)
                    }
                    setDragIndex(null)
                    setDropIndex(null)
                  }}
                >
                  {/* 把手 */}
                  <div className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 rounded-l-xl border-r border-slate-100 bg-slate-50 py-2">
                    {phase === 'building' ? (
                      <>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move'
                            setDragIndex(idx)
                          }}
                          onDragEnd={() => {
                            setDragIndex(null)
                            setDropIndex(null)
                          }}
                          className="cursor-grab rounded p-0.5 text-slate-300 hover:text-slate-500 active:cursor-grabbing"
                          aria-label="拖曳排序"
                          title="拖曳排序"
                        >
                          <GripVertical className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveLine(idx, idx - 1)}
                          disabled={idx === 0}
                          className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500 disabled:opacity-30"
                          aria-label="上移"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveLine(idx, idx + 1)}
                          className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500"
                          aria-label="下移"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <Check className="h-4 w-4 text-emerald-400" />
                    )}
                  </div>

                  {/* 内容 */}
                  <div className="grid flex-1 grid-cols-[1fr_1fr_auto_auto] gap-2 p-3 md:grid-cols-[1fr_1.6fr_70px_80px_80px_90px_1.2fr_36px] md:items-center">
                    {/* 编号 */}
                    {l.is_extra && phase === 'building' ? (
                      <input
                        value={l.item_code}
                        onChange={(e) => updateLine(l.key, { item_code: e.target.value })}
                        onBlur={(e) => lookupExtraLine(l.key, e.target.value)}
                        placeholder="Item Code"
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                      />
                    ) : (
                      <div className="font-mono text-sm font-medium text-slate-800">{l.item_code}</div>
                    )}

                    {/* 描述 */}
                    {l.is_extra && phase === 'building' ? (
                      <input
                        value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                        placeholder="Description"
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                      />
                    ) : (
                      <div className="truncate text-sm text-slate-600">{l.description}</div>
                    )}

                    {/* 单价 */}
                    <div className="text-right text-sm text-slate-600">{Number(l.unit_price).toFixed(2)}</div>

                    {/* 订购 */}
                    <div className="text-right text-sm text-slate-600">
                      {l.ordered_qty}
                      {l.uom ? <span className="text-xs text-slate-400"> {l.uom}</span> : null}
                    </div>

                    {/* 实收（可编辑） */}
                    {phase === 'building' ? (
                      <input
                        value={l.accepted_qty}
                        onChange={(e) => updateLine(l.key, { accepted_qty: e.target.value })}
                        inputMode="decimal"
                        placeholder="实收"
                        className={`w-full rounded-lg border px-2 py-1.5 text-right text-sm outline-none focus:ring-2 ${
                          shortage > 0 ? 'border-amber-300 bg-amber-50 focus:border-amber-500' : 'border-slate-300 focus:border-emerald-500'
                        }`}
                      />
                    ) : (
                      <div className="text-right text-sm font-semibold text-slate-800">{parseFloat(l.accepted_qty) || 0}</div>
                    )}

                    {/* 来源 */}
                    <div className="truncate font-mono text-xs text-slate-400" title={l.source_refs.map((r) => `${r.po_number}:${r.qty}`).join(', ')}>
                      {l.source_refs.map((r) => r.po_number).join(', ')}
                    </div>

                    {/* 备注 */}
                    {phase === 'building' ? (
                      <input
                        value={l.note}
                        onChange={(e) => updateLine(l.key, { note: e.target.value })}
                        placeholder={shortage > 0 ? `未交货 ${shortage}` : '备注'}
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                      />
                    ) : (
                      <div className="truncate text-xs text-slate-500">{l.note || (shortage > 0 ? `未交货 ${shortage}` : '')}</div>
                    )}

                    {/* 删除（仅额外行可删） */}
                    {phase === 'building' && l.is_extra ? (
                      <div className="flex justify-end">
                        <button type="button" onClick={() => removeLine(l.key)} className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500" aria-label="删除">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* 送货单号 + 核对人（building 阶段） */}
        {phase === 'building' && (
          <section className="mb-6 space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">Delivery Order No.（送货单号，可选）</label>
              <input
                value={deliveryOrderNo}
                onChange={(e) => setDeliveryOrderNo(e.target.value)}
                placeholder="例如 D-021660"
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">核对人（前台）</label>
              <div className="flex flex-wrap gap-2">
                {CREATED_BY_OPTIONS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setCheckedBy(name)}
                    className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                      checkedBy === name ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* 底部操作 */}
        <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:mx-0">
          <div>
            {phase === 'pending_approval' && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
              >
                取消合并
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {phase === 'building' && (
              <button
                type="button"
                onClick={() => setShowCreatorPicker(true)}
                disabled={busy || !checkedBy}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                保存并提交审批
              </button>
            )}
            {phase === 'pending_approval' && (
              <button
                type="button"
                onClick={() => setShowApproverPicker(true)}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                批准并冻结
              </button>
            )}
            {phase === 'confirmed' && (
              <>
                <button
                  type="button"
                  onClick={handleExportGr}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <Download className="h-4 w-4" /> 导出收货单 (GR)
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/tj-po-system')}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                >
                  完成，返回列表
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 开单人选择 */}
      {showCreatorPicker && (
        <PickerModal
          title="谁发起的合并？"
          options={CREATED_BY_OPTIONS}
          onPick={(n) => handleSubmitForApproval(n)}
          onCancel={() => setShowCreatorPicker(false)}
        />
      )}
      {showApproverPicker && (
        <PickerModal
          title="审批人"
          options={CREATED_BY_OPTIONS}
          onPick={(n) => handleApprove(n)}
          onCancel={() => setShowApproverPicker(false)}
        />
      )}
    </div>
  )
}

function PickerModal({
  title,
  options,
  onPick,
  onCancel,
}: {
  title: string
  options: string[]
  onPick: (name: string) => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="mb-3 text-base font-semibold text-slate-900">{title}</h3>
        <div className="space-y-2">
          {options.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onPick(name)}
              className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:border-emerald-300 hover:bg-emerald-50"
            >
              {name}
            </button>
          ))}
        </div>
        <button type="button" onClick={onCancel} className="mt-3 w-full rounded-xl px-4 py-2 text-sm text-slate-500 hover:bg-slate-100">
          取消
        </button>
      </div>
    </div>
  )
}
