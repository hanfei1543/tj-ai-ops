#!/usr/bin/env node
// 本地 harness：在内存 Postgres（PGlite/WASM）中真实执行
//   1) scripts/gr-local-fixture.sql（复刻 tj_preview 既有对象/权限）
//   2) supabase/migrations/20261113_gr_unified_preview.sql
//   3) supabase/tests/20261113_gr_preview_integration.sql（事务内全回滚）
//   4) JS 与 SQL 的 canonical 哈希逐字节对照（事件哈希 + v2 批准快照）
//
// 这只是本地可执行性/一致性验证，**不等于**真实 Supabase tj_preview 验收（由主脑执行）。
//
// 依赖（不在仓库依赖里，按需安装）：
//   npm i --prefix /tmp/gr-pg @electric-sql/pglite
//   GR_PGLITE_ENTRY=/tmp/gr-pg/node_modules/@electric-sql/pglite/dist/index.js \
//     node scripts/gr-local-smoke.mjs
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadPGlite() {
  try {
    return (await import('@electric-sql/pglite')).PGlite
  } catch {
    const entry = process.env.GR_PGLITE_ENTRY
    if (!entry) {
      throw new Error(
        '缺少 @electric-sql/pglite。安装后设置 GR_PGLITE_ENTRY 指向 ' +
          '<dir>/node_modules/@electric-sql/pglite/dist/index.js',
      )
    }
    const require = createRequire(pathToFileURL(entry))
    return require(entry).PGlite
  }
}

function log(step, detail = '') {
  console.log(`[gr-local-smoke] ${step}${detail ? ' :: ' + detail : ''}`)
}

async function main() {
  const PGlite = await loadPGlite()
  const db = new PGlite()

  const fixture = await readFile(path.join(ROOT, 'scripts/gr-local-fixture.sql'), 'utf8')
  const migration = await readFile(
    path.join(ROOT, 'supabase/migrations/20261113_gr_unified_preview.sql'),
    'utf8',
  )

  log('apply fixture')
  await db.exec(fixture)

  log('apply migration')
  await db.exec(migration)

  log('apply migration again (reentrancy)')
  await db.exec(migration)
  const afterReapply = await db.query(`
    select count(*)::int as n from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname='tj_preview' and c.relkind='r' and c.relname like 'tj_gr_%'
  `)
  if (afterReapply.rows[0].n < 10) throw new Error('重复执行迁移后 GR 表数量异常')
  log('PASS', '迁移可重入（重复执行无错误、表数量不变）')

  log('read back objects')
  const counts = await db.query(`
    select
      (select count(*)::int from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname='tj_preview' and c.relkind='r' and c.relname like 'tj_gr_%') as gr_tables,
      (select count(*)::int from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname='tj_preview' and p.proname like 'tj_gr_%') as gr_funcs,
      (select has_schema_privilege('service_role','tj_preview','USAGE')) as service_role_usage,
      (select has_function_privilege('anon','tj_preview.tj_gr_api(text,jsonb)','EXECUTE')) as anon_exec,
      (select has_table_privilege('authenticated','tj_preview.tj_gr_receipt_events','INSERT')) as auth_insert,
      (select has_table_privilege('authenticated','tj_preview.tj_gr_receipt_events','SELECT')) as auth_select,
      (select has_table_privilege('authenticated','tj_preview.tj_po_headers','UPDATE')) as auth_update_legacy
  `)
  console.log(counts.rows[0])

  const expectations = [
    ['gr_tables >= 10', counts.rows[0].gr_tables >= 10],
    ['gr_funcs >= 20', counts.rows[0].gr_funcs >= 20],
    ['service_role 无 tj_preview USAGE', counts.rows[0].service_role_usage === false],
    ['anon 无 tj_gr_api EXECUTE', counts.rows[0].anon_exec === false],
    ['authenticated 不能直插新表', counts.rows[0].auth_insert === false],
    ['authenticated 可读新表', counts.rows[0].auth_select === true],
    ['authenticated 不能直改旧表', counts.rows[0].auth_update_legacy === false],
  ]
  for (const [label, ok] of expectations) {
    if (!ok) throw new Error(`读回断言失败：${label}`)
    log('PASS', label)
  }

  log('integration sql (transactional, rolls back)')
  const integration = await readFile(
    path.join(ROOT, 'supabase/tests/20261113_gr_preview_integration.sql'),
    'utf8',
  )
  await db.exec(integration)
  log('PASS', 'integration sql executed without assertion failure')

  // ---- JS ↔ SQL canonical 对照 -------------------------------------------
  const core = await import(pathToFileURL(path.join(ROOT, 'web/src/lib/core/receipt-core.js')))
  const snap = await import(pathToFileURL(path.join(ROOT, 'web/src/lib/core/approved-snapshot.js')))

  const EV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const L1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const P1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const PL1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  await db.exec(`
    insert into tj_preview.tj_po_headers (id, po_seq, supplier_code, supplier_name, status, po_type, created_by)
    overriding system value
    values ('${P1}', -901, '4000/A01', 'AMFIX', 'confirmed', 'standard', 'harness');
    insert into tj_preview.tj_po_lines (id, po_header_id, line_no, item_code, description, uom, qty, unit_price)
    values ('${PL1}', '${P1}', 1, '00101', 'HINGE', 'UNIT', 5, 2.50);
    insert into tj_preview.tj_gr_receipt_events
      (id, event_no, revision, status, supplier_code, supplier_name, po_ids,
       invoice_no, delivery_order_no, receive_date, checked_by, created_by, approved_by, approved_at, payload_sha256)
    values ('${EV}', 'GR-HARNESS-1', 3, 'approved', '4000/A01', 'AMFIX', array['${P1}']::uuid[],
       'INV-1', 'DO-1', date '2026-11-13', 'Ah Huat', '${P1}', '${P1}', '2026-11-13T01:02:03Z', null);
    insert into tj_preview.tj_gr_receipt_lines
      (id, receipt_event_id, line_no, item_code, description, uom, unit_price, ordered_qty, accepted_qty, note)
    values ('${L1}', '${EV}', 1, '00101', 'HINGE', 'UNIT', 2.50, 5, 4, '短收 1');
    insert into tj_preview.tj_gr_line_sources
      (receipt_event_id, receipt_line_id, po_header_id, po_line_id, ordered_qty, accepted_qty)
    values ('${EV}', '${L1}', '${P1}', '${PL1}', 5, 4);
  `)

  const sqlCanon = await db.query('select tj_preview.tj_gr_event_canonical($1::uuid) as c, tj_preview.tj_gr_event_hash($1::uuid) as h', [EV])
  const event = {
    id: EV,
    revision: 3,
    supplier_code: '4000/A01',
    supplier_name: 'AMFIX',
    po_ids: [P1],
    invoice_no: 'INV-1',
    delivery_order_no: 'DO-1',
    receive_date: '2026-11-13',
    invoice_date: null,
    checked_by: 'Ah Huat',
    approved_by: P1,
    approved_at: '2026-11-13T01:02:03Z',
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
  const jsCanon = core.canonicalEventPayload(event)
  const jsHash = await core.eventPayloadHash(event)

  if (sqlCanon.rows[0].c !== jsCanon) {
    console.error('--- SQL ---\n' + sqlCanon.rows[0].c)
    console.error('--- JS ---\n' + jsCanon)
    throw new Error('事件 canonical 文本 JS 与 SQL 不一致')
  }
  if (sqlCanon.rows[0].h !== jsHash) {
    throw new Error(`事件 hash 不一致：sql=${sqlCanon.rows[0].h} js=${jsHash}`)
  }
  log('PASS', '事件 canonical/hash JS==SQL')

  // ---- 任务 payload canonical 对照（离线复算：只从 payload 自身） -------------
  const tasksCore = await import(pathToFileURL(path.join(ROOT, 'web/src/lib/core/receipt-tasks.js')))
  const TASK1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const taskPayloadRow = await db.query(
    'select tj_preview.tj_gr_task_payload($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text) as p',
    [TASK1, EV, P1, '5', 'e'.repeat(64)],
  )
  const taskPayload = taskPayloadRow.rows[0].p
  const sqlTaskCanon = await db.query('select tj_preview.tj_gr_task_canonical($1::jsonb) as c', [
    JSON.stringify(taskPayload),
  ])
  const jsTaskCanon = tasksCore.canonicalTaskPayloadFromPayload(taskPayload)
  if (sqlTaskCanon.rows[0].c !== jsTaskCanon) {
    console.error('--- SQL task canonical ---\n' + sqlTaskCanon.rows[0].c)
    console.error('--- JS task canonical ---\n' + jsTaskCanon)
    throw new Error('任务 payload canonical JS 与 SQL 不一致')
  }
  const sqlTaskHash = crypto.createHash('sha256').update(sqlTaskCanon.rows[0].c).digest('hex')
  const jsTaskHash = await tasksCore.taskPayloadHash(taskPayload)
  if (sqlTaskHash !== jsTaskHash) throw new Error('任务 payload hash JS 与 SQL 不一致')
  log('PASS', '任务 payload canonical/hash JS==SQL（可离线复算）')

  // v2 批准快照对照（合并单）
  const C1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const P2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const P3 = '99999999-9999-4999-8999-999999999999'
  await db.exec(`
    insert into tj_preview.tj_po_headers
      (id, po_seq, supplier_code, supplier_name, status, po_type, source_po_ids, website_po_date,
       po_revision, created_by, frozen, approved_by)
    overriding system value
    values ('${C1}', -902, '4000/A01', 'AMFIX', 'confirmed', 'combined',
            array['PO-000901','PO-000902'], date '2026-11-09', 2, 'harness', false, 'harness');
    insert into tj_preview.tj_po_lines
      (id, po_header_id, line_no, item_code, description, uom, qty, unit_price, original_qty, accepted_qty,
       note, source_refs)
    values
      ('11111111-2222-4333-8444-555555555555', '${C1}', 1, '00101', 'HINGE', 'UNIT', 5, 2.50, 5, 4, '',
       '[{"po_id":"${P2}","po_number":"PO-000901","line_id":"${P2}","qty":3},{"po_id":"${P3}","po_number":"PO-000902","line_id":"${P3}","qty":2}]'::jsonb),
      ('11111111-2222-4333-8444-666666666666', '${C1}', 2, '00102', 'BOX ITEM', 'BOX', 1, 25.00, 1, 1, 'ok',
       '[]'::jsonb);
    update tj_preview.tj_po_headers set frozen = true where id = '${C1}';
  `)
  const sqlApproval = await db.query('select tj_preview.tj_gr_approval_canonical($1::uuid) as c', [C1])
  const jsApproval = snap.canonicalApprovedSnapshot(
    { po_id: 'PO-000902', po_type: 'combined', website_po_date: '2026-11-09' },
    [
      {
        line_no: 1, item_code: '00101', description: 'HINGE', uom: 'UNIT',
        original_qty: '5', accepted_qty: '4', unit_price: '2.50', note: '',
        source_refs: [
          { po_id: P2, po_number: 'PO-000901', line_id: P2, qty: '3' },
          { po_id: P3, po_number: 'PO-000902', line_id: P3, qty: '2' },
        ],
      },
      {
        line_no: 2, item_code: '00102', description: 'BOX ITEM', uom: 'BOX',
        original_qty: '1', accepted_qty: '1', unit_price: '25.00', note: 'ok',
        source_refs: [],
      },
    ],
  )
  // 只有 po_id 不同（夹具里的 po_id 由 po_seq 生成）→ 用 SQL 读回的 po_id 重算
  const poRow = await db.query('select po_id from tj_preview.tj_po_headers where id = $1::uuid', [C1])
  const lineRows = await db.query(
    `select line_no, item_code, description, uom, unit_price::text as unit_price,
            original_qty::text as original_qty, accepted_qty::text as accepted_qty,
            note, source_refs
       from tj_preview.tj_po_lines where po_header_id = $1::uuid order by line_no, id::text`,
    [C1],
  )
  const jsApproval2 = snap.canonicalApprovedSnapshot(
    { po_id: poRow.rows[0].po_id, po_type: 'combined', website_po_date: '2026-11-09' },
    lineRows.rows,
  )
  if (sqlApproval.rows[0].c !== jsApproval2) {
    console.error('--- SQL approval ---\n' + sqlApproval.rows[0].c)
    console.error('--- JS approval ---\n' + jsApproval2)
    throw new Error('v2 批准快照 canonical JS 与 SQL 不一致')
  }
  log('PASS', 'v2 批准快照 canonical JS==SQL')

  const digest = crypto.createHash('sha256').update(jsCanon).digest('hex')
  if (digest !== jsHash) throw new Error('JS 哈希实现自检失败')
  log('PASS', 'JS sha256 自检')

  await db.close()

  // ---- phase 2: public PREPARED 版真实执行（门禁 + 全量 DDL） --------------
  const db2 = new PGlite()
  const fixturePublic = fixture.replaceAll('tj_preview', 'public')
  const publicMigration = await readFile(
    path.join(ROOT, 'supabase/migrations/gr_unified_public_prepared.sql'),
    'utf8',
  )

  log('phase2: apply public fixture')
  await db2.exec(fixturePublic)

  // 未声明授权 → 门禁必须在第一条 DDL 前中止
  let gateBlocked = false
  try {
    await db2.exec(publicMigration)
  } catch (e) {
    gateBlocked = /PREPARED|AUTHORIZED_MANUAL/.test(String(e.message))
  }
  if (!gateBlocked) throw new Error('public PREPARED 迁移未在缺授权时被门禁拦住')
  log('PASS', 'public 迁移门禁：缺授权时中止')

  const beforeGate = await db2.query(`
    select count(*)::int as n from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'tj_gr_%'
  `)
  if (beforeGate.rows[0].n !== 0) throw new Error('门禁失败后仍创建了 GR 对象')
  log('PASS', 'public 门禁失败后零 DDL 残留')

  log('phase2: apply public migration with explicit authorization')
  await db2.exec(`
    set tj.gr.apply_public = 'AUTHORIZED_MANUAL';
    ${publicMigration}
  `)
  const pub = await db2.query(`
    select
      (select count(*)::int from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relname like 'tj_gr_%') as gr_tables,
      (select has_function_privilege('anon','public.tj_gr_api(text,jsonb)','EXECUTE')) as anon_exec,
      (select has_table_privilege('authenticated','public.tj_gr_receipt_events','INSERT')) as auth_insert,
      (select has_table_privilege('authenticated','public.tj_po_headers','UPDATE')) as legacy_update,
      (select has_schema_privilege('service_role','public','USAGE')) as service_role_usage,
      (select count(*)::int from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and t.tgname = 'trg_tj_po_header_frozen_guard') as freeze_guards
  `)
  const p = pub.rows[0]
  for (const [label, ok] of [
    ['public GR 表已创建', p.gr_tables >= 10],
    ['public anon 无 EXECUTE', p.anon_exec === false],
    ['public authenticated 不能直插 GR 表', p.auth_insert === false],
    ['public 旧表直写未被本轮收紧（另有授权）', p.legacy_update === true],
    ['public service_role USAGE 保持 true（未动 DYT/原有权限）', p.service_role_usage === true],
    ['既有 freeze guard 仍存在', p.freeze_guards === 1],
  ]) {
    if (!ok) throw new Error(`public 读回断言失败：${label}`)
    log('PASS', label)
  }
  await db2.close()

  log('ALL PASS')
}

main().catch((e) => {
  console.error('[gr-local-smoke] FAILED:', e.message)
  if (e.detail) console.error(e.detail)
  process.exit(1)
})
