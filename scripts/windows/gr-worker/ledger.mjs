// JSONL 事件账本 —— 持久化状态机（task_id → 最新状态 + SHA 绑定 + 是否终态）。
// 只追加、不覆盖；加载时取每 task_id 的最后一条（latest wins），所以「收到/waiting_pad/claimed」
// 等非终态记录不会把任务当成「已处理」——终态只由 terminal:true 的那条决定。
//
// 与 worker-core 的契约：
//   get(taskId)   -> { payload_sha256, status, terminal, phase, at, code?, error? } | null
//   record(entry) -> 追加并更新内存态（entry 必须含 task_id / payload_sha256 / status / terminal）
//   _state        -> Map<string, entry>（供测试内省，不用于生产判断）
import { readFileSync, existsSync, appendFileSync } from 'node:fs'

export function createLedger({ file = null, fs = { readFileSync, existsSync, appendFileSync } } = {}) {
  const state = new Map()

  function load() {
    state.clear()
    if (!file || !fs.existsSync(file)) return
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (!e || !e.task_id) continue
      state.set(String(e.task_id), {
        payload_sha256: e.payload_sha256 ?? null,
        status: e.status ?? null,
        terminal: e.terminal === true,
        phase: e.phase ?? null,
        at: e.at ?? null,
        code: e.code ?? null,
        error: e.error ?? null,
      })
    }
  }

  function get(taskId) {
    return state.get(String(taskId)) ?? null
  }

  function record(entry) {
    if (!entry || !entry.task_id) throw new Error('ledger.record 需要 entry.task_id')
    const e = {
      task_id: String(entry.task_id),
      payload_sha256: entry.payload_sha256 ?? null,
      status: entry.status ?? null,
      terminal: entry.terminal === true,
      phase: entry.phase ?? null,
      at: entry.at ?? new Date().toISOString(),
      ...(entry.code !== undefined && entry.code !== null ? { code: entry.code } : {}),
      ...(entry.error !== undefined && entry.error !== null ? { error: entry.error } : {}),
    }
    state.set(e.task_id, {
      payload_sha256: e.payload_sha256,
      status: e.status,
      terminal: e.terminal,
      phase: e.phase,
      at: e.at,
      code: e.code ?? null,
      error: e.error ?? null,
    })
    if (file) fs.appendFileSync(file, JSON.stringify(e) + '\n')
  }

  if (file) load()

  return { load, get, record, _state: state }
}
