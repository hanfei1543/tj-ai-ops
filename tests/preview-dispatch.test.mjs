// Preview PO 推送器（tj_preview → Windows Pending）离线回归：
//   1) 8 列 PAD 口径 + 缺 Website PO Date fail closed（bridge 零调用、不改状态）
//   2) 永久 artifact 原件字节 hash = bridge 写入 b64 hash = bridge read 回 hash
//   3) server_prepared / windows_received 两级独立证据，顺序与 stage 分开
//   4) bridge 写失败 / read 回错 hash / 同名已存在 / delivered 落库失败 → uncertain，不重试
//   5) 同 request 重跑绝不第二次 write
//   6) 只允许 tj_preview + 只允许 Pending（新 PO），SQL 不碰 public
// 依赖全部注入；不触真实数据库 / bridge / Windows / Telegram。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  DELIVERY_CHANNEL,
  EVIDENCE_STAGES,
  PREVIEW_SCHEMA,
  QUEUE_ROOT,
  REQUEST_STATES,
  TARGET_DIR,
  PreviewDispatchError,
  assertPreviewSql,
  buildClaimSql,
  buildLoadPoSql,
  buildPreparedEvidenceSql,
  createFileArtifactStore,
  runPreviewDispatch,
  sqlLiteral,
  windowsPathJoin,
  windowsPathJoinDir,
} from '../scripts/lib/preview-dispatch-core.mjs'

const HDR = {
  id: '11111111-1111-4111-8111-111111111111',
  po_id: 'PO-000101',
  po_type: 'standard',
  status: 'confirmed',
  frozen: false,
  supplier_code: '4000/A01',
  supplier_name: 'AMFIX',
  website_po_date: '2026-11-16',
}
const LINES = [
  { line_no: 1, item_code: '0010001000002', description: 'HINGE', uom: 'UNIT', qty: '5.000000', unit_price: '1.250000' },
  { line_no: 2, item_code: '0020002000002', description: 'PLATE', uom: 'PCS', qty: '2.000000', unit_price: '0.900000' },
]
const REQ_ID = 'req-00000000-0000-4000-8000-000000000101'
const REQUEST_UUID = '33333333-3333-4333-8333-333333333333'
const INTENT_UUID = '22222222-2222-4222-8222-222222222222'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tj-preview-dispatch-'))
}

/**
 * 轻量内存“数据库”：按生成的 SQL 标记分派，记录调用顺序。
 * 不是 SQL 引擎——SQL 语义由 build*Sql 的字符串断言与真实迁移审阅覆盖；
 * 这里验证编排、状态机、证据顺序与失败路径。
 */
function makeDb({ request = null, header = HDR, lines = LINES, intent = null, evidence = [], failFinalize = false } = {}) {
  const state = {
    request: request
      ? { id: REQUEST_UUID, request_id: REQ_ID, po_header_id: HDR.id, state: 'requested', ...request }
      : { id: REQUEST_UUID, request_id: REQ_ID, po_header_id: HDR.id, state: 'requested' },
    intent: intent ? { id: INTENT_UUID, ...intent } : null,
    evidence: evidence.map((e) => ({ id: `ev-${e.stage}`, ...e })),
  }
  const calls = []
  const dbQuery = async (sql) => {
    calls.push(sql)

    // 读请求行
    if (/select id, po_header_id, request_id, state/.test(sql) && /tj_po_preview_push_requests/.test(sql)) {
      if (!state.request) return []
      return [{ ...state.request }]
    }
    // 原子抢单（UPDATE ... WHERE state='requested' + intent UNIQUE）
    if (/with claimed as/.test(sql)) {
      if (state.request.state !== 'requested' || state.intent) return []
      state.request.state = REQUEST_STATES.DISPATCH_STARTED
      state.intent = {
        id: INTENT_UUID,
        po_header_id: state.request.po_header_id,
        content_sha256: /content_sha256/.test(sql) ? 'claimed' : null,
        state: REQUEST_STATES.DISPATCH_STARTED,
        delivery_channel: DELIVERY_CHANNEL,
      }
      return [
        {
          request_uuid: state.request.id,
          po_header_id: state.request.po_header_id,
          request_id: state.request.request_id,
          intent_id: state.intent.id,
        },
      ]
    }
    // 抢单失败后的只读诊断
    if (/select r\.state as request_state/.test(sql) && /as intent_state/.test(sql)) {
      return [
        {
          request_state: state.request?.state ?? null,
          intent_id: state.intent?.id ?? null,
          intent_state: state.intent?.state ?? null,
        },
      ]
    }
    // 读 PO + lines（单次 JSON）
    if (/json_build_object\(\s*'header'/.test(sql)) {
      return [{ payload: { header, lines } }]
    }
    // server_prepared 证据（unique(intent_id,stage)）
    if (/'server_prepared'/.test(sql) && /insert into tj_preview\.tj_po_push_delivery_evidence/.test(sql)) {
      let row = state.evidence.find((e) => e.stage === EVIDENCE_STAGES.SERVER_PREPARED)
      if (!row) {
        row = {
          id: 'ev-server_prepared',
          intent_id: state.intent.id,
          stage: EVIDENCE_STAGES.SERVER_PREPARED,
          xlsx_sha256: /[0-9a-f]{64}/.exec(sql)?.[0],
          byte_count: Number(/values \(\s*'[^']*',\s*'server_prepared',\s*'[^']*',\s*(\d+)/.exec(sql)?.[1] ?? 0),
          target_path: /'((?:[^']|'')*)'\s*,\s*'\{/.exec(sql)?.[1]?.replace(/''/g, "'") ?? null,
        }
        state.evidence.push(row)
      }
      return [{ ...row }]
    }
    // windows_received 证据 + intent/request delivered（同一语句）
    if (/'windows_received'/.test(sql) && /insert into tj_preview\.tj_po_push_delivery_evidence/.test(sql)) {
      if (failFinalize) throw new Error('db down during finalize')
      let row = state.evidence.find((e) => e.stage === EVIDENCE_STAGES.WINDOWS_RECEIVED)
      if (!row) {
        row = {
          id: 'ev-windows_received',
          intent_id: state.intent.id,
          stage: EVIDENCE_STAGES.WINDOWS_RECEIVED,
          xlsx_sha256: /[0-9a-f]{64}/.exec(sql)?.[0],
          byte_count: Number(/values \(\s*'[^']*',\s*'windows_received',\s*'[^']*',\s*(\d+)/.exec(sql)?.[1] ?? 0),
          target_path: null,
        }
        state.evidence.push(row)
      }
      // CTE 内的 UPDATE 只有 intent 仍是 dispatch_started 才生效
      const intentOk = state.intent.state === REQUEST_STATES.DISPATCH_STARTED
      if (intentOk) state.intent.state = REQUEST_STATES.DELIVERED
      const requestOk = state.request.state === REQUEST_STATES.DISPATCH_STARTED && intentOk
      if (requestOk) state.request.state = REQUEST_STATES.DELIVERED
      return [
        {
          evidence_rows: 1,
          intent_state: intentOk ? REQUEST_STATES.DELIVERED : state.intent.state,
          request_state: requestOk ? REQUEST_STATES.DELIVERED : state.request.state,
        },
      ]
    }
    // uncertain 标记
    if (/state = 'delivery_uncertain'/.test(sql)) {
      if (state.intent && state.intent.state !== REQUEST_STATES.DELIVERED) {
        state.intent.state = REQUEST_STATES.DELIVERY_UNCERTAIN
      }
      if (state.request && state.request.state !== REQUEST_STATES.DELIVERED) {
        state.request.state = REQUEST_STATES.DELIVERY_UNCERTAIN
      }
      return [{ id: state.request.id, state: state.request.state }]
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 120)}`)
  }
  return { dbQuery, calls, state }
}

function makeBridge({ entries = [], write = {}, readBytes = null, listThrows = false } = {}) {
  const calls = []
  let lastWritten = null
  const call = async (payload) => {
    calls.push(payload)
    if (payload.list) {
      if (listThrows) throw new Error('bridge connection refused')
      return { ok: true, entries: entries.map((e) => (typeof e === 'string' ? e : { name: e.name })) }
    }
    if (payload.write) {
      if (write.throw) throw new Error(write.throw)
      if (write.ok === false) return { ok: false, error: write.error ?? 'disk full' }
      lastWritten = payload.write.b64
      return {
        ok: true,
        size: Buffer.from(payload.write.b64, 'base64').length,
        path: payload.write.path,
      }
    }
    if (payload.read) {
      const bytes = readBytes ?? lastWritten
      if (!bytes) return { ok: false, error: 'not found' }
      return { ok: true, size: Buffer.from(bytes, 'base64').length, b64: bytes }
    }
    throw new Error('unexpected bridge payload')
  }
  return { call, calls, writes: () => calls.filter((c) => c.write) }
}

function build(overrides = {}) {
  const root = tmpRoot()
  const db = makeDb(overrides.db)
  const bridge = makeBridge(overrides.bridge)
  const logs = []
  const artifacts = createFileArtifactStore({ root })
  const run = (requestId = REQ_ID, extra = {}) =>
    runPreviewDispatch({
      requestId,
      dbQuery: db.dbQuery,
      bridge: bridge.call,
      artifacts,
      log: { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
      now: () => new Date('2026-11-16T03:00:00.000Z'),
      ...extra,
    })
  return { db, bridge, artifacts, logs, run, root }
}

test('成功路径：8 列 PAD 口径 + 永久原件 + 两级证据 + 同一次写入', async () => {
  const { db, bridge, artifacts, run, root } = build({})
  const res = await run()

  assert.equal(res.state, REQUEST_STATES.DELIVERED)
  assert.equal(res.poId, HDR.po_id)
  assert.equal(res.filename, `${HDR.po_id}.xlsx`)
  assert.equal(db.state.intent.state, REQUEST_STATES.DELIVERED)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERED)
  assert.equal(db.state.intent.delivery_channel, DELIVERY_CHANNEL)

  // 8 列：7 列业务列 + Website PO Date；日期取显式业务日期
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(fs.readFileSync(res.artifactPath))
  const ws = wb.getWorksheet('PO_Lines')
  const header = ws.getRow(1).values.slice(1)
  assert.deepEqual(header, [
    'Supplier Code',
    'Supplier Name',
    'Item Code',
    'Description',
    'UOM',
    'Qty',
    'Unit Price (RM)',
    'Website PO Date',
  ])
  assert.equal(ws.getRow(2).getCell(8).value, '2026-11-16')
  assert.equal(ws.rowCount, LINES.length + 1)

  // 原件 hash = 写入 b64 hash = read 回 hash；artifact 不在 scratch
  const written = bridge.writes()[0]
  assert.equal(bridge.writes().length, 1)
  const writtenBytes = Buffer.from(written.write.b64, 'base64')
  assert.equal(res.xlsxSha256, res.artifactSha256)
  assert.equal(res.xlsxSha256, (await import('node:crypto')).createHash('sha256').update(writtenBytes).digest('hex'))
  assert.ok(res.artifactPath.startsWith(root))
  // 预检每个 Queue 目录（只读），最后才 write + read
  assert.deepEqual(
    bridge.calls.map((c) => Object.keys(c)[0]),
    ['list', 'list', 'list', 'list', 'list', 'write', 'read'],
  )
  assert.deepEqual(
    bridge.calls.filter((c) => c.list).map((c) => c.list),
    ['Pending', 'Processing', 'Done', 'Failed', 'NeedsReview'].map((d) => windowsPathJoinDir(QUEUE_ROOT, d)),
  )

  // 两级证据分开、同 sha、同字节数；server_prepared 先于 bridge write
  const stages = db.state.evidence.map((e) => e.stage)
  assert.deepEqual(stages, [EVIDENCE_STAGES.SERVER_PREPARED, EVIDENCE_STAGES.WINDOWS_RECEIVED])
  for (const ev of db.state.evidence) {
    assert.equal(ev.xlsx_sha256, res.xlsxSha256)
    assert.equal(ev.byte_count, writtenBytes.length)
  }
  const preparedIdx = db.calls.findIndex((s) => /'server_prepared'/.test(s))
  assert.ok(preparedIdx >= 0)
  assert.equal(db.calls.slice(0, preparedIdx).some((s) => /'windows_received'/.test(s)), false)

  // 目标目录只能是 Pending 且只写一次
  assert.equal(written.write.path, windowsPathJoin(TARGET_DIR, `${HDR.po_id}.xlsx`))
  assert.equal(db.calls.some((s) => /public\./.test(s)), false, '不得读/写 public')
  assert.ok(
    db.calls.some((s) => /from tj_preview\.tj_po_headers/.test(s)),
    'PO 事实必须从 tj_preview 读',
  )
  assert.equal(db.calls.some((s) => /tj_po_exports/.test(s)), false, '预览投递不写生产审计表')
})

test('缺 Website PO Date：fail closed（不改状态、不调 bridge）', async () => {
  const { db, bridge, run } = build({ db: { header: { ...HDR, website_po_date: null } } })
  await assert.rejects(run(), (e) => e instanceof PreviewDispatchError && e.code === 'MISSING_WEBSITE_PO_DATE')
  assert.equal(bridge.calls.length, 0)
  assert.equal(db.state.request.state, 'requested')
  assert.equal(db.state.intent, null)
})

test('非法日期格式：fail closed，不生成文件、不写库状态', async () => {
  const { db, bridge, run } = build({ db: { header: { ...HDR, website_po_date: '16/11/2026' } } })
  await assert.rejects(run(), (e) => e.code === 'INVALID_WEBSITE_PO_DATE')
  assert.equal(bridge.calls.length, 0)
  assert.equal(db.state.request.state, 'requested')
})

test('bridge 写失败 → delivery_uncertain；同 request 重跑无第二次 write', async () => {
  const { db, bridge, run } = build({ bridge: { write: { ok: false, error: 'disk full' } } })
  await assert.rejects(run(), (e) => e.uncertain === true && e.code === 'BRIDGE_WRITE_FAILED')
  assert.equal(bridge.writes().length, 1)
  assert.equal(db.state.intent.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)

  await assert.rejects(run(), (e) => e.uncertain === true)
  assert.equal(bridge.writes().length, 1, '不确定后绝不重试')
})

test('bridge 抛错 → uncertain，不重试', async () => {
  const { db, bridge, run } = build({ bridge: { write: { throw: 'ECONNRESET' } } })
  await assert.rejects(run(), (e) => e.uncertain === true)
  assert.equal(bridge.writes().length, 1)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  await assert.rejects(run())
  assert.equal(bridge.writes().length, 1)
})

test('read 回 hash 不一致 → uncertain，绝不标记 delivered', async () => {
  const { db, bridge, run } = build({ bridge: { readBytes: Buffer.from('tampered').toString('base64') } })
  await assert.rejects(run(), (e) => e.uncertain === true && e.code === 'READBACK_MISMATCH')
  assert.equal(bridge.writes().length, 1)
  assert.equal(db.state.intent.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  assert.equal(
    db.state.evidence.some((e) => e.stage === EVIDENCE_STAGES.WINDOWS_RECEIVED),
    false,
    'read 回不一致不得写 windows_received',
  )
  await assert.rejects(run())
  assert.equal(bridge.writes().length, 1)
})

test('Pending 已有同名文件 → 拒绝覆写并 uncertain（bridge 只 list，不 write）', async () => {
  const { db, bridge, run } = build({ bridge: { entries: [`${HDR.po_id}.xlsx`] } })
  await assert.rejects(run(), (e) => e.uncertain === true && e.code === 'TARGET_EXISTS')
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].list, TARGET_DIR)
  assert.equal(bridge.writes().length, 0)
  assert.equal(db.state.intent.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  assert.equal(db.state.evidence.some((e) => e.stage === EVIDENCE_STAGES.WINDOWS_RECEIVED), false)
})

test('同 PO 文件已出现在 Done/Processing → 拒绝（防把已处理单当新单重投）', async () => {
  for (const dir of ['Done', 'Processing']) {
    const { db, bridge, run } = build({ bridge: { entries: [`${HDR.po_id}.xlsx`] } })
    // 让 list 只在指定目录返回同名文件
    const original = bridge.call
    const seen = []
    const scoped = async (payload) => {
      if (payload.list) {
        seen.push(payload.list)
        const hit = payload.list.endsWith('\\' + dir)
        return { ok: true, entries: hit ? [`${HDR.po_id}.xlsx`] : [] }
      }
      return original(payload)
    }
    await assert.rejects(run(REQ_ID, { bridge: scoped }), (e) => e.code === 'QUEUE_FILE_EXISTS' && e.uncertain === true)
    assert.equal(bridge.writes().length, 0)
    assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
    assert.ok(seen.some((d) => d.endsWith('\\' + dir)))
  }
})

test('bridge 目录检查失败 → uncertain（不能证明目标不存在就不写）', async () => {
  const { db, bridge, run } = build({ bridge: { listThrows: true } })
  await assert.rejects(run(), (e) => e.uncertain === true && e.code === 'BRIDGE_LIST_FAILED')
  assert.equal(bridge.writes().length, 0)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
})

test('delivered 落库失败 → uncertain；重跑不得再 write', async () => {
  const { db, bridge, run } = build({ db: { failFinalize: true } })
  await assert.rejects(run(), (e) => e.uncertain === true && e.code === 'FINALIZE_FAILED')
  assert.equal(bridge.writes().length, 1)
  assert.equal(db.state.intent.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
  await assert.rejects(run())
  assert.equal(bridge.writes().length, 1, '数据库未记 delivered 也绝不重投')
})

test('已 delivered 的同 request 重跑：无第二次 write', async () => {
  const { bridge, run } = build({ db: { request: { state: REQUEST_STATES.DELIVERED } } })
  const res = await run()
  assert.equal(res.alreadyDelivered, true)
  assert.equal(bridge.calls.length, 0)
})

test('残留在 dispatch_started 的 request → 升级 uncertain 且不写', async () => {
  const { db, bridge, run } = build({ db: { request: { state: REQUEST_STATES.DISPATCH_STARTED } } })
  await assert.rejects(run(), (e) => e.uncertain === true && e.code === 'REQUEST_IN_PROGRESS')
  assert.equal(bridge.writes().length, 0)
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
})

test('同 PO 已有历史 intent（legacy 本地投递）→ 拒绝并 uncertain，不覆写旧 intent', async () => {
  const legacy = {
    id: '44444444-4444-4444-8444-444444444444',
    po_header_id: HDR.id,
    po_id: HDR.po_id,
    content_sha256: 'legacy-business-sha',
    state: REQUEST_STATES.DELIVERED,
    delivery_channel: 'legacy_local_unverified',
  }
  const { db, bridge, run } = build({ db: { intent: legacy } })
  await assert.rejects(run(), (e) => e.code === 'INTENT_ALREADY_EXISTS' && e.uncertain === true)
  assert.equal(bridge.writes().length, 0)
  assert.equal(db.state.intent.content_sha256, 'legacy-business-sha', '不得覆盖旧 intent')
  assert.equal(db.state.intent.delivery_channel, 'legacy_local_unverified')
  assert.equal(db.state.request.state, REQUEST_STATES.DELIVERY_UNCERTAIN)
})

test('未知 request / 非 requested 状态：拒绝且不写', async () => {
  const { bridge, run } = build({ db: { request: { state: 'cancelled' } } })
  await assert.rejects(run(), (e) => e.code === 'NOT_REQUESTED')
  assert.equal(bridge.calls.length, 0)
})

test('目标目录不是 Pending（Done/Outbox/IRS）→ 直接拒绝', async () => {
  for (const dir of [
    'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Done',
    'C:\\Users\\Administrator\\Desktop\\operation\\PO_Queue\\Processing',
    '/tmp/irs',
  ]) {
    const { db, bridge, run } = build({})
    await assert.rejects(run(REQ_ID, { targetDir: dir }), (e) => e.code === 'INVALID_TARGET_DIR')
    assert.equal(db.calls.length, 0)
    assert.equal(bridge.calls.length, 0)
  }
})

test('artifact：永久文件读回 hash 一致；不同字节同名拒绝覆盖', async () => {
  const root = tmpRoot()
  const store = createFileArtifactStore({ root })
  const a = await store.prepare({ requestId: REQ_ID, filename: 'PO-000101.xlsx', bytes: Buffer.from('one') })
  assert.ok(fs.existsSync(a.path))
  assert.equal(a.sha256, (await import('node:crypto')).createHash('sha256').update('one').digest('hex'))
  const again = await store.prepare({ requestId: REQ_ID, filename: 'PO-000101.xlsx', bytes: Buffer.from('one') })
  assert.equal(again.created, false)
  await assert.rejects(
    store.prepare({ requestId: REQ_ID, filename: 'PO-000101.xlsx', bytes: Buffer.from('two') }),
    (e) => e.code === 'ARTIFACT_CONFLICT',
  )
})

test('SQL：只生成 tj_preview 语句；字面值转义；public 被断言拒绝', () => {
  const claim = buildClaimSql({ requestId: REQ_ID, poId: HDR.po_id, contentSha256: 'a'.repeat(64) })
  assert.match(claim, /update tj_preview\.tj_po_preview_push_requests/)
  assert.match(claim, /where r\.request_id = '[^']+'\s+and r\.state = 'requested'/)
  assert.match(claim, /insert into tj_preview\.tj_po_push_intents/)
  assert.match(claim, /on conflict \(po_header_id\) do nothing/)
  assert.match(claim, /RETURNING|returning/)
  assert.equal(/public\./.test(claim), false)

  const load = buildLoadPoSql(HDR.id)
  assert.match(load, /from tj_preview\.tj_po_headers/)
  assert.match(load, /tj_preview\.tj_po_lines/)
  assert.equal(/public\./.test(load), false)

  const ev = buildPreparedEvidenceSql({
    intentId: INTENT_UUID,
    xlsxSha256: 'b'.repeat(64),
    byteCount: 1234,
    targetPath: windowsPathJoin(TARGET_DIR, `${HDR.po_id}.xlsx`),
    evidence: { note: "O'Brien" },
  })
  assert.match(ev, /'server_prepared'/)
  assert.match(ev, /tj_preview\.tj_po_push_delivery_evidence/)
  assert.match(ev, /on conflict \(intent_id, stage\) do nothing/)

  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'")
  assert.equal(sqlLiteral('a\\b'), "'a\\b'")
  assert.throws(() => sqlLiteral('a\u0000b'), (e) => e.code === 'INVALID_SQL_LITERAL')
  assert.throws(() => assertPreviewSql('select * from public.tj_po_headers'), (e) => e.code === 'PUBLIC_SCHEMA_FORBIDDEN')
  assert.equal(PREVIEW_SCHEMA, 'tj_preview')
})
