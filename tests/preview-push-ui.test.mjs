// Preview 投递网页接线回归：
//   * 预览按钮文案明确是「请求预览投递」，绝不冒充生产推送/已导出/已保存
//   * 预览 requestPush 走 RPC tj_po_preview_request_push（不再设 pending_push）
//   * 生产 public requestPush 原路径保持不变（仍置 pending_push）
//   * 预览状态读回只显示 request/state，未知状态原样显示
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PREVIEW_REQUEST_STATES,
  parsePreviewPushResponse,
  previewPushStateInfo,
} from '../web/src/lib/core/preview-push.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('状态文案：四个预览阶段各不相同，且不含「已导出/已保存/已发送到电脑」', () => {
  const labels = Object.values(PREVIEW_REQUEST_STATES).map((s) => previewPushStateInfo(s).label)
  assert.equal(new Set(labels).size, 4)
  for (const st of Object.values(PREVIEW_REQUEST_STATES)) {
    const info = previewPushStateInfo(st)
    assert.equal(info.raw, st)
    assert.doesNotMatch(info.label, /已导出|已保存|已发送到电脑|IRS/)
  }
  assert.match(previewPushStateInfo('delivered').label, /Windows/)
  assert.match(previewPushStateInfo('delivery_uncertain').label, /人工核对/)
  assert.match(previewPushStateInfo('delivery_uncertain').hint, /不会自动重试/)
  // 未知状态如实显示，不伪装成功
  assert.match(previewPushStateInfo('weird_state').label, /weird_state/)
})

test('RPC 响应校验：缺 id/po_id/state 或 po 不匹配一律拒绝', () => {
  const ok = parsePreviewPushResponse(
    { id: '11111111-1111-4111-8111-111111111111', po_id: 'PO-000101', state: 'requested' },
    { expectedPoId: 'PO-000101' },
  )
  assert.equal(ok.state, 'requested')
  assert.equal(ok.poId, 'PO-000101')

  assert.throws(() => parsePreviewPushResponse(null), (e) => e.code === 'PREVIEW_RPC_EMPTY')
  assert.throws(() => parsePreviewPushResponse({ po_id: 'PO-000101', state: 'requested' }), (e) =>
    e.code === 'PREVIEW_RPC_INVALID',
  )
  assert.throws(
    () => parsePreviewPushResponse({ id: 'x', po_id: 'PO-999999', state: 'requested' }, { expectedPoId: 'PO-000101' }),
    (e) => e.code === 'PREVIEW_RPC_PO_MISMATCH',
  )
  // 未知状态不能静默当作成功
  assert.throws(
    () => parsePreviewPushResponse({ id: 'x', po_id: 'PO-000101', state: 'exported' }),
    (e) => e.code === 'PREVIEW_RPC_UNKNOWN_STATE',
  )
})

test('tjPoApi：预览 requestPush 走 RPC，不再写 pending_push；生产分支保持原样', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /export async function requestPreviewPush\(id: string\)/)
  assert.match(api, /rpc\('tj_po_preview_request_push'/)
  assert.match(api, /p_po_header_id: id/)
  assert.match(api, /p_request_id: requestId/)
  assert.match(api, /parsePreviewPushResponse/)

  // 预览 requestPush 直接拒绝生产推送（不再设 pending_push）
  assert.match(
    api,
    /export async function requestPush\(id: string\)[\s\S]{0,400}预览环境（tj_preview）禁止推送[\s\S]{0,40}生产/,
  )
  // 生产路径保持 pending_push（与旧测试一致）
  assert.match(api, /status: 'pending_push'/)
  // 预览读回
  assert.match(api, /export async function listPreviewPushRequests\(\)/)
  assert.match(api, /rpc\('tj_po_preview_list_push_requests'\)/)
})

test('页面：预览按钮文案为「请求预览投递」；生产按钮文案不变', () => {
  const page = read('web/src/pages/TjPoSystemPage.tsx')
  assert.match(page, /请求预览投递/)
  assert.match(page, /发送采购 PO 到电脑/)
  assert.match(page, /requestPreviewPush/)
  // 预览按钮只在 IS_PREVIEW_SCHEMA 下显示；生产按钮仍由 !IS_PREVIEW_SCHEMA 控制
  const previewBtnIdx = page.lastIndexOf('请求预览投递')
  const previewBtn = page.slice(Math.max(0, previewBtnIdx - 1200), previewBtnIdx + 200)
  assert.match(previewBtn, /IS_PREVIEW_SCHEMA/)
  assert.match(previewBtn, /\{\.\.\.exportingId|exportingId === p\.id|disabled=\{exportingId/)
  // 预览状态读回渲染
  assert.match(page, /previewPushStateInfo/)
  assert.match(page, /previewPushByPoId|previewPushById|previewRequests/)
})
