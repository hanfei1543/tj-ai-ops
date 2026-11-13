// tjPoExcel.ts 真实函数测试：标准 8 列、legacy 拒绝、合并单审批快照不能靠 mode 绕过。
// 用 esbuild 打包（exceljs 一起打包），不连浏览器下载路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import ExcelJS from 'exceljs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuild = webRequire('esbuild')
const OUT = path.join(os.homedir(), '.hermes/cache/scratch', 'tj-po-excel-test-bundle')

const STD = {
  id: 'h-1',
  po_id: 'PO-000005',
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
  po_type: 'standard',
  status: 'confirmed',
  frozen: false,
  website_po_date: '2026-11-13', // TEST ONLY
}
const COMBINED = {
  id: 'h-3',
  po_id: 'PO-000003',
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
  po_type: 'combined',
  status: 'confirmed',
  frozen: true,
  website_po_date: '2026-11-12',
  approval_snapshot_version: null,
  source_sha256: 'a'.repeat(64),
}
const LINES = [
  {
    line_no: 1,
    item_code: '0010001000002',
    description: 'HINGE',
    uom: 'UNIT',
    qty: 5,
    original_qty: 5,
    accepted_qty: 5,
    unit_price: 1.25,
    source_refs: [],
    note: null,
  },
]

let modPromise = null
function loadExcelLib() {
  if (!modPromise) {
    fs.mkdirSync(OUT, { recursive: true })
    modPromise = esbuild
      .build({
        entryPoints: [path.join(ROOT, 'web/src/lib/tjPoExcel.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
        // exceljs 的 CJS 内部用 require('crypto')；ESM bundle 需要注入 createRequire
        banner: {
          js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
        },
      })
      .then(async (r) => {
        const file = path.join(OUT, `tjPoExcel.bundle-${process.pid}.mjs`)
        fs.writeFileSync(file, r.outputFiles[0].text)
        return import(pathToFileURL(file).href)
      })
  }
  return modPromise
}

async function sheetRows(blob) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()))
  const ws = wb.getWorksheet('PO_Lines')
  const rows = []
  ws.eachRow((row) => rows.push(row.values.slice(1)))
  return rows
}

test('buildPoWorkbook standard：8 列（原 7 列 + Website PO Date）', async () => {
  const { buildPoWorkbook } = await loadExcelLib()
  const blob = await buildPoWorkbook(STD, LINES, 'standard')
  const rows = await sheetRows(blob)
  assert.deepEqual(rows[0], [
    'Supplier Code',
    'Supplier Name',
    'Item Code',
    'Description',
    'UOM',
    'Qty',
    'Unit Price (RM)',
    'Website PO Date',
  ])
  assert.equal(rows[1][7], '2026-11-13')
  assert.equal(rows[1][2], '0010001000002')
})

test('buildPoWorkbook standard：缺日期 fail closed（不生成 legacy 7 列）', async () => {
  const { buildPoWorkbook } = await loadExcelLib()
  await assert.rejects(
    () => buildPoWorkbook({ ...STD, website_po_date: null }, LINES, 'standard'),
    (e) => e.code === 'MISSING_WEBSITE_PO_DATE',
  )
})

test('buildPoWorkbook：legacy-standard 在网页导出层被拒绝', async () => {
  const { buildPoWorkbook } = await loadExcelLib()
  await assert.rejects(
    () => buildPoWorkbook(STD, LINES, 'legacy-standard'),
    (e) => e.code === 'LEGACY_MODE_NOT_ALLOWED',
  )
})

test('合并单不能靠换 standard/legacy mode 绕过（po_type 自洽校验）', async () => {
  const { buildPoWorkbook } = await loadExcelLib()
  for (const mode of ['standard', 'legacy-standard']) {
    await assert.rejects(
      () => buildPoWorkbook(COMBINED, LINES, mode),
      (e) => e.code === 'LEGACY_MODE_NOT_ALLOWED' || e.code === 'PO_TYPE_MODE_MISMATCH',
      `mode=${mode}`,
    )
  }
})

test('合并单正式导出仍强制 v2 批准快照（未校验即拒绝）', async () => {
  const { buildPoWorkbook } = await loadExcelLib()
  await assert.rejects(
    () => buildPoWorkbook(COMBINED, LINES, 'combined'),
    (e) => e.code === 'APPROVAL_SNAPSHOT_UNVERIFIED',
  )
})

test('合并单 review 内部样本仍许可（8 列，不冒充正式导出）', async () => {
  const { buildPoWorkbook } = await loadExcelLib()
  const blob = await buildPoWorkbook(COMBINED, LINES, 'review')
  const rows = await sheetRows(blob)
  assert.equal(rows[0].length, 8)
  assert.equal(rows[0][7], 'Website PO Date')
})
