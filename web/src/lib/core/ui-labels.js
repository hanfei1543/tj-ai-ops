// 员工界面中文标签 —— 唯一真相源（纯逻辑，无 React，可测试）。
//
// 设计原则（对应 docs/gr-contract.md 的真实后端契约，绝不虚构状态或合并 IRS 阶段）：
//   * 状态徽章只显示「人话」，原始 code 保留在返回对象的 raw 字段，供技术详情/排障。
//   * 「已审批」「已放行（等待系统处理）」「IRS 已尝试保存」「IRS 已核对完成」是四个
//     不同阶段，绝不合并成一句「成功」。
//   * 任务永远不等于 IRS 已过账；未知状态如实显示，不冒充成功。
//   * 金额/数量没有可靠来源就不显示，绝不伪造。

// ---------------------------------------------------------------------------
// 采购单（PO）状态
// ---------------------------------------------------------------------------

/**
 * PO 状态徽章（区分普通单 / 合并单）。
 * @param {string} status 后端 tj_po_headers.status
 * @param {string} poType 'standard' | 'combined'
 * @returns {{label: string, cls: string, raw: string, hint: string}}
 */
export function poStatusInfo(status, poType) {
  const raw = String(status ?? '').trim()
  const isCombined = String(poType ?? 'standard') === 'combined'

  if (isCombined) {
    if (raw === 'pending_approval') {
      return { label: '合并单 · 待审批', cls: 'bg-amber-100 text-amber-700', raw, hint: '等待审批人批准后冻结，才能登记收货' }
    }
    if (raw === 'confirmed') {
      return { label: '合并单 · 已批准', cls: 'bg-emerald-100 text-emerald-700', raw, hint: '已批准并冻结，可登记收货' }
    }
    if (raw === 'cancelled') {
      return { label: '合并单 · 已取消', cls: 'bg-slate-200 text-slate-600', raw, hint: '已取消，不再使用' }
    }
    return { label: '合并单', cls: 'bg-violet-100 text-violet-700', raw, hint: '' }
  }

  switch (raw) {
    case 'confirmed':
      return { label: '已确认', cls: 'bg-emerald-100 text-emerald-700', raw, hint: '等待登记收货或发送到电脑' }
    case 'pending_push':
      return { label: '正在发送', cls: 'bg-blue-100 text-blue-700', raw, hint: '正在发送到电脑，请稍候' }
    case 'exported':
      return { label: '已发送', cls: 'bg-emerald-100 text-emerald-700', raw, hint: '已发送到电脑，等待收货' }
    case 'combining':
      return { label: '合并中', cls: 'bg-blue-100 text-blue-700', raw, hint: '正在合并为合并单' }
    case 'combined':
      return { label: '已合并', cls: 'bg-slate-200 text-slate-600', raw, hint: '已并入合并单，请到合并单查看' }
    case 'pending_approval':
      return { label: '待审批', cls: 'bg-amber-100 text-amber-700', raw, hint: '等待审批' }
    case 'cancelled':
      return { label: '已取消', cls: 'bg-slate-200 text-slate-600', raw, hint: '已取消，不再使用' }
    default:
      // 未知状态如实显示，不冒充「未导出」这类假状态
      return {
        label: raw ? `状态：${raw}` : '状态未知',
        cls: 'bg-slate-200 text-slate-600',
        raw,
        hint: '请向管理员核对此采购单的实际状态',
      }
  }
}

// ---------------------------------------------------------------------------
// 收货事件状态（tj_gr_receipt_events.status）
// ---------------------------------------------------------------------------

/**
 * 收货事件状态徽章。阶段分明，绝不合并成「成功」。
 * @returns {{label: string, cls: string, raw: string, known: boolean, hint: string}}
 */
export function eventStatusInfo(status) {
  const raw = String(status ?? '').trim()
  const map = {
    draft: {
      label: '草稿',
      cls: 'bg-slate-100 text-slate-600',
      hint: '还没提交，只有你自己能看到',
    },
    saved: {
      label: '草稿（已保存）',
      cls: 'bg-slate-100 text-slate-600',
      hint: '还没提交',
    },
    submitted: {
      label: '已提交，等待审批',
      cls: 'bg-amber-100 text-amber-700',
      hint: '已提交，等待审批人批准',
    },
    pending_approval: {
      label: '等待审批',
      cls: 'bg-amber-100 text-amber-700',
      hint: '等待审批人批准',
    },
    approved: {
      label: '已审批，等待系统处理',
      cls: 'bg-emerald-100 text-emerald-700',
      hint: '已批准，等待放行并交给系统处理',
    },
    waiting_mapping: {
      label: '等待登记 IRS 采购单编号',
      cls: 'bg-amber-100 text-amber-700',
      hint: '还差采购单的 IRS 编号，登记后才能继续',
    },
    released: {
      label: '已批准，等待系统处理',
      cls: 'bg-emerald-100 text-emerald-700',
      hint: '已放行，系统正在处理（尚未确认 IRS 保存成功）',
    },
    in_progress: {
      label: '系统处理中',
      cls: 'bg-blue-100 text-blue-700',
      hint: '系统正在处理，结果尚未确认',
    },
    saved_unverified: {
      label: 'IRS 已尝试保存，等待核对',
      cls: 'bg-blue-100 text-blue-700',
      hint: '系统已尝试保存到 IRS，但还没核对，请等待',
    },
    verified: {
      label: 'IRS 已核对完成',
      cls: 'bg-emerald-100 text-emerald-700',
      hint: '已与 IRS 核对一致',
    },
    needs_review: {
      label: '需要人工检查',
      cls: 'bg-red-100 text-red-700',
      hint: '有问题需要人工核对，系统不会自动重试',
    },
    failed_unsaved: {
      label: '保存失败',
      cls: 'bg-red-100 text-red-700',
      hint: '没有写入 IRS，需要人工处理',
    },
    rejected: {
      label: '已退回',
      cls: 'bg-slate-200 text-slate-600',
      hint: '已被退回',
    },
    cancelled: {
      label: '已取消',
      cls: 'bg-slate-200 text-slate-600',
      hint: '已取消，不再使用',
    },
  }
  const hit = map[raw]
  if (hit) return { ...hit, raw, known: true }
  return {
    label: raw ? `状态：${raw}（请核对）` : '状态未知',
    cls: 'bg-slate-200 text-slate-600',
    raw,
    known: false,
    hint: '请向管理员核对实际状态',
  }
}

// ---------------------------------------------------------------------------
// 任务状态（tj_gr_tasks.status）
// ---------------------------------------------------------------------------

/**
 * 任务状态徽章。任务永远不等于 IRS 已过账。
 * @returns {{label: string, raw: string, irs_confirmed: boolean, hint: string}}
 */
export function taskStatusInfo(status) {
  const raw = String(status ?? '').trim()
  const map = {
    ready: '已准备，等待系统处理',
    planned: '已准备，等待系统处理',
    queued: '已准备，等待系统处理',
    pending: '已准备，等待系统处理',
    claimed: '系统已领取，正在保存（结果未确认）',
    save_attempted: '系统已开始保存（结果未确认）',
    sent: '已交给系统处理（结果未确认）',
    dispatched: '已交给系统处理（结果未确认）',
    saved_unverified: 'IRS 已尝试保存，等待核对',
    verified: 'IRS 已核对完成',
    done: '系统处理完成（不等于 IRS 过账）',
    completed: '系统处理完成（不等于 IRS 过账）',
    failed_unsaved: '保存失败（未写入，需人工处理）',
    failed: '处理失败（需人工核对）',
    needs_review: '需要人工检查（不自动重试）',
    cancelled: '已取消',
  }
  return {
    label: map[raw] ?? `任务状态：${raw || '空'}（按未处理对待）`,
    raw,
    irs_confirmed: false,
    hint: '任务状态不等于 IRS 已过账，最终以 IRS 系统为准',
  }
}

// ---------------------------------------------------------------------------
// 警告 / 例外（服务端 warnings / exceptions 的 code）
// ---------------------------------------------------------------------------

const WARNING_LABELS = {
  short_receipt: '本次少收货（实收少于订购）',
  zero_receipt: '本次实收为 0',
  duplicate_document: '单据号码可能重复（同供应商同单据已有其他记录）',
  mapping_missing: '采购单尚未登记 IRS 采购单编号',
}

const EXCEPTION_LABELS = {
  over_receipt: '实收超过订购数量',
  over_balance: '累计实收超过采购单订购数量（含之前的收货批次）',
  extra_line: '额外货品（没有对应的采购单明细）',
  OVER_DELIVERY: '实收超过订购数量',
  EXTRA_LINE: '额外货品（没有对应的采购单明细）',
}

/** 警告 code → 员工能懂的中文解释；未知 code 原样返回（不猜） */
export function warningLabel(code) {
  const raw = String(code ?? '').trim()
  return WARNING_LABELS[raw] ?? raw
}

/** 例外 code → 员工能懂的中文解释；未知 code 原样返回（不猜） */
export function exceptionLabel(code) {
  const raw = String(code ?? '').trim()
  return EXCEPTION_LABELS[raw] ?? raw
}

// ---------------------------------------------------------------------------
// 角色 / 环境
// ---------------------------------------------------------------------------

export const ROLE_LABELS = {
  staff: '员工',
  approver: '审批人员',
  executor: '执行人员',
  admin: '管理员',
}

/** 角色 → 人可读中文；未知原样返回 */
export function roleLabel(role) {
  return ROLE_LABELS[String(role ?? '').trim()] ?? String(role ?? '')
}
