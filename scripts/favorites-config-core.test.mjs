import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planFavoritesConfig, writeFavoritesConfig, readFavoritesConfig } from './favorites-config-core.mjs'

const BASE = {
  _说明: '搬运口径',
  albums: ['灵感库'],
  xiaohongshuUserId: '5cc32828000000001203745e',
  maxScrollRounds: 30,
  platforms: ['xiaohongshu', 'douyin'],
}

function fixture(cfg = BASE) {
  const root = join(tmpdir(), `favorites-config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config/favorites.json'), `${JSON.stringify(cfg, null, 2)}\n`)
  return root
}

test('正常提交：只带回可编辑字段，注释键与换号配置原样留着', () => {
  const root = fixture()
  const v = planFavoritesConfig({ albums: ['灵感库', ' 厨艺 ', '厨艺'] }, root)
  assert.deepEqual(v.albums, ['灵感库', '厨艺'])
  assert.equal(v._说明, undefined)
  writeFavoritesConfig({ albums: v.albums }, root)
  const after = readFavoritesConfig(root)
  assert.deepEqual(after.albums, ['灵感库', '厨艺'])
  assert.equal(after.maxScrollRounds, 30)
  assert.equal(after.xiaohongshuUserId, '5cc32828000000001203745e')
  assert.equal(after._说明, '搬运口径')
})

test('名单清空直接拒：没有专辑名等于整表又搬回来了', () => {
  const root = fixture()
  assert.throws(() => planFavoritesConfig({ albums: [] }, root), /专辑至少要留一个/)
  assert.throws(() => planFavoritesConfig({ albums: ['  ', ''] }, root), /专辑至少要留一个/)
})

test('白名单外的平台直接拒', () => {
  const root = fixture()
  assert.throws(() => planFavoritesConfig({ platforms: ['kuaishou'] }, root), /还不支持搬运：kuaishou/)
  assert.throws(() => planFavoritesConfig({ platforms: [] }, root), /采集平台至少要留一个/)
})

test('专辑超过 20 个拒掉：翻不完的名单等于没写', () => {
  const root = fixture()
  assert.throws(() => planFavoritesConfig({ albums: Array.from({ length: 21 }, (_, i) => `专辑${i}`) }, root), /最多 20 个/)
})
