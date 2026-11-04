import test from 'node:test'
import assert from 'node:assert/strict'
import { toCount, heatScore, hasHeatData } from './viral-heat-core.mjs'

test('平台计数串折成数字：万/千/裸数/脏值', () => {
  assert.equal(toCount('1.2万'), 12000)
  assert.equal(toCount('3.5千'), 3500)
  assert.equal(toCount('2314'), 2314)
  assert.equal(toCount('72.5w'), 725000)
  assert.equal(toCount(''), 0)
  assert.equal(toCount('点赞'), 0)
  assert.equal(toCount(null), 0)
})

test('互动分按赞1藏2评3加权：评论比点赞贵', () => {
  assert.equal(heatScore({ likes: '100', collects: '100', comments: '100' }), 600)
  // 同赞不同评论：评论区吵起来的那条排前面
  assert.ok(heatScore({ likes: '1万', comments: '2000' }) > heatScore({ likes: '1万', collects: '2000' }))
})

test('一个读数都没采到时 heat 为 0 且 hasHeatData 为假：0 是「没证据」不是「不火」', () => {
  assert.equal(heatScore({}), 0)
  assert.equal(hasHeatData({}), false)
  assert.equal(hasHeatData({ likes: '1万' }), true)
  assert.equal(hasHeatData({ likes: '', collects: '', comments: '3' }), true)
})
