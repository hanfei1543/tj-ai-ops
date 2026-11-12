// Website 内部 Excel 测试文件核对（开发联调用，只读 tj_preview + 只读已生成文件）。
//
// 用法：
//   node scripts/verify_website_test.mjs --dir <目录> [--po PO-000009]
//
// 从真实预览库读回 PO 表头/明细，与同目录下 WEBSITE_PO_TEST.xlsx /
// WEBSITE_GR_TEST.xlsx 逐行逐字段核对，输出逐条 PASS/FAIL 报告（退出码 0=全过）。
// 覆盖：身份一致、供应商一致、逐行 Item Code/UOM/Description/Unit Price 严格对照、
//       PO Qty == GR Ordered Qty（订购口径）、Accepted Qty 独立核对、
//       source_line_ids 可追溯、重复 Item Code / 同 UOM 不同价格正确区分、
//       未核实 IRS 编号保持空白（重复 receipt_event_id 由 DB 唯一索引拦截，见 SQL 测试）。
import path from 'node:path'
import fs from 'node:fs'
import ExcelJS from 'exceljs'
import { loadEnvFile } from './lib/env.mjs'
import { createPreviewRest } from './lib/preview-sample.mjs'

async function readSheet(file, sheetName) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(fs.readFileSync(file))
  const ws = wb.getWorksheet(sheetName)
  const rows = []
  ws.eachRow((r) => rows.push(r.values.slice(1)))
  return rows
}

function parseArgs(argv) {
  const args = { dir: '.', po: 'PO-000009' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i].startsWith('--dir=')) args.dir = argv[i].slice(6)
    else if (argv[i] === '--po') args.po = argv[++i]
    else if (argv[i].startsWith('--po=')) args.po = argv[i].slice(5)
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
  }
  return args
}

/** 数值归一：number/字符串/空 统一转 number 后比较（价格/数量可能被 Excel 存成 number） */
function numEq(a, b) {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  return String(a ?? '') === String(b ?? '')
}

/** 文本归一：空单元格（undefined/null）与空串等价，其余按字符串精确比较（前导零安全） */
function textEq(a, b) {
  const sa = a === undefined || a === null ? '' : String(a)
  const sb = b === undefined || b === null ? '' : String(b)
  return sa === sb
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/verify_website_test.mjs --dir <目录> [--po PO-000009]')
    return 0
  }
  const poFile = path.join(args.dir, 'WEBSITE_PO_TEST.xlsx')
  const grFile = path.join(args.dir, 'WEBSITE_GR_TEST.xlsx')
  if (!fs.existsSync(poFile)) throw new Error(`找不到 ${poFile}`)
  if (!fs.existsSync(grFile)) throw new Error(`找不到 ${grFile}`)

  const env = loadEnvFile()
  const rest = createPreviewRest({ url: env.SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY })
  const headers = await rest(`tj_po_headers?select=*&po_id=eq.${encodeURIComponent(args.po)}&limit=1`)
  if (!Array.isArray(headers) || !headers.length) throw new Error(`找不到 ${args.po}`)
  const header = headers[0]
  const lines = await rest(
    `tj_po_lines?select=*&po_header_id=eq.${header.id}&order=line_no`,
  )

  const results = []
  const pass = (name) => results.push({ name, ok: true })
  const fail = (name, msg) => results.push({ name, ok: false, msg })

  // ---- 读回文件 ----
  const poRows = await readSheet(poFile, 'PO_Lines')
  const grInfo = await readSheet(grFile, 'GR_Info')
  const grLines = await readSheet(grFile, 'GR_Lines')
  const grInfoMap = new Map(grInfo.slice(1).map((r) => [String(r[0]), r[1]]))

  // ---- 1) PO_Lines 结构与日期 ----
  const poHeader = poRows[0]
  const expectPoCols = [
    'Supplier Code', 'Supplier Name', 'Item Code', 'Description',
    'UOM', 'Qty', 'Unit Price (RM)', 'Website PO Date',
  ]
  JSON.stringify(poHeader) === JSON.stringify(expectPoCols)
    ? pass('PO_Lines 8 列（7 原栏 + Website PO Date）')
    : fail('PO_Lines 8 列', `实际 ${JSON.stringify(poHeader)}`)
  const poDataRows = poRows.slice(1).filter((r) => r.some((c) => c !== undefined && c !== null && c !== ''))
  poDataRows.length >= 3
    ? pass(`PO_Lines 数据行 >= 3（实际 ${poDataRows.length}）`)
    : fail('PO_Lines 数据行', `只有 ${poDataRows.length} 行`)
  const dateCol = poHeader.indexOf('Website PO Date')
  const dates = poDataRows.map((r) => r[dateCol])
  dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
    ? pass(`Website PO Date 格式 yyyy-MM-dd（${dates[0]}）`)
    : fail('Website PO Date 格式', JSON.stringify(dates))

  // ---- 2) GR_Info 关键字段 ----
  const receiptEventId = grInfoMap.get('receipt_event_id')
  receiptEventId === header.receipt_event_id
    ? pass('receipt_event_id 与库一致')
    : fail('receipt_event_id', `文件=${receiptEventId} 库=${header.receipt_event_id}`)
  grInfoMap.get('delivery_order_no') === header.delivery_order_no
    ? pass('delivery_order_no 与库一致')
    : fail('delivery_order_no', `文件=${grInfoMap.get('delivery_order_no')} 库=${header.delivery_order_no}`)
  grInfoMap.get('frozen') === 'true'
    ? pass('GR_Info frozen=true')
    : fail('GR_Info frozen', String(grInfoMap.get('frozen')))
  grInfoMap.get('erp_status') === 'none'
    ? pass('GR_Info erp_status=none')
    : fail('GR_Info erp_status', String(grInfoMap.get('erp_status')))

  // ---- 3) IRS 编号保持空白（erp_status=none + 未核实） ----
  grInfoMap.get('irs_po_no') === '' && grInfoMap.get('irs_grn_no') === ''
    ? pass('未核实 IRS 编号保持空白（irs_po_no / irs_grn_no 均空）')
    : fail('IRS 编号', `irs_po_no=${JSON.stringify(grInfoMap.get('irs_po_no'))} irs_grn_no=${JSON.stringify(grInfoMap.get('irs_grn_no'))}`)
  ;['unverified', 'missing'].includes(grInfoMap.get('irs_po_no_status'))
    ? pass(`irs_po_no_status=${grInfoMap.get('irs_po_no_status')}`)
    : fail('irs_po_no_status', String(grInfoMap.get('irs_po_no_status')))

  // ---- 4) 身份一致（PO/GR 同一 po_id / supplier） ----
  grInfoMap.get('po_id') === header.po_id
    ? pass(`PO/GR 身份一致（po_id=${header.po_id}）`)
    : fail('PO/GR 身份', `GR_Info.po_id=${grInfoMap.get('po_id')} 库=${header.po_id}`)
  grInfoMap.get('supplier_code') === header.supplier_code && grInfoMap.get('supplier_name') === header.supplier_name
    ? pass('供应商一致（supplier_code + name）')
    : fail('供应商', `GR=${grInfoMap.get('supplier_code')}/${grInfoMap.get('supplier_name')} 库=${header.supplier_code}/${header.supplier_name}`)
  const poSupplierCode = poDataRows[0]?.[0]
  const poSupplierName = poDataRows[0]?.[1]
  poSupplierCode === header.supplier_code && poSupplierName === header.supplier_name
    ? pass('PO_Lines 供应商与库一致')
    : fail('PO_Lines 供应商', `${poSupplierCode}/${poSupplierName} vs ${header.supplier_code}/${header.supplier_name}`)

  // ---- 5) 逐行严格核对（positional，不按 item_code 查表，区分重复 item_code / 同 UOM 不同价） ----
  const grHeader = grLines[0]
  const grDataRows = grLines.slice(1).filter((r) => r.some((c) => c !== undefined && c !== null && c !== ''))
  const poIdx = {
    item: poHeader.indexOf('Item Code'),
    uom: poHeader.indexOf('UOM'),
    desc: poHeader.indexOf('Description'),
    price: poHeader.indexOf('Unit Price (RM)'),
    qty: poHeader.indexOf('Qty'),
  }
  const grIdx = {
    item: grHeader.indexOf('Item Code'),
    uom: grHeader.indexOf('UOM'),
    desc: grHeader.indexOf('Description'),
    price: grHeader.indexOf('Unit Price (RM)'),
    ord: grHeader.indexOf('Ordered Qty'),
    acc: grHeader.indexOf('Accepted Qty'),
    srcLine: grHeader.indexOf('Source Line IDs'),
    srcPo: grHeader.indexOf('Source PO'),
  }

  const lineCountOk = poDataRows.length === lines.length && grDataRows.length === lines.length
  lineCountOk
    ? pass(`PO_Lines / GR_Lines / 库 行数一致（各 ${lines.length} 行）`)
    : fail('行数', `PO=${poDataRows.length} GR=${grDataRows.length} 库=${lines.length}`)

  // 重复 item_code 检测：同 item_code 多行必须靠 UOM/价格/描述/位置区分，逐行按位置对齐
  const codeCounts = new Map()
  for (const l of lines) codeCounts.set(l.item_code, (codeCounts.get(l.item_code) ?? 0) + 1)
  const dupCodes = [...codeCounts.entries()].filter(([, n]) => n > 1).map(([c]) => c)
  if (dupCodes.length) {
    pass(`重复 Item Code 已识别（${dupCodes.join(', ')}），逐行按位置+UOM+价格+描述区分`)
  }

  const maxRows = Math.max(poDataRows.length, grDataRows.length, lines.length)
  let perLineAllOk = true
  const perLineReport = []
  for (let i = 0; i < maxRows; i += 1) {
    const l = lines[i]
    const p = poDataRows[i]
    const g = grDataRows[i]
    if (!l) { perLineReport.push(`第 ${i + 1} 行：库无此明细`); perLineAllOk = false; continue }
    if (!p) { perLineReport.push(`第 ${i + 1} 行：PO_Lines 无此行`); perLineAllOk = false; continue }
    if (!g) { perLineReport.push(`第 ${i + 1} 行：GR_Lines 无此行`); perLineAllOk = false; continue }

    const label = `#${i + 1} ${l.item_code}/${l.uom ?? '-'}/RM${l.unit_price}`
    const problems = []
    if (!textEq(p[poIdx.item], l.item_code)) problems.push(`Item Code PO=${p[poIdx.item]} 库=${l.item_code}`)
    if (!textEq(g[grIdx.item], l.item_code)) problems.push(`Item Code GR=${g[grIdx.item]} 库=${l.item_code}`)
    if (!textEq(p[poIdx.uom], l.uom ?? '')) problems.push(`UOM PO=${p[poIdx.uom]} 库=${l.uom ?? ''}`)
    if (!textEq(g[grIdx.uom], l.uom ?? '')) problems.push(`UOM GR=${g[grIdx.uom]} 库=${l.uom ?? ''}`)
    if (!textEq(p[poIdx.desc], l.description)) problems.push(`Description PO="${p[poIdx.desc]}" 库="${l.description}"`)
    if (!textEq(g[grIdx.desc], l.description)) problems.push(`Description GR="${g[grIdx.desc]}" 库="${l.description}"`)
    if (!numEq(p[poIdx.price], l.unit_price)) problems.push(`Unit Price PO=${p[poIdx.price]} 库=${l.unit_price}`)
    if (!numEq(g[grIdx.price], l.unit_price)) problems.push(`Unit Price GR=${g[grIdx.price]} 库=${l.unit_price}`)

    // 核心契约：PO Qty == GR Ordered Qty == 订购数量（original_qty ?? qty）
    const ordered = Number(l.original_qty ?? l.qty)
    if (!numEq(p[poIdx.qty], ordered)) problems.push(`PO Qty=${p[poIdx.qty]} != 订购 ${ordered}`)
    if (!numEq(g[grIdx.ord], ordered)) problems.push(`GR Ordered Qty=${g[grIdx.ord]} != 订购 ${ordered}`)
    if (!numEq(p[poIdx.qty], g[grIdx.ord])) problems.push(`PO Qty=${p[poIdx.qty]} != GR Ordered Qty=${g[grIdx.ord]}`)

    // Accepted Qty 独立核对（实收，可与订购不同）
    const accepted = Number(l.accepted_qty ?? l.qty)
    if (!numEq(g[grIdx.acc], accepted)) problems.push(`GR Accepted Qty=${g[grIdx.acc]} != 实收 ${accepted}`)

    // source_line_ids 可追溯：与 DB source_refs 的 line_id 对齐
    const refLineIds = (Array.isArray(l.source_refs) ? l.source_refs : []).map((r) => r.line_id).join(', ')
    if (!textEq(g[grIdx.srcLine], refLineIds)) problems.push(`Source Line IDs GR="${g[grIdx.srcLine]}" 库="${refLineIds}"`)
    const refPos = (Array.isArray(l.source_refs) ? l.source_refs : []).map((r) => r.po_number).join(', ')
    if (!textEq(g[grIdx.srcPo], refPos)) problems.push(`Source PO GR="${g[grIdx.srcPo]}" 库="${refPos}"`)

    if (problems.length) {
      perLineAllOk = false
      perLineReport.push(`${label}：${problems.join('；')}`)
    }
  }
  perLineAllOk
    ? pass('逐行严格核对：Item Code / UOM / Description / Unit Price / PO Qty==GR Ordered Qty / Accepted Qty / 来源追溯 全部一致')
    : fail('逐行核对', perLineReport.join('\n    '))

  // ---- 6) 批准快照状态（v2 + verified，证明日期/明细与冻结摘要一致） ----
  grInfoMap.get('approval_snapshot_version') === 2 && grInfoMap.get('approval_snapshot_status') === 'verified'
    ? pass('批准快照 v2 + verified（日期与明细经过冻结摘要校验）')
    : fail('批准快照', `version=${grInfoMap.get('approval_snapshot_version')} status=${grInfoMap.get('approval_snapshot_status')}`)

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== Website 内部 Excel 逐行核对：${args.po} ===`)
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     -> ${r.msg}`}`)
  }
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  return failed.length ? 1 : 0
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isDirectRun) {
  main().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
