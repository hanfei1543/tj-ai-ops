// 推送资格测试：合并单永久冻结 / 来源单按关系拦截 / 普通单放行 / GR 不启用
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluatePushEligibility,
  isSourceOfCombined,
  assertGrPushDisabled,
  GR_PUSH_ENABLED,
  PUSH_REJECT_CODES,
} from '../web/src/lib/core/push-policy.js'

const combined = {
  po_id: 'PO-000003',
  po_type: 'combined',
  status: 'confirmed',
  frozen: true,
  source_po_ids: ['PO-000001', 'PO-000002'],
}

test('合并单永久冻结：任何 status / frozen 组合都拒绝', () => {
  for (const status of ['draft', 'pending_approval', 'confirmed', 'pending_push', 'exported']) {
    for (const frozen of [true, false]) {
      const v = evaluatePushEligibility({
        header: { po_id: 'PO-000003', po_type: 'combined', status, frozen },
        combinedHeaders: [combined],
      })
      assert.equal(v.allowed, false, `status=${status} frozen=${frozen}`)
      assert.equal(v.code, PUSH_REJECT_CODES.COMBINED_FROZEN)
    }
  }
})

test('来源单即使被改回 confirmed 也按关系拦截（status 不能绕过）', () => {
  const v = evaluatePushEligibility({
    header: { po_id: 'PO-000001', po_type: 'standard', status: 'confirmed', frozen: false },
    combinedHeaders: [combined],
  })
  assert.equal(v.allowed, false)
  assert.equal(v.code, PUSH_REJECT_CODES.SOURCE_OF_COMBINED)
  assert.equal(v.matchingCombined, 'PO-000003')
})

test('来源单改为 pending_push 也照样拦截', () => {
  const v = evaluatePushEligibility({
    header: { po_id: 'PO-000002', status: 'pending_push' },
    combinedHeaders: [combined],
  })
  assert.equal(v.allowed, false)
  assert.equal(v.code, PUSH_REJECT_CODES.SOURCE_OF_COMBINED)
})

test('普通 standard 单未被合并引用时放行（原 queue/bridge 路径）', () => {
  const v = evaluatePushEligibility({
    header: { po_id: 'PO-000005', po_type: 'standard', status: 'confirmed' },
    combinedHeaders: [combined],
  })
  assert.deepEqual(v, { allowed: true })
})

test('没有 combined 列表时普通单放行；缺标识拒绝', () => {
  assert.equal(evaluatePushEligibility({ header: { po_id: 'PO-000005' } }).allowed, true)
  assert.equal(evaluatePushEligibility({ header: {} }).allowed, false)
})

test('isSourceOfCombined 只看关系、忽略非 combined 行与空值', () => {
  assert.equal(isSourceOfCombined('PO-000001', [combined]), true)
  assert.equal(isSourceOfCombined('PO-000009', [combined]), false)
  assert.equal(isSourceOfCombined(null, [combined]), false)
  assert.equal(isSourceOfCombined('PO-000001', []), false)
  assert.equal(
    isSourceOfCombined('PO-000001', [{ po_id: 'PO-X', po_type: 'standard', source_po_ids: ['PO-000001'] }]),
    false,
  )
})

test('GR 正式 push/post 永久不启用', () => {
  assert.equal(GR_PUSH_ENABLED, false)
  assert.throws(() => assertGrPushDisabled(), /GR 正式 push\/post 未启用/)
})
