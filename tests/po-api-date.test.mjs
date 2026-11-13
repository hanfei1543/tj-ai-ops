// 普通 PO 的 Website PO Date 真实函数测试（esbuild 打包 tjPoApi.ts + 内存 mock Supabase）。
//
// 覆盖用户明确要求的边界：
//   * createPo / updatePo 必须显式传日期，缺失/非法/DB 缺列 → 写库前 fail closed
//   * updatePo 读旧 header，拒绝 combined / frozen / 过时冲突；冲突时不得删明细
//   * 日期读回不一致 → 拒绝（冲突），不继续写
//   * requestPush 冻结不变，且普通单无日期不得入队
// 全程 mock，不连真实 Supabase / VPS / Bridge / Queue / PAD / IRS。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMockDb,
  lineWrites,
  loadTjPoApi,
  standardLines,
  SUPPLIER,
  writeCalls,
} from './helpers/api-harness.mjs'

// TEST ONLY：仅用于本地单测的固定业务日期，不是业务默认值、不入库任何生产数据。
const TEST_DATE = '2026-11-13'

function seedDb(overrides = {}) {
  return createMockDb({
    tj_po_headers: [
      {
        id: 'h-1',
        po_id: 'PO-000005',
        supplier_code: SUPPLIER.code,
        supplier_name: SUPPLIER.name,
        status: 'confirmed',
        po_type: 'standard',
        frozen: false,
        created_by: 'Ms Toh',
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
        website_po_date: '2026-11-12',
        ...overrides,
      },
    ],
    tj_po_lines: [
      {
        id: 'l-1',
        po_header_id: 'h-1',
        line_no: 1,
        item_code: '0010001000002',
        description: 'HINGE',
        uom: 'UNIT',
        qty: 5,
        unit_price: 1.25,
      },
    ],
  })
}

/** 模拟 public 尚未应用迁移：website_po_date 列不存在 */
function failProbe(db) {
  db.before = (ctx) =>
    ctx.op === 'select' &&
    ctx.table === 'tj_po_headers' &&
    String(ctx.selectCols).includes('website_po_date')
      ? {
          data: null,
          error: { code: '42703', message: 'column tj_po_headers.website_po_date does not exist' },
        }
      : undefined
}

// ---------------------------------------------------------------------------
// createPo
// ---------------------------------------------------------------------------

test('createPo：显式日期写入 header，并从返回行读回核对', async () => {
  const db = seedDb()
  const api = await loadTjPoApi(db)
  const header = await api.createPo(SUPPLIER, standardLines(), 'Ms Toh', TEST_DATE)

  const headerInserts = writeCalls(db).filter((c) => c.table === 'tj_po_headers' && c.op === 'insert')
  assert.equal(headerInserts.length, 1)
  assert.equal(headerInserts[0].payload.website_po_date, TEST_DATE, '必须把显式日期写入 website_po_date')
  assert.equal(headerInserts[0].payload.po_type, 'standard')
  assert.equal(header.website_po_date, TEST_DATE)

  const lineInsert = writeCalls(db).find((c) => c.table === 'tj_po_lines' && c.op === 'insert')
  assert.ok(lineInsert, '日期校验通过后才写明细')
  assert.deepEqual(lineInsert.payload.map((r) => r.qty), [5, 2])
  assert.equal(lineInsert.payload[0].line_no, 1)
})

test('createPo：缺日期直接拒绝，写库前 fail closed（不默认当天）', async () => {
  const db = seedDb()
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.createPo(SUPPLIER, standardLines(), 'Ms Toh'),
    /Website PO Date 必填/,
  )
  assert.deepEqual(writeCalls(db), [], '缺日期不得产生任何写库请求')
})

test('createPo：非法日期（含不存在日期）拒绝且不写库', async () => {
  for (const bad of ['13/11/2026', '2026-11-13T00:00:00Z', '2026-02-30']) {
    const db = seedDb()
    const api = await loadTjPoApi(db)
    await assert.rejects(
      () => api.createPo(SUPPLIER, standardLines(), 'Ms Toh', bad),
      (e) => e.code === 'INVALID_WEBSITE_PO_DATE',
      `bad=${bad}`,
    )
    assert.deepEqual(writeCalls(db), [], `bad=${bad} 不得写库`)
  }
})

test('createPo：public 缺 website_po_date 列 → 不跳过日期、写库前拒绝', async () => {
  const db = seedDb()
  failProbe(db)
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.createPo(SUPPLIER, standardLines(), 'Ms Toh', TEST_DATE),
    /未启用 website_po_date 列（迁移待应用）/,
  )
  assert.deepEqual(writeCalls(db), [], '缺列时不得插入 header 或明细')
})

test('createPo：读回日期与写入不一致 → 判为冲突并停止写明细', async () => {
  const db = seedDb()
  db.after = (ctx) => {
    if (ctx.op === 'insert' && ctx.table === 'tj_po_headers') {
      const row = Array.isArray(ctx.result.data) ? ctx.result.data[0] : ctx.result.data
      row.website_po_date = '2026-12-24'
    }
  }
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.createPo(SUPPLIER, standardLines(), 'Ms Toh', TEST_DATE),
    /写入校验失败|冲突/,
  )
  assert.equal(
    writeCalls(db).filter((c) => c.table === 'tj_po_lines').length,
    0,
    '读回不一致时不得继续写明细',
  )
})

// ---------------------------------------------------------------------------
// updatePo
// ---------------------------------------------------------------------------

test('updatePo：带日期更新 header（条件匹配旧 updated_at）并替换明细', async () => {
  const db = seedDb()
  const api = await loadTjPoApi(db)
  const header = await api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE)

  const update = writeCalls(db).find((c) => c.table === 'tj_po_headers' && c.op === 'update')
  assert.ok(update, '必须更新 header')
  assert.equal(update.payload.website_po_date, TEST_DATE)
  assert.ok(
    update.filters.some((f) => f.col === 'updated_at' && f.val === '2026-11-01T00:00:00.000Z'),
    '更新必须带旧 updated_at 条件，防止覆盖他人修改',
  )
  assert.equal(header.website_po_date, TEST_DATE)

  assert.equal(writeCalls(db).filter((c) => c.table === 'tj_po_lines' && c.op === 'delete').length, 1)
  assert.equal(writeCalls(db).filter((c) => c.table === 'tj_po_lines' && c.op === 'insert').length, 1)
})

test('updatePo：缺日期拒绝，且不 update、不删明细', async () => {
  const db = seedDb()
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.updatePo('h-1', SUPPLIER, standardLines()), /Website PO Date 必填/)
  assert.deepEqual(writeCalls(db), [])
})

test('updatePo：合并单拒绝（不能按普通单改日期）', async () => {
  const db = seedDb({ po_type: 'combined', frozen: true })
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE), /合并单/)
  assert.deepEqual(writeCalls(db), [])
})

test('updatePo：已冻结普通单拒绝修改日期与明细', async () => {
  const db = seedDb({ frozen: true })
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE), /冻结/)
  assert.deepEqual(writeCalls(db), [])
})

test('updatePo：pending_push / exported 普通单拒绝改日期与明细（防导出身份漂移）', async () => {
  for (const status of ['pending_push', 'exported']) {
    const db = seedDb({ status })
    const api = await loadTjPoApi(db)
    await assert.rejects(
      () => api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE),
      /推送\/导出流程/,
      `status=${status}`,
    )
    assert.deepEqual(writeCalls(db), [], `status=${status} 不得写库`)
  }
})

test('updatePo：过时更新（updated_at 已被改）拒绝且不删明细', async () => {
  const db = seedDb()
  // 读完旧 header 后、条件 update 执行前，模拟另一个会话已更新
  db.before = (ctx) => {
    if (ctx.op === 'update' && ctx.table === 'tj_po_headers') {
      db.store.get('tj_po_headers')[0].updated_at = '2026-11-13T08:00:00.000Z'
    }
    return undefined
  }
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE),
    /已被他人修改|冲突/,
  )
  assert.deepEqual(lineWrites(db), [], '冲突时绝不能删除/重写明细')
})

test('updatePo：日期读回不一致 → 判为冲突，且不删明细', async () => {
  const db = seedDb()
  db.after = (ctx) => {
    if (ctx.op === 'update' && ctx.table === 'tj_po_headers') {
      ctx.result.data.website_po_date = null
    }
  }
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE),
    /写入校验失败|冲突/,
  )
  assert.deepEqual(lineWrites(db), [], '读回不一致时不得进入删明细步骤')
})

test('updatePo：public 缺 website_po_date 列 → 读旧 header 前即拒绝', async () => {
  const db = seedDb()
  failProbe(db)
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.updatePo('h-1', SUPPLIER, standardLines(), TEST_DATE),
    /未启用 website_po_date 列（迁移待应用）/,
  )
  assert.deepEqual(writeCalls(db), [])
})

// ---------------------------------------------------------------------------
// requestPush（只验证入队判定，不执行任何真实推送）
// ---------------------------------------------------------------------------

test('requestPush：普通单有日期才允许进入 pending_push', async () => {
  const db = seedDb()
  const api = await loadTjPoApi(db)
  await api.requestPush('h-1')
  const patch = writeCalls(db).find((c) => c.table === 'tj_po_headers' && c.op === 'update')
  assert.ok(patch)
  assert.equal(patch.payload.status, 'pending_push')
  assert.equal(db.store.get('tj_po_headers')[0].status, 'pending_push')
})

test('requestPush：普通单缺日期拒绝入队（PAD 导出必须显式日期）', async () => {
  const db = seedDb({ website_po_date: null })
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.requestPush('h-1'), /Website PO Date/)
  assert.deepEqual(writeCalls(db), [], '缺日期不得改状态')
})

test('requestPush：日期非法拒绝入队', async () => {
  const db = seedDb({ website_po_date: '2026-02-30' })
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.requestPush('h-1'), (e) => e.code === 'INVALID_WEBSITE_PO_DATE')
  assert.deepEqual(writeCalls(db), [])
})

test('requestPush：public 缺 website_po_date 列 → 推送阻止（不退回 7 列、不写状态）', async () => {
  const db = seedDb()
  failProbe(db)
  const api = await loadTjPoApi(db)
  await assert.rejects(
    () => api.requestPush('h-1'),
    /未启用 website_po_date 列（迁移待应用）/,
  )
  assert.deepEqual(writeCalls(db), [])
})

test('requestPush：合并单冻结不变（即使有日期也拒绝）', async () => {
  const db = seedDb({ po_type: 'combined', frozen: true })
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.requestPush('h-1'), /合并单永久冻结推送/)
  assert.deepEqual(writeCalls(db), [])
})

test('requestPush：来源单冻结不变（即使有日期也拒绝）', async () => {
  const db = seedDb()
  db.store.set('tj_po_headers', [
    ...db.store.get('tj_po_headers'),
    {
      id: 'h-c',
      po_id: 'PO-000003',
      po_type: 'combined',
      status: 'confirmed',
      frozen: true,
      source_po_ids: ['PO-000005'],
    },
  ])
  const api = await loadTjPoApi(db)
  await assert.rejects(() => api.requestPush('h-1'), /已并入合并单/)
  assert.deepEqual(writeCalls(db), [])
})
