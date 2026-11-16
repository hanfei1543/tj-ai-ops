#!/usr/bin/env node
// Preview PO 投递 CLI（只给主脑/人工单次运行）：
//   node scripts/preview-po-dispatch.mjs --request-id <tj_po_preview_push_requests.request_id>
//
// 永久边界：
//   * 必须显式 --request-id；没有 runall / poll / once / 常驻服务，也不复用生产 cron 入口。
//   * 只走 Supabase Management API db/query（PostgREST service_role 对 tj_preview 无 USAGE）。
//   * 只允许 tj_preview；生成的每条 SQL 都经 assertPreviewSql 拒绝 public。
//   * 只允许新 PO 写入 Pending；同 PO 在任一 Queue 状态目录已存在同名文件即拒绝。
//   * bridge 调用窗口后任何失败 → delivery_uncertain，进程退出码 2，绝不自动重试。
//   * 不打印 PAT / JWT / .env 内容；stdout 只有一行结构化摘要。
import { pathToFileURL } from 'node:url'
import { loadEnvFile } from './lib/env.mjs'
import {
  DEFAULT_ARTIFACT_ROOT,
  PreviewDispatchError,
  TARGET_DIR,
  assertPreviewSql,
  assertRequestId,
  createBridgeClient,
  createFileArtifactStore,
  requirePendingDir,
  runPreviewDispatch,
} from './lib/preview-dispatch-core.mjs'

const MGMT_BASE = 'https://api.supabase.com'

/**
 * 解析 CLI 参数。只接受显式 request id 与装配选项；任何批处理/轮询开关都视为未知参数。
 * @param {string[]} argv
 * @returns {{requestId: string, targetDir?: string, artifactRoot?: string, bridgeUrl?: string}}
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : []
  let requestId = null
  let targetDir
  let artifactRoot
  let bridgeUrl

  const takeValue = (name, i, missingCode = 'UNKNOWN_ARG') => {
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) {
      throw new PreviewDispatchError(missingCode, `${name} 需要一个值`)
    }
    return v
  }

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--request-id') {
      requestId = takeValue('--request-id', i, 'REQUEST_ID_REQUIRED')
      i += 1
    } else if (a === '--target-dir') {
      targetDir = requirePendingDir(takeValue('--target-dir', i))
      i += 1
    } else if (a === '--artifact-root') {
      artifactRoot = takeValue('--artifact-root', i)
      i += 1
    } else if (a === '--bridge-url') {
      bridgeUrl = takeValue('--bridge-url', i)
      i += 1
    } else {
      throw new PreviewDispatchError(
        'UNKNOWN_ARG',
        `未知参数 ${a}：只允许 --request-id（可选 --target-dir/--artifact-root/--bridge-url），不接受批处理/轮询`,
      )
    }
  }
  if (!requestId) {
    throw new PreviewDispatchError(
      'REQUEST_ID_REQUIRED',
      '必须显式 --request-id <request_id>：本工具一次只投递一个已请求的预览 PO',
    )
  }
  return {
    requestId: assertRequestId(requestId),
    ...(targetDir ? { targetDir } : {}),
    ...(artifactRoot ? { artifactRoot } : {}),
    ...(bridgeUrl ? { bridgeUrl } : {}),
  }
}

/**
 * 从环境变量解析 Management API 凭据（只在 CLI 运行时调用；不落盘、不打印）。
 * PAT 变量兼容 SUPABASE_PAT / SUPABASE_ACCESS_TOKEN / SUPABASE_MANAGEMENT_PAT。
 */
export function resolveConfig(env = {}) {
  const pat =
    env.SUPABASE_PAT || env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_MANAGEMENT_PAT || ''
  if (!pat.trim()) {
    throw new PreviewDispatchError(
      'MISSING_PAT',
      '缺少 Supabase Management PAT（SUPABASE_PAT 或 SUPABASE_ACCESS_TOKEN），无法调用 db/query',
    )
  }
  let projectRef = String(env.SUPABASE_PROJECT_REF ?? '').trim()
  if (!projectRef) {
    const url = String(env.SUPABASE_URL ?? '').trim()
    const m = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i.exec(url)
    if (m) projectRef = m[1]
  }
  if (!/^[a-z0-9][a-z0-9-]{5,}$/i.test(projectRef)) {
    throw new PreviewDispatchError(
      'MISSING_PROJECT_REF',
      '缺少可用的 SUPABASE_PROJECT_REF（或可解析的 SUPABASE_URL）',
    )
  }
  return { pat: pat.trim(), projectRef }
}

/**
 * Management API db/query 访问器（唯一允许的数据库通道）。
 * @param {{projectRef: string, pat: string, fetchImpl?: Function}} opts
 */
export function createManagementDbQuery({ projectRef, pat, fetchImpl = fetch } = {}) {
  if (!projectRef || !pat) {
    throw new PreviewDispatchError('MISSING_MGMT_CONFIG', 'Management API 需要 projectRef 与 PAT')
  }
  return async function dbQuery(sql) {
    assertPreviewSql(sql)
    const r = await fetchImpl(`${MGMT_BASE}/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    })
    const text = await r.text()
    if (!r.ok) {
      // 只回状态码 + 服务端错误正文；绝不回带 Authorization / PAT
      throw new PreviewDispatchError(
        'MGMT_QUERY_FAILED',
        `Management db/query 失败 HTTP ${r.status}: ${text.slice(0, 500)}`,
      )
    }
    if (!text) return []
    try {
      return JSON.parse(text)
    } catch {
      throw new PreviewDispatchError('MGMT_BAD_RESPONSE', 'Management db/query 返回不是 JSON')
    }
  }
}

/**
 * CLI 入口（可注入依赖，便于离线测试）。
 * 退出码：0 已投递/已投递过；2 结果不确定或业务拒绝；1 配置/参数/意外错误。
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console
  const emit = (obj) => log.log(JSON.stringify(obj))
  try {
    const args = parseArgs(argv)
    const env = deps.env ?? loadEnvFile()
    const config = resolveConfig(env)
    const dbQuery = deps.dbQuery ?? createManagementDbQuery({ ...config, fetchImpl: deps.fetchImpl })
    const bridge = deps.bridge ?? createBridgeClient({ bridgeUrl: args.bridgeUrl })
    const artifacts =
      deps.artifacts ??
      createFileArtifactStore({ root: args.artifactRoot ?? DEFAULT_ARTIFACT_ROOT })
    const run = deps.runPreviewDispatch ?? runPreviewDispatch

    const res = await run({
      requestId: args.requestId,
      dbQuery,
      bridge,
      artifacts,
      targetDir: args.targetDir ?? TARGET_DIR,
      log,
    })
    emit({
      ok: true,
      outcome: res.alreadyDelivered ? 'already_delivered' : 'delivered',
      requestId: args.requestId,
      poId: res.poId ?? null,
      state: res.state,
      xlsxSha256: res.xlsxSha256 ?? null,
      byteCount: res.byteCount ?? null,
      artifactPath: res.artifactPath ?? null,
    })
    return 0
  } catch (e) {
    if (e?.uncertain === true) {
      emit({
        ok: false,
        outcome: 'delivery_uncertain',
        code: e.code,
        message: e.message,
        retry_allowed: false,
      })
      return 2
    }
    emit({
      ok: false,
      outcome: 'error',
      code: e?.code ?? 'UNEXPECTED',
      message: e?.message ?? String(e),
    })
    return 1
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code
  })
}
