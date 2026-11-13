#!/usr/bin/env node
// PO Push 人工恢复 —— 只读 CLI 入口（dry-run）。
//
// 用法：
//   node scripts/po-push-recovery.mjs --po-id PO-000001
//   node scripts/po-push-recovery.mjs --header-id <uuid>
//
// 只读：只查询意图表 / header / 导出审计并打印证据 + 恢复建议。
// 不做任何写入、不解除 intent、不删除、不重投。真正恢复需人工核对后另行授权。
import { pathToFileURL } from 'node:url'
import { createSupabaseRest } from './lib/po-push-core.mjs'
import { createRecoveryInspector } from './lib/po-push-recovery.mjs'
import { loadEnvFile } from './lib/env.mjs'

function usage() {
  return [
    'PO Push 人工恢复（只读 dry-run）',
    '用法：',
    '  node scripts/po-push-recovery.mjs --po-id <PO编号>',
    '  node scripts/po-push-recovery.mjs --header-id <uuid>',
    '只读：不写入、不解除、不重投。',
  ].join('\n')
}

function parseArgv(argv) {
  const out = { poId: null, poHeaderId: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--po-id') out.poId = argv[++i]
    else if (argv[i] === '--header-id') out.poHeaderId = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true
  }
  return out
}

function fmtTs(v) {
  return v ? String(v).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'
}

export async function run(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgv(argv)
  if (args.help || (!args.poId && !args.poHeaderId)) {
    console.log(usage())
    return args.help ? 0 : 2
  }
  const env = opts.env ?? loadEnvFile()
  const sbFetch =
    opts.sbFetch ??
    createSupabaseRest({
      url: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    })
  const inspector = createRecoveryInspector(sbFetch)
  const result = await inspector.inspect({ poId: args.poId, poHeaderId: args.poHeaderId })

  if (!result.found) {
    console.log('未找到该采购单。')
    console.log('查询条件：', JSON.stringify(result.ref))
    return 1
  }

  const { header, intent, decision } = result
  console.log('==================== 投递恢复（只读 dry-run） ====================')
  console.log(`采购单编号  : ${header.po_id}`)
  console.log(`采购单类型  : ${header.po_type ?? '—'}`)
  console.log(`采购单状态  : ${header.status ?? '—'}`)
  console.log(`业务日期    : ${header.website_po_date ?? '—'}`)
  console.log('------------------------------------------------------------------')
  console.log(`投递意图    : ${intent ? intent.state : '（无）'}`)
  if (intent) {
    console.log(`  内容指纹   : ${intent.content_sha256 ?? '—'}`)
    console.log(`  文件       : ${intent.filename ?? '—'}`)
    console.log(`  错误       : ${intent.error ?? '—'}`)
    console.log(`  更新时间   : ${fmtTs(intent.updated_at)}`)
  }
  console.log(`导出审计    : ${result.exports.length} 条`)
  console.log('------------------------------------------------------------------')
  console.log(`结论        : ${decision.title}`)
  console.log(`说明        : ${decision.summary}`)
  if (decision.mustNot.length) {
    console.log('禁止        :')
    decision.mustNot.forEach((m) => console.log(`  - ${m}`))
  }
  if (decision.steps.length) {
    console.log('建议步骤    :')
    decision.steps.forEach((s) => console.log(`  - ${s}`))
  }
  if (decision.requiresAuthorization.length) {
    console.log('需授权写操作:')
    decision.requiresAuthorization.forEach((a) => console.log(`  - ${a}`))
  }
  console.log('==================================================================')
  console.log('本工具只读，未执行任何写入/解除/重投。')
  return 0
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  run().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
