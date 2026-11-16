// Parent acceptance: real Postgres engine + actual existing bridge wire contract.
// This is not a Windows/IRS test; the faithful bridge fake has no business side effects.
//
// 没有 @electric-sql/pglite 时整组明确 skip（不伪装通过）；设置
// STAGE25_PGLITE_ENTRY 后必须真实运行（加载失败即测试失败，不会静默跳过）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadPGlite } from '../scripts/stage25-local-smoke.mjs'
import { runPreviewDispatch, createFileArtifactStore } from '../scripts/lib/preview-dispatch-core.mjs'

const root = path.resolve(import.meta.dirname, '..')
const staff = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const headerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const intentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

let PGliteCtor = null
let pgliteMissing = null
try {
  PGliteCtor = await loadPGlite()
} catch (err) {
  if (err.code !== 'PGLITE_MISSING') throw err
  pgliteMissing = err
}
const pgTest = PGliteCtor ? test : (name, fn) => test(name, { skip: pgliteMissing.message }, fn)

const migrations = [
  'scripts/stage25-local-fixture.sql',
  'supabase/migrations/20261116_po_done_ack_preview.sql',
  'supabase/migrations/20261116_stage25_preview_closure.sql',
].map((rel) => fs.readFileSync(path.join(root, rel), 'utf8'))

async function fixture({ request = true } = {}) {
  const db = new PGliteCtor()
  for (const sql of migrations) await db.exec(sql)
  await db.exec(`insert into tj_preview.tj_gr_memberships(user_id,role) values ('${staff}','staff');
    insert into tj_preview.tj_po_headers(id,po_id,supplier_code,supplier_name,website_po_date)
    values ('${headerId}','PO-917427','4000/C17','TEST ONLY','2026-11-16');
    insert into tj_preview.tj_po_lines(po_header_id,line_no,item_code,description,uom,qty,unit_price)
    values ('${headerId}',1,'00101','TEST ONLY','UNIT',3,12.6);`)
  let req
  if (request) {
    await db.exec(`set request.jwt.claim.sub='${staff}';`)
    req = (await db.query(`select tj_preview.tj_po_preview_request_push('${headerId}','req.parent.acceptance.0001') as r`)).rows[0].r
    await db.exec("set request.jwt.claim.sub='';")
  }
  return { db, req }
}

async function makeWorker(db) {
  await db.exec(`insert into auth.users(id) values ('${staff}');
    insert into tj_preview.tj_po_ack_workers(user_id,role) values ('${staff}','executor');
    set request.jwt.claim.sub='${staff}';`)
}

async function ack(db, payload) {
  return (await db.query('select tj_preview.tj_po_ack_ingest($1::jsonb) as r', [JSON.stringify(payload)])).rows[0].r
}

async function insertBridgeDelivery(db, { xlsx, delivered = true } = {}) {
  await db.exec(`insert into tj_preview.tj_po_push_intents
      (id,po_header_id,po_id,content_sha256,xlsx_sha256,state,delivery_channel)
    values ('${intentId}','${headerId}','PO-917427','${'c'.repeat(64)}','${xlsx}','dispatch_started','windows_bridge_v1');
    insert into tj_preview.tj_po_push_delivery_evidence(intent_id,stage,xlsx_sha256,byte_count,target_path)
      values ('${intentId}','server_prepared','${xlsx}',100,'OFFLINE TEST ONLY'),
             ('${intentId}','windows_received','${xlsx}',100,'OFFLINE TEST ONLY');`)
  if (delivered) await db.exec(`update tj_preview.tj_po_push_intents set state='delivered' where id='${intentId}'`)
}

pgTest('parent: real SQL dispatcher uses string list payload and records real-engine evidence before delivered', async () => {
  const { db, req } = await fixture()
  const files = new Map()
  let writes = 0
  const bridge = async (payload) => {
    if ('list' in payload) {
      assert.equal(typeof payload.list, 'string', 'deployed bridge.js requires {list:path}, not {list:{dir}}')
      return { ok: true, entries: [] }
    }
    if (payload.write) {
      writes++
      const bytes = Buffer.from(payload.write.b64, 'base64')
      files.set(payload.write.path, bytes)
      return { ok: true, path: payload.write.path, size: bytes.length }
    }
    if (payload.read) {
      const bytes = files.get(payload.read)
      return { ok: true, b64: bytes.toString('base64'), size: bytes.length }
    }
    throw new Error('unknown bridge command')
  }
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/hermes/.hermes/cache/scratch', 'stage25-parent-'))
  try {
    const args = {
      requestId: req.request_id,
      dbQuery: async (sql) => (await db.query(sql)).rows,
      bridge,
      artifacts: createFileArtifactStore({ root: dir }),
      log: { log() {}, error() {} },
    }
    const result = await runPreviewDispatch(args)
    assert.equal(result.state, 'delivered')
    assert.equal(writes, 1)
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_push_delivery_evidence')).rows[0].n, 2)
    assert.equal((await runPreviewDispatch(args)).alreadyDelivered, true)
    assert.equal(writes, 1)
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

pgTest('parent: website can read request statuses through controlled staff RPC, not ungranted table', async () => {
  const { db } = await fixture()
  try {
    await db.exec(`set request.jwt.claim.sub='${staff}'; set role authenticated;`)
    const rows = (await db.query('select tj_preview.tj_po_preview_list_push_requests() as r')).rows[0].r
    assert.equal(rows.length, 1)
    assert.equal(rows[0].po_header_id, headerId)
    await assert.rejects(db.query('select * from tj_preview.tj_po_preview_push_requests'), /permission denied/)
    await db.exec("reset role; set request.jwt.claim.sub='cccccccc-cccc-4ccc-8ccc-cccccccccccc'; set role authenticated;")
    await assert.rejects(db.query('select tj_preview.tj_po_preview_list_push_requests()'), /PO_PUSH_FORBIDDEN/)
  } finally {
    await db.close()
  }
})

pgTest('parent: requested Preview PO business fields cannot change underneath the dispatcher', async () => {
  const { db } = await fixture()
  try {
    await assert.rejects(
      db.query(`update tj_preview.tj_po_headers set website_po_date='2026-11-17' where id='${headerId}'`),
      /PO_PUSH_SNAPSHOT_LOCKED/,
    )
    await assert.rejects(
      db.query(`update tj_preview.tj_po_lines set qty=99 where po_header_id='${headerId}'`),
      /PO_PUSH_SNAPSHOT_LOCKED/,
    )
  } finally {
    await db.close()
  }
})

pgTest('parent: legacy push intent alone also freezes business fields (no website request row)', async () => {
  const { db } = await fixture({ request: false })
  try {
    await db.exec(`insert into tj_preview.tj_po_push_intents
        (po_header_id,po_id,content_sha256,xlsx_sha256,state)
      values ('${headerId}','PO-917427','${'c'.repeat(64)}','${'a'.repeat(64)}','delivered');`)
    await assert.rejects(
      db.query(`update tj_preview.tj_po_headers set website_po_date='2026-11-17' where id='${headerId}'`),
      /PO_PUSH_SNAPSHOT_LOCKED/,
    )
    await assert.rejects(
      db.query(`update tj_preview.tj_po_lines set unit_price=99 where po_header_id='${headerId}'`),
      /PO_PUSH_SNAPSHOT_LOCKED/,
    )
  } finally {
    await db.close()
  }
})

function ackPayload(source = 'a'.repeat(64), po = 'PO-917427', irs = 'PO99000028') {
  return {
    schema: 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1',
    po_id: po,
    business_po_id: po,
    irs_po_number: irs,
    source_sha256: source,
    queue_done_sha256: source,
    event_id:
      'tj.po.queue.done.v1.' +
      createHash('sha256')
        .update(`TJ_QUEUE_DONE_V1|${po}|${source.toUpperCase()}|${irs}`)
        .digest('hex'),
    queue_done_ack: true,
    queue_folder: 'Done',
    ledger_state: 'SAVED_VERIFIED_QUEUE_DONE',
    verification: 'MANUAL_POSTSAVE_VERIFIED',
    queue_done_verified_at: '2026-11-16T06:00:00Z',
  }
}

function manualPayload({
  source = 'a'.repeat(64),
  screenshot = 'b'.repeat(64),
  po = 'PO-917427',
  irs = 'PO99000028',
  total = '37.80',
  lines = [{ item_code: '00101', uom: 'UNIT', qty: '3', unit_price_rm: '12.60', amount_rm: total }],
} = {}) {
  const a = ackPayload(source, po, irs)
  const ledger = {
    po_id: a.po_id,
    irs_po_number: a.irs_po_number,
    queue_commit_event_id: a.event_id,
    state: a.ledger_state,
    verification: a.verification,
    source_sha256: a.source_sha256,
    queue_disposition: 'DONE_VERIFIED',
    queue_done_verified_at: a.queue_done_verified_at,
    postsave_evidence_sha256: screenshot,
    expected_total_rm: total,
    expected_lines: lines,
  }
  return {
    outbox_raw: JSON.stringify(a),
    ledger_raw: JSON.stringify(ledger),
    source_sha256: a.source_sha256,
    screenshot_sha256: screenshot,
    reviewer: 'OFFLINE TEST ONLY',
    reason: 'OFFLINE TEST ONLY',
    expected_total_rm: total,
  }
}

pgTest('parent: timing rejection (no intent yet) writes audit only and the same event is later accepted', async () => {
  const { db } = await fixture()
  try {
    await makeWorker(db)
    const a = ackPayload()

    const first = await ack(db, a)
    assert.equal(first.rejected, true)
    assert.equal(first.state, 'needs_review')
    assert.equal(first.code, 'PO_ACK_NO_PUSH_DELIVERY')
    assert.equal(first.retryable, true, 'timing rejection must be retryable')
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 0,
      'timing rejection must not write a unique receipt tombstone')
    assert.equal(
      (await db.query('select count(*)::int as n from tj_preview.tj_po_ack_audit where event_id=$1 and action=\'defer\'', [a.event_id])).rows[0].n,
      1,
    )

    await db.exec(`insert into tj_preview.tj_po_push_intents
        (id,po_header_id,po_id,content_sha256,xlsx_sha256,state,delivery_channel)
      values ('${intentId}','${headerId}','PO-917427','${'c'.repeat(64)}','${a.source_sha256}','dispatch_started','windows_bridge_v1')`)

    const second = await ack(db, a)
    assert.equal(second.rejected, true)
    assert.equal(second.code, 'PO_ACK_NO_PUSH_DELIVERY')
    assert.equal(second.retryable, true)
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 0)

    await db.exec(`insert into tj_preview.tj_po_push_delivery_evidence(intent_id,stage,xlsx_sha256,byte_count,target_path)
        values ('${intentId}','server_prepared','${a.source_sha256}',100,'OFFLINE TEST ONLY'),
               ('${intentId}','windows_received','${a.source_sha256}',100,'OFFLINE TEST ONLY');
      update tj_preview.tj_po_push_intents set state='delivered' where id='${intentId}'`)

    const third = await ack(db, a)
    assert.equal(third.accepted, true, 'same deterministic event must be acceptable once evidence has arrived')
    assert.equal(third.state, 'accepted')
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 1)
    assert.equal((await db.query('select state from tj_preview.tj_po_ack_receipts')).rows[0].state, 'accepted')
  } finally {
    await db.close()
  }
})

pgTest('parent: legacy intent not delivered is deferred; once delivered it becomes an audited channel rejection', async () => {
  const { db } = await fixture()
  try {
    await makeWorker(db)
    const a = ackPayload()
    await db.exec(`insert into tj_preview.tj_po_push_intents
        (po_header_id,po_id,content_sha256,xlsx_sha256,state,delivery_channel)
      values ('${headerId}','PO-917427','${'c'.repeat(64)}','${a.source_sha256}','dispatch_started','legacy_local_unverified')`)
    const pending = await ack(db, a)
    assert.equal(pending.code, 'PO_ACK_NO_PUSH_DELIVERY')
    assert.equal(pending.retryable, true)
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 0)

    await db.exec(`update tj_preview.tj_po_push_intents set state='delivered' where po_header_id='${headerId}'`)
    const rejected = await ack(db, a)
    assert.equal(rejected.code, 'PO_ACK_NO_WINDOWS_RECEIPT')
    assert.equal(rejected.retryable, undefined)
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 1)
  } finally {
    await db.close()
  }
})

pgTest('parent: SHA conflict still writes a needs_review receipt and never becomes retryable', async () => {
  const { db } = await fixture()
  try {
    await makeWorker(db)
    await insertBridgeDelivery(db, { xlsx: 'b'.repeat(64) })
    const res = await ack(db, ackPayload('a'.repeat(64)))
    assert.equal(res.accepted, false)
    assert.equal(res.rejected, true)
    assert.equal(res.code, 'PO_ACK_DELIVERY_HASH_MISMATCH')
    assert.notEqual(res.retryable, true, 'SHA conflicts are not timing retries')
    const receipts = (await db.query('select state,reject_code from tj_preview.tj_po_ack_receipts')).rows
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].state, 'needs_review')
    assert.equal(receipts[0].reject_code, 'PO_ACK_DELIVERY_HASH_MISMATCH')
  } finally {
    await db.close()
  }
})

pgTest('parent: pre-existing needs_review receipt stays manual work, not auto-revived', async () => {
  const { db } = await fixture()
  try {
    await makeWorker(db)
    const a = ackPayload()
    await db.query(
      `insert into tj_preview.tj_po_ack_receipts
         (event_id,content_sha256,po_header_id,po_id,state,reject_code,irs_po_number,actor)
       values ($1, tj_preview.tj_po_ack_fingerprint($2::jsonb), $3, 'PO-917427', 'needs_review', 'LEGACY_REVIEW', $4, $5)`,
      [a.event_id, JSON.stringify(a), headerId, a.irs_po_number, staff],
    )
    await insertBridgeDelivery(db, { xlsx: a.source_sha256 })
    const res = await ack(db, a)
    assert.equal(res.accepted, false)
    assert.equal(res.replayed, true)
    assert.equal(res.state, 'needs_review')
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 1)
  } finally {
    await db.close()
  }
})

pgTest('parent: manual historical channel accepts legacy intent with different source SHA and keeps both digests', async () => {
  const { db } = await fixture()
  try {
    const legacyXlsx = 'b'.repeat(64)
    await db.exec(`insert into tj_preview.tj_po_push_intents
        (po_header_id,po_id,content_sha256,xlsx_sha256,state,delivery_channel)
      values ('${headerId}','PO-917427','${'c'.repeat(64)}','${legacyXlsx}','delivered','legacy_local_unverified')`)
    await db.exec("set request.jwt.claim.sub=''")
    const out = (await db.query('select tj_preview.tj_po_manual_reconcile($1::jsonb) as r', [JSON.stringify(manualPayload())])).rows[0].r
    assert.ok(out.id, 'manual reconciliation must accept the authorized legacy SHA difference')
    const row = (await db.query(
      'select source_sha256, push_intent_xlsx_sha256, push_intent_state, push_intent_id from tj_preview.tj_po_manual_reconciliations where id=$1',
      [out.id],
    )).rows[0]
    assert.equal(row.source_sha256, 'a'.repeat(64), 'website/historical Windows source digest preserved')
    assert.equal(row.push_intent_xlsx_sha256, legacyXlsx, 'legacy intent digest preserved separately')
    assert.notEqual(row.source_sha256, row.push_intent_xlsx_sha256)
    assert.equal(row.push_intent_state, 'delivered')
    const intent = (await db.query(
      "select id from tj_preview.tj_po_push_intents where po_header_id=$1",
      [headerId],
    )).rows[0]
    assert.equal(row.push_intent_id, intent.id)
  } finally {
    await db.close()
  }
})

pgTest('parent: manual channel fails closed for windows_bridge_v1 intent (must use standard ACK)', async () => {
  const { db } = await fixture()
  try {
    await insertBridgeDelivery(db, { xlsx: 'a'.repeat(64) })
    await db.exec("set request.jwt.claim.sub=''")
    await assert.rejects(
      db.query('select tj_preview.tj_po_manual_reconcile($1::jsonb)', [JSON.stringify(manualPayload())]),
      /MANUAL_RECONCILE_WINDOWS_BRIDGE_FORBIDDEN/,
    )
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_manual_reconciliations')).rows[0].n, 0)
  } finally {
    await db.close()
  }
})

pgTest('parent: manual amount check rejects NULL qty / unit_price per line instead of ignoring via sum()', async () => {
  const { db } = await fixture()
  try {
    await db.exec(`alter table tj_preview.tj_po_lines alter column qty drop not null;
      alter table tj_preview.tj_po_lines alter column unit_price drop not null;
      insert into tj_preview.tj_po_headers(po_id,supplier_code,website_po_date)
        values ('PO-917429','4000/C17','2026-11-16'),('PO-917430','4000/C17','2026-11-16');
      insert into tj_preview.tj_po_lines(po_header_id,line_no,item_code,qty,unit_price)
        select id,1,'00101',null,12.6 from tj_preview.tj_po_headers where po_id='PO-917429';
      insert into tj_preview.tj_po_lines(po_header_id,line_no,item_code,qty,unit_price)
        select id,1,'00101',3,null from tj_preview.tj_po_headers where po_id='PO-917430';`)
    await db.exec("set request.jwt.claim.sub=''")
    await assert.rejects(
      db.query('select tj_preview.tj_po_manual_reconcile($1::jsonb)', [
        JSON.stringify(manualPayload({ po: 'PO-917429', irs: 'PO99000029', total: '0.00' })),
      ]),
      /MANUAL_RECONCILE_LINE_INCOMPLETE/,
    )
    await assert.rejects(
      db.query('select tj_preview.tj_po_manual_reconcile($1::jsonb)', [
        JSON.stringify(manualPayload({ po: 'PO-917430', irs: 'PO99000030', total: '0.00' })),
      ]),
      /MANUAL_RECONCILE_LINE_INCOMPLETE/,
    )
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_manual_reconciliations')).rows[0].n, 0)
  } finally {
    await db.close()
  }
})

pgTest('parent: delivered intent with missing windows_received evidence is retryable, not tombstoned', async () => {
  const { db } = await fixture()
  try {
    await makeWorker(db)
    const a = ackPayload()
    // 模拟证据尚未落库的时序窗口（正常触发器会阻止 delivered 无证据；这里只放开该守卫）。
    await db.exec(`drop trigger if exists trg_tj_po_push_intent_delivery_guard on tj_preview.tj_po_push_intents;
      insert into tj_preview.tj_po_push_intents
        (id,po_header_id,po_id,content_sha256,xlsx_sha256,state,delivery_channel)
      values ('${intentId}','${headerId}','PO-917427','${'c'.repeat(64)}','${a.source_sha256}','delivered','windows_bridge_v1')`)

    const pending = await ack(db, a)
    assert.equal(pending.rejected, true)
    assert.equal(pending.code, 'PO_ACK_NO_WINDOWS_RECEIPT')
    assert.equal(pending.retryable, true)
    assert.equal((await db.query('select count(*)::int as n from tj_preview.tj_po_ack_receipts')).rows[0].n, 0)

    await db.exec(`insert into tj_preview.tj_po_push_delivery_evidence(intent_id,stage,xlsx_sha256,byte_count,target_path)
      values ('${intentId}','windows_received','${a.source_sha256}',100,'OFFLINE TEST ONLY')`)

    const accepted = await ack(db, a)
    assert.equal(accepted.accepted, true, 'same event becomes acceptable after the receipt evidence arrives')
    assert.equal((await db.query('select state from tj_preview.tj_po_ack_receipts')).rows[0].state, 'accepted')
  } finally {
    await db.close()
  }
})

pgTest('parent: manual historical entry rejects queue_done_ack=false', async () => {
  const { db } = await fixture()
  try {
    const p = manualPayload()
    const a = JSON.parse(p.outbox_raw)
    a.queue_done_ack = false
    p.outbox_raw = JSON.stringify(a)
    await assert.rejects(
      db.query('select tj_preview.tj_po_manual_reconcile($1::jsonb)', [JSON.stringify(p)]),
      /MANUAL_RECONCILE_DONE_ACK_REQUIRED/,
    )
  } finally {
    await db.close()
  }
})

pgTest('parent: manual historical entry cannot reuse an IRS owned by another PO', async () => {
  const { db } = await fixture()
  try {
    await db.exec(`insert into tj_preview.tj_po_headers(po_id,supplier_code,irs_po_no,irs_po_no_verified_at,irs_po_no_verified_by)
      values ('PO-917428','4000/C17','PO99000028',now(),'OFFLINE TEST ONLY');`)
    await assert.rejects(
      db.query('select tj_preview.tj_po_manual_reconcile($1::jsonb)', [JSON.stringify(manualPayload())]),
      /MANUAL_RECONCILE_IRS_CONFLICT/,
    )
  } finally {
    await db.close()
  }
})

pgTest('parent: new event with changed source SHA cannot impersonate an accepted replay', async () => {
  const { db } = await fixture()
  try {
    const a = ackPayload()
    await db.exec(`insert into auth.users(id) values ('${staff}');
      insert into tj_preview.tj_po_ack_workers(user_id,role) values ('${staff}','executor');
      insert into tj_preview.tj_po_push_intents(id,po_header_id,po_id,content_sha256,xlsx_sha256,state,delivery_channel)
      values ('${intentId}','${headerId}','PO-917427','${'c'.repeat(64)}','${a.source_sha256}','dispatch_started','windows_bridge_v1');
      insert into tj_preview.tj_po_push_delivery_evidence(intent_id,stage,xlsx_sha256,byte_count,target_path)
      values ('${intentId}','server_prepared','${a.source_sha256}',100,'OFFLINE TEST ONLY'),
      ('${intentId}','windows_received','${a.source_sha256}',100,'OFFLINE TEST ONLY');
      update tj_preview.tj_po_push_intents set state='delivered';
      set request.jwt.claim.sub='${staff}';`)
    const first = await ack(db, a)
    assert.equal(first.accepted, true)
    const changed = await ack(db, ackPayload('d'.repeat(64)))
    assert.equal(changed.accepted, false, 'same IRS alone is not evidence of replay')
    assert.equal(changed.rejected, true)
  } finally {
    await db.close()
  }
})

pgTest('parent: service_role has no direct table access to new Stage25 tables', async () => {
  const { db } = await fixture()
  try {
    await db.exec('set role service_role;')
    for (const table of [
      'tj_preview.tj_po_preview_push_requests',
      'tj_preview.tj_po_push_delivery_evidence',
      'tj_preview.tj_po_manual_reconciliations',
    ]) {
      await assert.rejects(db.query(`select * from ${table}`), /permission denied/)
    }
  } finally {
    await db.close()
  }
})
