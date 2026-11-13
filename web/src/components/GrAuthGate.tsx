import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Loader2, LogIn, LogOut, ShieldCheck } from 'lucide-react'
import { GR_AUTH_AVAILABLE, signInWithPassword, signOutGr, useGrIdentity } from '@/lib/grAuth'
import type { GrIdentity } from '@/lib/grAuth'
import { capabilities } from '@/lib/core/gr-form.js'
import type { GrCapabilities } from '@/lib/core/gr-form.js'

const ROLE_LABELS: Record<string, string> = {
  staff: '员工',
  approver: '审批',
  executor: '放行',
  admin: '管理',
}

/** 生产环境（public）：统一收货是预览功能，入口与页面一律硬禁用（旧界面不受影响） */
function PreviewDisabled() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 md:px-8">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-bold text-slate-900">统一收货（预览环境专用）</h1>
        <p className="mt-2 text-sm text-slate-600">
          该界面只在预览库（tj_preview）启用，并依赖登录身份与服务器强制权限。
          生产环境（public）不启用统一收货，采购单与推送流程保持原样。
        </p>
        <Link to="/tj-po-system" className="mt-4 inline-block text-sm font-semibold text-emerald-700 hover:underline">
          返回采购单
        </Link>
      </div>
    </div>
  )
}

function LoginCard({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await signInWithPassword(email, password)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-bold text-slate-900">统一收货登录</h1>
        <p className="mt-1 text-xs text-slate-500">
          预览环境使用 Supabase Auth 账号登录。核对人身份自动来自登录，不需要员工手填。
        </p>
        {error && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}
        <label className="mt-4 block text-xs font-medium text-slate-600">邮箱</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
        <label className="mt-3 block text-xs font-medium text-slate-600">密码</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          登录
        </button>
        <Link to="/tj-po-system" className="mt-3 block text-center text-xs text-slate-500 hover:underline">
          返回采购单
        </Link>
      </form>
    </div>
  )
}

/** 收货页面统一外壳：硬禁用（生产）→ 登录 → 身份条 + 内容 */
export default function GrAuthGate({ children }: { children: (identity: GrIdentity, caps: GrCapabilities) => React.ReactNode }) {
  const { identity, loading, error, refresh } = useGrIdentity()
  const location = useLocation()

  if (!GR_AUTH_AVAILABLE) return <PreviewDisabled />
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在确认登录身份…
      </div>
    )
  }
  if (error) {
    return (
      <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        身份读取失败：{error}
        <button type="button" onClick={() => void refresh()} className="ml-3 font-semibold underline">
          重试
        </button>
      </div>
    )
  }
  if (!identity) return <LoginCard onDone={() => void refresh()} />

  const caps = capabilities(identity)
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2.5 md:px-8">
          <div className="flex items-center gap-3 text-sm">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <Link
              to="/tj-po-system/receipts"
              className={`font-semibold ${location.pathname.startsWith('/tj-po-system/receipts') ? 'text-emerald-700' : 'text-slate-600 hover:text-slate-900'}`}
            >
              收货列表
            </Link>
            <Link to="/tj-po-system" className="text-slate-500 hover:text-slate-900">
              采购单
            </Link>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <span className="font-medium text-slate-800">{identity.displayName || identity.email}</span>
            <span className="text-slate-400">·</span>
            {identity.roles.length === 0 ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">无角色</span>
            ) : (
              identity.roles.map((r) => (
                <span key={r} className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">
                  {ROLE_LABELS[r] ?? r}
                </span>
              ))
            )}
            <button
              type="button"
              onClick={() => void signOutGr().then(() => refresh())}
              className="ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100"
            >
              <LogOut className="h-3.5 w-3.5" /> 退出
            </button>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <p className="mb-4 text-[11px] text-slate-400">
          权限由服务器强制（此处只决定按钮显示）；任务发布不等于 IRS 成功。
        </p>
        {children(identity, caps)}
      </div>
    </div>
  )
}
