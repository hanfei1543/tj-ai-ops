// 真实样本生成 CLI：从 tj_preview 只读真实 PO，生成 PO Excel（PO_Lines）与 GR 内部数据包。
//
// 用法：
//   node scripts/gen_po_excel.mjs --po PO-000003                 # 默认 review 模式
//   node scripts/gen_po_excel.mjs --po PO-000003 --mode formal   # 正式 build（缺日期/批准快照未通过即失败）
//   node scripts/gen_po_excel.mjs --po PO-000001,PO-000003 --out /path
//
// 规则：
//   * 只读 tj_preview（GET + Accept-Profile: tj_preview），不写库。
//   * 不猜日期：website_po_date 缺失时，review 模式输出文件名与首张 sheet 均标
//     INTERNAL NOT FOR PAD，日期列留空并打印告警；formal 模式直接拒绝。
//   * 批准快照 v2：formal 模式必须通过 DB 数据重算校验；缺 approval_snapshot_version
//     的旧单只能出 review 样本（明确标注未校验），不冒充已校验批准快照。
//   * 输出到 scratch（默认 ~/.hermes/cache/scratch/tj_samples），不写 /tmp。
//   * 普通单仍按 7 列（PAD 口径）；合并单 8 列（含 Website PO Date）。
import path from 'node:path'
import {
  createPreviewRest,
  generatePreviewSample,
  DEFAULT_OUT_DIR,
  REVIEW_BANNER,
} from './lib/preview-sample.mjs'
import { loadEnvFile } from './lib/env.mjs'

export function parseArgs(argv) {
  const args = { poIds: [], mode: 'review', outDir: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--po') {
      const v = argv[++i]
      if (!v) throw new Error('--po 需要 po_id，例如 --po PO-000003')
      args.poIds.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a.startsWith('--po=')) {
      args.poIds.push(...a.slice(5).split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a === '--mode') {
      const v = argv[++i]
      if (v !== 'review' && v !== 'formal') throw new Error('--mode 只允许 review 或 formal')
      args.mode = v
    } else if (a.startsWith('--mode=')) {
      const v = a.slice(7)
      if (v !== 'review' && v !== 'formal') throw new Error('--mode 只允许 review 或 formal')
      args.mode = v
    } else if (a === '--out') {
      const v = argv[++i]
      if (!v) throw new Error('--out 需要目录')
      args.outDir = path.resolve(v)
    } else if (a.startsWith('--out=')) {
      args.outDir = path.resolve(a.slice(6))
    } else if (a === '--po-name') {
      const v = argv[++i]
      if (!v) throw new Error('--po-name 需要文件名')
      args.poName = v
    } else if (a.startsWith('--po-name=')) {
      args.poName = a.slice(10)
    } else if (a === '--gr-name') {
      const v = argv[++i]
      if (!v) throw new Error('--gr-name 需要文件名')
      args.grName = v
    } else if (a.startsWith('--gr-name=')) {
      args.grName = a.slice(10)
    } else if (a === '--help' || a === '-h') {
      args.help = true
    } else {
      throw new Error(`未知参数：${a}`)
    }
  }
  if (!args.poIds.length) args.poIds = ['PO-000003']
  return args
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    return 1
  }
  if (args.help) {
    console.log('node scripts/gen_po_excel.mjs --po PO-000003 [--mode review|formal] [--out DIR] [--po-name FILE] [--gr-name FILE]')
    return 0
  }

  const env = loadEnvFile()
  const url = env.SUPABASE_URL
  // 只读预览库用 anon key（service_role 刻意不授权 tj_preview）
  const anonKey = env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    console.error('缺 Supabase 凭据（SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
    return 1
  }

  const rest = createPreviewRest({ url, anonKey })
  try {
    const out = await generatePreviewSample({
      rest,
      poIds: args.poIds,
      mode: args.mode,
      outDir: args.outDir,
      poName: args.poName ?? null,
      grName: args.grName ?? null,
    })
    console.log(`mode: ${out.mode}`)
    for (const f of out.files) {
      console.log(
        `${f.kind === 'po' ? 'PO' : 'GR'}: ${f.path}${f.review ? `  [${REVIEW_BANNER}]` : ''}`,
      )
    }
    if (out.warnings.length) {
      console.log(`warnings (${out.warnings.length}):`)
      for (const w of out.warnings) console.log(`  - ${w}`)
    } else {
      console.log('warnings: 0')
    }
    console.log(`out dir: ${out.outDir}`)
    return 0
  } catch (e) {
    console.error(`失败：${e.message}`)
    return 1
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isDirectRun) {
  main().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
