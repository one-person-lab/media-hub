import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pendingPage, resolveStaticFile, isAssetPath } from './serve.mjs'

test('构建中那一屏自己隔 5 秒回来看一眼，失败那一屏不刷（刷了原因就没了）', () => {
  assert.match(pendingPage('running', ''), /http-equiv="refresh" content="5"/)
  assert.doesNotMatch(pendingPage('failed', 'x'), /http-equiv="refresh"/)
  assert.match(pendingPage('failed', '构建没出产物（退出码 2）'), /构建没出产物（退出码 2）/)
})

test('报错里带尖括号也只能当文字，不能把这一页撑破', () => {
  const html = pendingPage('failed', "Cannot find module '<script>alert(1)</script>' & more")
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&amp; more/)
})

test('静态文件：先查构建产物再查 public，越界的路径一律 403', () => {
  const a = mkdtempSync(join(tmpdir(), 'serve-a-'))
  const b = mkdtempSync(join(tmpdir(), 'serve-b-'))
  writeFileSync(join(b, 'clip.mp4'), 'x') // 只在 public 存在的运行时产物
  assert.equal(resolveStaticFile('/clip.mp4', [a, b]).file, join(b, 'clip.mp4'))
  assert.equal(resolveStaticFile('/nope.png', [a, b]).miss, true)
  assert.equal(resolveStaticFile('/../../etc/passwd', [a, b]).forbidden, true)
})

test('资源请求没命中就是没命中：回 index.html 会让 <img> 吃到一份 HTML，200 把封面全裂藏住', () => {
  assert.equal(isAssetPath('/inspiration/fav-5d56100f.webp'), true)
  assert.equal(resolveStaticFile('/nope.webp', [mkdtempSync(join(tmpdir(), 'serve-c-'))]).miss, true)
  assert.equal(isAssetPath('/videos/promo.mp4'), true)
  assert.equal(isAssetPath('/'), false, '根路径要回界面')
  assert.equal(isAssetPath('/inspiration'), false, '无扩展名的是 SPA 路由，照常回 index.html')
  assert.equal(isAssetPath('/index.html'), false)
})
