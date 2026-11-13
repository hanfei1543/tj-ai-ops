// PO Push 人工恢复 —— 只读原型（dry-run）。
//
// 永久安全边界（用户明确要求，绝不放宽）：
//   * 本模块只读：只发出 GET（select），不提供任何 PATCH / POST / DELETE。
//   * 不解除 intent、不删除投递意图、不重新投递、不修改 header 状态。
//   * 真正恢复（记录 delivered / 解除旧意图后重投）必须由人工核对 Windows Queue
//     实况后，另行授权、由独立写路径执行——绝不在本原型里实现。
//
// 设计：
//   * recoveryDecision 是纯函数（无 I/O），给定 intent + header 事实输出 dry-run 决策，
//     可直接单测。它只做「建议」，绝不执行。
//   * createRecoveryInspector(sbFetch) 只读查询意图表 / header / 导出审计，返回证据。
import { PUSH_INTENT_TABLE, PUSH_INTENT_STATES } from './po-push-core.mjs'

export { PUSH_INTENT_STATES }

/**
 * 纯函数：投递恢复 dry-run 决策。只依据 intent + header 事实，不读写外部状态。
 * @param {{intent?: object|null, header?: object|null, exports?: object[]}} facts
 * @returns {{verdict: string, title: string, summary: string, mustNot: string[], steps: string[], requiresAuthorization: string[], header: object, intent: object|null}}
 */
export function recoveryDecision({ intent = null, header = null, exports = [] } = {}) {
  const headerStatus = String(header?.status ?? '').trim()
  const intentState = intent ? String(intent.state ?? '').trim() : ''
  const base = {
    header: { po_id: header?.po_id ?? null, status: headerStatus },
    intent: intent
      ? {
          state: intentState,
          content_sha256: intent.content_sha256 ?? null,
          filename: intent.filename ?? null,
          error: intent.error ?? null,
        }
      : null,
    exports_count: Array.isArray(exports) ? exports.length : 0,
  }

  // 无投递意图
  if (!intent) {
    if (headerStatus === 'pending_push') {
      return {
        ...base,
        verdict: 'no_intent_pending',
        title: '无投递意图，等待推送',
        summary: '该采购单尚未产生投递意图，当前等待推送器处理，无需人工恢复。',
        mustNot: ['不手工生成 Pending 文件', '不手工重投'],
        steps: ['确认推送器（scripts/tj-po-push.mjs）正在运行', '查推送器日志里该单是否被 reject / failed 及原因'],
        requiresAuthorization: [],
      }
    }
    return {
      ...base,
      verdict: 'no_intent',
      title: '无投递意图，无需恢复',
      summary: '该采购单没有投递意图记录，且不在待推送状态，无需恢复。',
      mustNot: [],
      steps: [],
      requiresAuthorization: [],
    }
  }

  if (intentState === PUSH_INTENT_STATES.DELIVERED) {
    if (headerStatus === 'exported') {
      return {
        ...base,
        verdict: 'ok_delivered',
        title: '已投递且已导出（正常终态）',
        summary: '投递意图为 delivered，采购单状态为 exported，一切正常，无需任何操作。',
        mustNot: [],
        steps: [],
        requiresAuthorization: [],
      }
    }
    return {
      ...base,
      verdict: 'sync_status',
      title: '已投递但状态未同步',
      summary: `投递意图已 delivered，但采购单状态仍是「${headerStatus || '空'}」。只需补记 exported，绝不重投。`,
      mustNot: ['不重投', '不删除 intent', '不重建投递意图'],
      steps: ['核对 Windows Queue 中该文件是否已存在（应已存在）', '仅补记 header.status=exported（幂等重放路径会自动完成）'],
      requiresAuthorization: ['补记 header.status=exported 是写操作，需单独授权'],
    }
  }

  if (intentState === PUSH_INTENT_STATES.DELIVERY_UNCERTAIN) {
    return {
      ...base,
      verdict: 'manual_verify_queue',
      title: '投递结果不确定，需人工核对',
      summary: `上次投递结果不确定（${intent.error || '无错误说明'}）。必须人工核对 Windows Queue 实况后再决定，系统不会自动重投。`,
      mustNot: [
        '不自动重投',
        '不删除 intent',
        '不凭 Windows Pending 文件不存在就重发',
        '不重建投递意图',
      ],
      steps: [
        '到 Windows Queue（Pending / Processing / Completed）核对该 PO 文件是否已实际写入',
        '若文件已写入：说明 bridge 实际成功、仅确认丢失 → 记录 delivered（需授权）',
        '若文件未写入：说明确实未送达 → 人工决定是否重投（重投前需先解除旧意图，需授权）',
      ],
      requiresAuthorization: ['记录 delivered（写 intent.state）需单独授权', '解除旧意图并重投需单独授权（且须确认不会重复）'],
    }
  }

  if (intentState === PUSH_INTENT_STATES.DISPATCH_STARTED) {
    return {
      ...base,
      verdict: 'manual_verify_stalled',
      title: '投递在途中残留，需人工核对',
      summary: '上次进程在 bridge 调用期间中断（dispatch_started 残留）。必须人工核对 Windows Queue 后再决定，绝不自动重投。',
      mustNot: ['不自动重投', '不删除 intent', '不凭 Pending 文件不存在就重发'],
      steps: [
        '核对 Windows Queue 是否已写入该 PO 文件（可能 bridge 已写但结果没记上）',
        '若文件已写入：记录 delivered（需授权）',
        '若文件未写入：人工决定是否重投（需授权）',
      ],
      requiresAuthorization: ['记录 delivered / 解除意图并重投，均需单独授权'],
    }
  }

  if (intentState === PUSH_INTENT_STATES.NEEDS_REVIEW) {
    return {
      ...base,
      verdict: 'manual_review',
      title: '需要人工复核',
      summary: `该投递已被标记为需要人工复核（${intent.error || '无错误说明'}）。系统不会自动处理。`,
      mustNot: ['不自动重投', '不自动解除 needs_review', '不删除 intent'],
      steps: ['人工核对 Windows Queue 实况', '人工核对采购单内容与投递内容是否一致', '复核后按结论决定 delivered 或重投（均需授权）'],
      requiresAuthorization: ['解除 needs_review / 记录 delivered / 重投，均需单独授权'],
    }
  }

  return {
    ...base,
    verdict: 'unknown_state',
    title: '未知投递状态',
    summary: `投递意图状态为「${intentState || '空'}」，超出已知状态机，需人工核对。`,
    mustNot: ['不自动处理'],
    steps: ['人工核对数据库 tj_po_push_intents 该行实际 state', '对照状态机确认是否被外部修改'],
    requiresAuthorization: [],
  }
}

/**
 * 只读恢复检查器：只用 GET 查询意图表 / header / 导出审计，返回证据 + dry-run 决策。
 * @param {Function} sbFetch Supabase REST 访问器（本模块只以 GET 调用）
 */
export function createRecoveryInspector(sbFetch) {
  if (typeof sbFetch !== 'function') throw new Error('createRecoveryInspector 需要 sbFetch')

  const onlyGet = (pathname) => sbFetch(pathname) // 无 opts.method → GET

  async function getHeaderById(poHeaderId) {
    if (!poHeaderId) throw new Error('缺少 po_header_id')
    const rows = await onlyGet(`tj_po_headers?select=*&id=eq.${encodeURIComponent(poHeaderId)}&limit=1`)
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  }

  async function getHeaderByPoId(poId) {
    if (!poId) throw new Error('缺少 po_id')
    const rows = await onlyGet(`tj_po_headers?select=*&po_id=eq.${encodeURIComponent(poId)}&limit=1`)
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  }

  async function getIntentByHeader(poHeaderId) {
    if (!poHeaderId) return null
    const rows = await onlyGet(`${PUSH_INTENT_TABLE}?select=*&po_header_id=eq.${encodeURIComponent(poHeaderId)}&order=created_at.desc&limit=1`)
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  }

  async function getExportsByPoId(poId) {
    if (!poId) return []
    const rows = await onlyGet(`tj_po_exports?select=*&po_id=eq.${encodeURIComponent(poId)}&order=exported_at.desc`)
    return Array.isArray(rows) ? rows : []
  }

  /**
   * 检查一个 PO 的投递状态：只读证据 + dry-run 恢复决策。
   * @param {{poId?: string, poHeaderId?: string}} ref 二者至少提供一个
   */
  async function inspect({ poId, poHeaderId } = {}) {
    let header = null
    if (poHeaderId) header = await getHeaderById(poHeaderId)
    if (!header && poId) header = await getHeaderByPoId(poId)
    if (!header) {
      return {
        found: false,
        ref: { poId: poId ?? null, poHeaderId: poHeaderId ?? null },
        header: null,
        intent: null,
        exports: [],
        decision: recoveryDecision({ intent: null, header: null, exports: [] }),
      }
    }
    const hId = header.id
    const intent = await getIntentByHeader(hId)
    const exports = await getExportsByPoId(header.po_id)
    return {
      found: true,
      ref: { poId: header.po_id, poHeaderId: hId },
      header,
      intent,
      exports,
      decision: recoveryDecision({ intent, header, exports }),
    }
  }

  return { inspect, getHeaderById, getHeaderByPoId, getIntentByHeader, getExportsByPoId }
}
