// 真实样本生成模块（从 tj_preview 只读，绝不写库、绝不猜日期）。
//
// 用法（入口 scripts/gen_po_excel.mjs）：默认 review 模式。
//   * review：缺 Website PO Date 也允许出文件，但文件名与首张 sheet 都明确标
//     INTERNAL NOT FOR PAD，并返回/打印告警；日期列留空，不用任何时间戳顶替。
//     合并单缺 approval_snapshot_version / 摘要不符时同样只出 review 样本，
//     并在 REVIEW_NOTICE 标明「未校验批准快照」，数据按 DB 原样保留。
//   * formal：合并单缺日期或批准快照未通过验证 → 直接 fail closed（PoExportError），
//     不产生任何文件（缺版本旧单不得冒充已校验批准快照）。
// 所有请求都是 GET + Accept-Profile: tj_preview；本模块没有写路径。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPoLineRows, EXPORT_MODE_COMBINED, EXPORT_MODE_REVIEW, EXPORT_MODE_STANDARD, PoExportError } from '../../web/src/lib/core/po-lines.js'
import { verifyApprovedSnapshot } from '../../web/src/lib/core/approved-snapshot.js'
import { buildGrInfoRows, buildGrLineRows, GR_INFO_COLUMNS, GR_LINE_COLUMNS } from '../../web/src/lib/core/gr.js'
import { buildWorkbook } from '../../web/src/lib/core/xlsx.js'

export const PREVIEW_SCHEMA = 'tj_preview'
export const REVIEW_BANNER = 'INTERNAL NOT FOR PAD'
export const REVIEW_PREFIX = 'REVIEW_INTERNAL_NOT_FOR_PAD_'
export const DEFAULT_OUT_DIR = path.join(
  os.homedir(),
  '.hermes',
  'cache',
  'scratch',
  'tj_samples',
)

/**
 * tj_preview 只读 REST 访问器。
 * 只允许 GET：任何写方法在发请求前就被拒绝，保证样本脚本不会碰数据库。
 */
export function createPreviewRest({
  url,
  anonKey,
  fetchImpl = fetch,
  schema = PREVIEW_SCHEMA,
} = {}) {
  if (!url || !anonKey) {
    throw new Error('缺 Supabase 凭据（SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
  }
  // 只读样本脚本限定隔离库：拒绝注入其他 schema（防止误读生产 public 当样本）
  if (schema !== PREVIEW_SCHEMA) {
    throw new Error(`预览样本只允许 schema=${PREVIEW_SCHEMA}，拒绝 schema=${String(schema)}`)
  }
  return async function rest(pathname, opts = {}) {
    const method = (opts.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      throw new Error(`预览样本只允许只读请求，拒绝 ${method} ${pathname}`)
    }
    const r = await fetchImpl(`${url}/rest/v1/${pathname}`, {
      method: 'GET',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: 'application/json',
        'Accept-Profile': schema,
      },
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }
}

function reviewNoticeSheet(reasons) {
  return {
    name: 'REVIEW_NOTICE',
    columns: [
      { header: 'Field', key: 'field', width: 26 },
      { header: 'Value', key: 'value', width: 70 },
    ],
    rows: [
      { field: 'FILE STATUS', value: REVIEW_BANNER },
      { field: '原因', value: reasons.join('; ') || '内部审阅样本（非正式导出）' },
      { field: '使用限制', value: '仅供内部核对；不得导入 PAD / IRS，不得作为已批准单据' },
      { field: 'Website PO Date', value: '缺失即留空；系统不推断创建/收货/审批时间' },
    ],
  }
}

/**
 * @param {{
 *   rest: (path: string) => Promise<any>,
 *   poIds: string[],
 *   mode?: 'review'|'formal',
 *   outDir?: string,
 *   fsImpl?: typeof fs,
 *   now?: () => Date,
 *   log?: Pick<Console,'log'|'warn'>,
 * }} args
 */
export async function generatePreviewSample({
  rest,
  poIds,
  mode = 'review',
  outDir = DEFAULT_OUT_DIR,
  fsImpl = fs,
  now = () => new Date(),
  log = console,
  poName = null,
  grName = null,
} = {}) {
  if (typeof rest !== 'function') throw new Error('generatePreviewSample 需要 rest')
  if (mode !== 'review' && mode !== 'formal') {
    throw new Error(`未知模式：${mode}（只允许 review / formal）`)
  }
  const ids = (poIds ?? []).filter(Boolean)
  if (!ids.length) throw new Error('至少指定一个 po_id（--po PO-000003）')

  const warnings = []
  const files = []
  fsImpl.mkdirSync(outDir, { recursive: true })

  for (const poId of ids) {
    const headers = await rest(
      `tj_po_headers?select=*&po_id=eq.${encodeURIComponent(poId)}&limit=1`,
    )
    if (!Array.isArray(headers) || headers.length === 0) {
      throw new Error(`tj_preview 找不到 ${poId}`)
    }
    const header = headers[0]
    const lines = await rest(
      `tj_po_lines?select=*&po_header_id=eq.${header.id}&order=line_no`,
    )
    const isCombined = header.po_type === 'combined'
    const exportMode = !isCombined
      ? EXPORT_MODE_STANDARD
      : mode === 'formal'
        ? EXPORT_MODE_COMBINED
        : EXPORT_MODE_REVIEW

    // buildPoLineRows 在 combined + 缺日期时抛 MISSING_WEBSITE_PO_DATE → formal 直接失败
    const poExport = buildPoLineRows(header, Array.isArray(lines) ? lines : [], {
      mode: exportMode,
    })

    const reviewReasons = []
    if (poExport.warnings.includes('MISSING_WEBSITE_PO_DATE')) {
      reviewReasons.push('MISSING_WEBSITE_PO_DATE（合并单无 Website PO Date）')
    }
    if (!isCombined) reviewReasons.push('STANDARD_PO_SAMPLE（普通单 7 列 PAD 口径）')

    // 批准快照（v2）：由 DB 读回的 header + lines 重算。
    //   formal：必须 verified，否则拒绝（缺 version 的旧单不能冒充已校验批准快照）
    //   review：保留旧 date/数据原样，只在 REVIEW_NOTICE 标明未校验（legacy）
    let snapshot = null
    if (isCombined) {
      snapshot = await verifyApprovedSnapshot({
        header,
        lines: Array.isArray(lines) ? lines : [],
      })
      if (!snapshot.ok) {
        if (mode === 'formal') {
          throw new PoExportError(
            'APPROVAL_SNAPSHOT_UNVERIFIED',
            `合并单 ${poId} 批准快照未通过校验（${snapshot.status}）：${snapshot.reason}。` +
              '缺 approval_snapshot_version 的旧单只允许 INTERNAL review 样本，不能作为正式导出。',
          )
        }
        reviewReasons.push(
          `APPROVAL_SNAPSHOT_${snapshot.status.toUpperCase()}（未校验批准快照，数据按原样保留，仅供内部核对）`,
        )
      }
    }
    const grHeader = isCombined
      ? { ...header, approval_snapshot_status: snapshot?.status ?? 'unchecked' }
      : header
    const isReview = mode === 'review'
    if (snapshot && !snapshot.ok) {
      const w = `${poId}: APPROVAL_SNAPSHOT_${snapshot.status.toUpperCase()} — 未校验批准快照，仅供内部核对（不得作为正式导出）`
      warnings.push(w)
      log.warn(`[warn] ${w}`)
    }

    const poSheets = []
    if (isReview) poSheets.push(reviewNoticeSheet(reviewReasons))
    poSheets.push({ name: 'PO_Lines', columns: poExport.columns, rows: poExport.rows })

    const poNameFinal = poName || (isReview ? `${REVIEW_PREFIX}${poId}.xlsx` : `${poId}.xlsx`)
    const poPath = path.join(outDir, poNameFinal)
    const poBlob = await buildWorkbook(poSheets)
    fsImpl.writeFileSync(poPath, Buffer.from(await poBlob.arrayBuffer()))

    // GR：内部 Excel 专用（未验证的 IRS 编号一律留空）
    const grSheets = []
    if (isReview) grSheets.push(reviewNoticeSheet([...reviewReasons, 'GR 内部 Excel（不 push/post IRS）']))
    grSheets.push(
      { name: 'GR_Info', columns: GR_INFO_COLUMNS, rows: buildGrInfoRows(grHeader).map(([field, value]) => ({ field, value })) },
      { name: 'GR_Lines', columns: GR_LINE_COLUMNS, rows: buildGrLineRows(Array.isArray(lines) ? lines : []) },
    )
    const grNameFinal = grName || (isReview ? `${REVIEW_PREFIX}GR_${poId}.xlsx` : `GR_${poId}.xlsx`)
    const grPath = path.join(outDir, grNameFinal)
    const grBlob = await buildWorkbook(grSheets)
    fsImpl.writeFileSync(grPath, Buffer.from(await grBlob.arrayBuffer()))

    files.push(
      { kind: 'po', po_id: poId, path: poPath, review: isReview, mode: exportMode },
      { kind: 'gr', po_id: poId, path: grPath, review: isReview, mode: exportMode },
    )

    if (poExport.warnings.includes('MISSING_WEBSITE_PO_DATE')) {
      const w = `${poId}: MISSING_WEBSITE_PO_DATE — 缺 Website PO Date，已输出审阅样本（${REVIEW_BANNER}），日期列留空；不得导入 PAD`
      warnings.push(w)
      log.warn(`[warn] ${w}`)
    }
  }

  log.log(`generated ${files.length} file(s) in ${outDir} (${now().toISOString()}, mode=${mode})`)
  return { files, warnings, outDir, mode }
}
