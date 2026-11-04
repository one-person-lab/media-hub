import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planViralConfig, writeViralConfig, readViralConfig, SUPPORTED_PLATFORMS } from './viral-config-core.mjs'

const BASE = {
  _说明: '改口径只动这个文件',
  minLikes: 10000,
  withinDays: 90,
  dailyLimitPerPlatform: 5,
  scrollRounds: 3,
  platforms: ['xiaohongshu', 'douyin'],
  keywords: ['认知提升', '行动力'],
}

function fixture(cfg = BASE) {
  const root = join(tmpdir(), `viral-config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config/viral.json'), `${JSON.stringify(cfg, null, 2)}\n`)
  return root
}

test('正常提交：只带回可编辑字段，注释键不进界面', () => {
  const root = fixture()
  const v = planViralConfig({ keywords: ['习惯养成', '习惯养成', ' 目标拆解 '] }, root)
  assert.deepEqual(v.keywords, ['习惯养成', '目标拆解'])
  assert.equal(v._说明, undefined)
  assert.equal(v.minLikes, 10000)
})

test('白名单外的平台直接拒，并说清为什么不给采', () => {
  const root = fixture()
  assert.throws(() => planViralConfig({ platforms: ['kuaishou'] }, root), /还不支持采集：kuaishou/)
})

test('平台至少留一个：全删等于采集线空转', () => {
  const root = fixture()
  assert.throws(() => planViralConfig({ platforms: [] }, root), /至少要留一个/)
})

test('关键词至少留一个：空串不是「删掉这个」', () => {
  const root = fixture()
  assert.throws(() => planViralConfig({ keywords: ['', '  '] }, root), /至少要留一个/)
})

test('门槛挡非法值：负数、小数、非数字', () => {
  const root = fixture()
  assert.throws(() => planViralConfig({ minLikes: -1 }, root), /≥ 0 的整数/)
  assert.throws(() => planViralConfig({ withinDays: 1.5 }, root), /≥ 1 的整数/)
  assert.throws(() => planViralConfig({ dailyLimitPerPlatform: '五' }, root), /≥ 1 的整数/)
})

test('合并写回：没提交的字段与人手写的 _说明 原样保留', () => {
  const root = fixture()
  writeViralConfig({ keywords: ['一个人做产品'], minLikes: 5000 }, root)
  const back = readViralConfig(root)
  assert.deepEqual(back.keywords, ['一个人做产品'])
  assert.equal(back.minLikes, 5000)
  assert.equal(back.withinDays, 90) // 没提交的字段不动
  assert.equal(back.scrollRounds, 3)
  assert.equal(back._说明, '改口径只动这个文件')
  assert.deepEqual(back.platforms, ['xiaohongshu', 'douyin'])
})

test('写盘是完整 JSON：落盘后立即可读，采集线不会读到半截', () => {
  const root = fixture()
  writeViralConfig({ platforms: ['douyin'] }, root)
  const text = readFileSync(join(root, 'config/viral.json'), 'utf8')
  assert.equal(JSON.parse(text).platforms.length, 1)
  assert.ok(!existsSync(join(root, 'config/viral.json.tmp')))
})

test('配置文件缺失时报错说清去哪看', () => {
  const root = join(tmpdir(), `viral-config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  assert.throws(() => planViralConfig({ keywords: ['x'] }, root), /config\/viral\.json 读不到/)
})
