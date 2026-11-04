import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDay, shiftDay } from './day-core.mjs'

test('localDay 用墙上那天的日期：凌晨那几趟不再算到前一天', () => {
  // 本机时区的 00:30——toISOString 在 UTC+8 会给出前一天，这正是快照桶错日的成因
  const justAfterMidnight = new Date(2026, 9, 29, 0, 30, 0)
  assert.equal(localDay(justAfterMidnight), '2026-10-29')
  assert.equal(localDay(justAfterMidnight.getTime()), '2026-10-29', '毫秒数也要接得住')
})

test('localDay 与浏览器/系统给的本地日一致（换时区也不破）', () => {
  for (const d of [new Date(), new Date(2026, 0, 1, 23, 59), new Date(2026, 6, 15, 7, 40)]) {
    assert.equal(localDay(d), d.toLocaleDateString('en-CA'))
  }
})

test('shiftDay 是纯日历加减：不退回一天，也不受时区影响', () => {
  // 旧写法 new Date(`${iso}T00:00:00`).toISOString().slice(0,10) 在东八区把这天判成前一天，
  // 于是「发布不早于排期日 7 天前」实际放宽成了 8 天
  assert.equal(shiftDay('2026-10-28', 0), '2026-10-28')
  assert.equal(shiftDay('2026-10-28', -7), '2026-10-21')
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01', '跨年')
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28', '平年 2 月')
  assert.equal(shiftDay('2028-02-28', 1), '2028-02-29', '闰年 2 月')
  assert.equal(shiftDay(localDay(), 0), localDay(), '今天加减零还是今天')
})

test('shiftDay 认得带时刻的串：只截前面那十位', () => {
  assert.equal(shiftDay('2026-10-28T13:45:00.000Z', 1), '2026-10-29')
})
