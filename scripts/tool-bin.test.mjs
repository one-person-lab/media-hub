import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toolBin, vendorBinDir } from './collect-note-core.mjs'

/** 造一个假仓库根：bin/darwin-arm64/<name> 想要几个有几个 */
function fakeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'toolbin-'))
  for (const rel of files) {
    const abs = join(root, 'bin', rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'x')
  }
  return root
}

test('包内有同名二进制时优先返回包内', () => {
  const root = fakeRoot(['darwin-arm64/ffmpeg'])
  const got = toolBin('ffmpeg', { root, arch: 'arm64', systemDirs: ['/nonexistent'] })
  assert.equal(got, join(root, 'bin/darwin-arm64/ffmpeg'))
  rmSync(root, { recursive: true, force: true })
})

test('包内没有时按 systemDirs 顺序返回第一个命中', () => {
  const root = fakeRoot([])
  const a = mkdtempSync(join(tmpdir(), 'sys-a-'))
  const b = mkdtempSync(join(tmpdir(), 'sys-b-'))
  writeFileSync(join(b, 'ffmpeg'), 'x') // 只在第二个目录里有
  const got = toolBin('ffmpeg', { root, arch: 'arm64', systemDirs: [a, b] })
  assert.equal(got, join(b, 'ffmpeg'))
  rmSync(root, { recursive: true, force: true })
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('哪里都没有时返回裸名，绝不抛错', () => {
  const root = fakeRoot([])
  assert.equal(toolBin('no-such-tool-xyz', { root, arch: 'arm64', systemDirs: ['/nonexistent'] }), 'no-such-tool-xyz')
  rmSync(root, { recursive: true, force: true })
})

test('Intel 机器解析到 darwin-x64 目录', () => {
  const root = fakeRoot(['darwin-x64/ffprobe'])
  const got = toolBin('ffprobe', { root, arch: 'x64', systemDirs: [] })
  assert.equal(got, join(root, 'bin/darwin-x64/ffprobe'))
  rmSync(root, { recursive: true, force: true })
})

test('打包态走 resourcesPath，开发态走仓库根', () => {
  assert.equal(vendorBinDir({ resourcesPath: '/Applications/工作台.app/Contents/Resources', arch: 'arm64' }),
    '/Applications/工作台.app/Contents/Resources/bin/darwin-arm64')
  assert.equal(vendorBinDir({ resourcesPath: undefined, root: '/repo', arch: 'arm64' }), '/repo/bin/darwin-arm64')
})
