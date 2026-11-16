// Preview 投递请求 —— 纯逻辑（无 React / 无 IO），前端与测试共用。
//
// 与生产 PO Push 的区别（绝不混同）：
//   * 生产：public.tj_po_headers.status = pending_push → VPS cron → Windows。
//   * 预览：只写 tj_preview.tj_po_preview_push_requests（requested），由显式
//     `preview-po-dispatch.mjs --request-id` 单次投递；没有常驻轮询。
//   * 预览状态文案绝不使用「已导出 / 已保存 / 已发送到电脑」——那些是生产/ACK 语义。

export const PREVIEW_REQUEST_STATES = Object.freeze({
  REQUESTED: 'requested',
  DISPATCH_STARTED: 'dispatch_started',
  DELIVERED: 'delivered',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
})

const STATE_INFO = {
  requested: {
    label: '已请求预览投递（等待服务器处理）',
    cls: 'bg-amber-100 text-amber-700',
    hint: '请求已排队；管理员会用单次命令投递到 Windows 预览队列',
  },
  dispatch_started: {
    label: '预览投递中（已锁定，不会重发）',
    cls: 'bg-blue-100 text-blue-700',
    hint: '投递进行中；结果确认前不会再次发送',
  },
  delivered: {
    label: '已送达 Windows 预览队列',
    cls: 'bg-emerald-100 text-emerald-700',
    hint: 'Windows 已读回同一文件字节（sha256 一致）；仍需在 Windows 侧人工核对',
  },
  delivery_uncertain: {
    label: '投递结果不确定（需人工核对）',
    cls: 'bg-red-100 text-red-700',
    hint: '可能已写入也可能没写入；系统不会自动重试，请核对 Windows Queue 实况',
  },
}

/**
 * 预览投递状态 → 员工可读文案。未知状态如实显示，不冒充成功。
 * @param {string} state
 * @returns {{label: string, cls: string, hint: string, raw: string, known: boolean}}
 */
export function previewPushStateInfo(state) {
  const raw = String(state ?? '').trim()
  const hit = STATE_INFO[raw]
  if (hit) return { ...hit, raw, known: true }
  return {
    label: raw ? `预览投递状态：${raw}（请核对）` : '预览投递状态未知',
    cls: 'bg-slate-200 text-slate-600',
    hint: '请核对 tj_preview.tj_po_preview_push_requests 的实际状态',
    raw,
    known: false,
  }
}

export class PreviewPushError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PreviewPushError'
    this.code = code
  }
}

const KNOWN_STATES = new Set(Object.values(PREVIEW_REQUEST_STATES))

/**
 * 校验 RPC tj_po_preview_request_push 的返回（{id, po_id, state}）。
 * 返回结构不完整、PO 不匹配、状态未知都直接拒绝——不把半截响应当成功。
 * @param {unknown} row
 * @param {{expectedPoId?: string}} [opts]
 */
export function parsePreviewPushResponse(row, opts = {}) {
  if (row === null || row === undefined) {
    throw new PreviewPushError('PREVIEW_RPC_EMPTY', '预览投递 RPC 没有返回请求记录：拒绝当作已请求')
  }
  const r = Array.isArray(row) ? row[0] : row
  if (!r || typeof r !== 'object') {
    throw new PreviewPushError('PREVIEW_RPC_INVALID', '预览投递 RPC 返回格式异常：缺少对象')
  }
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const poId = typeof r.po_id === 'string' ? r.po_id.trim() : ''
  const state = typeof r.state === 'string' ? r.state.trim() : ''
  const requestId = typeof r.request_id === 'string' ? r.request_id.trim() : ''
  if (!id || !poId || !state) {
    throw new PreviewPushError('PREVIEW_RPC_INVALID', '预览投递 RPC 返回缺少 id / po_id / state')
  }
  if (opts.expectedPoId && poId !== opts.expectedPoId) {
    throw new PreviewPushError(
      'PREVIEW_RPC_PO_MISMATCH',
      `预览投递 RPC 返回了不同的采购单（${poId} ≠ ${opts.expectedPoId}）`,
    )
  }
  if (!KNOWN_STATES.has(state)) {
    throw new PreviewPushError(
      'PREVIEW_RPC_UNKNOWN_STATE',
      `预览投递 RPC 返回未知状态 "${state}"：拒绝把未知状态当成功`,
    )
  }
  return { id, poId, state, requestId: requestId || null }
}
