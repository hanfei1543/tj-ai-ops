import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { listReceipts } from '@/lib/tjGrApi'
import { receiptStatusBadge } from '@/lib/core/gr-form.js'
import { warningLabel } from '@/lib/core/ui-labels.js'
import type { GrIdentity } from '@/lib/grAuth'
import type { GrCapabilities } from '@/lib/core/gr-form.js'
import type { GrReceiptEvent } from '@/types/tjGr'

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** 下一步操作提示（只按后端真实状态，不虚构） */
function nextActionHint(ev: GrReceiptEvent): string {
  const s = String(ev.status ?? '').trim()
  if (s === 'draft') return '草稿，还未提交'
  if (s === 'submitted' || s === 'pending_approval') return '等待审批人批准'
  if (s === 'approved') return '等待放行并交给系统处理'
  if (s === 'waiting_mapping') return '还差 IRS 采购单编号，请登记'
  if (s === 'needs_review') return '需要人工检查，不会自动重试'
  if (s === 'released' || s === 'in_progress') return '系统处理中，等待结果'
  if (s === 'saved_unverified') return 'IRS 已尝试保存，等待核对'
  if (s === 'verified') return 'IRS 已核对完成'
  if (s === 'cancelled') return '已取消'
  return ''
}

/** 收货记录列表：刷新/重开一律从 DB 读取（不依赖本地缓存） */
export default function ReceiptListPage({ caps }: { identity: GrIdentity; caps: GrCapabilities }) {
  const navigate = useNavigate()
  const [events, setEvents] = useState<GrReceiptEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setEvents(await listReceipts())
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取收货列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">收货记录</h1>
          <p className="text-sm text-slate-500">
            {caps.canApprove ? '你可以审批并放行；' : ''}
            员工日常只需填写数量、发票 / 送货单、收货日期与差异备注。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} 刷新
        </button>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && events.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center text-slate-500">
          还没有收货记录。请到采购单列表，对已确认的采购单点「登记本次收货」。
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((ev) => {
            const badge = receiptStatusBadge(ev.status)
            const hint = nextActionHint(ev)
            const warnings = Array.isArray(ev.warnings) ? ev.warnings : []
            const warningCodes = warnings.filter((w) => typeof w === 'string')
            return (
              <li key={ev.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/tj-po-system/receipts/${ev.id}`)}
                  className="flex w-full flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left hover:border-emerald-300"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-900" title={ev.id}>
                        {ev.event_no || shortId(ev.id)}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                      {warningCodes.length > 0 && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          {warningCodes.map(warningLabel).join('、')}
                        </span>
                      )}
                      {typeof ev.exception_count === 'number' && ev.exception_count > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                          有 {ev.exception_count} 项需要确认
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-sm text-slate-700">
                      {ev.supplier_name ? `${ev.supplier_name}` : ''}
                      {(ev.po_ids ?? []).length > 0 ? ` · 采购单 ${(ev.po_ids ?? []).join(' + ')}` : ''}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      收货日期 {ev.receive_date ?? '—'}
                      {ev.delivery_order_no ? ` · 送货单 ${ev.delivery_order_no}` : ''}
                      {ev.invoice_no ? ` · 发票 ${ev.invoice_no}` : ''}
                    </div>
                    {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
                  </div>
                  <span className="text-xs font-semibold text-emerald-700">查看详情 →</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
