import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GITHUB_TOKEN, authorizeUrl, exchangeCode, githubConfigured, githubIdentity } from './github-auth-core.mjs'

test('没配齐凭据就不算能用 GitHub 登录', () => {
  assert.equal(githubConfigured({}), false)
  assert.equal(githubConfigured({ GITHUB_CLIENT_ID: 'id' }), false)
  assert.equal(githubConfigured({ GITHUB_CLIENT_SECRET: 'sec' }), false)
  assert.equal(githubConfigured({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' }), true)
})

test('授权跳转：state 与回调地址原样带过去，scope 只到读邮箱', () => {
  const url = new URL(authorizeUrl({ clientId: 'CID', redirectUri: 'http://127.0.0.1:5173/__auth/github/callback', state: 'ST4TE' }))
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), 'CID')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/__auth/github/callback')
  assert.equal(url.searchParams.get('state'), 'ST4TE')
  assert.equal(url.searchParams.get('scope'), 'read:user user:email')
})

test('换 token：拿不到 access_token 一律算失败，不把 undefined 往下传', async () => {
  const ok = { ok: true, status: 200, json: async () => ({ access_token: 'gho_test' }) }
  assert.equal(await exchangeCode({ code: 'c', redirectUri: 'r', clientId: 'i', clientSecret: 's', fetchImpl: async () => ok }), 'gho_test')

  const denied = { ok: false, status: 400, json: async () => ({ error: 'bad_verification_code', error_description: '代码无效' }) }
  await assert.rejects(
    exchangeCode({ code: 'c', redirectUri: 'r', clientId: 'i', clientSecret: 's', fetchImpl: async () => denied }),
    /代码无效/,
  )
})

test('换 token：回调地址要一起送去核对，GitHub 拿它对登记的 redirect_uri', async () => {
  let sent = null
  const fetchImpl = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) }
    return { ok: true, status: 200, json: async () => ({ access_token: 'gho_test' }) }
  }
  await exchangeCode({ code: 'CODE', redirectUri: 'https://media.smzsapp.com/__auth/github/callback', clientId: 'i', clientSecret: 's', fetchImpl })
  assert.equal(sent.url, GITHUB_TOKEN)
  assert.equal(sent.body.get('code'), 'CODE')
  assert.equal(sent.body.get('redirect_uri'), 'https://media.smzsapp.com/__auth/github/callback')
})

test('认人：私有邮箱的号去 /user/emails 捞验证过的主邮箱', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/user')) return { json: async () => ({ id: 7, login: 'someone', email: null }) }
    return { json: async () => [{ email: 'old@x.com', verified: true, primary: false }, { email: 'me@x.com', verified: true, primary: true }] }
  }
  assert.deepEqual(await githubIdentity('tok', { fetchImpl }), { id: '7', login: 'someone', email: 'me@x.com' })
  assert.equal(calls.length, 2)
})

test('认人：一个邮箱都拿不到就如实回空，不造假邮箱', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/user')) return { json: async () => ({ id: 8, login: 'nopublic', email: '' }) }
    return { json: async () => [] }
  }
  assert.deepEqual(await githubIdentity('tok', { fetchImpl }), { id: '8', login: 'nopublic', email: '' })
})
