// 统一收货可信身份：Supabase Auth password 登录（仅预览工作流）。
// 角色来自 tj_gr_api('session') 的服务端结果，前端不维护角色表、不硬编码凭据。
import { useCallback, useEffect, useState } from 'react'
import { IS_PREVIEW_SCHEMA, supabase } from './supabaseClient'
import { getSessionInfo } from './tjGrApi'
import { normalizeRoles } from './core/gr-form.js'
import type { GrRole } from '@/types/tjGr'

export interface GrIdentity {
  userId: string
  email: string
  displayName: string
  roles: GrRole[]
}

export const GR_AUTH_AVAILABLE = IS_PREVIEW_SCHEMA

function displayNameOf(user: {
  email?: string | null
  user_metadata?: Record<string, unknown> | null
}): string {
  const meta = user.user_metadata ?? {}
  const fromMeta = [meta.full_name, meta.name, meta.display_name].find(
    (v) => typeof v === 'string' && v.trim(),
  ) as string | undefined
  if (fromMeta) return fromMeta.trim()
  const email = user.email ?? ''
  return email.includes('@') ? email.split('@')[0] : email
}

/** 密码登录（Supabase Auth）。仅预览环境启用；错误信息原样抛给界面 */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  if (!IS_PREVIEW_SCHEMA) {
    throw new Error('仅供预览环境登录：生产环境不使用新的可信身份界面')
  }
  const e = email.trim()
  if (!e || !password) throw new Error('请输入邮箱与密码')
  const { error } = await supabase.auth.signInWithPassword({ email: e, password })
  if (error) throw new Error(`登录失败：${error.message}`)
}

export async function signOutGr(): Promise<void> {
  const { error } = await supabase.auth.signOut()
  if (error) throw new Error(`退出失败：${error.message}`)
}

/** 读取当前 auth session + 服务端角色；没有登录返回 null */
export async function loadGrIdentity(): Promise<GrIdentity | null> {
  if (!IS_PREVIEW_SCHEMA) return null
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(`读取登录状态失败：${error.message}`)
  const user = data.session?.user
  if (!user) return null

  const info = await getSessionInfo()
  return {
    userId: user.id,
    email: user.email ?? '',
    displayName: displayNameOf(user),
    roles: normalizeRoles(info.roles) as GrRole[],
  }
}

/**
 * 页面用 hook：加载身份、订阅 auth 变化、可手动 refresh。
 * 权限真正由服务器强制，这里只用于显示按钮与文案。
 */
export function useGrIdentity() {
  const [identity, setIdentity] = useState<GrIdentity | null>(null)
  const [loading, setLoading] = useState(IS_PREVIEW_SCHEMA)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!IS_PREVIEW_SCHEMA) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      setIdentity(await loadGrIdentity())
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取身份失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const { data } = supabase.auth.onAuthStateChange(() => {
      void refresh()
    })
    return () => data.subscription.unsubscribe()
  }, [refresh])

  return { identity, loading, error, refresh }
}
