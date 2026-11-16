#!/usr/bin/env node
// GR Preview Task Dispatcher CLI 入口 —— 装配真实依赖（Management API 读/写 outbox + bridge 投递）。
//
// 用法：
//   node scripts/tj-gr-dispatch.mjs --once [--target-dir "C:\\...\\GR_Queue\\Pending"]
//   （常驻模式另由 cron/调度器驱动，本入口每次跑一轮，便于 cron 日志与测试。）
//
// 依赖环境变量（凭据只经环境/私有 .env，绝不硬编码、绝不进日志）：
//   SUPABASE_ACCESS_TOKEN   Supabase PAT（Management API，postgres 身份读/写 tj_preview 隔离 schema）
//   SUPABASE_PROJECT_REF    项目 ref
//   GR_QUEUE_DIR            可选，Windows GR Queue Pending 目录
//                           默认 C:\Users\Administrator\Desktop\operation\GR_Queue\Pending
//   GR_BRIDGE_URL           可选，默认 http://127.0.0.1:9000
//
// 说明：tj_preview 故意不授予 service_role USAGE，service_role 经 PostgREST 访问会 403；
// 因此 dispatcher 用 Management API（PAT，postgres 身份）读 outbox 与回写状态，绕过 schema 级
// GRANT 限制。PAT 已在 VPS 私有 .env，不在本文件/日志出现。
import { createDispatcher } from './gr-dispatch-core.mjs'
import { loadEnvFile } from './lib/env.mjs'

const DEFAULT_TARGET_DIR = 'C:\\Users\\Administrator\\Desktop\\operation\\GR_Queue\\Pending'
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:9000'

function parseArgs(argv) {
  const args = { once: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--once') args.once = true
    else if (a === '--target-dir') args.targetDir = argv[++i]
    else if (a === '--bridge-url') args.bridgeUrl = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('usage: node scripts/tj-gr-dispatch.mjs --once [--target-dir <win dir>] [--bridge-url <url>]')
    return
  }
  const env = loadEnvFile()
  const pat = env.SUPABASE_ACCESS_TOKEN
  const ref = env.SUPABASE_PROJECT_REF
  if (!pat || !ref) throw new Error('缺 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF')
  const targetDir = args.targetDir || env.GR_QUEUE_DIR || DEFAULT_TARGET_DIR
  const bridgeUrl = args.bridgeUrl || env.GR_BRIDGE_URL || DEFAULT_BRIDGE_URL

  // Management API：读 pending outbox 行（只读，postgres 身份）
  async function mgmtQuery(sql) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`Management API ${r.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function listPending() {
    const rows = await mgmtQuery(
      `select id, request_id, task_id, receipt_event_id, po_header_id, payload, payload_sha256, status, mock_only
         from tj_preview.tj_gr_outbox
        where kind = 'gr_task_dispatch' and status = 'pending' and mock_only = true
        order by created_at`,
    )
    return Array.isArray(rows) ? rows : []
  }

  async function markDispatched(row, status, dispatchedAt) {
    const id = row.id
    await mgmtQuery(
      `update tj_preview.tj_gr_outbox
          set status = '${status}', dispatched_at = '${dispatchedAt}', updated_at = now()
        where id = '${id}' and status = 'pending'`,
    )
  }

  // bridge 投递：把信封 JSON 经 Windows 桥写到 GR Queue（原子 .part → rename 由桥保证）
  async function deliver(filename, envelope) {
    const winPath = `${targetDir}\\${filename}`
    const b64 = Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8').toString('base64')
    const r = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write: { path: winPath, b64 } }),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}: ${text}`)
    return JSON.parse(text)
  }

  const dispatcher = createDispatcher({ listPending, markDispatched, deliver })
  const summary = await dispatcher.runOnce()
  console.log(JSON.stringify({ ok: true, target_dir: targetDir, ...summary }, null, 2))
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: e.code ?? 'GR_DISPATCH_FAILED', message: e.message }))
  process.exit(1)
})
