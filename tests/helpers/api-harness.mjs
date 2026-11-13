// tjPoApi.ts 真实函数测试夹具（仅本地测试，不连任何真实 Supabase / Bridge / Queue）。
//
// 用 esbuild 把 web/src/lib/tjPoApi.ts 打成 ESM，把 @supabase/supabase-js 换成本文件的
// 内存 mock client，然后动态 import。这样测试执行的是 createPo / updatePo / requestPush
// 的真实函数体（校验、写入顺序、读回），而不是复制一份逻辑。
//
// 每次 loadTjPoApi() 都用新的 import URL（?v=N），保证模块级缓存（如
// websitePoDateColumnSupported）不会跨用例串味。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const webRequire = createRequire(path.join(REPO_ROOT, 'web/package.json'))
const esbuild = webRequire('esbuild')

const OUT_DIR = path.join(os.homedir(), '.hermes', 'cache', 'scratch', 'tj-po-api-test-bundle')

const MOCK_MODULE = `
// 由 tests/helpers/api-harness.mjs 注入；真实 supabase-js 不参与测试。
export function createClient(...args) {
  const mock = globalThis.__TJ_SUPABASE_MOCK__
  if (!mock) throw new Error('缺少 __TJ_SUPABASE_MOCK__，测试必须先 createMockDb()')
  mock.createClientCalls.push(args)
  return mock.client
}
`

function clone(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

const PGRST116 = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
}

class MockQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.op = 'select'
    this.payload = null
    this.filters = []
    this.selectCols = '*'
    this.returning = false
    this.orderBy = null
    this.limitN = null
    this.singleFlag = false
    this.recorded = false
  }

  select(cols = '*') {
    if (this.op === 'select') this.selectCols = cols
    else this.returning = true
    return this
  }

  insert(payload) {
    this.op = 'insert'
    this.payload = payload
    return this
  }

  update(payload) {
    this.op = 'update'
    this.payload = payload
    return this
  }

  delete() {
    this.op = 'delete'
    return this
  }

  eq(col, val) {
    this.filters.push({ type: 'eq', col, val })
    return this
  }

  in(col, val) {
    this.filters.push({ type: 'in', col, val })
    return this
  }

  contains(col, val) {
    this.filters.push({ type: 'contains', col, val })
    return this
  }

  order(col, opts = {}) {
    this.orderBy = { col, ascending: opts.ascending !== false }
    return this
  }

  limit(n) {
    this.limitN = n
    return this
  }

  single() {
    this.singleFlag = true
    return this
  }

  then(onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected)
  }

  rows() {
    if (!this.db.store.has(this.table)) this.db.store.set(this.table, [])
    return this.db.store.get(this.table)
  }

  matches(row) {
    return this.filters.every((f) => {
      const v = row[f.col]
      if (f.type === 'eq') return v === f.val
      if (f.type === 'in') return Array.isArray(f.val) && f.val.includes(v)
      if (f.type === 'contains') {
        return Array.isArray(v) && Array.isArray(f.val) && f.val.every((x) => v.includes(x))
      }
      throw new Error(`mock 不支持过滤 ${f.type}`)
    })
  }

  engine() {
    const rows = this.rows()
    if (this.op === 'select') {
      let out = rows.filter((r) => this.matches(r))
      if (this.orderBy) {
        const { col, ascending } = this.orderBy
        out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0))
        if (!ascending) out.reverse()
      }
      if (this.limitN != null) out = out.slice(0, this.limitN)
      if (this.singleFlag) {
        if (out.length !== 1) return { data: null, error: PGRST116 }
        return { data: clone(out[0]), error: null }
      }
      return { data: out.map(clone), error: null }
    }

    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload]
      const inserted = list.map((raw) => {
        const row = { ...raw }
        if (!row.id) row.id = `mock-${this.db.nextSeq()}`
        if (this.table === 'tj_po_headers' && !row.po_id) {
          row.po_id = `PO-MOCK-${this.db.nextSeq()}`
        }
        rows.push(row)
        return row
      })
      const data = this.returning ? inserted.map(clone) : null
      if (this.singleFlag) {
        if (!data || data.length !== 1) return { data: null, error: PGRST116 }
        return { data: data[0], error: null }
      }
      return { data, error: null }
    }

    if (this.op === 'update') {
      const hit = rows.filter((r) => this.matches(r))
      for (const row of hit) Object.assign(row, this.payload)
      const data = this.returning ? hit.map(clone) : null
      if (this.singleFlag) {
        if (!data || data.length !== 1) return { data: null, error: PGRST116 }
        return { data: data[0], error: null }
      }
      return { data, error: null }
    }

    if (this.op === 'delete') {
      const keep = rows.filter((r) => !this.matches(r))
      this.db.store.set(this.table, keep)
      return { data: null, error: null }
    }

    throw new Error(`mock 不支持操作 ${this.op}`)
  }

  async run() {
    const ctx = {
      table: this.table,
      op: this.op,
      payload: clone(this.payload),
      filters: this.filters.map((f) => ({ ...f })),
      selectCols: this.selectCols,
      store: this.db.store,
    }
    if (!this.recorded) {
      this.db.calls.push(ctx)
      this.recorded = true
    }
    // 测试钩子：可在执行前篡改库（模拟并发更新），或直接返回错误（模拟缺列）
    if (this.db.before) {
      const forced = this.db.before(ctx)
      if (forced && typeof forced === 'object' && 'error' in forced) return forced
    }
    const result = this.engine()
    if (this.db.after) this.db.after({ ...ctx, result })
    return result
  }
}

/**
 * 内存 mock Supabase 数据库。
 * @param {Record<string, object[]>} seed 表名 -> 初始行
 */
export function createMockDb(seed = {}) {
  const store = new Map()
  for (const [table, rows] of Object.entries(seed)) store.set(table, rows.map(clone))
  let seq = 0
  const db = {
    store,
    calls: [],
    before: null,
    after: null,
    createClientCalls: [],
    nextSeq() {
      seq += 1
      return seq
    },
  }
  db.client = {
    from(table) {
      return new MockQuery(db, table)
    },
  }
  return db
}

/** 写操作调用（用于断言「缺列/缺日期时未写库」） */
export function writeCalls(db) {
  return db.calls.filter((c) => c.op !== 'select')
}

/** 明细表写操作（用于断言更新冲突时没有删/插明细） */
export function lineWrites(db) {
  return writeCalls(db).filter((c) => c.table === 'tj_po_lines')
}

let bundlePromise = null

async function buildBundle() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (!bundlePromise) {
    const mockPath = path.join(OUT_DIR, 'supabase-js-mock.mjs')
    fs.writeFileSync(mockPath, MOCK_MODULE)
    bundlePromise = esbuild
      .build({
        entryPoints: [path.join(REPO_ROOT, 'web/src/lib/tjPoApi.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
        define: {
          'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://sb.test'),
          'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
          'import.meta.env.VITE_SUPABASE_SCHEMA': JSON.stringify('public'),
        },
        plugins: [
          {
            name: 'mock-supabase-js',
            setup(build) {
              build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: mockPath }))
            },
          },
        ],
      })
      .then((r) => r.outputFiles[0].text)
  }
  return bundlePromise
}

let loadSeq = 0

/** 打包并加载一份全新的 tjPoApi 模块（模块级缓存清空） */
export async function loadTjPoApi(db) {
  const code = await buildBundle()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `tjPoApi.bundle.mjs`)
  fs.writeFileSync(file, code)
  globalThis.__TJ_SUPABASE_MOCK__ = { client: db.client, createClientCalls: db.createClientCalls }
  loadSeq += 1
  return import(`${pathToFileURL(file).href}?v=${loadSeq}`)
}

export const SUPPLIER = { id: 's-1', code: '4000/A01', name: 'AMFIX TRADING SDN BHD' }

export function standardLines() {
  return [
    { line_no: 1, item_code: '0010001000002', description: 'HINGE', uom: 'UNIT', qty: 5, unit_price: 1.25 },
    { line_no: 2, item_code: '0020002000002', description: 'PLATE', uom: 'PCS', qty: 2, unit_price: 0.9 },
  ]
}
