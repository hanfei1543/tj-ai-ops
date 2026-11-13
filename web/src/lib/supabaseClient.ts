// Supabase client 单例：PO 旧接口、统一收货 RPC、Auth 共用同一个 client，
// 避免多实例各自持有鉴权状态导致 session 漂移。
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// VITE_SUPABASE_SCHEMA 仅 Preview 隔离环境设置（=tj_preview）；生产不设则走 public。
export const DB_SCHEMA = import.meta.env.VITE_SUPABASE_SCHEMA || 'public'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: DB_SCHEMA },
})

/** 预览隔离环境（tj_preview）：统一收货 / 可信身份 / 新 RPC 只在这里启用 */
export const IS_PREVIEW_SCHEMA = DB_SCHEMA !== 'public'
