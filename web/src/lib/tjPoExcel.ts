// TJ PO 系统 Excel 导出：严格按 PAD_PO_Two_Items_Test.xlsx 的 PO_Lines 结构生成
import ExcelJS from 'exceljs'
import type { ItemRequest, PoHeader, PoLine } from '@/types/tjPo'

/**
 * 生成 PO Excel（Blob），worksheet 固定名 PO_Lines，
 * 列顺序与测试 Excel 一致：Supplier Code / Supplier Name / Item Code / Description / UOM / Qty / Unit Price (RM)
 * Item Code、Supplier Code 为文本（保留前导零）；Qty、Unit Price 为数值。
 * Qty 取「批准数量」accepted_qty（合并单经审批冻结后的实收数量），普通单回退到 qty。
 */
export async function buildPoWorkbook(po: PoHeader, lines: PoLine[]): Promise<Blob> {
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

  // 表头样式（加粗）
  ws.getRow(1).font = { bold: true }

  for (const l of lines) {
    ws.addRow({
      supplier_code: po.supplier_code, // string → 文本单元格，前导零安全
      supplier_name: po.supplier_name,
      item_code: l.item_code, // string → 文本单元格
      description: l.description,
      uom: l.uom ?? '',
      qty: Number(l.accepted_qty ?? l.qty), // number → 数值单元格
      unit_price: Number(l.unit_price), // number → 数值单元格
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/** 触发浏览器下载，文件名用 PO ID，如 PO-000123.xlsx */
export async function downloadPoExcel(po: PoHeader, lines: PoLine[]): Promise<string> {
  const blob = await buildPoWorkbook(po, lines)
  const filename = `${po.po_id}.xlsx`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return filename
}

// ---------------------------------------------------------------------------
// Add New Item Master 导出（独立于 PO；IRS Item Master 实际必填字段尚未验收，
// 此处按现有 tj_items 结构 + 常见字段生成，作为给 Windows/PAD 的数据包）
// ---------------------------------------------------------------------------

export async function buildItemMasterWorkbook(items: ItemRequest[]): Promise<Blob> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Item_Master')

  ws.columns = [
    { header: 'Item Code', key: 'item_code', width: 16 },
    { header: 'Barcode', key: 'barcode', width: 16 },
    { header: 'Description', key: 'description', width: 46 },
    { header: 'UOM', key: 'uom', width: 10 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Supplier Code', key: 'supplier_code', width: 16 },
    { header: 'Purchase Cost (RM)', key: 'purchase_cost', width: 16 },
    { header: 'Selling Price (RM)', key: 'selling_price', width: 16 },
    { header: 'Tax Rate (%)', key: 'tax_rate', width: 12 },
    { header: 'SST Info', key: 'sst_info', width: 20 },
  ]

  ws.getRow(1).font = { bold: true }

  for (const it of items) {
    ws.addRow({
      item_code: it.item_code, // 文本，前导零安全
      barcode: it.barcode ?? '',
      description: it.description,
      uom: it.uom ?? '',
      category: it.category ?? '',
      supplier_code: it.supplier_code ?? '',
      purchase_cost: it.purchase_cost != null ? Number(it.purchase_cost) : '',
      selling_price: it.selling_price != null ? Number(it.selling_price) : '',
      tax_rate: it.tax_rate != null ? Number(it.tax_rate) : '',
      sst_info: it.sst_info ?? '',
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/** 导出已批准的 Item Master 数据包（单条或多条） */
export async function downloadItemMasterExcel(items: ItemRequest[]): Promise<string> {
  const blob = await buildItemMasterWorkbook(items)
  const suffix =
    items.length === 1 ? items[0].item_code : `${items.length}items_${Date.now()}`
  const filename = `ItemMaster_${suffix}.xlsx`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return filename
}

// ---------------------------------------------------------------------------
// GR 收货数据导出（独立于 PO Excel）：receipt_event_id + DO No + 批准快照 + 实收明细
// 供 Windows/PAD 核对收货（IRS Goods Received Note）用，不混入 PO_Lines 导出。
// ---------------------------------------------------------------------------

/** 生成 GR 收货数据包：Sheet1 GR_Info（收货元数据+批准快照），Sheet2 GR_Lines（实收明细） */
export async function buildGrWorkbook(po: PoHeader, lines: PoLine[]): Promise<Blob> {
  const wb = new ExcelJS.Workbook()

  // ---- GR_Info：收货事件元数据 + 批准快照（字段/值 纵向）----
  const info = wb.addWorksheet('GR_Info')
  info.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 60 },
  ]
  info.getRow(1).font = { bold: true }
  const rows: [string, string][] = [
    ['receipt_event_id', po.receipt_event_id ?? ''],
    ['delivery_order_no', po.delivery_order_no ?? ''],
    ['po_id', po.po_id],
    ['po_type', po.po_type],
    ['po_revision', String(po.po_revision)],
    ['supplier_code', po.supplier_code],
    ['supplier_name', po.supplier_name],
    ['received_at', po.received_at ?? ''],
    ['checked_by', po.checked_by ?? ''],
    ['approved_by', po.approved_by ?? ''],
    ['approved_at', po.approved_at ?? ''],
    ['source_sha256', po.source_sha256 ?? ''],
    ['frozen', po.frozen ? 'true' : 'false'],
    ['erp_status', po.erp_status],
    ['irs_po_no', po.irs_po_no ?? ''],
    ['irs_grn_no', po.irs_grn_no ?? ''],
  ]
  for (const [f, v] of rows) {
    info.addRow({ field: f, value: v })
  }

  // ---- GR_Lines：实收明细（订购 vs 实收 分开保留）----
  const ws = wb.addWorksheet('GR_Lines')
  ws.columns = [
    { header: 'Line No', key: 'line_no', width: 8 },
    { header: 'Item Code', key: 'item_code', width: 16 },
    { header: 'Description', key: 'description', width: 46 },
    { header: 'UOM', key: 'uom', width: 10 },
    { header: 'Ordered Qty', key: 'ordered_qty', width: 12 },
    { header: 'Accepted Qty', key: 'accepted_qty', width: 12 },
    { header: 'Unit Price (RM)', key: 'unit_price', width: 16 },
    { header: 'Source PO', key: 'source_pos', width: 22 },
    { header: 'Source Line IDs', key: 'source_line_ids', width: 30 },
    { header: 'Note', key: 'note', width: 26 },
  ]
  ws.getRow(1).font = { bold: true }

  for (const l of lines) {
    const refs = l.source_refs ?? []
    ws.addRow({
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

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/** 触发浏览器下载 GR 收货数据包，文件名 GR_<po_id>.xlsx */
export async function downloadGrExcel(po: PoHeader, lines: PoLine[]): Promise<string> {
  const blob = await buildGrWorkbook(po, lines)
  const filename = `GR_${po.po_id}.xlsx`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return filename
}
