// 统一收货 UI 门禁测试（先失败后实现）：
//   * 表单校验：空白/负数拒绝而不是当 0；精确 decimal string；来源分配合计必须等于实收
//   * 草稿身份：初次保存前按 selectedPO 持久；同一 PO 不同批次绝不永久共用一个 ID
//   * 防双击重复提交
//   * 状态/角色文案：waiting_mapping / needs_review 中文；不虚构 blocked；任务不等于 IRS 成功
//   * 静态接线：Preview 走 tj_gr_api RPC，生产 GR 入口硬 disabled，员工无 Excel 下载入口
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addDecimalStrings,
  buildReceiptSavePayload,
  capabilities,
  createReceiptDraftSession,
  draftIdentityKey,
  normalizeRoles,
  parseDecimalString,
  receiptStatusBadge,
  taskStatusBadge,
  validateReceiptForm,
} from '../web/src/lib/core/gr-form.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const UUID = '11111111-1111-4111-8111-111111111111'

function line(over = {}) {
  return {
    id: UUID,
    line_no: 1,
    item_code: '0030000000003',
    description: 'D3',
    uom: 'UNIT',
    unit_price: '2.50',
    ordered_qty: '5',
    accepted_qty: '4',
    note: '短缺 1',
    source_allocations: [
      { po_header_id: UUID, po_line_id: UUID, accepted_qty: '4' },
    ],
    ...over,
  }
}

function header(over = {}) {
  return {
    invoice_no: 'INV-1',
    delivery_order_no: 'D-021660',
    receive_date: '2026-11-13',
    invoice_date: null,
    checked_by: 'Ms Toh',
    note: '',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 精确 decimal：不用 JS Number 做金额/数量计算
// ---------------------------------------------------------------------------

test('decimal：空白/负数/非数字一律拒绝，不静默变 0', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const r = parseDecimalString(raw, { field: '实收数量' })
    assert.equal(r.ok, false)
    assert.match(r.error, /不能为空/)
  }
  for (const raw of ['-1', '-0.01', '−2']) {
    const r = parseDecimalString(raw, { field: '实收数量' })
    assert.equal(r.ok, false)
    assert.match(r.error, /不能为负数/)
  }
  for (const raw of ['abc', '1,5', '1e3', '0x10', '.']) {
    assert.equal(parseDecimalString(raw).ok, false)
  }
  assert.deepEqual(parseDecimalString(' 12.30 '), { ok: true, value: '12.30' })
  assert.deepEqual(parseDecimalString('0'), { ok: true, value: '0' })
})

test('decimal：字符串加法保留精度（0.1 + 0.2 = 0.3，而非 0.30000000000000004）', () => {
  assert.equal(addDecimalStrings(['0.1', '0.2']), '0.3')
  assert.equal(addDecimalStrings(['10.10', '0.20']), '10.3')
  assert.equal(addDecimalStrings(['0', '0.005']), '0.005')
  assert.equal(addDecimalStrings(['1.995', '0.01']), '2.005')
  assert.throws(() => addDecimalStrings(['1', 'x']), /不是有效数字/)
})

// ---------------------------------------------------------------------------
// 表单校验
// ---------------------------------------------------------------------------

test('校验：合法表单 ok；收货日期必须显式选择（不默认当天）', () => {
  const ok = validateReceiptForm({ header: header(), lines: [line()] })
  assert.equal(ok.ok, true)
  assert.equal(ok.canSubmit, true)
  assert.equal(ok.errors.length, 0)

  const noDate = validateReceiptForm({ header: header({ receive_date: '' }), lines: [line()] })
  assert.equal(noDate.ok, false)
  assert.match(noDate.errors.map((e) => e.message).join(' '), /收货日期必填/)

  const badDate = validateReceiptForm({ header: header({ receive_date: '2026-02-30' }), lines: [line()] })
  assert.equal(badDate.ok, false)
  assert.match(badDate.errors.map((e) => e.message).join(' '), /收货日期/)
})

test('校验：发票日期 null 或显式 yyyy-MM-dd；非法格式拒绝', () => {
  assert.equal(validateReceiptForm({ header: header({ invoice_date: null }), lines: [line()] }).ok, true)
  assert.equal(
    validateReceiptForm({ header: header({ invoice_date: '2026-11-01' }), lines: [line()] }).ok,
    true,
  )
  const bad = validateReceiptForm({ header: header({ invoice_date: '01/11/2026' }), lines: [line()] })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.map((e) => e.message).join(' '), /发票日期/)
})

test('校验：空数量/负数按错误拒绝，绝不按 0 提交', () => {
  for (const bad of ['', '-2']) {
    const r = validateReceiptForm({ header: header(), lines: [line({ accepted_qty: bad })] })
    assert.equal(r.ok, false)
    assert.match(r.errors.map((e) => e.message).join(' '), /第 1 行/)
  }
})

test('校验：超收/额外行是例外（可提交但必须审批复核），来源分配合计必须等于实收', () => {
  const over = validateReceiptForm({
    header: header(),
    lines: [line({ accepted_qty: '6', source_allocations: [{ po_header_id: UUID, po_line_id: UUID, accepted_qty: '6' }] })],
  })
  assert.equal(over.ok, true)
  assert.equal(over.requires_exception_approval, true)
  assert.deepEqual(over.exceptions.map((e) => e.code), ['OVER_DELIVERY'])

  const extra = validateReceiptForm({
    header: header(),
    lines: [line({ source_allocations: [] })],
  })
  assert.equal(extra.ok, true)
  assert.equal(extra.requires_exception_approval, true)
  assert.ok(extra.exceptions.some((e) => e.code === 'EXTRA_LINE'))

  const mismatch = validateReceiptForm({
    header: header(),
    lines: [line({ accepted_qty: '4', source_allocations: [{ po_header_id: UUID, po_line_id: UUID, accepted_qty: '3' }] })],
  })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.errors.map((e) => e.message).join(' '), /来源分配合计/)
})

test('校验：零行允许保存草稿，但不形成正式 GR（不能提交）', () => {
  const r = validateReceiptForm({ header: header(), lines: [] })
  assert.equal(r.ok, true)
  assert.equal(r.canSaveDraft, true)
  assert.equal(r.canSubmit, false)
  assert.match(r.submit_blocked_reason, /草稿/)
})

test('校验：checked_by 缺失（未登录身份）拒绝', () => {
  const r = validateReceiptForm({ header: header({ checked_by: '' }), lines: [line()] })
  assert.equal(r.ok, false)
  assert.match(r.errors.map((e) => e.message).join(' '), /核对人/)
})

// ---------------------------------------------------------------------------
// 保存 payload（严格对齐 RPC contract，UUID/字符串完整保留）
// ---------------------------------------------------------------------------

test('payload：字段与类型对齐 receipt_save；精确字符串不被 Number 化', () => {
  const payload = buildReceiptSavePayload({
    receiptId: UUID,
    revision: 0,
    selectedPoIds: [UUID],
    header: header(),
    lines: [line({ accepted_qty: '0.10', source_allocations: [{ po_header_id: UUID, po_line_id: UUID, accepted_qty: '0.10' }] })],
  })
  assert.equal(payload.id, UUID)
  assert.equal(payload.revision, 0)
  assert.deepEqual(payload.po_ids, [UUID])
  assert.equal(payload.invoice_no, 'INV-1')
  assert.equal(payload.delivery_order_no, 'D-021660')
  assert.equal(payload.receive_date, '2026-11-13')
  assert.equal(payload.invoice_date, null)
  assert.equal(payload.checked_by, 'Ms Toh')
  assert.equal(payload.lines[0].unit_price, '2.50')
  assert.equal(payload.lines[0].ordered_qty, '5')
  assert.equal(payload.lines[0].accepted_qty, '0.10')
  assert.equal(payload.lines[0].source_allocations[0].accepted_qty, '0.10')
  assert.equal(typeof payload.lines[0].accepted_qty, 'string')
})

test('payload：合并来源 UUID 完整保留，po_ids 由来源分配汇总（不丢来源）', () => {
  const other = '22222222-2222-4222-8222-222222222222'
  const payload = buildReceiptSavePayload({
    receiptId: UUID,
    revision: 3,
    selectedPoIds: [UUID],
    header: header(),
    lines: [
      line({
        accepted_qty: '5',
        source_allocations: [
          { po_header_id: UUID, po_line_id: UUID, accepted_qty: '3' },
          { po_header_id: other, po_line_id: other, accepted_qty: '2' },
        ],
      }),
    ],
  })
  assert.deepEqual(new Set(payload.po_ids), new Set([UUID, other]))
  assert.equal(payload.lines[0].source_allocations.length, 2)
  assert.equal(payload.lines[0].source_allocations[1].po_header_id, other)
})

test('payload：缺行 UUID / 来源 UUID 直接抛错（不猜、不随机补）', () => {
  assert.throws(
    () =>
      buildReceiptSavePayload({
        receiptId: UUID,
        revision: 0,
        selectedPoIds: [UUID],
        header: header(),
        lines: [line({ id: '' })],
      }),
    /行 UUID/,
  )
  assert.throws(
    () =>
      buildReceiptSavePayload({
        receiptId: UUID,
        revision: 0,
        selectedPoIds: [UUID],
        header: header(),
        lines: [line({ source_allocations: [{ po_header_id: '', po_line_id: UUID, accepted_qty: '4' }] })],
      }),
    /来源 PO UUID/,
  )
})

// ---------------------------------------------------------------------------
// 草稿身份 + 防双击
// ---------------------------------------------------------------------------

function fakeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

test('草稿身份：初次保存前按 selectedPO 持久，重开后复用同一 receipt UUID + revision', () => {
  const storage = fakeStorage()
  const poIds = [UUID]
  const a = createReceiptDraftSession({ storage, poIds, newId: () => 'draft-1' })
  assert.equal(a.receiptId, 'draft-1')
  assert.equal(a.revision, 0)

  a.saveResult({ id: 'draft-1', revision: 2, status: 'draft' })
  assert.equal(a.revision, 2)

  const b = createReceiptDraftSession({ storage, poIds, newId: () => 'draft-2' })
  assert.equal(b.receiptId, 'draft-1', '未提交的草稿必须恢复原 UUID/revision')
  assert.equal(b.revision, 2)
  assert.equal(draftIdentityKey(poIds), draftIdentityKey([...poIds].reverse()), 'PO 顺序不影响 key')
})

test('草稿身份：提交/放行后同一 PO 的新批次必须换新 UUID（不能永久绑定一个 ID）', () => {
  const storage = fakeStorage()
  const poIds = [UUID]
  const a = createReceiptDraftSession({ storage, poIds, newId: () => 'draft-A' })
  a.saveResult({ id: 'draft-A', revision: 1, status: 'draft' })
  a.submitResult({ id: 'draft-A', revision: 1, status: 'pending_approval' })
  assert.equal(storage.getItem(draftIdentityKey(poIds)), null, '提交后必须清掉绑定')

  const b = createReceiptDraftSession({ storage, poIds, newId: () => 'draft-B' })
  assert.equal(b.receiptId, 'draft-B')
  // 即使提交返回 needs_review 也必须换新批次
  const c = createReceiptDraftSession({ storage, poIds, newId: () => 'draft-C' })
  c.submitResult({ id: 'draft-C', revision: 0, status: 'needs_review' })
  const d = createReceiptDraftSession({ storage, poIds, newId: () => 'draft-D' })
  assert.equal(d.receiptId, 'draft-D')
})

test('防双击：save/submit 在飞行中一律拒绝第二次，结束后才可继续', () => {
  const storage = fakeStorage()
  const s = createReceiptDraftSession({ storage, poIds: [UUID], newId: () => 'x' })
  assert.equal(s.begin('submit'), true)
  assert.equal(s.begin('submit'), false)
  assert.equal(s.begin('save'), false)
  assert.equal(s.isBusy(), true)
  s.end()
  assert.equal(s.isBusy(), false)
  assert.equal(s.begin('submit'), true)
  s.end()
})

// ---------------------------------------------------------------------------
// 状态 / 角色 / 任务文案
// ---------------------------------------------------------------------------

test('收货状态：waiting_mapping / needs_review 有中文且保留原始码；blocked 不是真实状态', () => {
  const waiting = receiptStatusBadge('waiting_mapping')
  assert.match(waiting.label, /等待映射/)
  assert.equal(waiting.raw, 'waiting_mapping')
  // 服务端没有 blocked 事件状态：不虚构专门文案，未知状态如实显示原始码
  const blocked = receiptStatusBadge('blocked')
  assert.equal(blocked.known, false)
  assert.match(blocked.label, /blocked/)
  const review = receiptStatusBadge('needs_review')
  assert.match(review.label, /需复核/)
  // 未知状态不冒充成功
  assert.match(receiptStatusBadge('weird').label, /weird/)
})

test('任务状态：绝不标成 IRS 成功/已过账', () => {
  for (const st of ['planned', 'queued', 'sent', 'dispatched', 'done', 'completed', 'failed']) {
    const b = taskStatusBadge(st)
    assert.equal(b.irs_confirmed, false)
    assert.doesNotMatch(b.label, /IRS\s*(成功|已过账)/)
  }
  assert.match(taskStatusBadge('planned').label, /未推送 IRS/)
  assert.match(taskStatusBadge('done').label, /不是 IRS 过账/)
})

test('角色能力：只有 approver/admin 能批准，只有 executor/admin 能放行，无身份全关', () => {
  assert.deepEqual(normalizeRoles(['staff', 'staff', 'root']), ['staff'])
  assert.deepEqual(normalizeRoles(null), [])

  const staff = capabilities({ roles: ['staff'] })
  assert.equal(staff.canSubmit, true)
  assert.equal(staff.canApprove, false)
  assert.equal(staff.canRelease, false)

  const approver = capabilities({ roles: ['staff', 'approver'] })
  assert.equal(approver.canApprove, true)
  assert.equal(approver.canRelease, true)

  const executor = capabilities({ roles: ['executor'] })
  assert.equal(executor.canRelease, false, '合同：receipt_release 只允许 approver/admin')
  assert.equal(executor.canApprove, false)
  assert.equal(executor.canSubmit, false, 'executor 不能保存/提交收货事件')
  assert.equal(executor.canTaskResult, true)

  const admin = capabilities({ roles: ['admin'] })
  assert.equal(admin.canApprove, true)
  assert.equal(admin.canRelease, true)

  const anonymous = capabilities(null)
  assert.equal(anonymous.canSubmit, false)
  assert.equal(anonymous.canApprove, false)
  assert.equal(anonymous.canRelease, false)
})

// ---------------------------------------------------------------------------
// 静态接线守卫
// ---------------------------------------------------------------------------

test('Preview：旧 PO 保存走 po_save RPC，合并走 combine_* RPC，禁发保持；生产旧路径保留', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /po_save/)
  assert.match(api, /combine_create/)
  assert.match(api, /combine_submit/)
  assert.match(api, /combine_approve/)
  assert.match(api, /combine_cancel/)
  assert.match(api, /request_id/)
  assert.match(api, /if \(IS_PREVIEW_SCHEMA\)/)
  assert.match(api, /预览环境（tj_preview）禁止推送/)

  // 生产旧路径仍在（createPo/updatePo 直写表）
  assert.match(api, /from\('tj_po_headers'\)[\s\S]{0,120}\.insert\(/)
  // 函数签名兼容 notes
  assert.match(api, /export async function createPo\([^)]*notes/s)
  assert.match(api, /export async function updatePo\([^)]*notes/s)
})

test('UI：收货入口、按钮文案、员工无 Excel 下载入口、合并单按 ID 恢复', () => {
  const page = read('web/src/pages/TjPoSystemPage.tsx')
  assert.match(page, /登记本次收货/)
  assert.match(page, /发送采购 PO 到电脑/)
  assert.equal(page.includes('推送到电脑'), false)
  assert.match(page, /IS_PREVIEW_SCHEMA/)

  const list = read('web/src/pages/TjPoSystemPage.tsx')
  assert.match(list, /combine\?id=/)
  assert.match(list, /po_type === 'combined'/)

  const combine = read('web/src/pages/CombinePoPage.tsx')
  assert.match(combine, /登记本次收货/)
  assert.equal(/downloadGrExcel/.test(combine), false, '员工界面不得有 Excel 下载入口')
  assert.equal(/导出收货单/.test(combine), false)
  assert.match(combine, /tj-po-system\/receipts\/new/)
  assert.match(combine, /params\.get\('id'\)/)

  const excel = read('web/src/lib/tjPoExcel.ts')
  assert.match(excel, /export async function buildGrWorkbook/) // 内部生成函数保留
})

test('Auth：Supabase password login + session roles，无前端凭据；生产收货入口硬 disabled', () => {
  const auth = read('web/src/lib/grAuth.ts')
  assert.match(auth, /signInWithPassword/)
  assert.match(auth, /tj_gr_api/)
  assert.match(auth, /roles/)
  assert.equal(/service_role|SERVICE_ROLE/.test(auth), false)
  assert.equal(/password\s*[:=]\s*['"][^'"]+['"]/i.test(auth), false, '不得硬编码密码')

  const service = read('web/src/lib/tjGrApi.ts')
  const rpc = read('web/src/lib/grRpc.ts')
  assert.equal(/service_role|SERVICE_ROLE/.test(service), false)
  assert.match(rpc, /GR_API_FUNCTION = 'tj_gr_api'/)
  assert.match(rpc, /\.rpc\(/)
  assert.match(rpc, /p_action/)
  assert.match(rpc, /p_data/)
  for (const action of ['receipt_list', 'receipt_get', 'receipt_save', 'receipt_submit', 'receipt_approve', 'receipt_release', 'mapping_set']) {
    assert.ok(service.includes(action), `service 缺少 ${action}`)
  }
  assert.match(rpc, /assertGrRpcEnabled/)
})

test('UI 页面：收货列表/表单/详情路由存在且员工看不到 executor 模拟执行', () => {
  const app = read('web/src/App.tsx')
  assert.match(app, /receipts/)
  assert.match(app, /Receipt/)

  const form = read('web/src/pages/ReceiptFormPage.tsx')
  assert.match(form, /登记本次收货|保存草稿/)
  assert.match(form, /receipt_save|saveReceipt/)
  assert.match(form, /createReceiptDraftSession/)
  assert.match(form, /l\.sources/, 'receipt_get 输出字段是 sources，必须显式映射')
  assert.equal(/模拟执行|mock/i.test(form), false)

  const detail = read('web/src/pages/ReceiptDetailPage.tsx')
  assert.match(detail, /receipt_get|getReceipt/)
  assert.match(detail, /review_required|review_note/)
  assert.match(detail, /l\.sources/)
  assert.equal(/模拟执行|mock/i.test(detail), false)

  const list = read('web/src/pages/ReceiptListPage.tsx')
  assert.match(list, /receipt_list|listReceipts/)
  assert.match(list, /刷新/)
})
