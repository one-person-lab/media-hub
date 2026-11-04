import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  dropVideoCandidate,
  parseBeats,
  promoteVideoCandidate,
  saveVideoCandidates,
  scriptDurationSec,
  structureFromScript,
  structureRejectReason,
  videoCandidate,
} from './video-harvest-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 只拷一份 config 进临时目录：收编会整份重写 video-templates.json，测试不许碰真目录 */
function sandbox() {
  const root = join(tmpdir(), `video-harvest-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  copyFileSync(join(ROOT, 'config/video-templates.json'), join(root, 'config/video-templates.json'))
  return { root, read: () => JSON.parse(readFileSync(join(root, 'config/video-templates.json'), 'utf8')) }
}

const SCRIPT = [
  '[0s] 你有没有这样的感觉',
  '[2s] 心里有很大的梦想',
  '[4s] 却没有精力把它们变成现实',
  '[8s] 你想做出一番成绩',
  '[12s] 却觉得连开始都很困难',
  '[20s] 好消息是你可以改变这种情况',
  '[24s] 懒惰不是身份它只是一个习惯',
].join('\n')

test('逐字稿 → 拍：只认 [Ns] 行，按时间排好，空行和散文都不算', () => {
  const beats = parseBeats(`前言不搭后语\n${SCRIPT}\n\n[6s] 补一拍`)
  assert.equal(beats.length, 8)
  assert.deepEqual(beats.map((b) => b.at).slice(0, 4), [0, 2, 4, 6])
  assert.equal(beats[beats.length - 1].text, '懒惰不是身份它只是一个习惯')
  assert.deepEqual(parseBeats('整段没有时间码'), [])
})

/** 抖音那条线转写与画面字幕会撞出同一句两遍，不去重就把字数翻倍、语速算成 6 字/秒的假读数 */
test('同一句写两遍（转写 + 画面字幕）只算一拍', () => {
  const dup = `${SCRIPT}\n[2s] 心里有很大的梦想\n[26s] 你有没有这样的感觉`
  const beats = parseBeats(dup)
  assert.equal(beats.length, 7, beats.map((b) => `${b.at}s ${b.text}`).join(' | '))
  assert.equal(scriptDurationSec(dup), 24)
})

test('量结构：时长、语速、平均拍长、开场钩子都是从时间码上算的', () => {
  const st = structureFromScript(SCRIPT)
  assert.equal(st.durationSec, 24)
  assert.equal(st.beats, 7)
  assert.equal(st.chars, 73)
  assert.equal(st.charsPerSec, 3)
  // 7 拍跨 24 秒：平均一拍 4 秒；最长一次停顿是 12s→20s 那处
  assert.equal(st.beatSec, 4)
  assert.equal(st.maxGap, 8)
  assert.equal(st.hookLines, 4)
  assert.equal(st.hookSec, 8)
  assert.equal(st.hookChars, 37)
  assert.equal(st.hookText, '你有没有这样的感觉 心里有很大的梦想 却没有精力把它们变成现实 你想做出一番成绩')
})

test('量不出来的就不收：不足 3 拍、没有时间码一律给 null', () => {
  assert.equal(structureFromScript(''), null)
  assert.equal(structureFromScript('[0s] 一句'), null)
  assert.equal(structureFromScript('[0s] 一\n[2s] 二'), null)
  assert.equal(videoCandidate({ id: 'x', script: '没有时间码的稿子' }), null)
})

/** 三道闸各挡一种真收进来过的脏数据：太短的切片、太长的直播、混了画面字的稿子。
 *  宁可跳过并说清原因，也不给库里挂一个说不圆的读数。 */
test('太短、太长、语速不可信：都拒收，且理由各说各的', () => {
  const tooShort = '[0s] 一二三\n[5s] 四五六\n[10s] 七八九'
  const tooLong = '[0s] 开场\n[200s] 中间\n[400s] 结尾'
  const line = (n) => '字'.repeat(150) + n
  const inflated = `[0s] ${line(1)}\n[20s] ${line(2)}\n[40s] ${line(3)}`
  for (const s of [tooShort, tooLong, inflated]) assert.equal(structureFromScript(s), null)

  assert.equal(structureRejectReason(SCRIPT), '')
  assert.match(structureRejectReason(tooShort), /只有 10 秒，太短/)
  assert.match(structureRejectReason(tooLong), /7 分钟/)
  assert.match(structureRejectReason(inflated), /混了画面字（算出来 11\.3 字\/秒）/)
  assert.match(structureRejectReason('没有时间码'), /时间码/)

  const s = sandbox()
  const r = saveVideoCandidates(
    [
      { id: 'short0001', platform: 'douyin', script: tooShort },
      { id: 'long000001', platform: 'douyin', script: tooLong },
      { id: 'fast000001', platform: 'douyin', script: inflated },
    ],
    { root: s.root },
  )
  assert.deepEqual(r.saved, [])
  assert.equal(r.skipped.map((x) => x.why).join('\n').match(/太短|分钟|画面字/g).length, 3)
})

test('收编：候选带来源读数和结构，没有 composition、没有小样地址', () => {
  const s = sandbox()
  const before = s.read().templates.length
  const r = saveVideoCandidates(
    [{ id: '7658123409198058815', platform: 'douyin', title: '某条口播', url: 'https://www.douyin.com/video/7658123409198058815', likes: '151.1万', heat: 1511000, script: SCRIPT }],
    { root: s.root },
  )
  assert.equal(r.saved.length, 1)
  assert.deepEqual(r.skipped, [])
  assert.equal(r.saved[0].key, 'viral-douyin-76581234')

  const t = s.read().templates.find((x) => x.key === 'viral-douyin-76581234')
  assert.equal(s.read().templates.length, before + 1)
  assert.equal(t.status, 'candidate')
  assert.equal(t.kind, '爆款结构')
  assert.equal(t.composition, '')
  assert.ok(!t.poster && !t.preview && !t.render, '收编来的结构模板不该挂着成片地址')
  assert.equal(t.source.likes, '151.1万')
  assert.equal(t.source.heat, 1511000)
  assert.equal(t.structure.maxGap, 8)
  assert.match(t.label, /^24 秒口播 · 3 字\/秒 · 每拍 4 秒$/)
  assert.match(t.pick, /前 8 秒把钩子说完（37 字）/)
})

test('重收同一条笔记不入库；没逐字稿的跳过并说清为什么', () => {
  const s = sandbox()
  const item = { id: 'aaaabbbb1234', platform: 'douyin', script: SCRIPT, likes: '1万', heat: 10000 }
  assert.equal(saveVideoCandidates([item], { root: s.root }).saved.length, 1)
  const afterFirst = s.read().templates.length
  const again = saveVideoCandidates([item, { id: 'ccccdddd', platform: 'douyin', script: '没有时间码' }], { root: s.root })
  assert.deepEqual(again.saved, [])
  assert.equal(again.skipped.length, 2)
  assert.match(again.skipped[0].why, /库里已经收过/)
  assert.match(again.skipped[1].why, /时间码/)
  // 一条没收进来就不该动盘
  assert.equal(s.read().templates.length, afterFirst)
})

test('转正只改状态，删掉只删候选：在架的那几条不许在这里被删', () => {
  const s = sandbox()
  saveVideoCandidates([{ id: 'eeee1111', platform: 'douyin', script: SCRIPT, heat: 1 }], { root: s.root })
  const p = promoteVideoCandidate({ template: 'viral-douyin-eeee1111' }, { root: s.root })
  assert.equal(p.label, '24 秒口播 · 3 字/秒 · 每拍 4 秒')
  assert.equal(s.read().templates.find((t) => t.key === p.templateKey).status, 'active')

  assert.throws(() => dropVideoCandidate({ template: 'viral-douyin-eeee1111' }, { root: s.root }), /已经转正/)
  assert.throws(() => promoteVideoCandidate({ template: 'mh-value' }, { root: s.root }), /不是候选/)
  assert.throws(() => dropVideoCandidate({ template: 'nope' }, { root: s.root }), /没有/)
})
