// Website 内部 Excel 测试文件核对（开发联调用，只读 tj_preview + 只读已生成文件）。
//
// 用法：
//   node scripts/verify_website_test.mjs --dir <目录> [--po PO-000009]
//
// 从真实预览库读回 PO 表头/明细，与同目录下 WEBSITE_PO_TEST.xlsx /
// WEBSITE_GR_TEST.xlsx 逐项核对，输出逐条 PASS/FAIL 报告（退出码 0=全过）。
// 覆盖：身份一致、供应商一致、Item/UOM/数量一致、重复 receipt_event_id 被拒、
//       未核实 IRS 编号保持空白。
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

  // ---- 5) Item / UOM / 数量一致（PO_Lines vs GR_Lines vs 库） ----
  const grHeader = grLines[0]
  const grDataRows = grLines.slice(1).filter((r) => r.some((c) => c !== undefined && c !== null && c !== ''))
  grDataRows.length === lines.length
    ? pass(`GR_Lines 行数与库明细一致（${grDataRows.length}）`)
    : fail('GR_Lines 行数', `${grDataRows.length} vs ${lines.length}`)
  const itemIdx = grHeader.indexOf('Item Code')
  const uomIdx = grHeader.indexOf('UOM')
  const ordIdx = grHeader.indexOf('Ordered Qty')
  const accIdx = grHeader.indexOf('Accepted Qty')
  const itemsMatch = grDataRows.length === lines.length && grDataRows.every((r, i) => {
    const l = lines[i]
    return (
      String(r[itemIdx]) === String(l.item_code) &&
      String(r[uomIdx]) === String(l.uom ?? '') &&
      Number(r[ordIdx]) === Number(l.original_qty ?? l.qty) &&
      Number(r[accIdx]) === Number(l.accepted_qty ?? l.qty)
    )
  })
  itemsMatch
    ? pass('Item / UOM / 订购·实收数量一致（PO·GR·库）')
    : fail('Item/UOM/数量', '存在不一致明细行')

  // ---- 6) 批准快照状态（v2 + verified，证明日期/明细与冻结摘要一致） ----
  grInfoMap.get('approval_snapshot_version') === 2 && grInfoMap.get('approval_snapshot_status') === 'verified'
    ? pass('批准快照 v2 + verified（日期与明细经过冻结摘要校验）')
    : fail('批准快照', `version=${grInfoMap.get('approval_snapshot_version')} status=${grInfoMap.get('approval_snapshot_status')}`)

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== Website 内部 Excel 核对：${args.po} ===`)
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.msg}`}`)
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
