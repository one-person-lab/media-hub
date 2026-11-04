import test from 'node:test'
import assert from 'node:assert/strict'
import { TARGET_TYPES, targetUi, makeTarget } from '../config/promotion-target.mjs'

test('每类都带界面描述符：素材槽、那一行怎么问、状态词一样不缺', () => {
  for (const [key, t] of Object.entries(TARGET_TYPES)) {
    assert.ok(Array.isArray(t.slots) && t.slots.length, `${key} 缺素材槽`)
    for (const s of t.slots) {
      assert.ok(s.key && s.label && s.ratio, `${key} 的素材槽不完整：${JSON.stringify(s)}`)
      assert.match(s.ratio, /^\d+\/\d+$/, `${key}/${s.key} 的比例要写成 宽/高`)
    }
    assert.ok(t.entryLabel, `${key} 缺「那一行怎么问」`)
    assert.ok(Array.isArray(t.statuses), `${key} 缺状态词表`)
  }
})

test('门店是独立一类，状态词不是软件那套', () => {
  const store = TARGET_TYPES.store
  assert.equal(store.label, '门店')
  assert.deepEqual(store.statuses, ['营业中', '试营业', '已歇业'])
  assert.equal(store.entryLabel, '到店')
  assert.ok(store.slots.some((s) => s.label === '门头照'))
})

test('targetUi 与注册表同源，且不把转化指标漏给界面', () => {
  const ui = targetUi()
  assert.deepEqual(ui.map((u) => u.key), Object.keys(TARGET_TYPES))
  for (const u of ui) {
    assert.deepEqual(Object.keys(u).sort(), ['entryHint', 'entryLabel', 'key', 'label', 'slots', 'statuses'])
  }
})

test('makeTarget 只带口径字段，界面描述符不会混进推广对象实例', () => {
  const t = makeTarget({ type: 'store', brandName: '甲·美甲工作室' })
  assert.equal(t.conversionGoalLabel, '到店 / 核销 / 复购')
  assert.equal(t.slots, undefined)
  assert.equal(t.statuses, undefined)
})
