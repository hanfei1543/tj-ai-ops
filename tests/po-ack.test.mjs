// PO Done ACK 判定 —— 纯函数单测（无 IO）。
// 覆盖：相同 ACK 重放、冲突、SHA 不同语义、event_id 缺失/非法、PO 已清理不重建、
//       无可信 Push 交付、IRS 号冲突、content_sha256(业务 JSON) ≠ xlsx_sha256(文件字节)。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeAckPayload,
  ackFingerprintSource,
  computeAckFingerprint,
  decideAck,
  describeAckState,
  PO_ACK_SCHEMA,
  PO_ACK_CODES,
  PO_ACK_STATES,
  PoAckError,
} from '../web/src/lib/core/po-ack.js'
import { computeXlsxSha256, computePushContentSha256 } from '../scripts/lib/po-push-core.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function read(p) {
  return fs.readFileSync(path.join(repoRoot, p), 'utf8')
}

const XLSX_SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)

function basePayload(overrides = {}) {
  return {
    schema: PO_ACK_SCHEMA,
    event_id: 'tj.po.queue.done.v1.0123456789abcdef',
    business_po_id: 'PO-123456',
    po_id: 'PO-123456',
    source_sha256: XLSX_SHA,
    irs_po_number: 'PO26000783',
    verification: 'MANUAL_POSTSAVE_VERIFIED',
    queue_done_ack: true,
    queue_done_sha256: XLSX_SHA,
    queue_folder: 'Done',
    ledger_state: 'SAVED_VERIFIED_QUEUE_DONE',
    callback_state: 'OUTBOX_NOT_SENT',
    ...overrides,
  }
}

function facts(overrides = {}) {
  const payload = normalizeAckPayload(basePayload())
  const f = {
    payload,
    fingerprint: 'fp',
    receipt: null,
    po: { id: 'uuid-po', po_id: 'PO-123456' },
    pushIntent: { state: 'delivered', xlsx_sha256: XLSX_SHA, content_sha256: 'business-json-hash' },
    existingIrsOwner: null,
  }
  return { ...f, ...overrides }
}

// ---------------------------------------------------------------------------
// normalizeAckPayload
// ---------------------------------------------------------------------------
test('normalize：合法负载 + 非关键字段被忽略', () => {
  const n = normalizeAckPayload(basePayload({ queue_done_verified_at: 'x', transport: 'y', warning: 'z' }))
  assert.equal(n.eventId, 'tj.po.queue.done.v1.0123456789abcdef')
  assert.equal(n.poId, 'PO-123456')
  assert.equal(n.queueDoneAck, true)
  assert.equal(n.sourceSha256, XLSX_SHA)
})

test('normalize：schema 非法 → INVALID_SCHEMA', () => {
  assert.throws(() => normalizeAckPayload(basePayload({ schema: 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V2' })),
    (e) => e instanceof PoAckError && e.code === PO_ACK_CODES.INVALID_SCHEMA)
})

test('normalize：event_id 缺失/非法 → INVALID_EVENT_ID', () => {
  assert.throws(() => normalizeAckPayload(basePayload({ event_id: undefined })), (e) => e.code === PO_ACK_CODES.INVALID_EVENT_ID)
  assert.throws(() => normalizeAckPayload(basePayload({ event_id: 'not-an-id' })), (e) => e.code === PO_ACK_CODES.INVALID_EVENT_ID)
  // event_id 是幂等 ID，不是鉴权签名：不含 JWT/签名语义，只校验格式
  assert.throws(() => normalizeAckPayload(basePayload({ event_id: 'eyJhbGciOi...' })), (e) => e.code === PO_ACK_CODES.INVALID_EVENT_ID)
})

// ---------------------------------------------------------------------------
// computeAckFingerprint（幂等指纹）
// ---------------------------------------------------------------------------
test('指纹：确定、64 位 hex，语义字段变化即变，易变字段不参与', async () => {
  const fp1 = await computeAckFingerprint(basePayload())
  const fp2 = await computeAckFingerprint(basePayload())
  assert.match(fp1, /^[0-9a-f]{64}$/)
  assert.equal(fp1, fp2)

  const changed = await computeAckFingerprint(basePayload({ source_sha256: OTHER_SHA }))
  assert.notEqual(fp1, changed)

  // callback_state / transport 等易变字段不参与指纹（重试不误判冲突）
  const same = await computeAckFingerprint(basePayload({ callback_state: 'OUTBOX_SENT', transport: 'https' }))
  assert.equal(fp1, same)
})

test('指纹源与 SQL 口径：| 连接、空值归一、queue_done_ack 1/0', () => {
  const n = normalizeAckPayload(basePayload())
  const src = ackFingerprintSource(n)
  assert.equal(src, [
    'PO-123456', 'PO-123456', XLSX_SHA, XLSX_SHA, 'PO26000783',
    'MANUAL_POSTSAVE_VERIFIED', '1', 'Done', 'SAVED_VERIFIED_QUEUE_DONE',
  ].join('|'))
  const n2 = normalizeAckPayload(basePayload({ queue_done_ack: false }))
  assert.ok(ackFingerprintSource(n2).includes('|0|'))
})

// ---------------------------------------------------------------------------
// decideAck：判定状态机
// ---------------------------------------------------------------------------
test('decideAck：全通过 → accepted，不重建、不重投、不互比两种 sha', async () => {
  const fp = await computeAckFingerprint(basePayload())
  const v = decideAck(facts({ fingerprint: fp }))
  assert.equal(v.state, PO_ACK_STATES.ACCEPTED)
  assert.equal(v.code, null)
  assert.equal(v.rejected, false)
  assert.ok(v.mustNot.some((s) => s.includes('不把 content_sha256')))
})

test('decideAck：同 event_id 同指纹 → replay（不再写入）', async () => {
  const fp = await computeAckFingerprint(basePayload())
  const v = decideAck(facts({
    fingerprint: fp,
    receipt: { content_sha256: fp, state: 'accepted' },
  }))
  assert.equal(v.state, PO_ACK_STATES.ACCEPTED)
  assert.equal(v.replayed, true)
  assert.equal(v.code, PO_ACK_CODES.REPLAY)
})

test('decideAck：同 event_id 不同指纹 → 冲突拒绝', async () => {
  const fp = await computeAckFingerprint(basePayload())
  const v = decideAck(facts({
    fingerprint: fp,
    receipt: { content_sha256: 'other-fp', state: 'accepted' },
  }))
  assert.equal(v.state, PO_ACK_STATES.REJECTED)
  assert.equal(v.rejected, true)
  assert.equal(v.code, PO_ACK_CODES.CONFLICT)
})

test('decideAck：queue_done_ack 非 true → DONE_ACK_MISSING', async () => {
  const p = normalizeAckPayload(basePayload({ queue_done_ack: false }))
  const v = decideAck(facts({ payload: p, fingerprint: 'x' }))
  assert.equal(v.code, PO_ACK_CODES.DONE_ACK_MISSING)
  assert.equal(v.rejected, true)
})

test('decideAck：PO 已清理/找不到 → needs_review，绝不自动重建', async () => {
  const v = decideAck(facts({ fingerprint: 'x', po: null }))
  assert.equal(v.state, PO_ACK_STATES.NEEDS_REVIEW)
  assert.equal(v.code, PO_ACK_CODES.PO_NOT_FOUND)
  assert.ok(v.mustNot.some((s) => s.includes('绝不自动重建')))
})

test('decideAck：未见 delivered 投递意图 → NO_PUSH_DELIVERY', async () => {
  assert.equal(decideAck(facts({ fingerprint: 'x', pushIntent: null })).code, PO_ACK_CODES.NO_PUSH_DELIVERY)
  assert.equal(decideAck(facts({ fingerprint: 'x', pushIntent: { state: 'dispatch_started' } })).code, PO_ACK_CODES.NO_PUSH_DELIVERY)
})

test('decideAck：source_sha256 与投递清单 xlsx_sha256 不一致 → SHA_MISMATCH', async () => {
  const v = decideAck(facts({ fingerprint: 'x', pushIntent: { state: 'delivered', xlsx_sha256: OTHER_SHA } }))
  assert.equal(v.code, PO_ACK_CODES.SHA_MISMATCH)
})

test('decideAck：queue_done_sha256 与 source_sha256 不一致 → SHA_MISMATCH', async () => {
  const p = normalizeAckPayload(basePayload({ queue_done_sha256: OTHER_SHA }))
  const v = decideAck(facts({ payload: p, fingerprint: 'x' }))
  assert.equal(v.code, PO_ACK_CODES.SHA_MISMATCH)
})

test('decideAck：source_sha256 非 64 位 hex → SHA_MISMATCH', async () => {
  const p = normalizeAckPayload(basePayload({ source_sha256: 'not-a-sha' }))
  const v = decideAck(facts({ payload: p, fingerprint: 'x' }))
  assert.equal(v.code, PO_ACK_CODES.SHA_MISMATCH)
})

test('decideAck：IRS 号被另一 PO 占用 → IRS_NUMBER_CONFLICT', async () => {
  const v = decideAck(facts({
    fingerprint: 'x',
    existingIrsOwner: { id: 'other-po', po_id: 'PO-999999' },
  }))
  assert.equal(v.code, PO_ACK_CODES.IRS_NUMBER_CONFLICT)
})

test('decideAck：synthetic 历史编号（PO-878329→PO26000783）不写回、不自动建 PO', async () => {
  // PO 不在 Website（已清理）时，即使带真实 IRS 号也只 needs_review，不自动重建、不写回
  const p = normalizeAckPayload(basePayload({ po_id: 'PO-878329', business_po_id: 'PO-878329', irs_po_number: 'PO26000783' }))
  const v = decideAck(facts({ payload: p, fingerprint: 'x', po: null }))
  assert.equal(v.code, PO_ACK_CODES.PO_NOT_FOUND)
  assert.equal(v.state, PO_ACK_STATES.NEEDS_REVIEW)
})

// ---------------------------------------------------------------------------
// content_sha256（业务 JSON）与 xlsx_sha256（文件字节）是两种不同哈希，绝不互比
// ---------------------------------------------------------------------------
test('content_sha256（业务 JSON）≠ xlsx_sha256（文件字节）：证明不得直接比较', () => {
  const header = {
    po_id: 'PO-123456', po_type: 'standard',
    supplier_code: '4000/A01', supplier_name: 'AMFIX', website_po_date: '2026-11-15',
  }
  const lines = [
    { item_code: '00101', description: 'x', uom: 'UNIT', qty: '4', unit_price: '2.50', original_qty: '5' },
  ]
  const contentSha = computePushContentSha256(header, lines)
  // 一份真实 XLSX 字节（任意 Buffer）
  const xlsxBytes = Buffer.from('this is a real exported xlsx binary blob', 'utf8')
  const xlsxSha = computeXlsxSha256(xlsxBytes)
  assert.match(contentSha, /^[0-9a-f]{64}$/)
  assert.match(xlsxSha, /^[0-9a-f]{64}$/)
  // 两者算法不同、字节不同，必然不同值 —— 这是 ACK 绝不能拿 source_sha256 比 content_sha256 的根据
  assert.notEqual(contentSha, xlsxSha)
})

// ---------------------------------------------------------------------------
// 迁移文件声明（与 receipt-event-dedup 测试同款：迁移在仓库里且声明正确）
// ---------------------------------------------------------------------------
test('迁移：声明 xlsx_sha256、ACK 回执唯一 event_id、ingest RPC、鉴权、撤销 anon', () => {
  const sql = read('supabase/migrations/20261115_po_done_ack.sql')
  assert.match(sql, /xlsx_sha256 text/)
  assert.match(sql, /create unique index if not exists uq_tj_po_ack_receipts_event_id\s+on public\.tj_po_ack_receipts \(event_id\)/)
  assert.match(sql, /create or replace function public\.tj_po_ack_ingest\(p_payload jsonb\)/)
  assert.match(sql, /security definer/)
  assert.match(sql, /revoke all on function public\.tj_po_ack_ingest\(jsonb\) from public/)
  assert.match(sql, /grant execute on function public\.tj_po_ack_ingest\(jsonb\) to authenticated/)
  assert.match(sql, /auth\.uid\(\)/)
})

test('迁移：PO ACK 只动 public tj_po_* / tj_po_ack_*，不执行任何 GR/预览对象', () => {
  const sql = read('supabase/migrations/20261115_po_done_ack.sql')
  // 去掉注释行后，不得出现任何 tj_gr_ / tj_preview 的可执行语句
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(code, /tj_gr_/)
  assert.doesNotMatch(code, /tj_preview\./)
  assert.doesNotMatch(code, /tj_gr_task_result/)
})

test('describeAckState：accepted/needs_review/rejected 展示文案', () => {
  assert.equal(describeAckState('accepted'), '已保存并核对（Queue Done）')
  assert.match(describeAckState('needs_review', 'PO_ACK_SHA_MISMATCH'), /SHA_MISMATCH/)
  assert.match(describeAckState('rejected', 'PO_ACK_CONFLICT'), /CONFLICT/)
})
