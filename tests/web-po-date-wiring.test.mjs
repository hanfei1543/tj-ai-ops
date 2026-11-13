// 网页接线与导出模式的静态回归线（真实源码文本断言）：
//   * 普通 PO 编辑器有显式业务日期输入，随 createPo/updatePo 传入，冻结禁改，绝不默认当天
//   * 标准导出固定 8 列（PAD 口径），legacy 7 列只能显式请求，网页/推送器不得自动回退
//   * preview 样本入口：standard 正式必须带日期，review 走内部 review 模式
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const PAGE = 'web/src/pages/TjPoSystemPage.tsx'

test('编辑器：Website PO Date 为显式输入（type=date），初值来自 DB/空，不默认当天', () => {
  const page = read(PAGE)

  assert.match(page, /const \[websitePoDate, setWebsitePoDate\] = useState\(''\)/)
  assert.match(page, /type="date"/)
  assert.match(page, /value=\{websitePoDate\}/)
  assert.match(page, /Website PO Date/)

  // 载入已有单据：取 DB 值；null 保持空（旧历史不回填、不推断）
  assert.match(page, /setWebsitePoDate\(po\.website_po_date \?\? ''\)/)

  // 不得拿浏览器当天/创建时间兜底
  assert.equal(/new Date\(\)\.toISOString/.test(page), false, '不得默认当天')
  assert.equal(/toISOString\(\)\.slice\(/.test(page), false, '不得从时间戳截日期')
  assert.equal(/approved_at|created_at[\s\S]{0,80}websitePoDate/.test(page), false, '不得用创建/审批时间推断')
})

test('编辑器：保存时校验并显式传给 createPo / updatePo（尾参数）', () => {
  const page = read(PAGE)
  assert.match(page, /formatWebsitePoDate\(websitePoDate\)/)
  assert.match(page, /Website PO Date 必填/)
  assert.match(page, /createPo\(supplier!, parsed, by \?\? createdBy \?\? '', date, notes, poRequestId\.current\)/)
  assert.match(page, /updatePo\(savedPoId, supplier!, parsed, date, notes, poRequestId\.current, createdBy\)/)
})

test('编辑器：冻结单据日期输入禁用（禁改）', () => {
  const page = read(PAGE)
  const dateInput = page.slice(page.indexOf('id="website-po-date"'))
  const block = dateInput.slice(0, dateInput.indexOf('/>') + 2)
  assert.match(block, /disabled=\{frozen \|\| saving\}/)
})

test('tjPoExcel：标准默认 8 列，legacy 仅显式且网页层禁止（无自动回退开关）', () => {
  const excel = read('web/src/lib/tjPoExcel.ts')
  assert.match(excel, /mode: PoExportMode = EXPORT_MODE_STANDARD/)
  assert.match(excel, /EXPORT_MODE_LEGACY_STANDARD/)
  assert.match(excel, /LEGACY_MODE_NOT_ALLOWED/)
  // 不得出现「缺日期就换 legacy」的分支
  assert.equal(
    /MISSING_WEBSITE_PO_DATE[\s\S]{0,300}EXPORT_MODE_LEGACY_STANDARD/.test(excel),
    false,
    '不允许缺日期自动回退 legacy 7 列',
  )
  // 合并单校验必须保持，且按 DB 的 po_type 强制，不能靠换 mode 绕过（review 内部样本除外）
  assert.match(
    excel,
    /po\.po_type === 'combined' && mode !== EXPORT_MODE_REVIEW[\s\S]{0,120}assertVerifiedApprovedSnapshot/,
  )
})

test('推送器：普通单仍选 STANDARD（8 列），不得引入 legacy 回退', () => {
  const pusher = read('scripts/lib/po-push-core.mjs')
  assert.match(pusher, /combined \? EXPORT_MODE_COMBINED : EXPORT_MODE_STANDARD/)
  assert.equal(/EXPORT_MODE_LEGACY_STANDARD|legacy-standard/.test(pusher), false)
})

test('preview 样本入口：standard formal 走 STANDARD（严格日期），review 走内部 REVIEW（日期可空）', () => {
  const sample = read('scripts/lib/preview-sample.mjs')
  assert.match(
    sample,
    /mode === 'formal'[\s\S]{0,80}\? EXPORT_MODE_STANDARD[\s\S]{0,80}: EXPORT_MODE_REVIEW/,
  )
  assert.equal(/EXPORT_MODE_LEGACY_STANDARD|legacy-standard/.test(sample), false)
})

test('API：createPo / updatePo 尾参数 websitePoDate + 缺列/缺日期前置拒绝；requestPush 加日期门禁', () => {
  const api = read('web/src/lib/tjPoApi.ts')
  assert.match(api, /export async function createPo\([^)]*websitePoDate: string/)
  assert.match(api, /export async function updatePo\([^)]*websitePoDate: string/)
  assert.match(api, /probeWebsitePoDateColumn\(\)/)
  assert.match(api, /未启用 website_po_date 列（迁移待应用）/)
  assert.match(api, /website_po_date: date/)
  assert.match(api, /写入校验失败/)
  assert.match(api, /已被他人修改/)
  // 合并单 / 冻结拒绝
  assert.match(api, /合并单（po_type=combined）不能按普通单编辑/)
  assert.match(api, /不能修改明细或 Website PO Date/)
  assert.match(api, /pending_push' \|\|[\s\S]{0,120}'exported'/)
  // requestPush 日期门禁（冻结文案保持）
  assert.match(api, /合并单永久冻结推送/)
  assert.match(api, /已并入合并单/)
  assert.match(api, /Website PO Date/)
})
