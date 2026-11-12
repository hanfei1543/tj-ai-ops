// 真实样本脚本测试：只读 tj_preview、不写库、不猜日期、缺日期出 INTERNAL NOT FOR PAD 样本
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  createPreviewRest,
  generatePreviewSample,
  PREVIEW_SCHEMA,
  REVIEW_BANNER,
  REVIEW_PREFIX,
} from '../scripts/lib/preview-sample.mjs'
import { computeApprovalSnapshotHash } from '../web/src/lib/core/approved-snapshot.js'

const SCRATCH_ROOT = path.join(os.homedir(), '.hermes', 'cache', 'scratch')

const HDR_COMBINED = {
  id: 'uuid-3',
  po_id: 'PO-000003',
  po_type: 'combined',
  status: 'confirmed',
  frozen: true,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX TRADING SDN BHD',
  erp_status: 'none',
  created_at: '2026-11-10T01:00:00Z',
  received_at: '2026-11-11T01:00:00Z',
  approved_at: '2026-11-11T02:00:00Z',
  irs_po_no: null,
  irs_grn_no: null,
}
const HDR_STANDARD = {
  id: 'uuid-5',
  po_id: 'PO-000005',
  po_type: 'standard',
  status: 'confirmed',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX TRADING SDN BHD',
  created_at: '2026-11-10T01:00:00Z',
}
const LINES = [
  { id: 'l1', line_no: 1, item_code: '0030000000003', description: 'SCREW', uom: 'UNIT', qty: 5, unit_price: 2.5, original_qty: 5, accepted_qty: 4, source_refs: [{ po_number: 'PO-000001', line_id: 'a', qty: 5 }] },
  { id: 'l2', line_no: 2, item_code: '0010001000002', description: 'HINGE', uom: 'PCS', qty: 3, unit_price: 1.25 },
]

function makeRest({ headersById, lines = LINES }) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const pq = `${u.pathname}${u.search}`
    requests.push({ method, url: pq, headers: init.headers })
    if (method !== 'GET') return { ok: false, status: 405, text: async () => 'no write' }
    if (pq.includes('tj_po_headers?')) {
      const poId = decodeURIComponent(/po_id=eq\.([^&]+)/.exec(pq)?.[1] ?? '')
      const h = headersById[poId]
      return { ok: true, status: 200, text: async () => JSON.stringify(h ? [h] : []) }
    }
    if (pq.includes('tj_po_lines?')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(lines) }
    }
    throw new Error(`unexpected ${pq}`)
  }
  return { fetchImpl, requests }
}

/** 生成已通过 v2 校验的合并单 header（用与批准时相同的 core 计算摘要） */
async function verifiedCombinedHeader(overrides = {}, lines = LINES) {
  const header = {
    ...HDR_COMBINED,
    website_po_date: '2026-11-12',
    approval_snapshot_version: 2,
    ...overrides,
  }
  header.source_sha256 = await computeApprovalSnapshotHash(header, lines)
  return header
}

function tmpDir(name) {
  const d = path.join(SCRATCH_ROOT, `tj-sample-test-${process.pid}-${name}`)
  fs.rmSync(d, { recursive: true, force: true })
  return d
}

async function readSheet(file, sheetName) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(fs.readFileSync(file))
  const ws = wb.getWorksheet(sheetName)
  const rows = []
  ws.eachRow((r) => rows.push(r.values.slice(1)))
  return { wb, ws, rows }
}

test('预览 REST：只允许 GET 且显式 Accept-Profile: tj_preview', async () => {
  const { fetchImpl, requests } = makeRest({ headersById: { 'PO-000003': HDR_COMBINED } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  await rest('tj_po_headers?select=*&po_id=eq.PO-000003&limit=1')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].headers['Accept-Profile'], PREVIEW_SCHEMA)
  assert.equal(PREVIEW_SCHEMA, 'tj_preview')
  await assert.rejects(() => rest('tj_po_headers', { method: 'POST' }), /只读/)
  assert.equal(requests.length, 1, '写请求在发出去之前就被拒绝')
})

test('预览 REST 拒绝注入 public schema（样本只能读隔离库）', () => {
  assert.throws(
    () =>
      createPreviewRest({
        url: 'https://sb.test',
        anonKey: 'anon-key',
        schema: 'public',
        fetchImpl: async () => {
          throw new Error('不应发请求')
        },
      }),
    /只允许 schema=tj_preview/,
  )
})

test('缺日期：review 模式产出 INTERNAL NOT FOR PAD 样本，日期留空并告警', async () => {
  const outDir = tmpDir('review')
  const { fetchImpl, requests } = makeRest({ headersById: { 'PO-000003': HDR_COMBINED } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  const logs = { log: () => {}, warn: () => {} }

  const out = await generatePreviewSample({ rest, poIds: ['PO-000003'], mode: 'review', outDir, log: logs })

  assert.equal(out.files.length, 2)
  assert.ok(out.warnings.some((w) => w.includes('MISSING_WEBSITE_PO_DATE')))
  const poFile = out.files.find((f) => f.kind === 'po')
  assert.ok(path.basename(poFile.path).startsWith(REVIEW_PREFIX))
  assert.ok(path.isAbsolute(poFile.path))
  assert.equal(poFile.review, true)

  const notice = await readSheet(poFile.path, 'REVIEW_NOTICE')
  const noticeText = notice.rows.flat().join(' ')
  assert.match(noticeText, /INTERNAL NOT FOR PAD/)

  const po = await readSheet(poFile.path, 'PO_Lines')
  assert.deepEqual(po.rows[0], [
    'Supplier Code',
    'Supplier Name',
    'Item Code',
    'Description',
    'UOM',
    'Qty',
    'Unit Price (RM)',
    'Website PO Date',
  ])
  // 日期列必须为空（空单元格），绝不拿 created_at/received_at/approved_at 顶替
  for (const r of po.rows.slice(1)) {
    assert.ok(r[7] === undefined || r[7] === null || r[7] === '', `日期列应为空，实际 ${JSON.stringify(r[7])}`)
  }
  // Qty = original_qty ?? qty（订购数量）；长号码前导零保留
  assert.equal(po.rows[1][2], '0030000000003')
  assert.equal(po.rows[1][5], 5)
  assert.equal(po.rows[2][5], 3)

  // 全程只读
  assert.ok(requests.every((r) => r.method === 'GET'))
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('formal 模式：合并单缺日期直接拒绝且不产出文件', async () => {
  const outDir = tmpDir('formal-reject')
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': HDR_COMBINED } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  await assert.rejects(
    () => generatePreviewSample({ rest, poIds: ['PO-000003'], mode: 'formal', outDir, log: { log: () => {}, warn: () => {} } }),
    (e) => e.code === 'MISSING_WEBSITE_PO_DATE',
  )
  const leftovers = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
  assert.deepEqual(leftovers, [])
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('formal 模式：有日期且批准快照 v2 通过时产出正式文件名与 8 列', async () => {
  const outDir = tmpDir('formal-ok')
  const header = await verifiedCombinedHeader()
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': header } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  const out = await generatePreviewSample({
    rest,
    poIds: ['PO-000003'],
    mode: 'formal',
    outDir,
    log: { log: () => {}, warn: () => {} },
  })
  const poFile = out.files.find((f) => f.kind === 'po')
  assert.equal(path.basename(poFile.path), 'PO-000003.xlsx')
  assert.equal(out.warnings.length, 0)
  const po = await readSheet(poFile.path, 'PO_Lines')
  assert.equal(po.rows[0][7], 'Website PO Date')
  assert.equal(po.rows[1][7], '2026-11-12')

  // GR_Info 必须标明 version=2 + verified（不是 unchecked/legacy）
  const grFile = out.files.find((f) => f.kind === 'gr')
  const info = await readSheet(grFile.path, 'GR_Info')
  const map = new Map(info.rows.slice(1).map((r) => [r[0], r[1]]))
  assert.equal(map.get('approval_snapshot_version'), 2)
  assert.equal(map.get('approval_snapshot_status'), 'verified')
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('formal 模式：缺 approval_snapshot_version 的旧单拒绝正式导出且不产文件', async () => {
  const outDir = tmpDir('formal-legacy')
  // 旧单：有日期、有 v1 摘要，但没有版本号
  const legacy = {
    ...HDR_COMBINED,
    website_po_date: '2026-11-12',
    source_sha256: 'a'.repeat(64),
  }
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': legacy } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  await assert.rejects(
    () => generatePreviewSample({ rest, poIds: ['PO-000003'], mode: 'formal', outDir, log: { log: () => {}, warn: () => {} } }),
    (e) => e.code === 'APPROVAL_SNAPSHOT_UNVERIFIED' && /legacy_missing_version/.test(e.message),
  )
  const leftovers = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
  assert.deepEqual(leftovers, [])
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('formal 模式：摘要被篡改（version=2 但 hash 不符）→ 拒绝且不产文件', async () => {
  const outDir = tmpDir('formal-tamper')
  const header = await verifiedCombinedHeader()
  header.source_sha256 = 'b'.repeat(64)
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': header } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  await assert.rejects(
    () => generatePreviewSample({ rest, poIds: ['PO-000003'], mode: 'formal', outDir, log: { log: () => {}, warn: () => {} } }),
    (e) => e.code === 'APPROVAL_SNAPSHOT_UNVERIFIED' && /hash_mismatch/.test(e.message),
  )
  const leftovers = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
  assert.deepEqual(leftovers, [])
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('review 模式：旧单（无版本）保留原日期/数据，但明确标注未校验批准快照', async () => {
  const outDir = tmpDir('review-legacy')
  const legacy = {
    ...HDR_COMBINED,
    website_po_date: '2026-11-12',
    source_sha256: 'c'.repeat(64),
  }
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': legacy } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  const out = await generatePreviewSample({
    rest,
    poIds: ['PO-000003'],
    mode: 'review',
    outDir,
    log: { log: () => {}, warn: () => {} },
  })

  const poFile = out.files.find((f) => f.kind === 'po')
  assert.ok(path.basename(poFile.path).startsWith(REVIEW_PREFIX))
  const notice = await readSheet(poFile.path, 'REVIEW_NOTICE')
  const noticeText = notice.rows.flat().join(' ')
  assert.match(noticeText, /INTERNAL NOT FOR PAD/)
  assert.match(noticeText, /APPROVAL_SNAPSHOT_LEGACY_MISSING_VERSION/)

  // 数据按 DB 原样保留：日期仍是原值，不被清空、不推断
  const po = await readSheet(poFile.path, 'PO_Lines')
  assert.equal(po.rows[1][7], '2026-11-12')

  const grFile = out.files.find((f) => f.kind === 'gr')
  const info = await readSheet(grFile.path, 'GR_Info')
  const map = new Map(info.rows.slice(1).map((r) => [r[0], r[1]]))
  assert.equal(map.get('approval_snapshot_status'), 'legacy_missing_version')
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('普通单样本保持 7 列（PAD 口径不变）', async () => {
  const outDir = tmpDir('standard')
  const { fetchImpl } = makeRest({ headersById: { 'PO-000005': HDR_STANDARD } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  const out = await generatePreviewSample({
    rest,
    poIds: ['PO-000005'],
    mode: 'review',
    outDir,
    log: { log: () => {}, warn: () => {} },
  })
  const poFile = out.files.find((f) => f.kind === 'po')
  const po = await readSheet(poFile.path, 'PO_Lines')
  assert.equal(po.rows[0].length, 7)
  assert.equal(po.rows[0].includes('Website PO Date'), false)
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('GR 样本：未验证 IRS 编号导出留空并标注状态', async () => {
  const outDir = tmpDir('gr')
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': { ...HDR_COMBINED, irs_grn_no: '5' } } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  const out = await generatePreviewSample({
    rest,
    poIds: ['PO-000003'],
    mode: 'review',
    outDir,
    log: { log: () => {}, warn: () => {} },
  })
  const grFile = out.files.find((f) => f.kind === 'gr')
  const info = await readSheet(grFile.path, 'GR_Info')
  const map = new Map(info.rows.slice(1).map((r) => [r[0], r[1]]))
  assert.equal(map.get('irs_grn_no'), '')
  assert.equal(map.get('irs_grn_no_status'), 'unverified')
  assert.equal(map.get('irs_po_no'), '')
  // 旧单（无版本）只能作为内部样本：明确标注未校验快照
  assert.equal(map.get('approval_snapshot_status'), 'legacy_missing_version')
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('找不到 po_id 时报错，不生成空样本', async () => {
  const outDir = tmpDir('missing')
  const { fetchImpl } = makeRest({ headersById: {} })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  await assert.rejects(
    () => generatePreviewSample({ rest, poIds: ['PO-000099'], mode: 'review', outDir, log: { log: () => {}, warn: () => {} } }),
    /找不到 PO-000099/,
  )
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('默认输出目录在 scratch 下，不是 /tmp', async () => {
  const mod = await import('../scripts/lib/preview-sample.mjs')
  assert.ok(mod.DEFAULT_OUT_DIR.startsWith(SCRATCH_ROOT), mod.DEFAULT_OUT_DIR)
  assert.equal(mod.DEFAULT_OUT_DIR.startsWith('/tmp'), false)
})

test('formal 模式：自定义 --po-name / --gr-name 输出文件名生效', async () => {
  const outDir = tmpDir('custom-names')
  const header = await verifiedCombinedHeader()
  const { fetchImpl } = makeRest({ headersById: { 'PO-000003': header } })
  const rest = createPreviewRest({ url: 'https://sb.test', anonKey: 'anon-key', fetchImpl })
  const out = await generatePreviewSample({
    rest,
    poIds: ['PO-000003'],
    mode: 'formal',
    outDir,
    poName: 'WEBSITE_PO_TEST.xlsx',
    grName: 'WEBSITE_GR_TEST.xlsx',
    log: { log: () => {}, warn: () => {} },
  })
  const poFile = out.files.find((f) => f.kind === 'po')
  const grFile = out.files.find((f) => f.kind === 'gr')
  assert.equal(path.basename(poFile.path), 'WEBSITE_PO_TEST.xlsx')
  assert.equal(path.basename(grFile.path), 'WEBSITE_GR_TEST.xlsx')
  fs.rmSync(outDir, { recursive: true, force: true })
})
