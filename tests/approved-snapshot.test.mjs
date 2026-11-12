// 批准快照 v2：覆盖 Website PO Date + 行序 + 明细字段 + 来源引用；篡改任一项都必须失配。
// 纯 Node 运行（WebCrypto 与浏览器同一实现），不连库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  APPROVAL_SNAPSHOT_VERSION,
  canonicalApprovedSnapshot,
  computeApprovalSnapshotHash,
  normalizeSnapshotHash,
  sha256Hex,
  verifyApprovedSnapshot,
  assertVerifiedApprovedSnapshot,
} from '../web/src/lib/core/approved-snapshot.js'

const HEADER = {
  po_id: 'PO-000006',
  po_type: 'combined',
  website_po_date: '2026-11-09',
  frozen: true,
  approval_snapshot_version: 2,
  source_sha256: null,
}

const LINES = [
  {
    line_no: 1,
    item_code: '0030000000003',
    description: 'SCREW',
    uom: 'UNIT',
    qty: 4,
    original_qty: 5,
    accepted_qty: 4,
    unit_price: 2.5,
    note: '短缺 1',
    source_refs: [
      { po_id: 'p1', po_number: 'PO-000001', line_id: 'l1', qty: 3 },
      { po_id: 'p2', po_number: 'PO-000002', line_id: 'l2', qty: 2 },
    ],
  },
  {
    line_no: 2,
    item_code: '0010001000002',
    description: 'HINGE',
    uom: 'PCS',
    qty: 1,
    original_qty: 1,
    accepted_qty: 1,
    unit_price: 1.25,
    note: null,
    source_refs: [{ po_id: 'p1', po_number: 'PO-000001', line_id: 'l3', qty: 1 }],
  },
]

/** 克隆后按需篡改，避免测试之间互相污染 */
function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

async function approvedHeader(lines = LINES, overrides = {}) {
  const header = { ...HEADER, ...overrides }
  header.source_sha256 = await computeApprovalSnapshotHash(header, lines)
  return header
}

test('摘要格式：64 位小写 hex，且与 node:crypto 的 SHA-256 一致', async () => {
  const canonical = canonicalApprovedSnapshot(HEADER, LINES)
  const hash = await sha256Hex(canonical)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash, createHash('sha256').update(canonical).digest('hex'))
  assert.equal(hash, await computeApprovalSnapshotHash(HEADER, LINES))
  assert.equal(APPROVAL_SNAPSHOT_VERSION, 2)
})

test('canonical 覆盖 Website PO Date 与全部明细字段（含 line_no 顺序与 source_refs）', () => {
  const payload = JSON.parse(canonicalApprovedSnapshot(HEADER, LINES))
  assert.equal(payload.snapshot_version, 2)
  assert.equal(payload.website_po_date, '2026-11-09')
  assert.equal(payload.lines.length, 2)
  assert.deepEqual(Object.keys(payload.lines[0]), [
    'line_no',
    'item_code',
    'description',
    'uom',
    'ordered_qty',
    'accepted_qty',
    'unit_price',
    'note',
    'source_refs',
  ])
  assert.equal(payload.lines[0].ordered_qty, 5)
  assert.equal(payload.lines[0].accepted_qty, 4)
  assert.equal(payload.lines[0].source_refs.length, 2)
  assert.equal(payload.lines[0].source_refs[1].po_number, 'PO-000002')
  // 行序 = 传入顺序，不按 code 排序
  assert.deepEqual(
    payload.lines.map((l) => l.line_no),
    [1, 2],
  )
})

test('未经改动的 v2 数据校验通过', async () => {
  const header = await approvedHeader()
  const v = await verifyApprovedSnapshot({ header, lines: LINES })
  assert.equal(v.ok, true)
  assert.equal(v.status, 'verified')
  assert.equal(v.version, 2)
  assert.equal(v.actualHash, header.source_sha256)
  await assert.doesNotReject(() => assertVerifiedApprovedSnapshot(header, LINES))
})

test('篡改 Website PO Date → hash_mismatch', async () => {
  const header = await approvedHeader()
  const v = await verifyApprovedSnapshot({
    header: { ...header, website_po_date: '2026-11-10' },
    lines: LINES,
  })
  assert.equal(v.ok, false)
  assert.equal(v.status, 'hash_mismatch')
})

test('篡改批准行序（不 sort by code）→ hash_mismatch', async () => {
  const header = await approvedHeader()
  const swapped = [LINES[1], LINES[0]]
  const v = await verifyApprovedSnapshot({ header, lines: swapped })
  assert.equal(v.status, 'hash_mismatch')

  // 同 code 的两行互换也必须失配：行序是业务事实，不能因 code 相同被忽略
  const sameCode = clone(LINES)
  sameCode[1].item_code = sameCode[0].item_code
  const h2 = await approvedHeader(sameCode)
  const swappedSameCode = [sameCode[1], sameCode[0]]
  const v2 = await verifyApprovedSnapshot({ header: h2, lines: swappedSameCode })
  assert.equal(v2.status, 'hash_mismatch')
})

test('篡改 line_no（不改数组顺序）→ hash_mismatch', async () => {
  const header = await approvedHeader()
  const tampered = clone(LINES)
  tampered[1].line_no = 3
  const v = await verifyApprovedSnapshot({ header, lines: tampered })
  assert.equal(v.status, 'hash_mismatch')
})

test('篡改 accepted / ordered 数量 → hash_mismatch', async () => {
  const header = await approvedHeader()
  const badAccepted = clone(LINES)
  badAccepted[0].accepted_qty = 3
  assert.equal(
    (await verifyApprovedSnapshot({ header, lines: badAccepted })).status,
    'hash_mismatch',
  )

  const badOrdered = clone(LINES)
  badOrdered[0].original_qty = 6
  assert.equal(
    (await verifyApprovedSnapshot({ header, lines: badOrdered })).status,
    'hash_mismatch',
  )
})

test('篡改 UOM / 单价 / code / description / note → hash_mismatch', async () => {
  const header = await approvedHeader()
  const mutations = [
    (l) => (l[0].uom = 'BOX'),
    (l) => (l[0].unit_price = 2.51),
    (l) => (l[0].item_code = '9999999999999'),
    (l) => (l[1].description = 'HINGE XL'),
    (l) => (l[0].note = ''),
  ]
  for (const mutate of mutations) {
    const tampered = clone(LINES)
    mutate(tampered)
    const v = await verifyApprovedSnapshot({ header, lines: tampered })
    assert.equal(v.status, 'hash_mismatch', mutate.toString())
  }
})

test('篡改来源引用（po_number / line_id / qty / 数组顺序）→ hash_mismatch', async () => {
  const header = await approvedHeader()
  const mutations = [
    (l) => (l[0].source_refs[0].po_number = 'PO-000099'),
    (l) => (l[0].source_refs[0].line_id = 'other-line'),
    (l) => (l[0].source_refs[0].qty = 99),
    (l) => l[0].source_refs.reverse(),
    (l) => l[0].source_refs.pop(),
  ]
  for (const mutate of mutations) {
    const tampered = clone(LINES)
    mutate(tampered)
    const v = await verifyApprovedSnapshot({ header, lines: tampered })
    assert.equal(v.status, 'hash_mismatch', mutate.toString())
  }
})

test('source_refs 对象键顺序无关（canonical 按固定字段顺序序列化）', async () => {
  const header = await approvedHeader()
  const shuffledKeys = LINES.map((l) => ({
    ...l,
    source_refs: l.source_refs.map((r) => ({ qty: r.qty, line_id: r.line_id, po_number: r.po_number, po_id: r.po_id })),
  }))
  const v = await verifyApprovedSnapshot({ header, lines: shuffledKeys })
  assert.equal(v.status, 'verified')
})

test('缺 approval_snapshot_version 的旧单：legacy_missing_version，不冒充已校验', async () => {
  const header = await approvedHeader(LINES, { approval_snapshot_version: null })
  const v = await verifyApprovedSnapshot({ header, lines: LINES })
  assert.equal(v.ok, false)
  assert.equal(v.status, 'legacy_missing_version')
  assert.match(v.reason, /approval_snapshot_version/)
  await assert.rejects(
    () => assertVerifiedApprovedSnapshot(header, LINES),
    (e) => e.code === 'APPROVAL_SNAPSHOT_UNVERIFIED' && /legacy_missing_version/.test(e.message),
  )
})

test('未知版本 / 未冻结 / 非法 hash 都被拒绝', async () => {
  const good = await approvedHeader()
  assert.equal(
    (await verifyApprovedSnapshot({ header: { ...good, approval_snapshot_version: 1 }, lines: LINES })).status,
    'unsupported_version',
  )
  assert.equal(
    (await verifyApprovedSnapshot({ header: { ...good, frozen: false }, lines: LINES })).status,
    'not_frozen',
  )
  for (const bad of ['', 'abc', `sha256:${good.source_sha256}`, good.source_sha256.slice(1)]) {
    assert.equal(
      (await verifyApprovedSnapshot({ header: { ...good, source_sha256: bad }, lines: LINES })).status,
      'invalid_hash',
    )
  }
})

test('normalizeSnapshotHash 不做前缀兼容：只接受 64 位 hex', async () => {
  const hash = await sha256Hex('x')
  assert.equal(normalizeSnapshotHash(hash), hash)
  assert.equal(normalizeSnapshotHash(`  ${hash.toUpperCase()}  `), hash)
  assert.equal(normalizeSnapshotHash(`sha256:${hash}`), null)
  assert.equal(normalizeSnapshotHash(null), null)
})

test('明细缺字段无法计算 → invalid_data（导出拒绝，不静默补 0）', async () => {
  const header = await approvedHeader()
  const missingSourceQty = clone(LINES)
  delete missingSourceQty[0].source_refs[0].qty
  const missingSourceResult = await verifyApprovedSnapshot({ header, lines: missingSourceQty })
  assert.equal(missingSourceResult.status, 'invalid_data')
  await assert.rejects(() => computeApprovalSnapshotHash(HEADER, missingSourceQty), /source_refs.qty/)
  const missingPrice = clone(LINES)
  missingPrice[1].unit_price = null
  const v = await verifyApprovedSnapshot({ header, lines: missingPrice })
  assert.equal(v.ok, false)
  assert.equal(v.status, 'invalid_data')

  await assert.rejects(() => computeApprovalSnapshotHash(HEADER, missingPrice), /unit_price/)
  await assert.rejects(() => computeApprovalSnapshotHash(HEADER, []), /没有明细行/)
  await assert.rejects(
    () => computeApprovalSnapshotHash({ ...HEADER, website_po_date: null }, LINES),
    /缺少 Website PO Date/,
  )
})

test('numeric 以字符串返回时摘要不变（PostgREST numeric 兼容，不因格式漂移）', async () => {
  const asStrings = LINES.map((l) => ({
    ...l,
    qty: String(l.qty),
    original_qty: String(l.original_qty),
    accepted_qty: `${l.accepted_qty}.00`,
    unit_price: String(l.unit_price),
    source_refs: l.source_refs.map((r) => ({ ...r, qty: String(r.qty) })),
  }))
  assert.equal(
    await computeApprovalSnapshotHash(HEADER, asStrings),
    await computeApprovalSnapshotHash(HEADER, LINES),
  )
})

test('普通单不参与批准快照（not_combined，保持原 7 列流程）', async () => {
  const v = await verifyApprovedSnapshot({ header: { ...HEADER, po_type: 'standard' }, lines: LINES })
  assert.equal(v.ok, false)
  assert.equal(v.status, 'not_combined')
})
