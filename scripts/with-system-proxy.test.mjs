import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseScutil, proxyEnv } from './with-system-proxy.mjs'

const scutil = (body) => `<dictionary> {\n${body}\n}`

test('系统代理读法：HTTPS 那条优先，端口与主机都要拿到', () => {
  const hit = parseScutil(scutil(`
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
`))
  assert.deepEqual(hit, { host: '127.0.0.1', port: 7897 })
})

test('系统代理读法：只开了 HTTP 也认，值前后带空格不影响', () => {
  assert.deepEqual(parseScutil(scutil('  HTTPEnable : 1\n  HTTPProxy :  192.168.1.8 \n  HTTPPort : 8118\n')), { host: '192.168.1.8', port: 8118 })
})

test('系统代理读法：没开代理、开关是 0、端口是坏值，一律算没有', () => {
  assert.equal(parseScutil(scutil('HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 7897')), null)
  assert.equal(parseScutil(scutil('(null)')), null)
  assert.equal(parseScutil(''), null)
  assert.equal(parseScutil(scutil('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : abc')), null)
  assert.equal(parseScutil(scutil('HTTPEnable : 1\nHTTPPort : 7897')), null, '有端口没主机不算有代理')
})

test('只有 SOCKS 时不交出去：node 的 fetch 只认 http 型代理，硬塞等于把请求送进死路', () => {
  assert.equal(parseScutil(scutil('SOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\nSOCKSPort : 7890')), null)
})

test('环境交给子进程：没配过代理才填四个变量，且一定带上 NODE_USE_ENV_PROXY', () => {
  const o = proxyEnv({ PATH: '/bin' }, { host: '127.0.0.1', port: 7897 })
  assert.equal(o.NODE_USE_ENV_PROXY, '1')
  assert.equal(o.HTTPS_PROXY, 'http://127.0.0.1:7897')
  assert.equal(o.HTTP_PROXY, 'http://127.0.0.1:7897')
  assert.equal(o.https_proxy, 'http://127.0.0.1:7897')
  assert.equal(o.PATH, '/bin')
})

test('已经自己设过代理的机器不抢方向盘，只补开关', () => {
  const o = proxyEnv({ HTTPS_PROXY: 'http://10.0.0.2:3128' }, { host: '127.0.0.1', port: 7897 })
  assert.equal(o.HTTPS_PROXY, 'http://10.0.0.2:3128')
  assert.equal(o.HTTP_PROXY, undefined)
  assert.equal(o.NODE_USE_ENV_PROXY, '1')
})

test('读不到系统代理就原样放行，墙外机器不该被塞一个不存在的代理', () => {
  const o = proxyEnv({ HOME: '/Users/x' }, null)
  assert.equal(o.HTTPS_PROXY, undefined)
  assert.equal(o.HOME, '/Users/x')
})
