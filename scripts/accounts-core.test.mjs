import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planAccount, addAccount, renameAccount, readAccounts, platformTemplates } from './accounts-core.mjs'

const TEMPLATES = [
  { platform: '抖音', key: 'douyin', script: './scripts/publish-douyin.mjs', backend: 'https://creator.douyin.com/x', note: '图文单槽覆盖' },
  { platform: '视频号', key: 'sph', script: './scripts/publish-sph.mjs', backend: 'https://channels.weixin.qq.com/x', quickLogin: '微信快捷登录', note: '只存草稿箱' },
]

function fixture(accounts = []) {
  const root = join(tmpdir(), `accounts-${Math.random().toString(36).slice(2)}`)
  const w = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  w('config/platforms.json', JSON.stringify({ platforms: TEMPLATES }))
  w('config/accounts.json', JSON.stringify(accounts))
  w('scripts/publish-douyin.mjs', '')
  w('scripts/publish-sph.mjs', '')
  return root
}
const plan = (root, platform, nickname) =>
  planAccount({ templates: platformTemplates(root), list: readAccounts(root), platform, nickname })

test('一个平台的第一个号沿用旧口径：id 就是平台名，key 就是模板键', () => {
  const e = plan(fixture(), '抖音', '醒醒老己')
  assert.deepEqual(
    e,
    { id: '抖音', platform: '抖音', key: 'douyin', script: './scripts/publish-douyin.mjs', backend: 'https://creator.douyin.com/x', nickname: '醒醒老己', note: '图文单槽覆盖' },
  )
})

test('同平台第二个号：id 带昵称、key 往后排，形态说明照抄模板', () => {
  const root = fixture([{ id: '抖音', platform: '抖音', key: 'douyin', nickname: '醒醒老己' }])
  const e = plan(root, '抖音', '成长号')
  assert.equal(e.id, '抖音-成长号')
  assert.equal(e.key, 'douyin-2')
  assert.equal(e.note, '图文单槽覆盖')
})

test('昵称撞了已有账号就往后排，不许写出两条同 id 的登记', () => {
  const root = fixture([
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '醒醒老己' },
    { id: '抖音-成长号', platform: '抖音', key: 'douyin-2', nickname: '成长号' },
  ])
  const e = plan(root, '抖音', '成长号')
  assert.equal(e.id, '抖音-成长号-2')
  assert.equal(e.key, 'douyin-3')
})

test('带斜杠的昵称不会写出一个目录名外的账号 id', () => {
  const root = fixture([{ id: '抖音', platform: '抖音', key: 'douyin', nickname: '醒醒老己' }])
  const e = plan(root, '抖音', 'A/B 号')
  assert.equal(e.id, '抖音-AB号')
  assert.equal(e.nickname, 'A/B 号')
})

test('有快捷登录按钮的平台照模板带上，界面据此多给一个按钮', () => {
  const e = plan(fixture(), '视频号', '醒醒老己')
  assert.equal(e.quickLogin, '微信快捷登录')
})

test('昵称留空直接拒：宁可报错，不许落一条「未登记昵称」的空位', () => {
  assert.throws(() => plan(fixture(), '抖音', '   '), /昵称要填/)
  assert.throws(() => plan(fixture(), '快手', '醒醒老己'), /还没有平台模板/)
})

test('改名只动昵称：id/key 是目录名、快照桶与登录态库文件名，动了就断链', () => {
  const root = fixture([{ id: '抖音', platform: '抖音', key: 'douyin', nickname: '旧名' }])
  addAccount({ platform: '抖音', nickname: '第二个号' }, root)
  const r = renameAccount({ id: '抖音-第二个号', nickname: '真正的昵称' }, root)
  assert.equal(r.nickname, '真正的昵称')
  assert.equal(r.id, '抖音-第二个号')
  assert.equal(r.key, 'douyin-2')
  const onDisk = JSON.parse(readFileSync(join(root, 'config/accounts.json'), 'utf8'))
  assert.deepEqual(onDisk.map((a) => a.nickname), ['旧名', '真正的昵称'])
})

test('落盘是整表重写：老条目一个字段都不掉', () => {
  const root = fixture([{ id: '小红书', platform: '小红书', key: 'xiaohongshu', nickname: '醒醒老己', note: '号 510414382' }])
  writeFileSync(join(root, 'config/platforms.json'), JSON.stringify({ platforms: [...TEMPLATES, { platform: '小红书', key: 'xiaohongshu', script: './scripts/publish-xhs.mjs', backend: 'b' }] }))
  addAccount({ platform: '抖音', nickname: '醒醒老己' }, root)
  const list = readAccounts(root)
  assert.equal(list.length, 2)
  assert.equal(list[0].note, '号 510414382')
  assert.equal(list[1].id, '抖音')
})

/** profile 概念已退役（2026-10-23）：同平台多号靠本机按号存 cookie 隔离，
 *  不再要人在 Ego Lite 界面里建一只浏览器。这里钉住「新登记里不许再长出 profile 字段」。 */
test('新登记的号不带 profile / profileId：多号不靠浏览器 profile 隔离', () => {
  const root = fixture([{ id: '抖音', platform: '抖音', key: 'douyin', nickname: '醒醒老己' }])
  const second = addAccount({ platform: '抖音', nickname: '成长号' }, root)
  assert.equal(second.profileId, undefined)
  assert.equal(second.profile, undefined)
  assert.deepEqual(Object.keys(second).sort(), ['backend', 'id', 'key', 'nickname', 'note', 'platform', 'script'])
})
