import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeSnapshot, isBlank } from './raw-snapshot-core.mjs'

/** 当天文件里已有的内容：早上 publish-check 写的发布列表 + 上一次采集的读数 */
const prevDoc = () => ({
  collectedAt: '2026-10-28T00:42:00.000Z',
  date: '2026-10-28',
  publishedListAt: '2026-10-28T00:42:00.000Z',
  platforms: {
    xiaohongshu: { publishedList: [{ title: '早上那篇', at: '10-27' }], followers: 61 },
    douyin: { publishedList: [{ title: '早上那条', at: '10-27' }], followers: 359, daily: [{ d: '10-26', v: 1 }] },
    kuaishou: { publishedList: [{ title: '快手' }] },
  },
  errors: { mp: '发表记录返回 0 条' },
})

/** 晚上 collect 刚采到的新读数（collect 不产 publishedList） */
const freshDoc = () => ({
  collectedAt: '2026-10-28T13:47:00.000Z',
  date: '2026-10-28',
  platforms: {
    xiaohongshu: { nickname: '醒醒老己', followers: 62, metrics: { 曝光数: 1200 }, daily: [{ d: '10-27', v: 9 }], notes: [{ t: '新稿' }] },
    douyin: { nickname: '醒醒老己', followers: 360, metrics: { 播放量: 8000 }, daily: [{ d: '10-27', v: 7 }], notes: [] },
  },
  errors: {},
})

test('当天已有快照时，新采的读数不能被旧值冲掉', () => {
  const merged = mergeSnapshot(prevDoc(), freshDoc())
  const x = merged.platforms.xiaohongshu
  assert.equal(x.daily.length, 1)
  assert.equal(x.daily[0].d, '10-27', '日序列要拿本轮采到的，不是早上文件里的')
  assert.equal(x.metrics.曝光数, 1200)
  assert.equal(x.notes.length, 1)
  assert.equal(x.followers, 62)
  assert.equal(merged.platforms.douyin.daily[0].v, 7)
})

test('publish-check 写的发布列表要留着，collect 不产这个字段', () => {
  const merged = mergeSnapshot(prevDoc(), freshDoc())
  assert.deepEqual(merged.platforms.xiaohongshu.publishedList, [{ title: '早上那篇', at: '10-27' }])
  assert.deepEqual(merged.platforms.douyin.publishedList, [{ title: '早上那条', at: '10-27' }])
})

test('本轮没涉及的平台原样保留', () => {
  const merged = mergeSnapshot(prevDoc(), freshDoc())
  assert.deepEqual(merged.platforms.kuaishou, { publishedList: [{ title: '快手' }] })
})

test('某平台本轮挂了（读数字段全空）时，留旧读数不留空', () => {
  const failed = freshDoc()
  failed.platforms.douyin = { nickname: null, followers: null, metrics: {}, daily: null, notes: [] }
  failed.errors = { douyin: '人工停止，该平台本轮没跑' }
  const merged = mergeSnapshot(prevDoc(), failed)
  assert.equal(merged.platforms.douyin.followers, 359)
  assert.equal(merged.platforms.douyin.daily.length, 1)
  assert.equal(merged.platforms.douyin.daily[0].d, '10-26')
  assert.equal(merged.errors.douyin, '人工停止，该平台本轮没跑')
  assert.equal(merged.errors.mp, '发表记录返回 0 条', '别的平台的旧错误记录别被清掉')
})

test('合并结果不改动两份输入，也不与它们共用对象', () => {
  const prev = prevDoc()
  const fresh = freshDoc()
  const prevBefore = structuredClone(prev)
  const freshBefore = structuredClone(fresh)
  const merged = mergeSnapshot(prev, fresh)
  assert.deepEqual(prev, prevBefore, '当天文件那份不能被改写')
  assert.deepEqual(fresh, freshBefore, '本轮采集结果那份不能被改写——旧 bug 正是把旧块写回了 result.platforms')
  merged.platforms.xiaohongshu.followers = 999
  merged.platforms.douyin.daily.push({ d: '脏', v: 0 })
  assert.equal(fresh.platforms.xiaohongshu.followers, 62)
  assert.equal(prev.platforms.douyin.daily.length, 1)
})

test('当天还没有快照时直接落本轮结果', () => {
  const merged = mergeSnapshot(null, freshDoc())
  assert.equal(merged.platforms.xiaohongshu.daily[0].d, '10-27')
  assert.equal(merged.collectedAt, '2026-10-28T13:47:00.000Z')
  assert.equal(merged.publishedListAt, undefined)
})

test('空值判定：null、空数组、空对象都算本轮没拿到', () => {
  assert.ok(isBlank(null))
  assert.ok(isBlank(undefined))
  assert.ok(isBlank([]))
  assert.ok(isBlank({}))
  assert.ok(!isBlank(0))
  assert.ok(!isBlank(''))
  assert.ok(!isBlank([1]))
})
