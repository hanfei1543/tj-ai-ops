#!/usr/bin/env node
// Windows GR Worker 入口 —— 装配真实依赖（本地文件系统 + Supabase Auth RPC + PAD 适配器 + JSONL 账本）。
// 在 Windows 目标机运行：node worker.mjs [--once | --loop] [--env <file>]
//
// 依赖（凭据只经 .env 环境文件，绝不硬编码、绝不进日志）：
//   TJ_SUPABASE_URL / TJ_SUPABASE_ANON_KEY       Supabase 连接
//   TJ_GR_EXECUTOR_EMAIL / TJ_GR_EXECUTOR_PASSWORD  executor 成员的 Supabase Auth 登录（用于 claim/result）
//   TJ_GR_QUEUE_DIR                              本地 GR Queue 根（含 Pending/Processing/Done/Failed/NeedsReview）
//   TJ_GR_LEDGER_FILE                            本地 JSONL 事件账本（默认 <queue>/ledger.jsonl）
//   TJ_GR_PAD_CONNECTED                          PAD 环境开关（只表示已配置，不等于真实接口就绪）
//   TJ_GR_ALLOW_REAL                             是否放行 mode=real 任务（默认 false；真实 IRS 授权前保持 false）
//   TJ_GR_RPC_TIMEOUT_MS                         RPC 超时（毫秒，默认 30000）
//
// 安全边界：
//   * 只处理 Pending 下 task-*.json；信封/契约/SHA 校验失败 → 移入 Failed（不 claim）。
//   * PAD 未就绪（pad.isReady()=false）→ 不 claim，留 Pending，账本记 waiting_pad。
//   * 实际 Save 前回报 save_attempted；保存超时/结果不明 → needs_review，绝不重试。
//   * 不触发真实 IRS Save/Post（那是 PAD 适配器接入并授权后的职责）。
import { readFileSync, existsSync, readdirSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker, WorkerError } from './worker-core.mjs'
import { createPadAdapter } from './pad-adapter.mjs'
import { createLedger } from './ledger.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function loadEnv(file) {
  const env = {}
  const p = file || path.join(HERE, '.env')
  if (!existsSync(p)) return env
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

function parseArgs(argv) {
  const args = { loop: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--once') args.once = true
    else if (a === '--loop') args.loop = true
    else if (a === '--env') args.env = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('usage: node worker.mjs [--once|--loop] [--env <file>]')
    return
  }
  const env = loadEnv(args.env)
  const url = env.TJ_SUPABASE_URL
  const anon = env.TJ_SUPABASE_ANON_KEY
  const email = env.TJ_GR_EXECUTOR_EMAIL
  const password = env.TJ_GR_EXECUTOR_PASSWORD
  const queueRoot = env.TJ_GR_QUEUE_DIR
  if (!url || !anon || !email || !password || !queueRoot) {
    throw new Error('缺 TJ_SUPABASE_URL / TJ_SUPABASE_ANON_KEY / TJ_GR_EXECUTOR_EMAIL / TJ_GR_EXECUTOR_PASSWORD / TJ_GR_QUEUE_DIR')
  }
  const pendingDir = path.join(queueRoot, 'Pending')
  const processingDir = path.join(queueRoot, 'Processing')
  const doneDir = path.join(queueRoot, 'Done')
  const failedDir = path.join(queueRoot, 'Failed')
  const reviewDir = path.join(queueRoot, 'NeedsReview')
  const ledgerFile = env.TJ_GR_LEDGER_FILE || path.join(queueRoot, 'ledger.jsonl')
  for (const d of [pendingDir, processingDir, doneDir, failedDir, reviewDir]) mkdirSync(d, { recursive: true })

  const ledger = createLedger({ file: ledgerFile })

  // —— Supabase Auth + RPC（原生 fetch，无第三方依赖）——
  // HTTP 200 不等于业务成功：业务拒绝由 DB 以 {rejected:true,code} 返回；HTTP 异常/超时/401 抛 WorkerError。
  const RPC_TIMEOUT_MS = Number(env.TJ_GR_RPC_TIMEOUT_MS || 30000)
  let accessToken = null
  async function ensureToken() {
    if (accessToken) return accessToken
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
    let r
    try {
      r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anon },
        body: JSON.stringify({ email, password }),
        signal: controller.signal,
      })
    } catch (e) {
      throw new WorkerError('GR_RPC_AUTH', `Supabase 登录失败（网络/超时）：${e?.message || e}`)
    } finally {
      clearTimeout(t)
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.access_token) throw new WorkerError('GR_RPC_AUTH', `Supabase 登录失败: HTTP ${r.status}`)
    accessToken = j.access_token
    return accessToken
  }

  async function rpcCall(pAction, pData) {
    const token = await ensureToken()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
    try {
      const r = await fetch(`${url}/rest/v1/rpc/tj_gr_api`, {
        method: 'POST',
        headers: {
          apikey: anon,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Profile': 'tj_preview',
        },
        body: JSON.stringify({ p_action: pAction, p_data: pData }),
        signal: controller.signal,
      })
      const text = await r.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = { raw: String(text).slice(0, 500) } }
      if (r.status === 401) {
        accessToken = null // token 过期，强制下次重登
        throw new WorkerError('GR_RPC_AUTH', 'Supabase token 过期（401），已清除缓存待重登')
      }
      if (!r.ok) {
        // PostgREST 抛业务异常（GR_*）或 HTTP 错误 → 不得继续推进状态
        const msg = typeof body?.message === 'string' ? body.message : (body?.raw || `RPC HTTP ${r.status}`)
        throw new WorkerError('GR_RPC_REJECTED', `${pAction} RPC 异常: ${msg}`)
      }
      return body
    } catch (e) {
      if (e?.name === 'AbortError') throw new WorkerError('GR_RPC_TIMEOUT', `${pAction} RPC 超时`)
      if (e instanceof WorkerError) throw e
      throw new WorkerError('GR_RPC_ERROR', `${pAction} RPC 错误: ${e?.message || e}`)
    } finally {
      clearTimeout(timer)
    }
  }

  const rpc = {
    claim: (taskId) => rpcCall('task_claim', { task_id: taskId }),
    result: (args) => rpcCall('task_result', args),
  }
  const pad = createPadAdapter({ connected: env.TJ_GR_PAD_CONNECTED === 'true' })
  const allowReal = env.TJ_GR_ALLOW_REAL === 'true'
  const worker = createWorker({ rpc, pad, ledger, allowReal, log: console })

  // 崩溃恢复：上次处理中断残留的 Processing 文件 → 放回 Pending 重试（账本/DB 状态机兜底正确性）
  function recoverProcessing() {
    if (!existsSync(processingDir)) return []
    const recovered = []
    for (const f of readdirSync(processingDir)) {
      if (!f.startsWith('task-') || !f.endsWith('.json')) continue
      renameSync(path.join(processingDir, f), path.join(pendingDir, f))
      recovered.push(f)
    }
    return recovered
  }

  function routeTarget(result) {
    // 终态：verified/duplicate_skipped → Done；needs_review/sha_conflict/claim_rejected → NeedsReview。
    // 非终态：waiting_pad/claim_leased/claim_rpc_error/draft_failed/reconcile_failed → 放回 Pending 重试。
    if (result.terminal) {
      if (result.status === 'verified' || result.status === 'duplicate_skipped') return { dir: doneDir }
      return { dir: reviewDir }
    }
    return { dir: pendingDir }
  }

  async function runOnce() {
    const recovered = recoverProcessing()
    const files = readdirSync(pendingDir).filter((f) => f.startsWith('task-') && f.endsWith('.json'))
    const summary = { scanned: files.length, recovered, processed: [], failed: [] }
    for (const f of files) {
      const src = path.join(pendingDir, f)
      const taskId = f.replace(/^task-/, '').replace(/\.json$/, '')
      let envelope
      try {
        envelope = JSON.parse(readFileSync(src, 'utf8'))
      } catch (e) {
        renameSync(src, path.join(failedDir, f))
        summary.failed.push({ task_id: taskId, error: `bad json: ${e.message}` })
        continue
      }
      // 原子落地：先移到 Processing，再处理；处理完按 terminal + status 路由
      renameSync(src, path.join(processingDir, f))
      try {
        const result = await worker.processTask(envelope)
        const target = routeTarget(result)
        renameSync(path.join(processingDir, f), path.join(target.dir, f))
        summary.processed.push({ task_id: taskId, ...result })
      } catch (e) {
        // 信封/契约/SHA 校验失败（WorkerError）→ Failed（保留现场，不重复投递）
        renameSync(path.join(processingDir, f), path.join(failedDir, f))
        summary.failed.push({ task_id: taskId, error: e?.message || String(e), code: e?.code })
      }
    }
    return summary
  }

  if (args.once || !args.loop) {
    console.log(JSON.stringify({ ok: true, ...(await runOnce()) }, null, 2))
    return
  }
  // 常驻轮询
  const POLL_MS = Number(env.TJ_GR_POLL_MS || 5000)
  for (;;) {
    try {
      await runOnce()
    } catch (e) {
      console.error('[worker]', e.message)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message || String(e), code: e?.code }))
  process.exit(1)
})
