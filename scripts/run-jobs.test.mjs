import test from 'node:test'
import assert from 'node:assert/strict'
import { holdJob, runningJobs, stopJob, STOPPED_TEXT, __test } from './run-jobs.mjs'

const reset = () => __test.clear()
/** 一格现在的样子（没有则 undefined）：界面上的「已按停」全靠这一句 */
const slot = (id) => runningJobs().find((j) => j.id === id)

test('登记了才看得见，跑完松手就消失', () => {
  reset()
  const release = holdJob('render', { label: '图卡渲染', startedAt: 1000, stop: () => {} })
  assert.deepEqual(runningJobs(4000), [{ id: 'render', key: '', label: '图卡渲染', startedAt: 1000, limitMs: 0, elapsed: 3000, stopping: false }])
  release()
  assert.deepEqual(runningJobs(), [])
})

test('采集那一格要带得出真正在跑的任务键：界面按停时得把它递回服务端核对', () => {
  reset()
  holdJob('sync', { label: '收藏搬运', key: 'favorites', stop: () => {} })
  assert.equal(runningJobs()[0].key, 'favorites')
})

test('按停走登记时交出来的那条 stop', () => {
  reset()
  let killed = 0
  holdJob('gen', { label: '图文创作', stop: () => (killed += 1) })
  assert.deepEqual(stopJob('gen'), { ok: true, id: 'gen', label: '图文创作' })
  assert.equal(killed, 1)
})

test('按停的那一句人话记在这一格上，活儿收工松手就跟着没了', () => {
  reset()
  let stopped = ''
  const release = holdJob('push', { label: '推草稿', stop: (reason) => (stopped = reason) })
  stopJob('push')
  assert.equal(stopped, STOPPED_TEXT)
  assert.equal(slot('push').stopping, true)
  release()
  assert.equal(slot('push'), undefined)
})

test('没人在跑就说没人，不假装停成功', () => {
  reset()
  assert.equal(stopJob('push').ok, false)
  assert.match(stopJob('push').error, /没有在跑/)
})

test('stop 自己砸了要把原因带回来，界面上不能变成静默失败', () => {
  reset()
  holdJob('sync', { label: '爆款采集', key: 'viral', stop: () => { throw new Error('信号文件写不进去') } })
  const r = stopJob('sync')
  assert.equal(r.ok, false)
  assert.match(r.error, /信号文件写不进去/)
  // 没停成就不许留「有人按停」的记号，否则活儿会在自己砸了之后照停止退场
  assert.equal(slot('sync').stopping, false)
})

test('同一格只留最新那一笔：上一轮的 release 不能把这一轮的停掉', () => {
  reset()
  const first = holdJob('sync', { label: '爆款采集', key: 'viral', stop: () => {} })
  holdJob('sync', { label: '收藏搬运', key: 'favorites', stop: () => {} })
  first()
  assert.deepEqual(runningJobs().map((j) => j.label), ['收藏搬运'])
})
