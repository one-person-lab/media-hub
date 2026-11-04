import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planBenchConfig, writeBenchConfig, readBenchConfig } from './benchmark-config-core.mjs'

const BASE = {
  _说明: '对标账号（自动线）的口径',
  minFollowers: 20000,
  maxInactiveDays: 45,
  dailyLimitPerPlatform: 5,
  visitLimit: 18,
  noteSample: 30,
  scrollRounds: 2,
  platforms: ['xiaohongshu', 'douyin'],
  keywords: ['认知提升', '行动力'],
}

function fixture(cfg = BASE) {
  const root = join(tmpdir(), `bench-config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config/benchmarks.json'), `${JSON.stringify(cfg, null, 2)}\n`)
  return root
}

test('正常提交：只带回可编辑字段，注释键与不常动的键不进界面', () => {
  const root = fixture()
  const v = planBenchConfig({ keywords: ['游戏化人生', '游戏化人生', ' 习惯养成 '] }, root)
  assert.deepEqual(v.keywords, ['游戏化人生', '习惯养成'])
  assert.equal(v._说明, undefined)
  assert.equal(v.visitLimit, undefined)
  assert.equal(v.minFollowers, 20000)
})

test('白名单外的平台直接拒，并说清为什么不给找', () => {
  const root = fixture()
  assert.throws(() => planBenchConfig({ platforms: ['kuaishou'] }, root), /还不支持找号：kuaishou/)
})

test('平台和关键词各至少留一个：全删等于对标线空转', () => {
  const root = fixture()
  assert.throws(() => planBenchConfig({ platforms: [] }, root), /至少要留一个/)
  assert.throws(() => planBenchConfig({ keywords: ['', '  '] }, root), /至少要留一个/)
})

test('门槛挡非法值：负数、小数、非数字', () => {
  const root = fixture()
  assert.throws(() => planBenchConfig({ minFollowers: -1 }, root), /≥ 0 的整数/)
  assert.throws(() => planBenchConfig({ maxInactiveDays: 0 }, root), /≥ 1 的整数/)
  assert.throws(() => planBenchConfig({ dailyLimitPerPlatform: '五' }, root), /≥ 1 的整数/)
})

test('合并写回：没提交的字段（visitLimit、_说明 那类）原样保留', () => {
  const root = fixture()
  writeBenchConfig({ keywords: ['一个人做产品'], minFollowers: 5000 }, root)
  const back = readBenchConfig(root)
  assert.deepEqual(back.keywords, ['一个人做产品'])
  assert.equal(back.minFollowers, 5000)
  assert.equal(back.maxInactiveDays, 45)
  assert.equal(back.visitLimit, 18)
  assert.equal(back.scrollRounds, 2)
  assert.equal(back._说明, '对标账号（自动线）的口径')
})

test('写盘是完整 JSON：落盘后立即可读，采集线不会读到半截', () => {
  const root = fixture()
  writeBenchConfig({ platforms: ['douyin'] }, root)
  const text = readFileSync(join(root, 'config/benchmarks.json'), 'utf8')
  assert.equal(JSON.parse(text).platforms.length, 1)
  assert.ok(!existsSync(join(root, 'config/benchmarks.json.tmp')))
})

test('配置文件缺失时报错说清去哪看', () => {
  const root = join(tmpdir(), `bench-config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  assert.throws(() => planBenchConfig({ keywords: ['x'] }, root), /config\/benchmarks\.json 读不到/)
})
