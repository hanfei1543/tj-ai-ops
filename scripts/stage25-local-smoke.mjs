#!/usr/bin/env node
// Stage25 本地 harness：在内存 Postgres（PGlite/WASM）里按真实部署顺序跑
//   1) scripts/stage25-local-fixture.sql              （复刻 tj_preview 既有对象/权限/守卫）
//   2) supabase/migrations/20261116_po_done_ack_preview.sql  （已部署的 ACK v1 主体）
//   3) supabase/migrations/20261116_stage25_preview_closure.sql（本包）
//   4) 再跑一次 (3) 证明可重入
//   5) supabase/tests/20261116_stage25_closure_integration.sql（事务内全回滚的真实断言）
//
// 这只是本地可执行性/契约验证，**不等于**真实 Supabase tj_preview 验收（由主脑执行）。
//
// 依赖（不在仓库依赖里，按需安装到独立目录）：
//   npm i --prefix /tmp/stage25-pg @electric-sql/pglite
//   STAGE25_PGLITE_ENTRY=/tmp/stage25-pg/node_modules/@electric-sql/pglite/dist/index.js \
//     node scripts/stage25-local-smoke.mjs
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const SQL_FILES = {
  fixture: 'scripts/stage25-local-fixture.sql',
  ackV1: 'supabase/migrations/20261116_po_done_ack_preview.sql',
  closure: 'supabase/migrations/20261116_stage25_preview_closure.sql',
  integration: 'supabase/tests/20261116_stage25_closure_integration.sql',
}

export async function loadPGlite() {
  try {
    return (await import('@electric-sql/pglite')).PGlite
  } catch {
    const entry = process.env.STAGE25_PGLITE_ENTRY || process.env.GR_PGLITE_ENTRY
    if (!entry) {
      const err = new Error(
        '缺少 @electric-sql/pglite（离线真实 SQL 测试需要）。安装到独立目录后设置 ' +
          'STAGE25_PGLITE_ENTRY=<dir>/node_modules/@electric-sql/pglite/dist/index.js',
      )
      err.code = 'PGLITE_MISSING'
      throw err
    }
    const require = createRequire(pathToFileURL(entry))
    return require(entry).PGlite
  }
}

async function read(rel) {
  return readFile(path.join(ROOT, rel), 'utf8')
}

/**
 * 执行 fixture + 两条迁移 + 集成断言。
 * @returns {{skipped?:boolean, reason?:string, assertions?:number, passed?:number, sections?:object, durationMs?:number}}
 */
export async function runStage25Harness({ log = () => {} } = {}) {
  let PGlite
  try {
    PGlite = await loadPGlite()
  } catch (err) {
    if (err.code === 'PGLITE_MISSING') return { skipped: true, reason: err.message }
    throw err
  }

  const t0 = Date.now()
  const db = new PGlite()
  const [fixture, ackV1, closure, integration] = await Promise.all([
    read(SQL_FILES.fixture),
    read(SQL_FILES.ackV1),
    read(SQL_FILES.closure),
    read(SQL_FILES.integration),
  ])

  log('apply fixture')
  await db.exec(fixture)

  log('apply ACK v1 (20261116_po_done_ack_preview.sql)')
  await db.exec(ackV1)

  log('apply closure (20261116_stage25_preview_closure.sql)')
  await db.exec(closure)

  log('re-apply closure (reentrancy)')
  await db.exec(closure)

  log('run integration assertions')
  const results = await db.exec(integration)
  // 汇总行是最后一个 SELECT（后面还有 rollback，所以倒序找 rows 里含 assertions 的那条）
  let summary = {}
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const rows = results[i]?.rows ?? []
    if (rows[0] && Object.prototype.hasOwnProperty.call(rows[0], 'assertions')) {
      summary = rows[0]
      break
    }
  }
  await db.close()

  return {
    skipped: false,
    assertions: Number(summary.assertions ?? 0),
    passed: Number(summary.passed ?? 0),
    failed: Number(summary.failed ?? 0),
    sections: summary.sections ?? {},
    durationMs: Date.now() - t0,
  }
}

/**
 * 跨语言核对：SQL 侧 tj_po_ack_event_id 与 JS/PS1 客户端逐字节一致。
 * 客户端算法（Stage25_PO_ACK_Worker_V1.ps1）：
 *   'tj.po.queue.done.v1.' + lowercase hex sha256(UTF8('TJ_QUEUE_DONE_V1|'+po_id+'|'+hash+'|'+irs))
 *   hash 由客户端以大写提供。
 */
export async function checkEventIdFormula() {
  const { createHash } = await import('node:crypto')
  const PGlite = await loadPGlite()
  const db = new PGlite()
  await db.exec(await readFile(path.join(ROOT, SQL_FILES.fixture), 'utf8'))
  await db.exec(await readFile(path.join(ROOT, SQL_FILES.ackV1), 'utf8'))
  await db.exec(await readFile(path.join(ROOT, SQL_FILES.closure), 'utf8'))

  const poId = 'PO-917426'
  const irs = 'PO99007426'
  const source = 'EAD80AC183077E1DB9F44E3F8C7B0E79B7883662650366C3FE68EFA5951AF1C6'.toLowerCase()
  const res = await db.query('select tj_preview.tj_po_ack_event_id($1, $2, $3) as event_id', [poId, source, irs])
  await db.close()

  const canonical = `TJ_QUEUE_DONE_V1|${poId}|${source.toUpperCase()}|${irs}`
  const jsEventId = `tj.po.queue.done.v1.${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  return { canonical, sqlEventId: res.rows[0].event_id, jsEventId, match: res.rows[0].event_id === jsEventId }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runStage25Harness({ log: (m) => console.log(`[stage25-smoke] ${m}`) })
    .then((out) => {
      if (out.skipped) {
        console.error(`[stage25-smoke] SKIPPED: ${out.reason}`)
        process.exit(0)
      }
      console.log(`[stage25-smoke] assertions=${out.assertions} passed=${out.passed} failed=${out.failed}`)
      for (const [name, count] of Object.entries(out.sections ?? {})) {
        console.log(`[stage25-smoke]   ${name}: ${count}`)
      }
      console.log(`[stage25-smoke] OK in ${out.durationMs}ms`)
    })
    .catch((err) => {
      console.error('[stage25-smoke] FAILED')
      console.error(err.message)
      process.exit(1)
    })
}
