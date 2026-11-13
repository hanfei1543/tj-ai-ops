import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Save, Send } from 'lucide-react'
import { getPo } from '@/lib/tjPoApi'
import { approveReceipt, getReceipt, listReceipts, releaseReceipt, saveReceipt, submitReceipt } from '@/lib/tjGrApi'
import { GrApiError } from '@/lib/grRpc'
import {
  addDecimalStrings,
  buildReceiptSavePayload,
  compareDecimalStrings,
  createReceiptDraftSession,
  documentNumbersPresent,
  isReceivablePoStatus,
  receiptRedoLock,
  receiptStatusBadge,
  validateReceiptForm,
} from '@/lib/core/gr-form.js'
import { buildReceiptAllocations, sumAllocationQty } from '@/lib/core/po-input.js'
import type { GrCapabilities, GrFormHeader, GrFormLine, ReceiptDraftSession } from '@/lib/core/gr-form.js'
import type { GrIdentity } from '@/lib/grAuth'
import type { PoWithLines } from '@/types/tjPo'
import type { GrReceiptEvent } from '@/types/tjGr'

function newUuid(): string {
  return crypto.randomUUID()
}

function emptyHeader(checkedBy: string): GrFormHeader {
  return {
    invoice_no: '',
    delivery_order_no: '',
    receive_date: '',
    invoice_date: null,
    checked_by: checkedBy,
    note: '',
  }
}

/**
 * 从 PO 行生成收货行。
 * defaultAccepted=false（该 PO 已有历史收货 = 非首批）时不预填满额：
 * 实收必须由人按本批实际情况填写，避免「第二次默认全收」。
 */
function linesFromPo(po: PoWithLines, { defaultAccepted }: { defaultAccepted: boolean }): GrFormLine[] {
  return po.lines.map((l, i) => {
    const ordered = String(l.original_qty ?? l.qty ?? '')
    const allocations = buildReceiptAllocations(po, l, { defaultAccepted })
    const accepted = defaultAccepted
      ? allocations.length > 0
        ? sumAllocationQty(allocations)
        : ordered
      : ''
    return {
      id: newUuid(),
      line_no: l.line_no ?? i + 1,
      item_code: l.item_code,
      description: l.description,
      uom: l.uom ?? null,
      unit_price: String(l.unit_price ?? ''),
      ordered_qty: ordered,
      accepted_qty: accepted,
      note: l.note ?? '',
      source_allocations: allocations,
    }
  })
}

function draftStorage(): Storage {
  try {
    return window.sessionStorage
  } catch {
    throw new Error('浏览器禁用了 sessionStorage：无法安全保存草稿身份，已停止（避免重复建单）')
  }
}

/**
 * 保存遇到「会话已有草稿/版本冲突」时，读取服务端真实草稿并恢复会话身份；
 * 恢复不了就保持原错误（不本地猜测 id/revision）。
 */
async function recoverDraft(
  session: ReceiptDraftSession,
  err: unknown,
): Promise<GrReceiptEvent | null> {
  if (!(err instanceof GrApiError)) return null
  const detail = (err.detail ?? null) as Record<string, unknown> | null
  const candidate = [detail?.receipt_id, detail?.draft_id, detail?.id].find(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  if (candidate) {
    const ev = await getReceipt(candidate).catch(() => null)
    if (ev && (ev.status === 'draft' || ev.status === 'needs_review')) return ev
  }
  if (err.code === 'GR_REVISION_CONFLICT' || err.code === 'GR_IDEMPOTENCY_CONFLICT') {
    const ev = await getReceipt(session.receiptId).catch(() => null)
    if (ev && ev.status === 'draft') return ev
  }
  return null
}

export default function ReceiptFormPage({ identity, caps }: { identity: GrIdentity; caps: GrCapabilities }) {
  const { receiptId: receiptIdParam } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()

  const requestedPoIds = useMemo(
    () => (params.get('po_ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    [params],
  )

  const [targets, setTargets] = useState<PoWithLines[]>([])
  const [header, setHeader] = useState<GrFormHeader>(emptyHeader(identity.displayName || identity.email))
  const [lines, setLines] = useState<GrFormLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'submit'>('')
  const [event, setEvent] = useState<GrReceiptEvent | null>(null)
  const [revision, setRevision] = useState(0)
  const [allowExceptions, setAllowExceptions] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  // 非首批（该 PO 已有历史收货）：不预填满额，提示按本次实收确认
  const [secondBatchPoIds, setSecondBatchPoIds] = useState<string[]>([])

  const sessionRef = useRef<ReceiptDraftSession | null>(null)
  const [sessionReady, setSessionReady] = useState(false)

  const checkedBy = identity.displayName || identity.email
  const targetPoIds = targets.map((p) => p.id)

  // 载入：编辑模式从 DB 恢复事件；新建模式从 PO 读取（冻结字段只读，不重写）
  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        if (receiptIdParam) {
          const ev = await getReceipt(receiptIdParam)
          if (!mounted) return
          setEvent(ev)
          setRevision(ev.revision ?? 0)
          setHeader({
            invoice_no: ev.invoice_no ?? '',
            delivery_order_no: ev.delivery_order_no ?? '',
            receive_date: ev.receive_date ?? '',
            invoice_date: ev.invoice_date ?? null,
            checked_by: ev.checked_by || checkedBy,
            note: ev.note ?? '',
          })
          const evLines: GrFormLine[] = (ev.lines ?? []).map((l, i) => ({
            id: l.id,
            line_no: l.line_no ?? i + 1,
            item_code: l.item_code,
            description: l.description,
            uom: l.uom ?? null,
            unit_price: String(l.unit_price ?? ''),
            ordered_qty: String(l.ordered_qty ?? ''),
            accepted_qty: String(l.accepted_qty ?? ''),
            note: l.note ?? '',
            // 合同：输出字段是 sources（输入才叫 source_allocations）
            source_allocations: l.sources ?? l.source_allocations ?? [],
          }))
          setLines(evLines)
          const poIds = ev.po_ids ?? []
          const headers: PoWithLines[] = []
          for (const id of poIds) {
            const po = await getPo(id)
            headers.push(po)
          }
          if (mounted) setTargets(headers)
        } else {
          if (requestedPoIds.length === 0) throw new Error('未选择要收货的采购单')
          const headers: PoWithLines[] = []
          for (const id of requestedPoIds) headers.push(await getPo(id))
          const bad = headers.filter((p) => !isReceivablePoStatus(p.status))
          if (bad.length > 0) {
            throw new Error(
              `采购单 ${bad.map((p) => `${p.po_id}（${p.status}）`).join('、')} 当前状态不能登记收货`,
            )
          }

          // 已有历史收货判定：按 PO 自身 + 合并单来源原始 PO 查询服务端事件（不猜本地缓存）。
          // 查询失败按「已有收货」处理：宁可不预填，也不默认全收。
          const queryIds = new Set<string>()
          for (const po of headers) {
            queryIds.add(po.id)
            for (const l of po.lines ?? []) {
              for (const r of l.source_refs ?? []) if (r.po_id) queryIds.add(r.po_id)
            }
          }
          const priorIds = new Set<string>()
          await Promise.all(
            Array.from(queryIds).map(async (id) => {
              try {
                const evs = await listReceipts({ po_id: id })
                if (evs.length > 0) priorIds.add(id)
              } catch {
                priorIds.add(id)
              }
            }),
          )
          const secondBatch = headers
            .filter((po) => {
              if (priorIds.has(po.id)) return true
              return (po.lines ?? []).some((l) =>
                (l.source_refs ?? []).some((r) => !!r.po_id && priorIds.has(r.po_id)),
              )
            })
            .map((po) => po.id)

          if (!mounted) return
          setSecondBatchPoIds(secondBatch)
          setTargets(headers)
          setLines(
            headers.flatMap((p) =>
              linesFromPo(p, { defaultAccepted: !secondBatch.includes(p.id) }),
            ),
          )
        }
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [receiptIdParam, requestedPoIds, checkedBy])

  // 草稿身份：按 selectedPO 集合持久（初次保存前就落 sessionStorage）；只初始化一次
  const sessionInitRef = useRef('')
  useEffect(() => {
    if (loading || error) return
    const initKey = receiptIdParam
      ? `edit:${receiptIdParam}:${event?.id ?? ''}:${targetPoIds.join(',')}`
      : targetPoIds.join(',')
    if (!initKey || sessionInitRef.current === initKey) return
    sessionInitRef.current = initKey
    if (receiptIdParam) {
      // 恢复既有草稿：沿用服务端 UUID/revision
      if (targetPoIds.length === 0) return
      sessionRef.current = createReceiptDraftSession({
        storage: draftStorage(),
        poIds: targetPoIds,
        seed: event ? { receipt_id: event.id, revision: event.revision } : null,
      })
    } else {
      if (targetPoIds.length === 0) return
      sessionRef.current = createReceiptDraftSession({ storage: draftStorage(), poIds: targetPoIds })
    }
    setRevision(sessionRef.current.revision)
    setSessionReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, receiptIdParam, targetPoIds.join(','), event?.id])

  const validation = validateReceiptForm({ header, lines, identity })
  // 已放行/已建任务/verified：不可重做（服务端同样会拒绝）
  const redoLock = receiptRedoLock(event)
  const editable =
    !event || ((event.status === 'draft' || event.status === 'needs_review') && !redoLock)
  const extraLines = lines.filter((l) => l.source_allocations.length === 0)

  function updateHeader(patch: Partial<GrFormHeader>) {
    setHeader((h) => ({ ...h, ...patch }))
  }

  function updateLine(id: string, patch: Partial<GrFormLine>) {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  function updateAccepted(line: GrFormLine, raw: string) {
    if (line.source_allocations.length <= 1) {
      updateLine(line.id, {
        accepted_qty: raw,
        source_allocations:
          line.source_allocations.length === 1
            ? [{ ...line.source_allocations[0], accepted_qty: raw }]
            : line.source_allocations,
      })
    } else {
      updateLine(line.id, { accepted_qty: raw })
    }
  }

  function updateAllocation(line: GrFormLine, index: number, raw: string) {
    const next = line.source_allocations.map((a, i) => (i === index ? { ...a, accepted_qty: raw } : a))
    let total = ''
    if (next.every((a) => a.accepted_qty.trim() !== '')) {
      try {
        total = addDecimalStrings(next.map((a) => a.accepted_qty))
      } catch {
        total = ''
      }
    }
    updateLine(line.id, { source_allocations: next, accepted_qty: total })
  }

  function currentPayload() {
    const session = sessionRef.current
    if (!session) throw new Error('草稿会话尚未就绪，请刷新后重试（不会重复建单）')
    return buildReceiptSavePayload({
      receiptId: session.receiptId,
      revision: session.revision,
      selectedPoIds: targetPoIds,
      header,
      lines,
    })
  }

  /** 保存草稿；遇到会话已有草稿/版本冲突时从服务端恢复 id/revision 后重试一次 */
  const persistDraft = useCallback(
    async (session: ReceiptDraftSession): Promise<{ ev: GrReceiptEvent; restored: boolean }> => {
      try {
        return { ev: await saveReceipt(currentPayload()), restored: false }
      } catch (e) {
        const draft = await recoverDraft(session, e)
        if (!draft) throw e
        session.adoptDraft({ receipt_id: draft.id, revision: draft.revision })
        setRevision(session.revision)
        return { ev: await saveReceipt(currentPayload()), restored: true }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [header, lines, targetPoIds],
  )

  const saveDraft = useCallback(async (): Promise<GrReceiptEvent | null> => {
    const session = sessionRef.current
    if (!session) {
      setError('草稿会话尚未就绪')
      return null
    }
    if (redoLock) {
      setError(redoLock.message)
      return null
    }
    const v = validateReceiptForm({ header, lines, identity })
    if (!v.ok) {
      setError(v.errors.slice(0, 5).map((e) => e.message).join('；'))
      return null
    }
    if (!session.begin('save')) return null
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const { ev, restored } = await persistDraft(session)
      session.saveResult(ev)
      setRevision(session.revision)
      setEvent(ev)
      const prefix = restored ? '已恢复服务端草稿并保存。' : ''
      setNotice(
        ev.review_required
          ? `${prefix}草稿已保存（版本 ${session.revision}），但服务端标记需复核（review_required）：请审批人核对后再提交/放行。`
          : `${prefix}草稿已保存（版本 ${session.revision}）。余量以服务端为准，刷新后可从数据库恢复。`,
      )
      return ev
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败（保存未读回，不能当作成功）')
      return null
    } finally {
      session.end()
      setBusy('')
    }
  }, [header, lines, identity, redoLock, persistDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(release: boolean) {
    const session = sessionRef.current
    if (!session) return
    if (redoLock) {
      setError(redoLock.message)
      return
    }
    const v = validateReceiptForm({ header, lines, identity })
    if (!v.canSubmit) {
      setError(v.submit_blocked_reason || v.errors.map((e) => e.message).join('；'))
      return
    }
    if (release && !caps.canApprove) {
      setError('当前身份没有审批角色：不能放行')
      return
    }
    if (release && !documentNumbersPresent(header)) {
      setError(
        '放行前必须至少填写 Invoice No. 或 Delivery Order No.（IRS 发票号以 Invoice No. 为准，号码原样保存；两者都空只能存草稿）',
      )
      return
    }
    if (v.requires_exception_approval && release && !allowExceptions) {
      setError('存在超收/额外行：请先勾选「确认例外」再放行（正常收货不需要）')
      return
    }
    if (v.requires_exception_approval && release && !reviewNote.trim()) {
      setError('存在超收/额外行：放行必须填写复核说明（review_note）')
      return
    }
    if (!session.begin('submit')) return
    setBusy('submit')
    setError('')
    setNotice('')
    try {
      const { ev: saved } = await persistDraft(session)
      session.saveResult(saved)
      setEvent(saved)

      const submitted = await submitReceipt({ id: session.receiptId, revision: session.revision })
      session.submitResult(submitted)
      setRevision(submitted.revision)
      setEvent(submitted)

      if (submitted.status === 'waiting_mapping') {
        const badge = receiptStatusBadge(submitted.status)
        throw new Error(`服务端状态 ${badge.label}，不能自动放行：请先登记映射后重试`)
      }

      if (release) {
        if (submitted.review_required && !allowExceptions) {
          throw new Error('服务端标记需复核（review_required）：请勾选「确认例外」并填写复核说明后再放行')
        }
        if (submitted.review_required && !reviewNote.trim()) {
          throw new Error('存在异常：放行必须填写复核说明（review_note）')
        }
        if (!documentNumbersPresent(header)) {
          throw new Error('放行前必须至少填写 Invoice No. 或 Delivery Order No.（合同要求，不能都空）')
        }
        const approved = await approveReceipt({
          id: submitted.id,
          revision: submitted.revision,
          allow_exceptions: allowExceptions,
          review_note: reviewNote,
        })
        setEvent(approved)
        setRevision(approved.revision)

        // 一键放行：批准后立即 release；缺映射时服务端返回 waiting_mapping（不是错误）
        const released = await releaseReceipt({ id: approved.id })
        setEvent(released.event)
        setRevision(released.event.revision)
        if (released.missing_mappings.length > 0) {
          setNotice(
            `已批准，但等待映射（waiting_mapping）：${released.missing_mappings.length} 个来源 PO 缺少已验证的 IRS PO 编号。登记映射后才能生成本机任务。`,
          )
        } else {
          setNotice('已提交并放行：本机任务已准备（未推送 IRS）。执行结果以本机回报为准。')
        }
      } else {
        setNotice(`已提交（状态：${receiptStatusBadge(submitted.status).label}）。等待审批，不会自动推送 IRS。`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败（请刷新核对服务端状态，不要重复提交）')
    } finally {
      session.end()
      setBusy('')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载采购单…
      </div>
    )
  }

  if (error && targets.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link to="/tj-po-system/receipts" className="text-sm text-slate-500 hover:underline">
          ← 返回收货列表
        </Link>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    )
  }

  const anySecondBatch = targets.some((p) => secondBatchPoIds.includes(p.id))

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> 返回
          </button>
          <h1 className="text-2xl font-bold text-slate-900">登记本次收货</h1>
          <p className="text-sm text-slate-500">
            {targets.length > 0 ? targets.map((p) => p.po_id).join(' + ') : '收货事件'}
            {targets[0]?.po_type === 'combined' ? '（合并单，来源行按原始 PO 行 UUID 分配）' : ''}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>收货单 UUID</div>
          <div className="font-mono text-[11px] text-slate-700">{sessionRef.current?.receiptId ?? '…'}</div>
          <div className="mt-0.5">版本 v{revision}</div>
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {redoLock && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">人工核对，不可重做</div>
          <p className="mt-1 text-xs">{redoLock.message}</p>
        </div>
      )}
      {!editable && !redoLock && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          该收货事件状态为 {receiptStatusBadge(event?.status).label}，已不能在此编辑。
          <Link to={`/tj-po-system/receipts/${event?.id}`} className="ml-2 font-semibold underline">
            查看详情
          </Link>
        </div>
      )}

      {/* 来源采购单 */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="text-xs font-medium text-slate-500">来源采购单（冻结字段只读，不在收货时改写）</div>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {targets.map((p) => {
            const badge = receiptStatusBadge(p.status)
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{p.po_id}</span>
                <span className="text-slate-500">{p.supplier_code} · {p.supplier_name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>
                {p.po_type === 'combined' && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700">合并单</span>
                )}
                {secondBatchPoIds.includes(p.id) && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    已有收货记录 · 本批不预填
                  </span>
                )}
              </li>
            )
          })}
          {targets.length === 0 && <li className="text-slate-400">（事件来源未返回）</li>}
        </ul>
        {anySecondBatch && (
          <p className="mt-2 text-xs text-amber-700">
            该采购单已有历史收货：实收数量默认留空，请按本次实际到货逐行填写（累计余量由服务端批准时按来源行校验）。
          </p>
        )}
      </section>

      {/* 收货资料：员工只填这些 */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block text-xs font-medium text-slate-600">
            Invoice No.（IRS 发票号，原样保存）
            <input
              value={header.invoice_no}
              onChange={(e) => updateHeader({ invoice_no: e.target.value })}
              disabled={!editable}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Delivery Order No.
            <input
              value={header.delivery_order_no}
              onChange={(e) => updateHeader({ delivery_order_no: e.target.value })}
              disabled={!editable}
              placeholder="例如 D-021660"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            收货日期（必选，不用提交时间代替）
            <input
              type="date"
              value={header.receive_date}
              onChange={(e) => updateHeader({ receive_date: e.target.value })}
              disabled={!editable}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            发票日期（可选）
            <input
              type="date"
              value={header.invoice_date ?? ''}
              onChange={(e) => updateHeader({ invoice_date: e.target.value || null })}
              disabled={!editable}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            核对人（自动来自登录）
            <input
              value={header.checked_by}
              readOnly
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            备注（差异说明）
            <input
              value={header.note}
              onChange={(e) => updateHeader({ note: e.target.value })}
              disabled={!editable}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Invoice No. 与 Delivery Order No. 至少填写一项才能提交/放行；两者都空只能保存草稿。
          号码按原样保存（trim 只用于判空，不改写发票/送货单号）。
        </p>
      </section>

      {/* 明细 */}
      <section className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">收货明细（只需填实收数量）</h2>
          <span className="text-xs text-slate-400">不同 Item / UOM / 单价不合并；单价只读</span>
        </div>
        <div className="hidden grid-cols-[1.2fr_1.6fr_70px_90px_90px_1fr_1.2fr] gap-2 px-2 pb-1 text-xs text-slate-400 md:grid">
          <span>商品编号</span>
          <span>描述</span>
          <span>UOM</span>
          <span className="text-right">订购</span>
          <span className="text-right">实收</span>
          <span className="text-right">单价</span>
          <span>差异备注</span>
        </div>
        <div className="space-y-2">
          {lines.map((l) => {
            const over = validateOver(l)
            return (
              <div key={l.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-[1.2fr_1.6fr_70px_90px_90px_1fr_1.2fr] md:items-center">
                  <div className="font-mono text-sm text-slate-800">{l.item_code}</div>
                  <div className="truncate text-sm text-slate-600">{l.description}</div>
                  <div className="text-xs text-slate-500">{l.uom ?? ''}</div>
                  <div className="text-right text-sm text-slate-600">{l.ordered_qty}</div>
                  <div>
                    <input
                      value={l.accepted_qty}
                      onChange={(e) => updateAccepted(l, e.target.value)}
                      disabled={!editable || l.source_allocations.length > 1}
                      inputMode="decimal"
                      placeholder={editable ? '本批实收' : ''}
                      title={l.source_allocations.length > 1 ? '多来源行：实收 = 下方来源分配合计' : ''}
                      className={`w-full rounded-lg border px-2 py-1.5 text-right text-sm outline-none ${
                        over ? 'border-amber-300 bg-amber-50' : 'border-slate-300 focus:border-emerald-500'
                      } ${l.source_allocations.length > 1 ? 'bg-slate-50' : ''}`}
                    />
                  </div>
                  <div className="text-right text-sm text-slate-600">{l.unit_price}</div>
                  <input
                    value={l.note}
                    onChange={(e) => updateLine(l.id, { note: e.target.value })}
                    disabled={!editable}
                    placeholder={over > 0 ? `超出订购 ${l.accepted_qty}` : '短缺/损坏/替代'}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
                  />
                </div>

                {/* 多来源行：逐条来源分配，合计必须等于实收 */}
                {l.source_allocations.length > 1 && (
                  <div className="mt-2 rounded-lg bg-slate-50 p-2">
                    <div className="mb-1 text-[11px] font-medium text-slate-500">来源分配（合计必须等于实收）</div>
                    <div className="space-y-1">
                      {l.source_allocations.map((a, ai) => (
                        <div key={`${a.po_header_id}:${a.po_line_id}`} className="flex items-center gap-2 text-xs text-slate-500">
                          <span className="min-w-0 flex-1 truncate font-mono" title={`${a.po_header_id} / ${a.po_line_id}`}>
                            {a.po_header_id.slice(0, 8)}… / {a.po_line_id.slice(0, 8)}…
                          </span>
                          <input
                            value={a.accepted_qty}
                            onChange={(e) => updateAllocation(l, ai, e.target.value)}
                            disabled={!editable}
                            inputMode="decimal"
                            placeholder="本批"
                            className="w-20 rounded border border-slate-300 px-2 py-1 text-right"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {l.source_allocations.length === 0 && (
                  <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                    无可核实的原 PO 来源分配：可先保存/提交，但放行会被服务端阻止
                    （GR_EXTRA_ASSIGNMENT_REQUIRED），需人工指定来源。
                  </div>
                )}
              </div>
            )
          })}
          {lines.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white py-8 text-center text-sm text-slate-500">
              没有可收货行：可以保存草稿，但不会形成正式 GR，也不能提交。
            </div>
          )}
        </div>
      </section>

      {validation.exceptions.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">需要审批复核的例外</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {validation.exceptions.map((x) => (
              <li key={`${x.code}-${x.line_no ?? ''}`}>{x.message}</li>
            ))}
          </ul>
        </div>
      )}

      {extraLines.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          有 {extraLines.length} 行没有可核实的原 PO 来源：审批可保留这些行，但服务端放行时会以
          GR_EXTRA_ASSIGNMENT_REQUIRED 阻止（需人工指定来源/确认无法自动过账），界面不会把漏行当作成功。
        </div>
      )}

      {caps.canApprove && editable && (
        <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={allowExceptions}
              onChange={(e) => setAllowExceptions(e.target.checked)}
              className="h-4 w-4 accent-emerald-600"
            />
            确认例外（超收/额外行）并允许放行
          </label>
          <label className="mt-2 block text-xs font-medium text-slate-600">
            复核说明（审批记录）
            <input
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <p className="mt-1 text-[11px] text-slate-400">审批仅代表内部放行；任务发布不等于 IRS 成功。</p>
        </section>
      )}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:mx-0">
        <div className="text-xs text-slate-500">
          {validation.canSubmit ? `共 ${lines.length} 行` : validation.submit_blocked_reason}
          {sessionReady ? '' : ' · 正在准备草稿身份…'}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void saveDraft()}
            disabled={!editable || busy !== '' || !sessionReady}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存草稿
          </button>
          {!caps.canApprove && (
            <button
              type="button"
              onClick={() => void handleSubmit(false)}
              disabled={!editable || busy !== '' || !validation.canSubmit || !sessionReady}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy === 'submit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 提交
            </button>
          )}
          {caps.canApprove && (
            <>
              <button
                type="button"
                onClick={() => void handleSubmit(false)}
                disabled={!editable || busy !== '' || !validation.canSubmit || !sessionReady}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
              >
                仅提交待审批
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit(true)}
                disabled={!editable || busy !== '' || !validation.canSubmit || !sessionReady}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === 'submit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 提交并放行
              </button>
            </>
          )}
        </div>
      </div>

      {event && (
        <p className="mt-3 text-xs text-slate-500">
          当前事件状态：{receiptStatusBadge(event.status).label}
          {' · '}
          <Link to={`/tj-po-system/receipts/${event.id}`} className="font-semibold text-emerald-700 hover:underline">
            查看事件详情
          </Link>
        </p>
      )}
    </div>
  )
}

/** 超收判断只用 decimal 比较，不用 Number 计算数量差 */
function validateOver(line: GrFormLine): number {
  try {
    return compareDecimalStrings(line.accepted_qty, line.ordered_qty)
  } catch {
    return 0
  }
}
