import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleGate } from './server-core.mjs'

const NOW = Date.now()
const pad = (n) => String(n).padStart(2, '0')
/** 按本机时区拼「年-月-日 时:分」：scheduleGate 用本地时间读这串，测试也得按本地时间给 */
const fmt = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

test('直接发布不带时间，定时发布才校验', () => {
  assert.equal(scheduleGate('publish', '', NOW), '')
  assert.equal(scheduleGate('publish', fmt(NOW + 3600_000), NOW), '')
})

test('界面那颗日期控件的 T 归一成平台时间框里的空格', () => {
  const at = fmt(NOW + 3600_000)
  assert.equal(scheduleGate('schedule', at.replace(' ', 'T'), NOW), at)
})

test('格式不对、空值都挡在服务端', () => {
  for (const bad of ['2026-11-04 21:52:00', '11-04 21:52', '2026-11-04', '', '   ']) {
    assert.throws(() => scheduleGate('schedule', bad, NOW), /定时发布/, `「${bad}」本该挡下`)
  }
  assert.throws(() => scheduleGate('schedule', '2026-13-40 21:52', NOW), /读不出来/)
})

test('时间太近挡下：脚本跑到平台那边还要一会儿', () => {
  assert.throws(() => scheduleGate('schedule', fmt(NOW + 2 * 60_000), NOW), /留够 5 分钟/)
  assert.equal(scheduleGate('schedule', fmt(NOW + 20 * 60_000), NOW), fmt(NOW + 20 * 60_000))
})

test('发法只有两种，别的档位进不来', () => {
  assert.throws(() => scheduleGate('auto', fmt(NOW + 3600_000), NOW), /mode 只有/)
})
