// GR 模拟 dispatcher：只写本地 scratch，硬拒绝真实出队线索；
// 并且**离线重算** payload 里的完整事件快照与任务哈希（不只看 64 位 hex 格式）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildDispatchPlan,
  writeDispatchPlan,
  validateDispatchRow,
  assertLocalPosixPath,
  DispatchRefused,
  DISPATCH_SCHEMA,
  sha256Hex,
} from '../scripts/gr-mock-dispatcher.mjs'
import { canonicalTaskPayloadFromPayload } from '../web/src/lib/core/receipt-tasks.js'
import { canonicalEventPayload } from '../web/src/lib/core/receipt-core.js'

const TASK = '77777777-7777-4777-8777-777777777777'
const EV = '11111111-1111-4111-8111-111111111111'
const L1 = '33333333-3333-4333-8333-333333333333'
const P1 = '55555555-5555-4555-8555-555555555555'
const PL1 = '66666666-6666-4666-8666-666666666666'

function makePayload() {
  const snapshot = {
    id: EV,
    event_no: 'GR-TEST-1',
    revision: 1,
    status: 'approved',
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
    po_ids: [P1],
    invoice_no: 'INV-1',
    delivery_order_no: 'DO-1',
    receive_date: '2026-11-13',
    invoice_date: '2026-11-10',
    checked_by: 'Ah Huat',
    approved_by: 'a0000000-0000-4000-8000-000000000001',
    approved_at: '2026-11-13T01:02:03Z',
    allow_exceptions: false,
    review_note: null,
    note: 'ok',
    payload_sha256: null,
    lines: [
      {
        id: L1,
        line_no: 1,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.5',
        ordered_qty: '5',
        accepted_qty: '4',
        note: '短收 1',
        sources: [{ po_header_id: P1, po_line_id: PL1, ordered_qty: '5', accepted_qty: '4' }],
      },
    ],
  }
  const eventHash = sha256Hex(canonicalEventPayload(snapshot))
  snapshot.payload_sha256 = eventHash
  return {
    task: {
      id: TASK,
      type: 'GOODS_RECEIVE',
      schema: 'tj.gr.v1',
      environment: 'preview',
      mock_only: true,
      event_revision: 1,
      po_header_id: P1,
      po_id: 'PO-000001',
      irs_po_no: '5',
    },
    mapping: {
      po_header_id: P1,
      po_id: 'PO-000001',
      irs_po_no: '5',
      irs_invoice_no: 'INV-1',
      evidence_sha256: 'b'.repeat(64),
    },
    event_payload_sha256: eventHash,
    approved_event_snapshot: snapshot,
    scope: {
      po_header_id: P1,
      po_id: 'PO-000001',
      lines: [
        {
          line_id: L1,
          line_no: 1,
          item_code: '00101',
          description: 'HINGE',
          uom: 'UNIT',
          unit_price: '2.5',
          ordered_qty: '5',
          accepted_qty: '4',
          note: '短收 1',
          sources: [{ po_header_id: P1, po_id: 'PO-000001', po_line_id: PL1, ordered_qty: '5', accepted_qty: '4' }],
        },
      ],
    },
    source_refs: [
      {
        receipt_line_id: L1,
        line_no: 1,
        po_header_id: P1,
        po_id: 'PO-000001',
        po_line_id: PL1,
        item_code: '00101',
        description: 'HINGE',
        uom: 'UNIT',
        unit_price: '2.5',
        ordered_qty: '5',
        accepted_qty: '4',
      },
    ],
  }
}

function payloadHash(p) {
  return sha256Hex(canonicalTaskPayloadFromPayload(p))
}

function row(over = {}) {
  const payload = makePayload()
  return {
    task_id: TASK,
    request_id: `gr:${TASK}`,
    receipt_event_id: EV,
    po_header_id: P1,
    environment: 'preview',
    mock_only: true,
    task_type: 'GOODS_RECEIVE',
    schema: 'tj.gr.v1',
    status: 'pending',
    payload_sha256: payloadHash(payload),
    payload,
    ...over,
  }
}

async function scratchDir() {
  const root = process.env.HERMES_SCRATCH || os.tmpdir()
  return fs.mkdtemp(path.join(root, 'gr-disp-test-'))
}

function refusal(fn, code) {
  assert.throws(fn, (e) => e instanceof DispatchRefused && e.code === code)
}

async function refusalAsync(promise, code) {
  await assert.rejects(promise, (e) => e instanceof DispatchRefused && e.code === code)
}

test('合法预览任务 → 生成计划与文件（manifest 计数一致）', async () => {
  const plan = buildDispatchPlan({ rows: [row()] })
  assert.equal(plan.schema, DISPATCH_SCHEMA)
  assert.equal(plan.mode, 'mock')
  assert.equal(plan.count, 1)
  assert.match(plan.files[0].content, /"mode": "mock"/)

  const dir = await scratchDir()
  const out = await writeDispatchPlan(plan, { outdir: path.join(dir, 'out'), root: dir })
  assert.equal(out.count, 1)
  const files = await fs.readdir(path.join(dir, 'out'))
  assert.deepEqual(files.sort(), [`task-${TASK}.json`, 'manifest.json'].sort())
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'out', 'manifest.json'), 'utf8'))
  assert.equal(manifest.count, 1)
  assert.equal(manifest.tasks[0].payload_sha256, payloadHash(makePayload()))
  const written = JSON.parse(await fs.readFile(path.join(dir, 'out', `task-${TASK}.json`), 'utf8'))
  assert.equal(written.task.payload.approved_event_snapshot.lines.length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('拒绝非 preview / 非 mock_only / 错误 type / 错误 schema', () => {
  refusal(() => validateDispatchRow(row({ environment: 'public' })), 'GR_DISPATCH_ENV')
  refusal(() => validateDispatchRow(row({ mock_only: false })), 'GR_DISPATCH_MOCK_ONLY')
  refusal(() => validateDispatchRow(row({ task_type: 'PO_PUSH' })), 'GR_DISPATCH_TASK_TYPE')
  refusal(() => validateDispatchRow(row({ schema: 'tj.gr.v2' })), 'GR_DISPATCH_SCHEMA')
  refusal(() => validateDispatchRow(row({ payload_sha256: 'nope' })), 'GR_DISPATCH_HASH')
  refusal(() => validateDispatchRow(row({ task_id: 'not-a-uuid' })), 'GR_DISPATCH_TASK_ID')
})

test('离线重算：payload 哈希/事件快照哈希必须与真实内容一致', () => {
  // 只把 hex 换成另一个合法 64 位 hex（旧的“仅格式检查”会放过）
  refusal(() => validateDispatchRow(row({ payload_sha256: 'c'.repeat(64) })), 'GR_DISPATCH_HASH_MISMATCH')

  // 任务内容被改但 hash 未更新
  const tampered = row()
  tampered.payload.scope.lines[0].accepted_qty = '5'
  refusal(() => validateDispatchRow(tampered), 'GR_DISPATCH_HASH_MISMATCH')

  // 事件快照被改，但 event_payload_sha256 还是旧的 → 事件哈希不一致
  const badEvent = row()
  badEvent.payload.approved_event_snapshot.lines[0].accepted_qty = '5'
  badEvent.payload_sha256 = payloadHash(badEvent.payload)
  refusal(() => validateDispatchRow(badEvent), 'GR_DISPATCH_EVENT_HASH_MISMATCH')

  // 事件快照缺失全部行 → 无法离线复算，整体拒绝（旧 payload.event 只有 header 的形态）
  const incomplete = row()
  incomplete.payload.approved_event_snapshot = { id: EV, revision: 1 }
  incomplete.payload_sha256 = payloadHash(incomplete.payload)
  refusal(() => validateDispatchRow(incomplete), 'GR_DISPATCH_PAYLOAD_INCOMPLETE')

  // 旧结构：没有 approved_event_snapshot，只有 event header
  const legacy = row()
  legacy.payload = { event: { id: EV }, scope: { lines: [] }, task: { id: TASK } }
  legacy.payload_sha256 = payloadHash(legacy.payload)
  refusal(() => validateDispatchRow(legacy), 'GR_DISPATCH_PAYLOAD_INCOMPLETE')
})

test('拒绝 payload 里的真实出队线索（http / bridge / Windows 路径）', () => {
  refusal(
    () => validateDispatchRow(row({ payload: { ...row().payload, bridge_url: 'http://127.0.0.1:9000/write' } })),
    'GR_DISPATCH_REAL_BRIDGE',
  )
  refusal(
    () => validateDispatchRow(row({ payload: { ...row().payload, target: 'C:\\Users\\Administrator\\Desktop\\PO_Queue\\Pending' } })),
    'GR_DISPATCH_REAL_BRIDGE',
  )
})

test('拒绝 Windows 输出路径与 root 之外的目录；dry-run 不落盘', async () => {
  refusal(() => assertLocalPosixPath('C:\\temp\\out', 'outdir'), 'GR_DISPATCH_WINDOWS_PATH')
  refusal(() => assertLocalPosixPath('\\\\server\\share', 'outdir'), 'GR_DISPATCH_WINDOWS_PATH')

  const plan = buildDispatchPlan({ rows: [row()] })
  const dir = await scratchDir()
  // 兄弟目录（不含 ..，确保命中「不在 root 之内」而不是路径规范化检查）
  const sibling = path.join(path.dirname(dir), `gr-escape-${Date.now()}`)
  await refusalAsync(
    writeDispatchPlan(plan, { outdir: sibling, root: dir }),
    'GR_DISPATCH_OUTSIDE_ROOT',
  )
  await refusalAsync(
    // 不经过 path.join 归一化，保留 .. 以命中路径检查
    writeDispatchPlan(plan, { outdir: `${dir}/../escape`, root: dir }),
    'GR_DISPATCH_PATH',
  )

  const dry = await writeDispatchPlan(plan, { outdir: path.join(dir, 'out'), root: dir, dryRun: true })
  assert.equal(dry.dry_run, true)
  await assert.rejects(fs.readdir(path.join(dir, 'out')))
  await fs.rm(dir, { recursive: true, force: true })
})

test('空批次 / 重复 request_id 被拒（不允许静默重复出队）', () => {
  refusal(() => buildDispatchPlan({ rows: [] }), 'GR_DISPATCH_EMPTY')
  refusal(() => buildDispatchPlan({ rows: [row(), row()] }), 'GR_DISPATCH_DUPLICATE')
})
