#!/usr/bin/env node
// GR 模拟 dispatcher —— 只把「已持久化的 outbox」渲染成本地文件，永不触达真实 bridge /
// Windows Queue / IRS。存在意义：让 UI/流程可以在没有真实出队的情况下验证 payload、
// 顺序与幂等键；同时用硬性检查证明「预览 GR 任务不可能被误发到生产」。
//
// 硬性拒绝（任何一条命中即整体失败，不写任何文件）：
//   1) environment != 'preview'       —— 真实环境不归本工具管
//   2) mock_only != true              —— 生产任务不得走模拟通道
//   3) task_type != 'GOODS_RECEIVE'   —— 避免误发其他类型
//   4) schema != 'tj.gr.v1'           —— 契约版本必须匹配
//   5) 输出目录是 Windows 盘符 / UNC  —— 只写本地 POSIX scratch
//   6) 输出目录不在允许的 root 之内   —— 防止写到项目/系统敏感目录
//   7) payload 里出现 http(s)/bridge 地址或 PO_Queue 路径 —— 明确不允许真实出队
//
// 用法：
//   node scripts/gr-mock-dispatcher.mjs --in outbox.json --outdir "$TMPDIR/gr-out" \
//        [--root "$TMPDIR"] [--dry-run]
// 输出：stdout 打印 JSON 摘要；每个 outbox 行写一个 <outdir>/task-<task_id>.json。
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const DISPATCH_SCHEMA = 'tj.gr.dispatch.v1'
const FORBIDDEN_VALUE = /(https?:\/\/|\\\\|PO_Queue|[A-Za-z]:\\\\)/i

export class DispatchRefused extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DispatchRefused'
    this.code = code
  }
}

function refuse(code, message) {
  throw new DispatchRefused(code, message)
}

/** Windows 盘符 / UNC / 反斜杠路径一律拒绝（本工具只写 POSIX 本地目录） */
export function assertLocalPosixPath(p, label = 'path') {
  if (typeof p !== 'string' || p.trim() === '') refuse('GR_DISPATCH_PATH', `${label} 为空`)
  if (/^[A-Za-z]:/.test(p)) refuse('GR_DISPATCH_WINDOWS_PATH', `${label} 是 Windows 盘符路径：${p}`)
  if (p.startsWith('\\\\') || p.includes('\\')) {
    refuse('GR_DISPATCH_WINDOWS_PATH', `${label} 含 Windows 反斜杠/UNC：${p}`)
  }
  if (p.split(path.sep).includes('..')) refuse('GR_DISPATCH_PATH', `${label} 含 ..：${p}`)
  return path.resolve(p)
}

/** outdir 必须位于 root 之内（root 默认系统临时目录） */
export function assertInsideRoot(outdir, root) {
  const r = path.resolve(root)
  const o = path.resolve(outdir)
  const rel = path.relative(r, o)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    refuse('GR_DISPATCH_OUTSIDE_ROOT', `输出目录 ${o} 不在允许的 root ${r} 之内`)
  }
  return o
}

function stable(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

function deepScanForForbidden(value, trail, hits) {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) hits.push({ path: trail, value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => deepScanForForbidden(v, `${trail}[${i}]`, hits))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) deepScanForForbidden(v, `${trail}.${k}`, hits)
  }
}

/** 校验一条 outbox/task 行；返回规范化后的条目 */
export function validateDispatchRow(row, index = 0) {
  if (!row || typeof row !== 'object') refuse('GR_DISPATCH_INVALID', `第 ${index} 行不是对象`)
  if (row.environment !== 'preview') {
    refuse('GR_DISPATCH_ENV', `第 ${index} 行 environment=${row.environment}（只允许 preview）`)
  }
  if (row.mock_only !== true) {
    refuse('GR_DISPATCH_MOCK_ONLY', `第 ${index} 行 mock_only!=true（生产任务不得模拟出队）`)
  }
  if ((row.task_type ?? 'GOODS_RECEIVE') !== 'GOODS_RECEIVE') {
    refuse('GR_DISPATCH_TASK_TYPE', `第 ${index} 行 task_type 非 GOODS_RECEIVE`)
  }
  if ((row.schema ?? 'tj.gr.v1') !== 'tj.gr.v1') {
    refuse('GR_DISPATCH_SCHEMA', `第 ${index} 行 schema 非 tj.gr.v1`)
  }
  if (!row.task_id || !/^[0-9a-f-]{36}$/i.test(String(row.task_id))) {
    refuse('GR_DISPATCH_TASK_ID', `第 ${index} 行缺少合法 task_id`)
  }
  const hash = row.payload_sha256
  if (!/^[0-9a-f]{64}$/.test(String(hash ?? ''))) {
    refuse('GR_DISPATCH_HASH', `第 ${index} 行 payload_sha256 不是 64 位 hex`)
  }

  const hits = []
  deepScanForForbidden(row.payload ?? {}, `[${index}].payload`, hits)
  if (hits.length > 0) {
    refuse(
      'GR_DISPATCH_REAL_BRIDGE',
      `第 ${index} 行 payload 含真实出队线索（http/bridge/Windows 路径）：${JSON.stringify(hits[0])}`,
    )
  }

  return {
    task_id: String(row.task_id),
    request_id: row.request_id ? String(row.request_id) : null,
    receipt_event_id: row.receipt_event_id ? String(row.receipt_event_id) : null,
    po_header_id: row.po_header_id ? String(row.po_header_id) : null,
    payload_sha256: String(hash),
    status: row.status ?? 'pending',
    payload: row.payload ?? {},
  }
}

/**
 * 渲染 dispatch 计划（不写盘）。
 * @param {{rows: object[]}} input
 */
export function buildDispatchPlan({ rows } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    refuse('GR_DISPATCH_EMPTY', '没有可 dispatch 的 outbox 行')
  }
  const items = rows.map((r, i) => validateDispatchRow(r, i))

  const seen = new Set()
  for (const it of items) {
    const key = it.request_id ?? it.task_id
    if (seen.has(key)) refuse('GR_DISPATCH_DUPLICATE', `重复的 request_id/task_id：${key}`)
    seen.add(key)
  }

  // 稳定排序：同批输出可复现（按 task_id）
  items.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))

  const files = items.map((it) => {
    const body = {
      schema: DISPATCH_SCHEMA,
      mode: 'mock',
      dispatched_at: new Date().toISOString(),
      task: it,
    }
    return {
      file: `task-${it.task_id}.json`,
      task_id: it.task_id,
      request_id: it.request_id,
      content: JSON.stringify(body, null, 2) + '\n',
      content_sha256: sha256Hex(stable(body)),
    }
  })

  return {
    schema: DISPATCH_SCHEMA,
    mode: 'mock',
    count: files.length,
    files,
    manifest: {
      schema: DISPATCH_SCHEMA,
      mode: 'mock',
      generated_at: new Date().toISOString(),
      count: files.length,
      tasks: files.map((f) => ({
        task_id: f.task_id,
        request_id: f.request_id,
        file: f.file,
        payload_sha256: items.find((i) => i.task_id === f.task_id)?.payload_sha256 ?? null,
        content_sha256: f.content_sha256,
      })),
    },
  }
}

/**
 * 写盘：outdir 必须在 root 内，且全部为本地 POSIX 路径。
 * @returns {Promise<{count:number, outdir:string, files:string[]}>}
 */
export async function writeDispatchPlan(plan, { outdir, root = os.tmpdir(), dryRun = false } = {}) {
  const rootDir = assertLocalPosixPath(root, 'root')
  const outDir = assertInsideRoot(assertLocalPosixPath(outdir, 'outdir'), rootDir)

  if (dryRun) {
    return { count: plan.count, outdir: outDir, files: plan.files.map((f) => f.file), dry_run: true }
  }

  await mkdir(outDir, { recursive: true })
  const written = []
  for (const f of plan.files) {
    const target = path.join(outDir, f.file)
    assertLocalPosixPath(target, 'target')
    await writeFile(target, f.content, 'utf8')
    written.push(target)
  }
  await writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(plan.manifest, null, 2) + '\n',
    'utf8',
  )
  return { count: plan.count, outdir: outDir, files: written }
}

function parseArgs(argv) {
  const args = { dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--in') args.input = argv[++i]
    else if (a === '--outdir') args.outdir = argv[++i]
    else if (a === '--root') args.root = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.input || !args.outdir) {
    console.error(
      'usage: node scripts/gr-mock-dispatcher.mjs --in <outbox.json> --outdir <dir> [--root <dir>] [--dry-run]',
    )
    process.exit(args.help ? 0 : 2)
  }
  const raw = JSON.parse(await readFile(args.input, 'utf8'))
  const rows = Array.isArray(raw) ? raw : raw.outbox ?? raw.rows ?? []
  const plan = buildDispatchPlan({ rows })
  const result = await writeDispatchPlan(plan, {
    outdir: args.outdir,
    root: args.root ?? path.dirname(path.resolve(args.outdir)),
    dryRun: args.dryRun,
  })
  console.log(JSON.stringify({ ok: true, mode: 'mock', ...result }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, code: e.code ?? 'GR_DISPATCH_FAILED', message: e.message }))
    process.exit(1)
  })
}
