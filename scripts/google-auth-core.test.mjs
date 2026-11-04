import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  GOOGLE_TOKEN, GOOGLE_USERINFO, authorizeUrl, exchangeCode, googleConfigured, googleIdentity, pkcePair,
} from './google-auth-core.mjs'

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

test('没配齐凭据就不算能用 Google 登录', () => {
  assert.equal(googleConfigured({}), false)
  assert.equal(googleConfigured({ GOOGLE_CLIENT_ID: 'id' }), false)
  assert.equal(googleConfigured({ GOOGLE_CLIENT_SECRET: 'sec' }), false)
  assert.equal(googleConfigured({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' }), true)
})

test('授权跳转：state、回调地址与 PKCE challenge 原样带过去，scope 只到人身份和邮箱', () => {
  const url = new URL(authorizeUrl({
    clientId: 'CID',
    redirectUri: 'http://127.0.0.1:5173/__auth/google/callback',
    state: 'ST4TE',
    codeChallenge: 'CH4LLENGE',
  }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), 'CID')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/__auth/google/callback')
  assert.equal(url.searchParams.get('state'), 'ST4TE')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('code_challenge'), 'CH4LLENGE')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  // 一个浏览器常登着好几个 Google 号，不让人当场挑就会登到默认那个上
  assert.equal(url.searchParams.get('prompt'), 'select_account')
})

test('PKCE：verifier 是 43 位 base64url，challenge 是它的 SHA-256，且没有 = + / 这些会被 URL 改掉的字符', () => {
  const { verifier, challenge } = pkcePair()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()))
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(pkcePair().verifier, verifier, '两次要不一样')
})

test('换 token：拿不到 access_token 一律算失败，不把 undefined 往下传', async () => {
  const ok = { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test' }) }
  assert.equal(
    await exchangeCode({ code: 'c', redirectUri: 'r', clientId: 'i', clientSecret: 's', codeVerifier: 'v', fetchImpl: async () => ok }),
    'ya29.test',
  )

  const denied = { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: '授权码已用过' }) }
  await assert.rejects(
    exchangeCode({ code: 'c', redirectUri: 'r', clientId: 'i', clientSecret: 's', codeVerifier: 'v', fetchImpl: async () => denied }),
    /授权码已用过/,
  )
})

test('换 token：回调地址与 verifier 一起交出去，grant_type 写死授权码', async () => {
  let sent = null
  const fetchImpl = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) }
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test' }) }
  }
  await exchangeCode({
    code: 'CODE',
    redirectUri: 'https://media.smzsapp.com/__auth/google/callback',
    clientId: 'i',
    clientSecret: 's',
    codeVerifier: 'VERIFIER',
    fetchImpl,
  })
  assert.equal(sent.url, GOOGLE_TOKEN)
  assert.equal(sent.body.get('code'), 'CODE')
  assert.equal(sent.body.get('redirect_uri'), 'https://media.smzsapp.com/__auth/google/callback')
  assert.equal(sent.body.get('code_verifier'), 'VERIFIER')
  assert.equal(sent.body.get('grant_type'), 'authorization_code')
})

test('问身份：sub、邮箱、名字拿回来，picture 不当成必填', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, GOOGLE_USERINFO)
    assert.equal(init.headers.authorization, 'Bearer ya29.test')
    return { ok: true, status: 200, json: async () => ({ sub: '108', email: 'a@b.com', name: 'A B' }) }
  }
  assert.deepEqual(await googleIdentity('ya29.test', { fetchImpl }), { id: '108', email: 'a@b.com', name: 'A B', picture: '' })
})

test('问身份：没验证过的邮箱不许带出去并号，否则别人抢注同一邮箱就能登进你的账号', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ sub: '108', email: 'a@b.com', email_verified: false, name: 'A B' }),
  })
  assert.equal((await googleIdentity('t', { fetchImpl })).email, '')
})

test('问身份：Google 没给 sub 就当失败，不让上层建出一个没有身份的空号', async () => {
  await assert.rejects(googleIdentity('t', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), /没回身份/)
  await assert.rejects(googleIdentity('t', { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), /HTTP 401/)
})
