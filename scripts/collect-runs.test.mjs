import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRun, appendRun, readRuns, isCollectionTask } from './collect-runs.mjs'
import { localDay } from './day-core.mjs'

const DAY = 86_400_000
const finished = Date.UTC(2026, 9, 21, 13, 54, 41)
const started = finished - 7 * 60_000
// 与 dayOf 同一把尺：卡片上的采集日期就按本机日历日盖
const day = localDay(finished)
/** 快照里那份读数落盘时间：留痕只认本轮写的 */
const at = new Date(finished).toISOString()

function fixture(files = {}) {
  const root = join(tmpdir(), `collect-runs-${Math.random().toString(36).slice(2)}`)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const run = (root, task, extra = {}) =>
  buildRun({ root, task, startedAt: started, finishedAt: finished, exitCode: 0, stopped: false, steps: {}, tail: '', ...extra })

test('collect 的逐平台结果从 metrics/raw 反推，不信自报', () => {
  const root = fixture({
    [`metrics/raw/${day}.json`]: JSON.stringify({
      collectedAt: at,
      platforms: {
        xiaohongshu: { followers: 1212, metrics: { 粉丝数量: '1212' }, daily: [{ date: day }] },
        douyin: { nickname: '醒醒老己', followers: null, metrics: {}, daily: [] },
      },
      errors: { douyin: '数据中心接口未捕获' },
    }),
  })
  const r = run(root, 'collect')
  assert.equal(r.counts.xiaohongshu, 1)
  assert.equal(r.platforms.xiaohongshu.state, 'ok')
  assert.equal(r.platforms.douyin.state, 'error')
  assert.deepEqual(r.failedPlatforms, ['douyin'])
  assert.equal(r.platforms.douyin.note, '数据中心接口未捕获')
})

test('publish-check 的空已发布列表是采到了 0 条，不是失败', () => {
  const root = fixture({
    [`metrics/raw/${day}.json`]: JSON.stringify({
      publishedListAt: at,
      platforms: { xiaohongshu: { publishedList: [] }, douyin: { publishedList: [1, 2] } },
    }),
  })
  const r = run(root, 'publish-check')
  assert.deepEqual(r.counts, { xiaohongshu: 0, douyin: 2 })
  assert.equal(r.platforms.xiaohongshu.state, 'ok')
  assert.deepEqual(r.failedPlatforms, [])
})

test('同一天补跑第二次砸了：昨夜那批卡是上一轮的产物，不能替本轮背书', () => {
  const card = (id) => `content/Inbox/采集笔记/收藏/小红书/${id}.md`
  const root = fixture({
    [card('a')]: `---\nnoteId: a\nplatform: 小红书\ncollected: ${day}\n---\n`,
    [card('b')]: `---\nnoteId: b\nplatform: 小红书\ncollected: ${day}\n---\n`,
  })
  // 把卡片落盘时间挪到本轮开始之前：模拟昨夜 cron 落的那批
  for (const id of ['a', 'b']) {
    const p = join(root, card(id))
    utimesSync(p, finished / 1000 - 3600, finished / 1000 - 3600)
  }
  const r = run(root, 'favorites', {
    exitCode: 1,
    steps: { xiaohongshu: { state: 'error', note: '没翻到收藏列表（登录态失效或被风控）' } },
  })
  assert.equal(r.platforms.xiaohongshu.state, 'error')
  assert.equal(r.platforms.xiaohongshu.count, 0)
  assert.deepEqual(r.failedPlatforms, ['xiaohongshu'])
})

test('快照的落盘时间早于本轮开始：读数是旧的，按没采到记', () => {
  const root = fixture({
    [`metrics/raw/${day}.json`]: JSON.stringify({
      collectedAt: new Date(started - 3 * 3600_000).toISOString(),
      platforms: { xiaohongshu: { followers: 1212, metrics: { 粉丝数量: '1212' }, daily: [] }, douyin: { followers: 9, daily: [] } },
    }),
  })
  const r = run(root, 'collect')
  assert.deepEqual(r.failedPlatforms, ['xiaohongshu', 'douyin'])
})

test('爆款/收藏按卡片入库日计数；自报失败但产物落了卡仍算 ok', () => {
  const card = (id, plat, field) =>
    `content/Inbox/采集笔记/收藏/${plat === 'xiaohongshu' ? '小红书' : '抖音'}/${id}.md`
  const root = fixture({
    [card('a', 'xiaohongshu')]: `---\nnoteId: a\nplatform: 小红书\ncollected: ${day}\n---\n`,
    [card('b', 'xiaohongshu')]: `---\nnoteId: b\nplatform: 小红书\ncollected: ${day}\n---\n`,
    [card('c', 'douyin')]: `---\nnoteId: c\nplatform: 抖音\ncollected: 2026-09-30\n---\n`,
  })
  const r = run(root, 'favorites', { exitCode: 2, steps: { douyin: { state: 'error', note: '没翻到收藏列表' } } })
  assert.deepEqual(r.counts, { xiaohongshu: 2, douyin: 0 })
  assert.equal(r.platforms.douyin.state, 'error')
  assert.equal(r.platforms.douyin.note, '没翻到收藏列表')
  assert.equal(r.partial, true)
  assert.equal(r.ok, false)
})

test('自报 ok 但产物一条没落，仍按空数据处理不冒充成功', () => {
  const root = fixture({})
  const r = run(root, 'viral', { steps: { douyin: { state: 'ok', count: 9 } } })
  assert.equal(r.platforms.douyin.state, 'ok')
  assert.equal(r.platforms.douyin.count, 0)
})

test('一个平台采到一个没采到：退 1 也按部分成功记，不整条判死', () => {
  const root = fixture({
    'content/Inbox/采集笔记/收藏/小红书/a.md': `---\nnoteId: a\nplatform: 小红书\ncollected: ${day}\n---\n`,
  })
  const r = run(root, 'favorites', {
    exitCode: 1,
    steps: {
      xiaohongshu: { state: 'ok' },
      douyin: { state: 'error', note: '主页没加载出收藏入口' },
    },
  })
  assert.equal(r.partial, true)
  assert.deepEqual(r.failedPlatforms, ['douyin'])
})

test('全部平台都没采到：才是真失败', () => {
  const r = run(fixture({}), 'favorites', {
    exitCode: 1,
    steps: { xiaohongshu: { state: 'error', note: '未登录' }, douyin: { state: 'error', note: '未登录' } },
  })
  assert.equal(r.partial, false)
  assert.equal(r.ok, false)
  assert.deepEqual(r.failedPlatforms, ['xiaohongshu', 'douyin'])
})

test('尾巴只留人话：进度行已经拆进逐平台结果，不该挤占兜底原因位', () => {
  const r = run(fixture({}), 'favorites', {
    exitCode: 1,
    tail: '[sync:step] {"task":"favorites","platform":"douyin","state":"error","note":"x"}\n[fav:抖音] 没翻到收藏列表（登录态失效或被风控）',
  })
  assert.ok(!r.tail.includes('[sync:step]'))
  assert.match(r.tail, /没翻到收藏列表/)
})

test('重采只跑失败平台：跳过的那个不算这轮的数', () => {
  const root = fixture({
    [`metrics/raw/${day}.json`]: JSON.stringify({
      platforms: {
        xiaohongshu: { followers: 1212, metrics: { 粉丝数量: '1212' }, daily: [] },
        douyin: { followers: null, metrics: {}, daily: [] },
      },
    }),
  })
  const r = run(root, 'collect', { steps: { xiaohongshu: { state: 'skip', note: '本轮只重采失败平台' } } })
  assert.deepEqual(Object.keys(r.platforms), ['douyin'])
  assert.deepEqual(r.failedPlatforms, ['douyin'])
})

test('人工停止 exit 3 记 stopped，不算成功', () => {
  const r = run(fixture({}), 'collect', { exitCode: 3, stopped: true })
  assert.equal(r.stopped, true)
  assert.equal(r.ok, false)
})

test('留痕只认采集类任务，追加走 tmp+rename 且封顶 200 条', () => {
  assert.equal(isCollectionTask('collect'), true)
  assert.equal(isCollectionTask('push'), false)
  const root = fixture({})
  const rec = (task) => run(root, task)
  appendRun(root, rec('collect'))
  for (let i = 0; i < 260; i++) appendRun(root, rec('viral'))
  const all = readRuns(root)
  assert.equal(all.length, 200)
  assert.equal(all[all.length - 1].task, 'viral')
  assert.match(readFileSync(join(root, 'metrics/collect-runs.json'), 'utf8'), /^\[/)
})
