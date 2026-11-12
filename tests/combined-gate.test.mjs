// 合并单日期门禁：提交/批准双校验、缺日期 fail closed、冻结后不可再改。
// 直接运行 lib/core/combined-gate.js 纯逻辑，不连库。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  requireCombinedWebsitePoDate,
  assertCombinedSubmittable,
  assertCombinedApprovable,
} from '../web/src/lib/core/combined-gate.js'

const BASE = {
  id: 'uuid-9',
  po_id: 'PO-000009',
  po_type: 'combined',
  status: 'draft',
  frozen: false,
  website_po_date: '2026-11-12',
}

test('缺日期：require / submit / approve 全部 fail closed', () => {
  for (const v of [null, undefined, '', '   ']) {
    const h = { ...BASE, website_po_date: v }
    assert.throws(() => requireCombinedWebsitePoDate(h), /缺少 Website PO Date/)
    assert.throws(() => assertCombinedSubmittable(h), /缺少 Website PO Date/)
    assert.throws(
      () => assertCombinedApprovable({ ...h, status: 'pending_approval' }),
      /缺少 Website PO Date/,
    )
  }
})

test('日期格式非法直接拒绝（不猜时区/不猜日期）', () => {
  for (const v of ['2026/11/12', '12-11-2026', '2026-02-30', '2026-11-12T00:00:00Z']) {
    assert.throws(() => requireCombinedWebsitePoDate({ ...BASE, website_po_date: v }))
  }
})

test('合法日期原样返回（不默认当天）', () => {
  assert.equal(requireCombinedWebsitePoDate(BASE), '2026-11-12')
})

test('draft + 日期可提交；pending_approval + 日期可批准', () => {
  assert.equal(assertCombinedSubmittable(BASE), '2026-11-12')
  assert.equal(
    assertCombinedApprovable({ ...BASE, status: 'pending_approval' }),
    '2026-11-12',
  )
})

test('已冻结/已确认不能再次提交或批准', () => {
  assert.throws(() => assertCombinedSubmittable({ ...BASE, frozen: true }), /已批准冻结/)
  assert.throws(() => assertCombinedSubmittable({ ...BASE, status: 'confirmed' }), /只有 draft/)
  assert.throws(
    () => assertCombinedSubmittable({ ...BASE, status: 'pending_approval' }),
    /只有 draft/,
  )
  assert.throws(
    () => assertCombinedApprovable({ ...BASE, status: 'pending_approval', frozen: true }),
    /已批准冻结/,
  )
  assert.throws(() => assertCombinedApprovable({ ...BASE, status: 'draft' }), /不能批准/)
})

test('非合并单不适用该门禁（普通单流程不变）', () => {
  assert.throws(
    () => assertCombinedSubmittable({ ...BASE, po_type: 'standard' }),
    /仅适用于合并单/,
  )
  assert.throws(
    () => assertCombinedApprovable({ ...BASE, po_type: 'standard', status: 'pending_approval' }),
    /仅适用于合并单/,
  )
})
