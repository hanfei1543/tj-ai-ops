// 生成测试样例：Combined PO Excel (PO_Lines) + GR 收货数据包 (GR_Info/GR_Lines)
// 从 tj_preview 隔离库读取 PO-000001 + PO-000002，模拟合并，不写库。
import ExcelJS from 'exceljs'
import fs from 'node:fs'
import crypto from 'node:crypto'

const env = {}
for (const line of fs.readFileSync('/home/hermes/.hermes/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const URL = env.SUPABASE_URL
const KEY = env.VITE_SUPABASE_ANON_KEY // 用 anon（已授权 tj_preview）；service_role 刻意不授权 tj_preview 以隔离正式推送器

async function rest(path, profile) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }
  if (profile) headers['Accept-Profile'] = profile
  const r = await fetch(URL + '/rest/v1/' + path, { headers })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}

const SUPPLIER = { code: '4000/A01', name: 'AMFIX TRADING SDN BHD' }

// 读取两张来源单
const h1 = await rest('tj_po_headers?select=*&po_id=eq.PO-000001&limit=1', 'tj_preview')
const h2 = await rest('tj_po_headers?select=*&po_id=eq.PO-000002&limit=1', 'tj_preview')
const l1 = await rest(`tj_po_lines?select=*&po_header_id=eq.${h1[0].id}&order=line_no`, 'tj_preview')
const l2 = await rest(`tj_po_lines?select=*&po_header_id=eq.${h2[0].id}&order=line_no`, 'tj_preview')

// 合并：按 item_code + uom + unit_price 分组
const groups = new Map()
function addLine(po, line) {
  const key = `${line.item_code}|${line.uom ?? ''}|${Number(line.unit_price)}`
  const ref = { po_id: po.id, po_number: po.po_id, line_id: line.id, qty: Number(line.qty) }
  if (groups.has(key)) {
    const g = groups.get(key)
    g.ordered_qty += Number(line.qty)
    g.accepted_qty = g.ordered_qty
    g.source_refs.push(ref)
  } else {
    groups.set(key, {
      item_code: line.item_code,
      description: line.description,
      uom: line.uom,
      unit_price: Number(line.unit_price),
      ordered_qty: Number(line.qty),
      accepted_qty: Number(line.qty),
      note: '',
      source_refs: [ref],
    })
  }
}
for (const l of l1) addLine(h1[0], l)
for (const l of l2) addLine(h2[0], l)
const merged = Array.from(groups.values())

// 演示短缺：item 1010001000002 订购 5 实收 4
const shortageLine = merged.find((m) => m.item_code === '1010001000002')
if (shortageLine) {
  shortageLine.accepted_qty = 4
  shortageLine.note = '短缺 1 UNIT'
}

const SAMPLE_PO_ID = 'PO-000003'
const receiptEventId = crypto.randomUUID()
const canonical = JSON.stringify(
  merged.map((m) => ({ code: m.item_code, orig: m.ordered_qty, acc: m.accepted_qty, price: m.unit_price, uom: m.uom }))
)
const sha256 = crypto.createHash('sha256').update(canonical).digest('hex')

// ===== 1) Combined PO Excel：PO_Lines（与原导出/PAD 字段一致）=====
const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('PO_Lines')
ws.columns = [
  { header: 'Supplier Code', key: 'supplier_code', width: 16 },
  { header: 'Supplier Name', key: 'supplier_name', width: 38 },
  { header: 'Item Code', key: 'item_code', width: 16 },
  { header: 'Description', key: 'description', width: 46 },
  { header: 'UOM', key: 'uom', width: 10 },
  { header: 'Qty', key: 'qty', width: 10 },
  { header: 'Unit Price (RM)', key: 'unit_price', width: 16 },
]
ws.getRow(1).font = { bold: true }
for (const m of merged) {
  ws.addRow({
    supplier_code: SUPPLIER.code,
    supplier_name: SUPPLIER.name,
    item_code: m.item_code,
    description: m.description,
    uom: m.uom ?? '',
    qty: Number(m.accepted_qty ?? m.ordered_qty),
    unit_price: Number(m.unit_price),
  })
}
const poBuf = await wb.xlsx.writeBuffer()

// ===== 2) GR 收货数据包：GR_Info + GR_Lines =====
const gwb = new ExcelJS.Workbook()
const info = gwb.addWorksheet('GR_Info')
info.columns = [
  { header: 'Field', key: 'field', width: 24 },
  { header: 'Value', key: 'value', width: 60 },
]
info.getRow(1).font = { bold: true }
const meta = [
  ['receipt_event_id', receiptEventId],
  ['delivery_order_no', 'D-SAMPLE-001'],
  ['po_id', SAMPLE_PO_ID],
  ['po_type', 'combined'],
  ['po_revision', '1'],
  ['supplier_code', SUPPLIER.code],
  ['supplier_name', SUPPLIER.name],
  ['received_at', new Date().toISOString()],
  ['checked_by', 'Ms Toh'],
  ['approved_by', 'Ah Huat'],
  ['approved_at', new Date().toISOString()],
  ['source_sha256', sha256],
  ['frozen', 'true'],
  ['erp_status', 'none'],
  ['irs_po_no', ''],
  ['irs_grn_no', ''],
]
for (const [f, v] of meta) info.addRow({ field: f, value: v })

const gws = gwb.addWorksheet('GR_Lines')
gws.columns = [
  { header: 'Line No', key: 'line_no', width: 8 },
  { header: 'Item Code', key: 'item_code', width: 16 },
  { header: 'Description', key: 'description', width: 46 },
  { header: 'UOM', key: 'uom', width: 10 },
  { header: 'Ordered Qty', key: 'ordered_qty', width: 12 },
  { header: 'Accepted Qty', key: 'accepted_qty', width: 12 },
  { header: 'Unit Price (RM)', key: 'unit_price', width: 16 },
  { header: 'Source PO', key: 'source_pos', width: 22 },
  { header: 'Source Line IDs', key: 'source_line_ids', width: 40 },
  { header: 'Note', key: 'note', width: 26 },
]
gws.getRow(1).font = { bold: true }
merged.forEach((m, i) => {
  gws.addRow({
    line_no: i + 1,
    item_code: m.item_code,
    description: m.description,
    uom: m.uom ?? '',
    ordered_qty: Number(m.ordered_qty),
    accepted_qty: Number(m.accepted_qty),
    unit_price: Number(m.unit_price),
    source_pos: m.source_refs.map((r) => r.po_number).join(', '),
    source_line_ids: m.source_refs.map((r) => r.line_id).join(', '),
    note: m.note,
  })
})
const grBuf = await gwb.xlsx.writeBuffer()

const dir = '/tmp/tj_samples'
fs.mkdirSync(dir, { recursive: true })
const poPath = `${dir}/${SAMPLE_PO_ID}.xlsx`
const grPath = `${dir}/GR_${SAMPLE_PO_ID}.xlsx`
fs.writeFileSync(poPath, Buffer.from(poBuf))
fs.writeFileSync(grPath, Buffer.from(grBuf))

console.log('PO_Lines sheet columns:', ['Supplier Code','Supplier Name','Item Code','Description','UOM','Qty','Unit Price (RM)'].join(' | '))
console.log('merged lines:')
for (const m of merged) {
  console.log(`  ${m.item_code} ${m.description.slice(0,20)}  ordered=${m.ordered_qty} accepted=${m.accepted_qty} price=${m.unit_price} src=${m.source_refs.map(r=>r.po_number).join('+')} note=${m.note||'-'}`)
}
console.log('PO file:', poPath)
console.log('GR file:', grPath)
console.log('source_sha256:', sha256)
