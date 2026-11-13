// tj_gr_api 低层调用：PostgREST RPC（p_action / p_data），返回直接 JSON；错误由服务端 raise。
// 只允许在预览 schema（tj_preview）使用：生产环境没有可信身份，GR 入口与 RPC 一律硬禁用。
import { IS_PREVIEW_SCHEMA, supabase } from './supabaseClient'

export const GR_API_FUNCTION = 'tj_gr_api'

/** 生产 public 环境不发任何新 RPC（生产旧界面/旧 API 保持可用，不被暗改） */
export function assertGrRpcEnabled(): void {
  if (!IS_PREVIEW_SCHEMA) {
    throw new Error(
      '统一收货 RPC 只在预览环境（tj_preview）启用：生产环境保持旧界面与旧 API，GR 入口已禁用',
    )
  }
}

/** 合同错误码 → 中文提示（docs/gr-contract.md §1.2；服务端 message 是 JSON 文本） */
const GR_ERROR_HINTS: Record<string, string> = {
  GR_AUTH_REQUIRED: '登录已失效：请重新登录',
  GR_FORBIDDEN: '当前身份没有该操作权限（服务器拒绝）',
  GR_NOT_MEMBER: '该账号没有预览库收货权限（等待管理员授权）',
  GR_NOT_FOUND: '单据/任务不存在：请刷新列表',
  GR_REVISION_CONFLICT: '版本冲突：记录已被他人修改，请刷新后重填',
  GR_STATE: '当前状态不允许该操作：请刷新核对，不要重复提交',
  GR_VALIDATION: '字段/结构校验失败',
  GR_INVALID_DECIMAL: '数量/单价必须是十进制字符串（不能为空、负数或指数形式）',
  GR_DECIMAL_SCALE: '数量/单价最多 6 位小数（不四舍五入）',
  GR_QTY_MISMATCH: '来源分配合计与实收/订购不一致',
  GR_SOURCE_MISMATCH: '商品编号/单位/单价与来源 PO 行不一致',
  GR_QTY_EXCEEDED: '超过来源行剩余可收数量（以服务端累计为准）',
  GR_EXCEPTION_NOT_ALLOWED: '存在超收/额外行：必须逐条确认例外后才能批准',
  GR_MAPPING_REQUIRED: '缺少已验证的 IRS PO 映射：请先登记映射',
  GR_TASK_STALE: '任务租约已过期且已开始保存：转人工复核，不自动重发',
  GR_CALLBACK_CONFLICT: '回调冲突：相同 callback_id 内容不同（已审计拒绝）',
  GR_CALLBACK_OUT_OF_ORDER: '回调状态倒退/跳步：已拒绝，请人工 review',
  GR_PUSH_BLOCKED: '预览环境禁止推送/出队（GR_PUSH_BLOCKED）',
  GR_IDEMPOTENCY_CONFLICT: '同一 request_id 参数不同：疑似重复提交，请刷新核对',
}

/** PostgREST/Supabase 错误转成操作员能看懂的中文，不吞掉服务端原因 */
export class GrApiError extends Error {
  code: string
  detail: unknown

  constructor(code: string, message: string, detail: unknown) {
    super(message)
    this.name = 'GrApiError'
    this.code = code
    this.detail = detail
  }
}

function describeGrError(
  action: string,
  error: { message?: string; code?: string; details?: string },
): GrApiError {
  const rawMessage = error.message ?? ''
  let parsed: { code?: string; message?: string; detail?: unknown } | null = null
  try {
    const candidate = JSON.parse(rawMessage)
    if (candidate && typeof candidate === 'object') parsed = candidate
  } catch {
    /* message 不是 JSON：按纯文本处理 */
  }
  const code = String(parsed?.code ?? error.code ?? '')
  const msg = String(parsed?.message ?? rawMessage)
  const detail = parsed?.detail ?? error.details ?? null

  if (!parsed && /PGRST202|Could not find the function|does not exist/i.test(rawMessage)) {
    return new GrApiError(
      'GR_RPC_MISSING',
      `预览数据库尚未部署 ${GR_API_FUNCTION}（${action}）：请先应用 DB contract，未执行任何写入`,
      null,
    )
  }
  const hint = GR_ERROR_HINTS[code]
  const detailText =
    detail === null || detail === undefined
      ? ''
      : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`
  return new GrApiError(
    code || 'GR_RPC_ERROR',
    `${hint ?? `${action} 被服务端拒绝`}${msg && msg !== hint ? `：${msg}` : ''}${detailText}`,
    detail,
  )
}

/** 统一 RPC 调用入口：参数名固定 p_action / p_data */
export async function callGrApi<T = unknown>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  assertGrRpcEnabled()
  const { data: result, error } = await supabase.rpc(GR_API_FUNCTION, {
    p_action: action,
    p_data: data,
  })
  if (error) throw describeGrError(action, error)
  return result as T
}
