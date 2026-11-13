// 员工界面中文标签单一真相源测试：只映射真实后端状态，不虚构假状态、不合并 IRS 阶段。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  poStatusInfo,
  eventStatusInfo,
  taskStatusInfo,
  warningLabel,
  exceptionLabel,
  roleLabel,
} from '../web/src/lib/core/ui-labels.js'

test('PO 状态：未知状态如实显示，不冒充「未导出」这类假状态', () => {
  assert.equal(poStatusInfo('confirmed', 'standard').label, '已确认')
  assert.equal(poStatusInfo('exported', 'standard').label, '已发送')
  assert.equal(poStatusInfo('pending_push', 'standard').label, '正在发送')
  // 未知状态必须如实显示原始码
  const unknown = poStatusInfo('some_new_status', 'standard')
  assert.match(unknown.label, /some_new_status/)
  // 合并单不能显示成普通单状态
  assert.equal(poStatusInfo('confirmed', 'combined').label, '合并单 · 已批准')
})

test('事件状态：四个 IRS 阶段文案各不相同，不合并成成功', () => {
  const stages = ['approved', 'released', 'saved_unverified', 'verified']
  const labels = stages.map((s) => eventStatusInfo(s).label)
  assert.equal(new Set(labels).size, 4)
  assert.match(eventStatusInfo('approved').label, /已审批/)
  assert.match(eventStatusInfo('released').label, /等待系统处理/)
  assert.match(eventStatusInfo('saved_unverified').label, /等待核对/)
  assert.match(eventStatusInfo('verified').label, /IRS 已核对完成/)
})

test('任务状态：irs_confirmed 永远 false，label 不含「IRS 成功/已过账」肯定表述', () => {
  for (const st of ['ready', 'claimed', 'done', 'saved_unverified', 'verified', 'needs_review']) {
    const b = taskStatusInfo(st)
    assert.equal(b.irs_confirmed, false)
    assert.doesNotMatch(b.label, /IRS\s*(成功|已过账)/)
  }
})

test('警告/例外 code → 员工能懂的中文；未知 code 原样返回（不猜）', () => {
  assert.equal(warningLabel('short_receipt'), '本次少收货（实收少于订购）')
  assert.equal(warningLabel('duplicate_document'), '单据号码可能重复（同供应商同单据已有其他记录）')
  assert.equal(exceptionLabel('over_receipt'), '实收超过订购数量')
  assert.equal(exceptionLabel('extra_line'), '额外货品（没有对应的采购单明细）')
  assert.equal(warningLabel('some_new_code'), 'some_new_code')
})

test('角色 label 中文；未知角色原样返回', () => {
  assert.equal(roleLabel('staff'), '员工')
  assert.equal(roleLabel('approver'), '审批人员')
  assert.equal(roleLabel('executor'), '执行人员')
  assert.equal(roleLabel('admin'), '管理员')
  assert.equal(roleLabel('root'), 'root')
})
