// 从 tj_preview 隔离库读取真实 PO，生成 PO Excel（PO_Lines）+ GR 收货数据包
// 用法：node scripts/gen_po_excel.mjs <po_id>
import ExcelJS from 'exceljs'
import fs from 'node:fs'

const env = {}
for (const line of fs.readFileSync('/home/hermes/.hermes/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const URL = env.SUPABASE_URL
const KEY = env.VITE_SUPABASE_ANON_KEY
const poId = process.argv[2] || 'PO-000003'

async function rest(path) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Accept-Profile': 'tj_preview' }
  const r = await fetch(URL + '/rest/v1/' + path, { headers })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}

const headers = await rest(`tj_po_headers?select=*&po_id=eq.${poId}&limit=1`)
if (!headers.length) { console.error('PO not found:', poId); process.exit(1) }
const h = headers[0]
const lines = await rest(`tj_po_lines?select=*&po_header_id=eq.${h.id}&order=line_no`)

// ===== PO_Lines（对齐 PAD，Qty = accepted_qty ?? qty）=====
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
for (const l of lines) {
  ws.addRow({
    supplier_code: h.supplier_code,
    supplier_name: h.supplier_name,
    item_code: l.item_code,
    description: l.description,
    uom: l.uom ?? '',
    qty: Number(l.accepted_qty ?? l.qty),
    unit_price: Number(l.unit_price),
  })
}

// ===== GR_Info + GR_Lines =====
const gwb = new ExcelJS.Workbook()
const info = gwb.addWorksheet('GR_Info')
info.columns = [
  { header: 'Field', key: 'field', width: 24 },
  { header: 'Value', key: 'value', width: 60 },
]
info.getRow(1).font = { bold: true }
const meta = [
  ['receipt_event_id', h.receipt_event_id ?? ''],
  ['delivery_order_no', h.delivery_order_no ?? ''],
  ['po_id', h.po_id],
  ['po_type', h.po_type],
  ['po_revision', String(h.po_revision)],
  ['supplier_code', h.supplier_code],
  ['supplier_name', h.supplier_name],
  ['received_at', h.received_at ?? ''],
  ['checked_by', h.checked_by ?? ''],
  ['approved_by', h.approved_by ?? ''],
  ['approved_at', h.approved_at ?? ''],
  ['source_sha256', h.source_sha256 ?? ''],
  ['frozen', h.frozen ? 'true' : 'false'],
  ['erp_status', h.erp_status],
  ['irs_po_no', h.irs_po_no ?? ''],
  ['irs_grn_no', h.irs_grn_no ?? ''],
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
for (const l of lines) {
  const refs = l.source_refs ?? []
  gws.addRow({
    line_no: Number(l.line_no),
    item_code: l.item_code,
    description: l.description,
    uom: l.uom ?? '',
    ordered_qty: Number(l.original_qty ?? l.qty),
    accepted_qty: Number(l.accepted_qty ?? l.qty),
    unit_price: Number(l.unit_price),
    source_pos: refs.map((r) => r.po_number).join(', '),
    source_line_ids: refs.map((r) => r.line_id).join(', '),
    note: l.note ?? '',
  })
}

const dir = '/tmp/tj_samples'
fs.mkdirSync(dir, { recursive: true })
const poPath = `${dir}/${poId}.xlsx`
const grPath = `${dir}/GR_${poId}.xlsx`
fs.writeFileSync(poPath, Buffer.from(await wb.xlsx.writeBuffer()))
fs.writeFileSync(grPath, Buffer.from(await gwb.xlsx.writeBuffer()))
console.log('PO:', poPath)
console.log('GR:', grPath)
console.log('lines:', lines.length, '| supplier:', h.supplier_name, '| frozen:', h.frozen, '| receipt_event_id:', h.receipt_event_id)
