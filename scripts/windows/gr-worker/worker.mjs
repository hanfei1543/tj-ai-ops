#!/usr/bin/env node
// Windows GR Worker 入口 —— 装配真实依赖（本地文件系统 + Supabase Auth RPC + PAD 适配器 + JSONL 账本）。
// 在 Windows 目标机运行：node worker.mjs [--once | --loop] [--env <file>]
//
// 依赖（凭据只经 .env 环境文件，绝不硬编码、绝不进日志）：
//   TJ_SUPABASE_URL / TJ_SUPABASE_ANON_KEY       Supabase 连接
//   TJ_GR_EXECUTOR_EMAIL / TJ_GR_EXECUTOR_PASSWORD  executor 成员的 Supabase Auth 登录（用于 claim/result）
//   TJ_GR_QUEUE_DIR                              本地 GR Queue 根（含 Pending/Processing/Done/Failed/NeedsReview）
//   TJ_GR_LEDGER_FILE                            本地 JSONL 事件账本（默认 <queue>/ledger.jsonl）
//
// 安全边界：
//   * 只处理 Pending 下 task-*.json；信封/契约/SHA 校验失败 → 移入 Failed（不 claim）。
//   * PAD 未接入（pad.isConnected()=false）→ 不 claim，留 Pending，账本记 waiting_pad。
//   * 不触发真实 IRS Save/Post（那是 PAD 适配器接入后的职责）。
import { readFileSync, existsSync, readdirSync, renameSync, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker } from './worker-core.mjs'
import { createPadAdapter } from './pad-adapter.mjs'

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
  const ledgerFile = env.TJ_GR_LEDGER_FILE || path.join(queueRoot, 'ledger.jsonl')
  for (const d of [pendingDir, processingDir, doneDir, failedDir]) mkdirSync(d, { recursive: true })

  // 事件账本（JSONL，追加式；重复阻断按 task_id）
  const ledger = {
    _seen: new Set(),
    load() {
      if (!existsSync(ledgerFile)) return
      for (const line of readFileSync(ledgerFile, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e.task_id) this._seen.add(e.task_id)
        } catch {}
      }
    },
    seen(taskId) {
      return this._seen.has(taskId)
    },
    async record(entry) {
      this._seen.add(entry.task_id)
      appendFileSync(ledgerFile, JSON.stringify(entry) + '\n')
    },
  }
  ledger.load()

  // Supabase Auth + RPC（原生 fetch，无第三方依赖）
  let accessToken = null
  async function ensureToken() {
    if (accessToken) return accessToken
    const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon },
      body: JSON.stringify({ email, password }),
    })
    const j = await r.json()
    if (!r.ok || !j.access_token) throw new Error(`Supabase 登录失败: ${r.status}`)
    accessToken = j.access_token
    return accessToken
  }
  async function rpcCall(pAction, pData) {
    const token = await ensureToken()
    const r = await fetch(`${url}/rest/v1/rpc/tj_gr_api`, {
      method: 'POST',
      headers: {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'tj_preview',
      },
      body: JSON.stringify({ p_action: pAction, p_data: pData }),
    })
    const text = await r.text()
    return text ? JSON.parse(text) : null
  }

  const rpc = {
    claim: (taskId) => rpcCall('task_claim', { task_id: taskId }),
    result: (args) => rpcCall('task_result', args),
  }
  const pad = createPadAdapter({ connected: env.TJ_GR_PAD_CONNECTED === 'true' })
  const worker = createWorker({ rpc, pad, ledger })

  async function runOnce() {
    const files = readdirSync(pendingDir).filter((f) => f.startsWith('task-') && f.endsWith('.json'))
    const summary = { scanned: files.length, processed: [], failed: [] }
    for (const f of files) {
      const src = path.join(pendingDir, f)
      const taskId = f.replace(/^task-/, '').replace(/\.json$/, '')
      if (ledger.seen(taskId)) {
        // 已处理过：重复文件 → 移入 Done（幂等，不重复处理）
        renameSync(src, path.join(doneDir, f))
        summary.processed.push({ task_id: taskId, status: 'duplicate_skipped' })
        continue
      }
      let envelope
      try {
        envelope = JSON.parse(readFileSync(src, 'utf8'))
      } catch (e) {
        renameSync(src, path.join(failedDir, f))
        summary.failed.push({ task_id: taskId, error: `bad json: ${e.message}` })
        continue
      }
      // 原子落地：先移到 Processing，再处理；处理完按结果移 Done/Failed/NeedsReview
      renameSync(src, path.join(processingDir, f))
      try {
        const result = await worker.processTask(envelope)
        const target = result.status === 'verified' || result.status === 'duplicate_skipped' || result.status === 'waiting_pad'
          ? (result.status === 'waiting_pad' ? pendingDir : doneDir)
          : (result.status === 'needs_review' ? path.join(queueRoot, 'NeedsReview') : failedDir)
        // waiting_pad：放回 Pending（等 PAD 接入）
        if (result.status === 'waiting_pad') {
          renameSync(path.join(processingDir, f), path.join(pendingDir, f))
        } else {
          mkdirSync(target, { recursive: true })
          renameSync(path.join(processingDir, f), path.join(target, f))
        }
        summary.processed.push({ task_id: taskId, ...result })
      } catch (e) {
        mkdirSync(failedDir, { recursive: true })
        renameSync(path.join(processingDir, f), path.join(failedDir, f))
        summary.failed.push({ task_id: taskId, error: e.message })
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
  console.error(JSON.stringify({ ok: false, error: e.message }))
  process.exit(1)
})
