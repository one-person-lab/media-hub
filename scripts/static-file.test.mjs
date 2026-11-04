import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveStaticFile } from './serve.mjs'

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'static-file-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

test('dist 快照里没有的运行时产物回 public 找得到', () => {
  const dist = fixture({ 'index.html': '<html>' })
  const pub = fixture({ 'videos/promo-2026-11-04.mp4': 'PNG' })
  const found = resolveStaticFile('/videos/promo-2026-11-04.mp4', [dist, pub])
  assert.equal(found.file, join(pub, 'videos/promo-2026-11-04.mp4'))
  rmSync(dist, { recursive: true, force: true })
  rmSync(pub, { recursive: true, force: true })
})

test('两边都有时优先 dist 的构建快照', () => {
  const dist = fixture({ 'cards/s01/01.png': 'dist' })
  const pub = fixture({ 'cards/s01/01.png': 'public' })
  const found = resolveStaticFile('/cards/s01/01.png', [dist, pub])
  assert.equal(found.file, join(dist, 'cards/s01/01.png'))
  rmSync(dist, { recursive: true, force: true })
  rmSync(pub, { recursive: true, force: true })
})

test('两处都没有时判 miss，交给 SPA 回退', () => {
  const dist = fixture({ 'index.html': '<html>' })
  const pub = fixture({ 'videos/other.png': 'PNG' })
  const found = resolveStaticFile('/studio', [dist, pub])
  assert.ok(found.miss)
  rmSync(dist, { recursive: true, force: true })
  rmSync(pub, { recursive: true, force: true })
})

test('目录不算命中', () => {
  const dist = fixture({ 'videos/promo.mp4': 'PNG' })
  const found = resolveStaticFile('/videos', [dist, dist])
  assert.ok(found.miss)
  rmSync(dist, { recursive: true, force: true })
})

test('越界路径两个根都拒', () => {
  const dist = fixture({ 'index.html': '<html>' })
  const pub = fixture({ 'videos/promo.mp4': 'PNG' })
  const found = resolveStaticFile('/../../etc/passwd', [dist, pub])
  assert.ok(found.forbidden)
  rmSync(dist, { recursive: true, force: true })
  rmSync(pub, { recursive: true, force: true })
})
