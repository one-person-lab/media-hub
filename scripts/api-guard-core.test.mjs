import test from 'node:test'
import assert from 'node:assert/strict'
import { corsHeaders, isMutating, originAllowed } from './api-guard-core.mjs'

const H = (origin, host = '127.0.0.1:5173') => ({ origin, host })

test('不带 Origin 的是非浏览器客户端：cron 的 curl、桌面壳主进程照常过', () => {
  assert.equal(originAllowed({ host: '127.0.0.1:5173' }), true)
})

test('界面自己（同源）放行，换 IP、换端口都算同源', () => {
  assert.equal(originAllowed(H('http://127.0.0.1:5173')), true)
  assert.equal(originAllowed(H('http://localhost:5173', 'localhost:5173')), true)
  assert.equal(originAllowed(H('http://192.168.1.7:5173', '192.168.1.7:5173')), true)
})

test('采集扩展的弹窗页放行', () => {
  assert.equal(originAllowed(H('chrome-extension://abcdefghijklmnop')), true)
})

test('别的网页一律挡：主机或端口对不上就不是同源', () => {
  assert.equal(originAllowed(H('http://evil.example')), false)
  assert.equal(originAllowed(H('http://127.0.0.1:9999')), false)
  assert.equal(originAllowed(H('http://localhost:5173')), false) // 本机开着，但Host写的是127.0.0.1，来路不同
  assert.equal(originAllowed(H('null')), false) // 沙箱 iframe 与 file:// 页面带的就是 "null"
  assert.equal(originAllowed(H('')), true) // 空串等于没带
})

test('同一个 host:port 换协议仍算自己：那个端口上起不了第二个服务', () => {
  assert.equal(originAllowed(H('https://127.0.0.1:5173')), true)
})

test('只读不挡，改机器状态的才挡', () => {
  assert.equal(isMutating('GET'), false)
  assert.equal(isMutating('HEAD'), false)
  assert.equal(isMutating('OPTIONS'), false)
  assert.equal(isMutating('POST'), true)
  assert.equal(isMutating('delete'), true)
})

test('CORS 头只回声被认下的来源，绝不写 *', () => {
  assert.deepEqual(corsHeaders(H('http://127.0.0.1:5173')), {
    'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  })
  assert.deepEqual(corsHeaders(H('http://evil.example')), {})
  assert.deepEqual(corsHeaders({ host: '127.0.0.1:5173' }), {})
})
