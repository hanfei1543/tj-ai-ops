// 工作簿生成 —— 单一真相源（前端下载 / 真实样本脚本共用同一列宽与样式）。
import ExcelJS from 'exceljs'

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * 按 sheet 规格生成 xlsx Blob（浏览器可直接下载；Node 用 blob.arrayBuffer() 落盘）。
 * @param {Array<{name: string, columns?: object[], rows?: object[]}>} sheets
 * @returns {Promise<Blob>}
 */
export async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook()
  for (const spec of sheets ?? []) {
    const ws = wb.addWorksheet(spec.name)
    if (spec.columns) ws.columns = spec.columns
    ws.getRow(1).font = { bold: true }
    for (const row of spec.rows ?? []) ws.addRow(row)
  }
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: XLSX_MIME })
}
