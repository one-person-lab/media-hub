import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_COOKIE, emailProblem, emailAllowed, normalizeEmail, parseAllowEmails, parseCookies,
  resolveSessionSecret, sessionCookieValue, signSession, verifySession,
} from './auth-core.mjs'

test('邮箱归一：大小写与首尾空格不产生第二个账号', () => {
  assert.equal(normalizeEmail('  Alice@X.COM '), 'alice@x.com')
})

test('邮箱只卡能出事的线，不搞正则体操', () => {
  assert.equal(emailProblem('alice@x.com'), null)
  assert.equal(emailProblem('alice@x'), '邮箱格式不对')
  assert.equal(emailProblem(''), '邮箱没填')
})

test('会话：自己的签才认，改一个字节就不认', () => {
  const t = signSession('secret-key-value-1', 'u_123')
  assert.equal(verifySession('secret-key-value-1', t), 'u_123')
  assert.equal(verifySession('another-secret-key', t), null)
  assert.equal(verifySession('secret-key-value-1', t.slice(0, -2) + 'xx'), null)
  assert.equal(verifySession('secret-key-value-1', ''), null)
  assert.equal(verifySession('secret-key-value-1', `${t}.${t}`), null)
})

test('会话：过期就是过期，不看签不签得动', () => {
  const t = signSession('secret-key-value-1', 'u_123', -1)
  assert.equal(verifySession('secret-key-value-1', t), null)
})

test('会话 cookie：只给 httpOnly，前端脚本经手不到', () => {
  const v = sessionCookieValue('abc', { maxAgeSec: 3600 })
  assert.ok(v.startsWith(`${SESSION_COOKIE}=abc`))
  assert.match(v, /HttpOnly/)
  assert.match(v, /SameSite=Lax/)
  assert.match(v, /Max-Age=3600/)
  assert.ok(!v.includes('Secure'), '本机 http 下加 Secure 会让 cookie 直接存不住')
  assert.match(sessionCookieValue('abc', { secure: true }), /Secure/)
  assert.match(sessionCookieValue('', { maxAgeSec: 0 }), /Max-Age=0/, '退出要能立刻过期')
})

test('读 cookie 头：只取鉴权要的那一枚', () => {
  const c = parseCookies(`other=1; ${SESSION_COOKIE}=tok%20en; trailing=`)
  assert.equal(c[SESSION_COOKIE], 'tok en')
  assert.equal(c.other, '1')
  assert.deepEqual(parseCookies(undefined), {})
})

test('会话密钥：环境变量优先，其次复用文件，都没有才现造', () => {
  assert.equal(resolveSessionSecret({ WORKBENCH_SESSION_SECRET: 'a-long-env-secret-value' }, () => null, () => { throw new Error('不该写盘') }), 'a-long-env-secret-value')
  assert.equal(resolveSessionSecret({}, () => 'f'.repeat(64), () => { throw new Error('不该写盘') }), 'f'.repeat(64))
  let written = ''
  const got = resolveSessionSecret({}, () => null, (k) => { written = k })
  assert.ok(got.length >= 32)
  assert.equal(written, got, '现造的密钥必须落盘，否则重启就把所有人踢下线')
})

test('开放名单：逗号空格混着写都行，坏值和大小写当场收干净', () => {
  assert.deepEqual(parseAllowEmails(' Alice@X.com , bob@y.com  carol@z.io '), ['alice@x.com', 'bob@y.com', 'carol@z.io'])
  assert.deepEqual(parseAllowEmails('a@b.com, 不是邮箱 ,, '), ['a@b.com'])
  assert.deepEqual(parseAllowEmails(undefined), [])
})

test('开放名单：名单空的远程那份一个都不放，认的是归一后的样子', () => {
  assert.equal(emailAllowed('alice@x.com', []), false)
  assert.equal(emailAllowed('  ALICE@x.com ', ['alice@x.com']), true)
  assert.equal(emailAllowed('mallory@x.com', ['alice@x.com']), false)
})
