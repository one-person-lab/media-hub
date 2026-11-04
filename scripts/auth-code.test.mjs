import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 这份测的是要落盘的验证码表，所以先把存放指到临时目录再 import 被测模块——
   auth-core 的目录在 import 时就定了，写在下面的赋值来不及。 */
process.env.MEDIA_HUB_STORE_DIR = mkdtempSync(join(tmpdir(), 'mh-auth-test-'))

const {
  CODE_TTL_SEC, RESEND_SEC, MAX_CODE_ATTEMPTS, hashCode, issueCode, redeemCode, resendWaitSec,
  findOrCreateByEmail, findOrCreateByGithub, readUsers,
} = await import('./auth-core.mjs')

const CODES_FILE = join(process.env.MEDIA_HUB_STORE_DIR, 'verify-codes.json')
const T0 = 1_800_000_000_000

test('发码：6 位数字，同一邮箱 60 秒内不重发', () => {
  const first = issueCode('alice@x.com', T0)
  assert.match(first.code, /^\d{6}$/)
  assert.equal(first.resendIn, RESEND_SEC)

  const again = issueCode('alice@x.com', T0 + 30_000)
  assert.equal(again.error, 'too_fast')
  assert.equal(again.waitSec, 30)
  assert.equal(resendWaitSec('alice@x.com', T0 + 30_000), 30)

  assert.match(issueCode('alice@x.com', T0 + 61_000).code, /^\d{6}$/)
  assert.equal(resendWaitSec('alice@x.com', T0 + 600_000), 0)
})

test('发码：只存哈希，文件里翻不出明文码', () => {
  const { code } = issueCode('bob@x.com', T0)
  const raw = readFileSync(CODES_FILE, 'utf8')
  assert.ok(!raw.includes(code), '明文码进了盘，拿到文件的人就直接拿到了登录')
  assert.ok(raw.includes(hashCode(code)))
})

test('兑码：错过一次还能再试，对上了就作废（一码一次）', () => {
  const { code } = issueCode('carol@x.com', T0)
  assert.deepEqual(redeemCode('carol@x.com', '000000', T0), { ok: false, reason: 'bad_code' })
  assert.equal(redeemCode('carol@x.com', code, T0).ok, true)
  assert.deepEqual(redeemCode('carol@x.com', code, T0), { ok: false, reason: 'no_code' })
})

test('兑码：格式不对、没发过、过期各回各的话', () => {
  assert.deepEqual(redeemCode('dave@x.com', '12345', T0), { ok: false, reason: 'no_code' })
  assert.deepEqual(redeemCode('dave@x.com', '', T0), { ok: false, reason: 'no_code' })
  assert.deepEqual(redeemCode('not-an-email', '123456', T0), { ok: false, reason: 'invalid_email' })
  const { code } = issueCode('dave@x.com', T0)
  assert.deepEqual(redeemCode('dave@x.com', code, T0 + CODE_TTL_SEC * 1000 + 1), { ok: false, reason: 'expired' })
})

test('兑码：连错到上限就作废，得重新发一封', () => {
  const { code } = issueCode('erin@x.com', T0)
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
    assert.equal(redeemCode('erin@x.com', '000000', T0).ok, false)
  }
  assert.deepEqual(redeemCode('erin@x.com', code, T0), { ok: false, reason: 'no_code' })
})

test('邮箱登录：认不出这个号就当场建一个，第二次还是同一个 id', () => {
  const u1 = findOrCreateByEmail('Frank@X.com')
  const u2 = findOrCreateByEmail('frank@x.com')
  assert.equal(u1.id, u2.id, '大小写差一点就变两个号，等于把他的内容劈成两半')
  assert.equal(u1.email, 'frank@x.com')
  assert.ok(!('passHash' in u1), '这一版没有口令那一层')
})

test('GitHub 登录：同一邮箱并到同一个号，不建分身', () => {
  const byMail = findOrCreateByEmail('grace@x.com')
  const byGh = findOrCreateByGithub({ id: '1001', login: 'gracegh', email: 'grace@x.com' })
  assert.equal(byGh.id, byMail.id)
  assert.equal(byGh.githubId, '1001')
  assert.equal(byGh.name, 'gracegh')
  assert.equal(Object.keys(readUsers()).filter((k) => readUsers()[k].id === byMail.id).length, 1)

  // 再来一次：换个 login 也只认得这个号
  const again = findOrCreateByGithub({ id: '1001', login: 'grace-renamed', email: 'other@x.com' })
  assert.equal(again.id, byMail.id)
  assert.equal(again.name, 'grace-renamed')
})

test('GitHub 登录：邮箱设成私有的号按 GitHub id 建，界面上显示 login', () => {
  const u = findOrCreateByGithub({ id: '2002', login: 'hide-my-mail', email: '' })
  assert.equal(u.email, '', '不能替人造一个假邮箱')
  assert.equal(u.name, 'hide-my-mail')
  assert.equal(readUsers()[`gh_2002`].id, u.id)
})
