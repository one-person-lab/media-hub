import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { ARCHES, REQUIRED_TOOLS, candidateFor, pickArchiveEntry, isCurrent, sha256Of, gate, checkTool } from './fetch-binaries.mjs'

test('两个架构都必须要 ffmpeg 与 ffprobe，候选表缺一就报错', () => {
  for (const arch of ARCHES) {
    for (const tool of REQUIRED_TOOLS) {
      const list = candidateFor(arch, tool)
      assert.ok(Array.isArray(list) && list.length >= 1, `${arch}/${tool} 没有候选源`)
      for (const c of list) assert.ok(c.url.startsWith('https://') && c.label, `${arch}/${tool} 候选缺 url 或 label`)
    }
  }
})

test('钉了 sha256 的镜像源打头：慢源排前面会让客户在界面上干等一刻钟', () => {
  for (const arch of ARCHES) {
    for (const tool of REQUIRED_TOOLS) {
      assert.ok(candidateFor(arch, tool)[0].sha256, `${arch}/${tool} 的首选源必须钉哈希`)
    }
  }
})

test('zip 清单里挑出真正的二进制，跳过 __MACOSX 与目录', () => {
  const list = ['__MACOSX/._ffmpeg', 'ffmpeg', 'readme.txt/', 'ffprobe']
  assert.equal(pickArchiveEntry(list, 'ffmpeg'), 'ffmpeg')
  assert.equal(pickArchiveEntry(list, 'ffprobe'), 'ffprobe')
  assert.equal(pickArchiveEntry(['__MACOSX/._ocr', 'ocr/'], 'ocr'), null)
})

test('sha256Of 算的是文件内容而不是路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sha-'))
  const f = join(dir, 'a.bin')
  writeFileSync(f, 'abc')
  assert.equal(await sha256Of(f), createHash('sha256').update('abc').digest('hex'))
  rmSync(dir, { recursive: true, force: true })
})

test('记账只在 arch+tool+sha 三项都对上时才算已就绪', () => {
  const m = { 'darwin-arm64': { ffmpeg: { sha256: 'aaa' } } }
  assert.equal(isCurrent(m, 'darwin-arm64', 'ffmpeg', 'aaa'), true)
  assert.equal(isCurrent(m, 'darwin-arm64', 'ffmpeg', 'bbb'), false)
  assert.equal(isCurrent(m, 'darwin-x64', 'ffmpeg', 'aaa'), false)
  assert.equal(isCurrent(m, 'darwin-arm64', 'ffprobe', 'aaa'), false)
})

/** 造一个会答话的假构建：校验认的是它的输出，不是它的名字 */
function stubBin(name, body) {
  const dir = mkdtempSync(join(tmpdir(), `gate-${name}-`))
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return { p, dir }
}

test('没有 libx264 的构建一律判不合格，哪怕它真是 ffmpeg', async () => {
  const b = stubBin('ffmpeg', 'echo "encoders: aac h264_mf"')
  try {
    await assert.rejects(() => gate('ffmpeg', b.p), /libx264/)
  } finally {
    rmSync(b.dir, { recursive: true, force: true })
  }
})

test('合格构建拿第一行当版本；ffprobe 不看编码器', async () => {
  const ok = stubBin('ffmpeg', 'echo "ffmpeg version 9.0 GPL"\necho "libx264"')
  const probe = stubBin('ffprobe', 'echo "ffprobe version 9.0"')
  try {
    assert.equal(await gate('ffmpeg', ok.p), 'ffmpeg version 9.0 GPL')
    assert.equal(await gate('ffprobe', probe.p), 'ffprobe version 9.0')
  } finally {
    rmSync(ok.dir, { recursive: true, force: true })
    rmSync(probe.dir, { recursive: true, force: true })
  }
})

test('checkTool 只看包内那一份，没有就报 missing（不许悄悄退回系统的 ffmpeg）', async () => {
  assert.deepEqual(await checkTool(ARCHES[0], 'no-such-tool'), {
    tool: 'no-such-tool', ready: false, reason: 'missing',
  })
})
