import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { approveReceipt, getReceipt, releaseReceipt, setPoMapping } from '@/lib/tjGrApi'
import {
  buildMappingEvidence,
  documentNumbersPresent,
  receiptRedoLock,
  receiptStatusBadge,
  taskStatusBadge,
} from '@/lib/core/gr-form.js'
import type { GrCapabilities } from '@/lib/core/gr-form.js'
import type { GrIdentity } from '@/lib/grAuth'
import type { GrReceiptEvent, GrTask } from '@/types/tjGr'
import { exceptionLabel, warningLabel } from '@/lib/core/ui-labels.js'

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function fmt(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function warningText(w: unknown): string {
  if (typeof w === 'string') return warningLabel(w)
  if (w && typeof w === 'object') {
    const o = w as Record<string, unknown>
    const code = String(o.code ?? 'warning')
    const detail = o.detail ?? o.message
    const label = warningLabel(code) ?? exceptionLabel(code)
    return detail && detail !== code ? `${label}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : label
  }
  return String(w ?? '')
}

interface MappingDraft {
  irsPoNo: string
  evidenceRef: string
  method: string
  confirmed: boolean
}

const EMPTY_MAPPING: MappingDraft = { irsPoNo: '', evidenceRef: '', method: '', confirmed: false }

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
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, MappingDraft>>({})
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

  const redoLock = receiptRedoLock(event)

  async function handleApprove() {
    if (!event || busy) return
    if (redoLock) {
      setError(redoLock.message)
      return
    }
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
      setNotice(`已批准（${receiptStatusBadge(ev.status).label}）。任务发布不等于 IRS 成功。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '批准失败（请刷新核对服务端状态）')
    } finally {
      setBusy('')
    }
  }

  async function handleRelease() {
    if (!event || busy) return
    if (redoLock) {
      setError(redoLock.message)
      return
    }
    if (!documentNumbersPresent(event)) {
      setError(
        '放行前必须至少有一项发票号码或送货单号（两者都空只能存草稿）：请先补充并重新提交',
      )
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

  function patchMapping(poId: string, patch: Partial<MappingDraft>) {
    setMappingDrafts((m) => ({ ...m, [poId]: { ...(m[poId] ?? EMPTY_MAPPING), ...patch } }))
  }

  async function handleSaveMapping(poHeaderId: string) {
    const draft = mappingDrafts[poHeaderId] ?? EMPTY_MAPPING
    // 编号原样保存：trim 只用来判空，不改写号码
    if (!draft.irsPoNo.trim()) {
      setError('请填写 IRS PO No.（编号原样保存，不按数字格式猜）')
      return
    }
    let evidence: ReturnType<typeof buildMappingEvidence>
    try {
      evidence = buildMappingEvidence({
        checkedBy: identity.displayName || identity.email,
        evidenceRef: draft.evidenceRef,
        method: draft.method,
        confirmed: draft.confirmed,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '映射证据不足')
      return
    }
    setMappingBusy(poHeaderId)
    setError('')
    setNotice('')
    try {
      await setPoMapping({
        po_header_id: poHeaderId,
        irs_po_no: draft.irsPoNo,
        evidence,
      })
      setNotice('IRS PO 映射已登记（含可核查证据）。请重新点「放行」生成任务。')
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
    caps.canApprove && !redoLock && (event.status === 'submitted' || event.status === 'needs_review')
  const canReleaseNow =
    caps.canRelease &&
    !redoLock &&
    (event.status === 'approved' || event.status === 'waiting_mapping')
  const canEditNow =
    !redoLock && (event.status === 'draft' || event.status === 'needs_review')
  const warnings = Array.isArray(event.warnings) ? event.warnings : []
  const extraLines = (event.lines ?? []).filter(
    (l) => (l.sources ?? l.source_allocations ?? []).length === 0,
  )
  // IRS 实际编号只来自任务回报；表头旧 irs_* 值不是放行/过账结果
  const reportedTasks = tasks.filter((t) => t.irs_po_no || t.irs_grn_no)

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/tj-po-system/receipts" className="text-xs text-slate-500 hover:underline">
            ← 返回收货列表
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">收货详情</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-mono text-sm font-semibold text-slate-900" title={event.id}>
              {event.event_no || shortId(event.id)}
            </span>
            <span className={`rounded-full px-2 py-0.5 font-medium ${badge.cls}`}>{badge.label}</span>
            {event.review_required && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">需要人工检查</span>
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

      {redoLock && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">人工核对，不可重做</div>
          <p className="mt-1 text-xs">{redoLock.message}</p>
        </div>
      )}

      {event.review_required && !redoLock && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">需要人工检查</div>
          <p className="mt-1 text-xs">
            这次收货里发现了需要人工核对的情况（超收 / 额外货品 / 单据号码可能重复）：不能当作已批准，请审批人逐条核对后处理。
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <div className="font-semibold">需要注意的问题</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {warnings.map((w, i) => (
              <li key={i}>{warningText(w)}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(event.exceptions) && event.exceptions.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">需要确认的例外（{event.exceptions.length}）</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {event.exceptions.map((x, i) => (
              <li key={`${x.code ?? 'x'}-${i}`}>
                {exceptionLabel(x.code)}
                {x.detail ? `：${typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {extraLines.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          有 {extraLines.length} 行没有可核实的原采购单明细（额外货品）：审批可保留，但放行会被服务端阻止，需人工指定来源，界面不会把漏行当作成功。
        </div>
      )}

      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-3">
          <Field label="来源采购单">{(event.po_ids ?? []).join(' + ') || '—'}</Field>
          <Field label="供应商">{event.supplier_name ? `${event.supplier_code ?? ''} ${event.supplier_name}` : '—'}</Field>
          <Field label="收货日期">{event.receive_date ?? '—'}</Field>
          <Field label="发票号码">{event.invoice_no || '—'}</Field>
          <Field label="送货单号">{event.delivery_order_no || '—'}</Field>
          <Field label="发票日期">{event.invoice_date || '—'}</Field>
          <Field label="核对人（登录身份）">{event.checked_by || '—'}</Field>
          <Field label="审批人">{event.approved_by || '—'}</Field>
          <Field label="批准时间">{fmt(event.approved_at)}</Field>
          <Field label="放行时间">{fmt(event.released_at)}</Field>
          <Field label="异常数">{typeof event.exception_count === 'number' ? event.exception_count : (event.exceptions?.length ?? 0)}</Field>
          <Field label="备注">{event.note || '—'}</Field>
        </dl>
        <p className="mt-2 text-[11px] text-slate-400">
          放行条件：发票号码与送货单号至少一项（号码原样保存）；两者都空只能存草稿。
          IRS 实际编号以本机任务回报为准，不读表头旧值。
        </p>
      </section>

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">商品核对（{event.lines?.length ?? 0} 行）</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">商品编号</th>
                <th className="px-3 py-2 text-left">描述</th>
                <th className="px-3 py-2 text-left">单位</th>
                <th className="px-3 py-2 text-right">订购（整单）</th>
                <th className="px-3 py-2 text-right">本批实收</th>
                <th className="px-3 py-2 text-right">单价</th>
                <th className="px-3 py-2 text-left">来源</th>
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
                      ? '额外货品（无来源）'
                      : `${(l.sources ?? l.source_allocations ?? []).length} 个来源`}
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
        <p className="mt-1 text-[11px] text-slate-400">
          订购数量是整张采购单的订购量（分批收货时每一批都显示完整订购量作为参照），本批实收是这次实际收到的数量；累计剩余由系统在批准时按来源行核对。
        </p>
      </section>

      <section className="mb-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
          系统处理进度
          <span className="text-[11px] font-normal text-slate-400">不等于 IRS 已过账，结果以系统回报为准</span>
        </h2>
        {tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-6 text-center text-xs text-slate-400">
            暂无进度（未放行或系统未生成任务）
          </div>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((t) => {
              const tb = taskStatusBadge(t.status)
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{tb.label}</span>
                  {t.irs_po_no && <span className="text-slate-600">IRS 采购单编号：{t.irs_po_no}</span>}
                  {t.irs_grn_no && <span className="text-slate-600">IRS 收货单编号：{t.irs_grn_no}</span>}
                  {t.last_error ? <span className="text-red-600">{t.last_error}</span> : null}
                </li>
              )
            })}
          </ul>
        )}
        {reportedTasks.length > 0 && (
          <p className="mt-2 text-[11px] text-slate-400">
            IRS 编号来自系统回报，不是表头历史字段；仍需人工核对是否真正过账。
          </p>
        )}
      </section>

      {canApproveNow && (
        <section className="mb-4 rounded-2xl border border-emerald-200 bg-white p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <ShieldCheck className="h-4 w-4 text-emerald-600" /> 批准收货
          </h2>
          {/* 只有真实存在超收/额外货品时，才出现例外确认；正常收货不要求勾选 */}
          {Array.isArray(event.exceptions) && event.exceptions.length > 0 && (
            <>
              <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={allowExceptions}
                  onChange={(e) => setAllowExceptions(e.target.checked)}
                  className="h-4 w-4 accent-emerald-600"
                />
                我已确认超收 / 额外货品的情况
              </label>
              <label className="mt-2 block text-xs font-medium text-slate-600">
                复核说明（必填）
                <input
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
            </>
          )}
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={busy !== ''}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 批准收货
          </button>
        </section>
      )}

      {canReleaseNow && (
        <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">放行（交给系统处理）</h2>
          <p className="mt-1 text-xs text-slate-500">放行只生成本机任务；IRS 是否过账以系统回报为准，界面不会标成 IRS 成功。</p>
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

      {missingMappings.length > 0 && caps.canApprove && !redoLock && (
        <section className="mb-4 rounded-2xl border border-amber-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-700">待登记 IRS PO 映射（{missingMappings.length}）</h2>
          <p className="mt-1 text-xs text-slate-500">
            编号按原文保存，不按数字格式猜测。证据必须是可核查的：填写证据编号与核验方式，并明确确认已核对
            （只写「页面登记」+ 当前时间不算核验证据）。
          </p>
          <div className="mt-2 space-y-3">
            {missingMappings.map((poId) => {
              const draft = mappingDrafts[poId] ?? EMPTY_MAPPING
              const ready = draft.irsPoNo.trim() && draft.evidenceRef.trim() && draft.method.trim() && draft.confirmed
              return (
                <div key={poId} className="rounded-xl border border-slate-200 p-3">
                  <div className="font-mono text-xs text-slate-500" title={poId}>{poId.slice(0, 8)}…</div>
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <label className="block text-[11px] text-slate-500">
                      IRS PO No.（原样）
                      <input
                        value={draft.irsPoNo}
                        onChange={(e) => patchMapping(poId, { irsPoNo: e.target.value })}
                        placeholder="例如 5 / PO-A01"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                      />
                    </label>
                    <label className="block text-[11px] text-slate-500">
                      可核查证据（截图/单号/文件）
                      <input
                        value={draft.evidenceRef}
                        onChange={(e) => patchMapping(poId, { evidenceRef: e.target.value })}
                        placeholder="例如 IRS 页面截图 20261113-01 / 纸单号"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                      />
                    </label>
                    <label className="block text-[11px] text-slate-500">
                      核验方式
                      <input
                        value={draft.method}
                        onChange={(e) => patchMapping(poId, { method: e.target.value })}
                        placeholder="例如 IRS 系统查询 / 纸质单据核对"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                      />
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        checked={draft.confirmed}
                        onChange={(e) => patchMapping(poId, { confirmed: e.target.checked })}
                        className="h-3.5 w-3.5 accent-emerald-600"
                      />
                      我已核对 IRS 采购单编号与证据一致
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleSaveMapping(poId)}
                      disabled={mappingBusy !== '' || !ready}
                      className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
                    >
                      {mappingBusy === poId ? '保存中…' : '登记映射'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {canEditNow && (
        <Link
          to={`/tj-po-system/receipts/${event.id}/edit`}
          className="inline-block rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          继续编辑草稿
        </Link>
      )}

      {/* 技术详情：内部编号 / 版本 / 来源明细 / 哈希，普通员工默认不展开；管理员/排障可查看复制 */}
      <details className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <summary className="cursor-pointer select-none text-xs font-medium text-slate-500 hover:text-slate-700">
          技术详情 / 审计记录
        </summary>
        <div className="mt-2 space-y-1 font-mono text-[11px] text-slate-500">
          <div>收货记录内部编号：{event.id}</div>
          <div>版本 revision：{event.revision ?? 0}</div>
          {event.payload_sha256 && <div>内容哈希：{event.payload_sha256}</div>}
          <div>来源采购单：{(event.po_ids ?? []).join(', ') || '—'}</div>
          <div>操作人 ID：{identity.userId || identity.email || '—'}</div>
          {(event.lines ?? []).map((l) => (
            <div key={l.id}>
              行 {l.line_no} 来源：
              {((l.sources ?? l.source_allocations ?? []).length === 0)
                ? '无（额外货品）'
                : (l.sources ?? l.source_allocations ?? []).map((a) => ` ${a.po_header_id}/${a.po_line_id}×${a.accepted_qty}`).join('；')}
            </div>
          ))}
          <div>完整任务/审计信息见服务端 tj_gr_tasks / tj_gr_audit（本页不删减底层数据）。</div>
        </div>
      </details>

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
