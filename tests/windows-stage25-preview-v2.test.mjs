// Windows Stage25 Preview V2 静态/契约回归：
//   * 新目录独立 AuthDir，不覆盖 V1 配置/会话/Queue
//   * schema 固定 tj_preview，GetConfig fail closed；SendOne 带 Content/Accept-Profile
//   * 修复 V1 三处真实缺陷：refresh 后把原始 token 丢进 Reveal、
//     accepted=false+replayed=true 被当成功、accepted=true+replayed=true 被错误拒绝
//   * 所有成功回执都必须核验 state=accepted / accepted=true / PO 身份
//   * 无凭据、无 JWT、无明文密码；SelfTest 是可运行的纯逻辑回归
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const PS1 = 'scripts/windows/Stage25_PO_ACK_Worker_Preview_V2.ps1'
const SHOW = 'scripts/show-preview-connection.py'
const README = 'docs/windows-stage25-preview-handoff.md'

function assertNoSecrets(text, label) {
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(text), false, `${label} 不得包含 JWT`)
  assert.equal(/sbp_[A-Za-z0-9]{10,}/.test(text), false, `${label} 不得包含 Supabase PAT`)
  assert.equal(/password\s*=\s*['"][^'"]+['"]/i.test(text), false, `${label} 不得包含明文密码`)
}

test('V2 脚本：独立 AuthDir + 固定 tj_preview + 不读环境凭据', () => {
  const ps = read(PS1)
  assert.match(ps, /TJ_PO_ACK_STAGE25_PREVIEW_V2/)
  assert.equal(/['"]TJ_PO_ACK_STAGE25['"]/.test(ps), false, '不得复用 V1 配置/会话目录')
  assert.match(ps, /\$Schema\s*=\s*'tj_preview'/)
  assert.match(ps, /ValidateSet\('tj_preview'\)/)
  assert.match(ps, /GetConfig[\s\S]{0,600}\$Schema[\s\S]{0,120}Fail/)
  assert.equal(/\$env:(SUPABASE|TJ_PO|PASSWORD|TOKEN)/i.test(ps), false, '不得自动读 VPS/外部 env')
  assertNoSecrets(ps, PS1)
})

test('V2 脚本：SendOne 带 Content-Profile / Accept-Profile tj_preview', () => {
  const ps = read(PS1)
  const send = ps.slice(ps.indexOf('function SendOne'), ps.indexOf('function StatusOne'))
  assert.match(send, /\$headers\s*=\s*@\{/)
  assert.match(send, /Content-Profile'\s*=\s*\$Schema/)
  assert.match(send, /Accept-Profile'\s*=\s*\$Schema/)
  assert.match(send, /rpc\/tj_po_ack_ingest/)
  // 拒绝把生产 schema 写死
  assert.equal(/Content-Profile'\s*=\s*'public'/.test(send), false)
})

test('V2 脚本：DPAPI refresh 不把原始 token 丢进 Reveal', () => {
  const ps = read(PS1)
  assert.equal(
    /Reveal\s*\(\s*Str\s*\(\s*Val\s+\$new\s+'access_token'\s*\)\s*\)/.test(ps),
    false,
    'V1 缺陷：refresh 返回的原始 token 被当成 DPAPI ciphertext',
  )
  assert.match(ps, /SaveSession \$new[\s\S]{0,400}GetSession[\s\S]{0,400}access_dpapi/)
})

test('V2 脚本：所有成功回执必须 accepted=true 且 state=accepted（replayed 可 true）', () => {
  const ps = read(PS1)
  assert.match(ps, /function Resolve-AckResponse/)
  const fn = ps.slice(ps.indexOf('function Resolve-AckResponse'), ps.indexOf('function SendOne'))
  assert.match(fn, /\$accepted\s*=\s*\(Val \$resp 'accepted'\)\s*-eq\s*\$true/)
  assert.match(fn, /\$state\s*=\s*Str \(Val \$resp 'state'\)/)
  assert.match(fn, /\$state\s*-cne\s*'accepted'/)
  assert.match(fn, /\$replayed\s*=\s*\(Val \$resp 'replayed'\)\s*-eq\s*\$true/)
  // V1 缺陷：accepted=true + replayed=true 被拒绝
  assert.equal(/\$accepted\s+-and\s+\$replayed/.test(fn), false)
  // 身份必须无条件核对（不只在 accepted 分支）
  assert.match(fn, /identity/i)
  assert.equal(/if\s*\(\$accepted\)\s*\{\s*if\s*\(\(Str \(Val \$resp 'po_id'\)/.test(ps), false)
})

test('V2 SelfTest：覆盖 accepted/replay/rejected/身份 的纯逻辑回归（可离线运行）', () => {
  const ps = read(PS1)
  const st = ps.slice(ps.indexOf('function SelfTest'), ps.indexOf('Write-Host (\'=== STAGE25'))
  const cases = st.match(/AssertVerdict/g) ?? []
  assert.ok(cases.length >= 6, `SelfTest 至少覆盖 6 个响应判定用例，实际 ${cases.length}`)
  for (const expected of ['ACCEPTED', 'ACCEPTED_REPLAY', 'REJECTED']) {
    assert.ok(st.includes(expected), `SelfTest 缺少 ${expected} 用例`)
  }
  assert.ok(st.includes('NO_NETWORK=True'))
  assert.match(st, /(TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1|\$AckSchema)/)
})

test('V2 脚本：ValidateOne 阻止已误发历史 PO（含 PO-000025 / PO-000026）', () => {
  const ps = read(PS1)
  const validate = ps.slice(ps.indexOf('function ValidateOne'), ps.indexOf('function GetConfig'))
  for (const id of ['PO-000025', 'PO-000026']) {
    assert.match(validate, new RegExp(`'${id}'`), `ValidateOne 历史 ID 列表必须包含 ${id}`)
  }
  assert.match(validate, /HISTORICAL_OR_ISOLATED_ID_BLOCKED/)
})

test('cmd 包装：SendOne 必须传 POID，不得硬编码旧 PO', () => {
  for (const [file, mode] of [
    ['01_Configure.cmd', 'Configure'],
    ['02_Login_Once.cmd', 'Login'],
    ['03_SelfTest.cmd', 'SelfTest'],
  ]) {
    const p = path.join(ROOT, 'scripts/windows', file)
    assert.ok(fs.existsSync(p), `缺少 ${file}`)
    const txt = fs.readFileSync(p, 'utf8')
    assert.ok(txt.includes(`-Mode ${mode}`) || txt.includes(`-Mode ${mode} `), `${file} 必须显式 Mode`)
  }
  const send = fs.readFileSync(path.join(ROOT, 'scripts/windows/04_SendOne_POID.cmd'), 'utf8')
  assert.match(send, /%~1|%1/)
  assert.match(send, /-Mode SendOne/)
  assert.match(send, /-POID/)
  assert.equal(/PO-000026|PO-000025/.test(send), false, '不得硬编码旧 PO')
})

test('无凭据交接：show-preview-connection.py 只在 TTY + 显式确认后显示', () => {
  const py = read(SHOW)
  assert.match(py, /sys\.stdin\.isatty\(\)/)
  assert.match(py, /sys\.stdout\.isatty\(\)/)
  assert.match(py, /credentials\/windows-preview-config\.env/)
  assert.match(py, /input\(/)
  assert.match(py, /确认|CONFIRM/)
  // 不写文件、不联网、不写日志
  assert.equal(/open\([^)]*,\s*['"]w/.test(py), false, '不得写文件')
  assert.equal(/requests|urllib|http\.client|socket/i.test(py), false, '不得联网')
  assertNoSecrets(py, SHOW)

  // 非 TTY 直接拒绝（stdin 为管道；不会进入显示密码分支）
  const r = spawnSync('python3', [path.join(ROOT, SHOW)], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(r.status, 0, '非 TTY 必须以非 0 退出')
  assert.equal(/SUPABASE_ANON_KEY=|PASSWORD=|eyJ/.test(`${r.stdout}${r.stderr}`), false)
})

test('README：真实交互交接说明（SSH 六项、DPAPI、不自动读 VPS env、无密钥文件）', () => {
  const doc = read(README)
  assert.match(doc, /hermes-xeon/)
  assert.match(doc, /167\.104\.103\.163/)
  assert.match(doc, /show-preview-connection\.py/)
  for (const item of ['SUPABASE_URL', 'ANON', 'SCHEMA', 'EMAIL', 'PASSWORD', 'QUEUE']) {
    assert.ok(doc.toUpperCase().includes(item), `README 缺少 ${item} 说明`)
  }
  assert.match(doc, /DPAPI/)
  assert.match(doc, /不会自动读取|不读取 VPS|手动输入/)
  assert.equal(/\.zip/i.test(doc), false, '不得引导生成含密钥的 ZIP')
  assertNoSecrets(doc, README)
})
