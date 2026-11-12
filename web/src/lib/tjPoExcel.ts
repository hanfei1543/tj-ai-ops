// TJ PO 系统 Excel 导出：列定义与行规则全部来自 lib/core（与真实样本脚本、VPS 推送器同源）。
import type { ItemRequest, PoHeader, PoLine } from '@/types/tjPo'
import {
  buildPoLineRows,
  EXPORT_MODE_COMBINED,
  EXPORT_MODE_STANDARD,
  type PoExportMode,
} from './core/po-lines.js'
import { assertVerifiedApprovedSnapshot } from './core/approved-snapshot.js'
import {
  buildGrInfoRows,
  buildGrLineRows,
  GR_INFO_COLUMNS,
  GR_LINE_COLUMNS,
} from './core/gr.js'
import { buildWorkbook } from './core/xlsx.js'

/**
 * 生成 PO Excel（Blob），worksheet 固定名 PO_Lines。
 *   standard（默认）：7 列，与 PAD 现有导入完全一致，绝不追加日期列。
 *   combined：8 列（+ Website PO Date yyyy-MM-dd）；website_po_date 缺失时抛
 *             PoExportError(MISSING_WEBSITE_PO_DATE)，不会用创建/收货/审批时间代替。
 *             并且必须先通过 v2 批准快照校验（重算 DB 数据摘要 != source_sha256 即拒绝）。
 *   review：8 列但日期可空 —— 仅内部审阅样本用（必须另加 INTERNAL NOT FOR PAD 标识）。
 * Qty 取 accepted_qty ?? qty；行序、code、uom、单价原样保留。
 */
export async function buildPoWorkbook(
  po: PoHeader,
  lines: PoLine[],
  mode: PoExportMode = EXPORT_MODE_STANDARD
): Promise<Blob> {
  const { columns, rows } = buildPoLineRows(po, lines, { mode })
  // 正式合并单导出：批准快照双校验（读失败/摘要不符 → 抛错，不产出文件）
  if (mode === EXPORT_MODE_COMBINED) {
    await assertVerifiedApprovedSnapshot(po, lines)
  }
  return buildWorkbook([{ name: 'PO_Lines', columns, rows }])
}

/** 触发浏览器下载，文件名用 PO ID，如 PO-000123.xlsx */
export async function downloadPoExcel(
  po: PoHeader,
  lines: PoLine[],
  mode: PoExportMode = EXPORT_MODE_STANDARD
): Promise<string> {
  const blob = await buildPoWorkbook(po, lines, mode)
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
// Add New Item Master 导出（页面写入已停用，此处保留仅供已批准历史数据的内部核对）
// IRS Item Master 实际必填字段尚未验收，此为过渡数据包。
// ---------------------------------------------------------------------------

export async function buildItemMasterWorkbook(items: ItemRequest[]): Promise<Blob> {
  const columns = [
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
  const rows = items.map((it) => ({
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
  }))
  return buildWorkbook([{ name: 'Item_Master', columns, rows }])
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
// GR 收货数据导出（内部 Excel，正式 push/post 不启用）：
// receipt_event_id + DO No + 批准快照 + 实收明细。
// IRS 编号必须有验证证据才会出现在文件里，否则留空并标注 unverified/missing。
// ---------------------------------------------------------------------------

/** 生成 GR 收货数据包：Sheet1 GR_Info（收货元数据+批准快照），Sheet2 GR_Lines（实收明细）
 *
 * 合并单：正式导出前必须通过 v2 批准快照校验（重算摘要与 source_sha256 一致）；
 * 缺 approval_snapshot_version 的旧单不能冒充已校验批准快照 —— 只能走内部 review 样本。
 */
export async function buildGrWorkbook(po: PoHeader, lines: PoLine[]): Promise<Blob> {
  let header: PoHeader = po
  if (po.po_type === 'combined') {
    const verification = await assertVerifiedApprovedSnapshot(po, lines)
    header = { ...po, approval_snapshot_status: verification.status }
  }
  return buildWorkbook([
    {
      name: 'GR_Info',
      columns: GR_INFO_COLUMNS,
      rows: buildGrInfoRows(header).map(([field, value]) => ({ field, value })),
    },
    { name: 'GR_Lines', columns: GR_LINE_COLUMNS, rows: buildGrLineRows(lines) },
  ])
}

/** 触发浏览器下载 GR 收货数据包，文件名 GR_<po_id>.xlsx（内部文件，不推送 IRS） */
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
