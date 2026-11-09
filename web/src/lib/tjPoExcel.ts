// TJ PO 系统 Excel 导出：严格按 PAD_PO_Two_Items_Test.xlsx 的 PO_Lines 结构生成
import ExcelJS from 'exceljs'
import type { PoHeader, PoLine } from '@/types/tjPo'

/**
 * 生成 PO Excel（Blob），worksheet 固定名 PO_Lines，
 * 列顺序与测试 Excel 一致：Supplier Code / Supplier Name / Item Code / Description / UOM / Qty / Unit Price (RM)
 * Item Code、Supplier Code 为文本（保留前导零）；Qty、Unit Price 为数值。
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
      qty: Number(l.qty), // number → 数值单元格
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
