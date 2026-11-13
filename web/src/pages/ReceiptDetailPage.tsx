import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { approveReceipt, getReceipt, releaseReceipt, setPoMapping } from '@/lib/tjGrApi'
import { receiptStatusBadge, taskStatusBadge } from '@/lib/core/gr-form.js'
import type { GrCapabilities } from '@/lib/core/gr-form.js'
import type { GrIdentity } from '@/lib/grAuth'
import type { GrReceiptEvent, GrTask } from '@/types/tjGr'

function fmt(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function ReceiptDetailPage({ identity, caps }: { identity: GrIdentity; caps: GrCapabilities }) {
  const { receiptId } = useParams()
  const [event, setEvent] = useState<GrReceiptEvent | null>(null)
  const [tasks, setTasks] = useState<GrTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'' | 'approve' | 'release'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reviewNote, setReviewNote] = useState('')
  const [allowExceptions, setAllowExceptions] = useState(false)
  const [missingMappings, setMissingMappings] = useState<string[]>([])
  const [mappingIrs, setMappingIrs] = useState<Record<string, string>>({})
  const [mappingBusy, setMappingBusy] = useState('')

  const load = useCallback(async () => {
    if (!receiptId) return
    setLoading(true)
    setError('')
    try {
      const ev = await getReceipt(receiptId)
      setEvent(ev)
      setTasks(ev.tasks ?? [])
      setMissingMappings(ev.missing_mappings ?? [])
      setReviewNote(ev.review_note ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取收货事件失败')
    } finally {
      setLoading(false)
    }
  }, [receiptId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleApprove() {
    if (!event || busy) return
    const exceptions = Array.isArray(event.exceptions) ? event.exceptions : []
    if (exceptions.length > 0 && allowExceptions && !reviewNote.trim()) {
      setError('存在超收/额外行：批准必须填写复核说明（review_note）')
      return
    }
    if (exceptions.length > 0 && !allowExceptions) {
      setError('存在超收/额外行：请先逐条核对并勾选「确认例外」再批准')
      return
    }
    setBusy('approve')
    setError('')
    setNotice('')
    try {
      const ev = await approveReceipt({
        id: event.id,
        revision: event.revision,
        allow_exceptions: allowExceptions,
        review_note: reviewNote,
      })
      setEvent(ev)
      setNotice(`已批准放行（${receiptStatusBadge(ev.status).label}）。任务发布不等于 IRS 成功。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '批准失败（请刷新核对服务端状态）')
    } finally {
      setBusy('')
    }
  }

  async function handleRelease() {
    if (!event || busy) return
    if (!event.delivery_order_no) {
      setError('放行前必须有 Delivery Order No.（合同要求）：请先在草稿补充并重新提交')
      return
    }
    setBusy('release')
    setError('')
    setNotice('')
    try {
      const res = await releaseReceipt({ id: event.id })
      setEvent(res.event)
      setTasks(res.tasks.length > 0 ? res.tasks : (res.event.tasks ?? []))
      setMissingMappings(res.missing_mappings.length > 0 ? res.missing_mappings : (res.event.missing_mappings ?? []))
      if (res.missing_mappings.length > 0) {
        setNotice('等待映射（waiting_mapping）：这些来源 PO 还没有已验证的 IRS PO 编号，登记映射后才能放行。')
      } else {
        setNotice('已放行：本机任务已准备（未推送 IRS）。执行结果以本机回报为准。')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '放行失败（不要重复提交）')
    } finally {
      setBusy('')
    }
  }

  async function handleSaveMapping(poHeaderId: string) {
    const irsPoNo = (mappingIrs[poHeaderId] ?? '').trim()
    if (!irsPoNo) {
      setError('请填写 IRS PO No.（编号原样保存，不按数字格式猜）')
      return
    }
    setMappingBusy(poHeaderId)
    setError('')
    setNotice('')
    try {
      await setPoMapping({
        po_header_id: poHeaderId,
        irs_po_no: irsPoNo,
        evidence: {
          checked_by: identity.displayName || identity.email,
          checked_at: new Date().toISOString(),
          note: '页面登记（approver/admin）',
        },
      })
      setNotice('IRS PO 映射已登记。请重新点「放行」生成任务。')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '映射登记失败')
    } finally {
      setMappingBusy('')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载收货事件…
      </div>
    )
  }
  if (!event) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link to="/tj-po-system/receipts" className="text-sm text-slate-500 hover:underline">
          ← 返回收货列表
        </Link>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error || '收货事件不存在'}
        </div>
      </div>
    )
  }

  const badge = receiptStatusBadge(event.status)
  const canApproveNow =
    caps.canApprove && (event.status === 'submitted' || event.status === 'needs_review')
  const canReleaseNow =
    caps.canRelease && (event.status === 'approved' || event.status === 'waiting_mapping')

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/tj-po-system/receipts" className="text-xs text-slate-500 hover:underline">
            ← 返回收货列表
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">收货事件详情</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-mono text-[11px]" title={event.id}>{event.id}</span>
            <span className={`rounded-full px-2 py-0.5 font-medium ${badge.cls}`}>{badge.label}</span>
            <span className="rounded bg-slate-100 px-2 py-0.5">v{event.revision ?? 0}</span>
            {event.needs_review && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">需复核</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> 刷新
        </button>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      )}

      {event.needs_review && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">需复核（needs_review）</div>
          <p className="mt-1 text-xs">
            服务端未确认保存读回，或存在超收/额外行。不能当作已批准；请审批人核对后放行。
            {event.status_reason ? ` 原因：${event.status_reason}` : ''}
          </p>
        </div>
      )}
      {event.status_reason && !event.needs_review && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
          服务端状态说明：{event.status_reason}
        </div>
      )}

      {Array.isArray(event.exceptions) && event.exceptions.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">服务端异常（{event.exceptions.length}）</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {event.exceptions.map((x, i) => (
              <li key={`${x.code ?? 'x'}-${i}`}>
                {x.code ?? 'exception'}
                {x.detail ? `：${typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-3">
          <Field label="来源采购单">{event.po_numbers?.length ? event.po_numbers.join(' + ') : (event.po_ids ?? []).join(' + ') || '—'}</Field>
          <Field label="供应商">{event.supplier_name ? `${event.supplier_code ?? ''} ${event.supplier_name}` : '—'}</Field>
          <Field label="收货日期">{event.receive_date ?? '—'}</Field>
          <Field label="Invoice No.">{event.invoice_no || '—'}</Field>
          <Field label="Delivery Order">{event.delivery_order_no || '—'}</Field>
          <Field label="发票日期">{event.invoice_date || '—'}</Field>
          <Field label="核对人（登录身份）">{event.checked_by || '—'}</Field>
          <Field label="审批人">{event.approved_by || '—'}</Field>
          <Field label="批准时间">{fmt(event.approved_at)}</Field>
          <Field label="放行时间">{fmt(event.released_at)}</Field>
          <Field label="IRS PO No.">{event.irs_po_no || '（为空/未登记）'}</Field>
          <Field label="IRS GRN No.">{event.irs_grn_no || '（为空/未登记）'}</Field>
          <Field label="备注">{event.note || '—'}</Field>
        </dl>
      </section>

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">收货明细（{event.lines?.length ?? 0} 行）</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-left">描述</th>
                <th className="px-3 py-2 text-left">UOM</th>
                <th className="px-3 py-2 text-right">订购</th>
                <th className="px-3 py-2 text-right">实收</th>
                <th className="px-3 py-2 text-right">单价</th>
                <th className="px-3 py-2 text-left">来源分配（PO / 行 / 数量）</th>
                <th className="px-3 py-2 text-left">备注</th>
              </tr>
            </thead>
            <tbody>
              {(event.lines ?? []).map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-slate-500">{l.line_no}</td>
                  <td className="px-3 py-2 font-mono text-slate-800">{l.item_code}</td>
                  <td className="px-3 py-2 text-slate-600">{l.description}</td>
                  <td className="px-3 py-2 text-slate-500">{l.uom ?? ''}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{l.ordered_qty}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800">{l.accepted_qty}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{l.unit_price}</td>
                  <td className="px-3 py-2 text-slate-500">
                    {((l.sources ?? l.source_allocations ?? []).length === 0)
                      ? '（无来源，额外行）'
                      : (l.sources ?? l.source_allocations ?? []).map((a) => (
                          <div key={`${a.po_header_id}:${a.po_line_id}`} className="font-mono text-[10px]">
                            {a.po_header_id.slice(0, 8)}… / {a.po_line_id.slice(0, 8)}… × {a.accepted_qty}
                          </div>
                        ))}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{l.note || ''}</td>
                </tr>
              ))}
              {(event.lines ?? []).length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-slate-400">没有明细行（草稿）</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
          本机任务
          <span className="text-[11px] font-normal text-slate-400">任务发布不等于 IRS 成功，执行结果以本机回报为准</span>
        </h2>
        {tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-6 text-center text-xs text-slate-400">
            暂无任务（未放行或服务端未生成）
          </div>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((t) => {
              const tb = taskStatusBadge(t.status)
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs">
                  <span className="font-mono text-[10px] text-slate-500">{t.id.slice(0, 8)}…</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{tb.label}</span>
                  <span className="text-slate-400">原始状态：{t.status || '空'}</span>
                  {t.message ? <span className="text-slate-500">{t.message}</span> : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {canApproveNow && (
        <section className="mb-4 rounded-2xl border border-emerald-200 bg-white p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <ShieldCheck className="h-4 w-4 text-emerald-600" /> 审批放行（审批角色）
          </h2>
          <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={allowExceptions}
              onChange={(e) => setAllowExceptions(e.target.checked)}
              className="h-4 w-4 accent-emerald-600"
            />
            确认例外（超收/额外行）
          </label>
          <label className="mt-2 block text-xs font-medium text-slate-600">
            复核说明
            <input
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={busy !== ''}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 批准并放行
          </button>
        </section>
      )}

      {canReleaseNow && (
        <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">放行（执行角色）</h2>
          <p className="mt-1 text-xs text-slate-500">放行只生成本机任务；IRS 过账仍需本机回报，界面不会标成 IRS 成功。</p>
          <button
            type="button"
            onClick={() => void handleRelease()}
            disabled={busy !== ''}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
          >
            {busy === 'release' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 放行并生成本机任务
          </button>
        </section>
      )}

      {missingMappings.length > 0 && caps.canApprove && (
        <section className="mb-4 rounded-2xl border border-amber-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">待登记 IRS PO 映射（{missingMappings.length}）</h2>
          <p className="mt-1 text-xs text-slate-500">
            没有已验证映射时 release 只会把事件置为 waiting_mapping，不会生成任务。编号按原文保存，不按数字格式猜测。
          </p>
          <div className="mt-2 space-y-2">
            {missingMappings.map((poId) => (
              <div key={poId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-slate-500" title={poId}>{poId.slice(0, 8)}…</span>
                <input
                  value={mappingIrs[poId] ?? ''}
                  onChange={(e) => setMappingIrs((m) => ({ ...m, [poId]: e.target.value }))}
                  placeholder="IRS PO No."
                  className="w-40 rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveMapping(poId)}
                  disabled={mappingBusy !== ''}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
                >
                  {mappingBusy === poId ? '保存中…' : '登记映射'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {event.status === 'draft' && (
        <Link
          to={`/tj-po-system/receipts/${event.id}/edit`}
          className="inline-block rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          继续编辑草稿
        </Link>
      )}

      <p className="mt-4 text-[11px] text-slate-400">
        操作人：{identity.displayName || identity.email}。真实权限由服务器强制，本页按钮只是显示控制。
      </p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-400">{label}</dt>
      <dd className="text-slate-700">{children}</dd>
    </div>
  )
}
