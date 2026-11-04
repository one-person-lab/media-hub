import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkItems } from './selfcheck.mjs'

const READY_BINS = () => Promise.resolve([
  { tool: 'ffmpeg', ready: true, version: 'ffmpeg version 6.0 Copyright (c) 2000-2023' },
  { tool: 'ffprobe', ready: true, version: 'ffprobe version 6.0' },
])

function fixture() {
  const root = join(tmpdir(), `selfcheck-${Math.random().toString(36).slice(2)}`)
  const w = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  w('src/data/generated.json', JSON.stringify({ topics: [1, 2], articles: [1], snapshots: [1] }))
  w('config/accounts.json', JSON.stringify([
    { platform: '小红书', key: 'xiaohongshu', script: './scripts/publish-xhs.mjs' },
  ]))
  w('scripts/publish-xhs.mjs', '')
  return { root, w }
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const day = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const byId = (r, id) => r.items.find((i) => i.id === id)

test('一份齐活的机器：全绿，推草稿那项只交人工', async () => {
  const { root, w } = fixture()
  w('metrics/login-state.json', JSON.stringify({ platforms: { 小红书: { state: 'ok', evidence: '10 条已发布', checkedAt: iso(60_000) } } }))
  w('content/Inbox/采集笔记/a.md', '---\ntitle: 测试卡\ncoverImage: /inspiration/n1.jpg\nsourceImages: n1\n---\n\n# 测试卡\n')
  w('public/inspiration/n1.jpg', 'x')
  w('public/inspiration/n1/page-01.png', 'x')
  w(`metrics/raw/${day(0)}.json`, JSON.stringify({ platforms: { xiaohongshu: { followers: 54, publishedList: [{ title: 'x' }] } } }))
  w(`content/Inbox/爆款采集/小红书/v1.md`, `---\nnoteId: v1\nplatform: xiaohongshu\ncapturedAt: ${day(0)}\n---\n\n# 卡\n`)
  w(`content/Inbox/采集笔记/收藏/小红书/f1.md`, `---\nnoteId: f1\nplatform: 小红书\ncollected: ${day(0)}\n---\n\n# 卡\n`)
  w(`content/Resources/对标账号/小红书/某号.md`, `---\nplatform: xiaohongshu\n---\n`)
  w('content/Projects/卡片/n1.json', JSON.stringify({ slug: 'n1', title: '测试图卡', pages: [{}, {}] }))
  w('public/cards/n1/01.png', 'x')
  w('public/cards/n1/02.png', 'x')

  const r = await checkItems({ root, data: { ok: true }, probe: { hasEgo: true, llmKey: 'k', bins: READY_BINS } })
  assert.ok(r.ok, JSON.stringify(r.items.filter((i) => i.state === 'missing')))
  assert.equal(byId(r, 'push').state, 'manual')
  assert.equal(byId(r, 'cards').detail, '最近一张「测试图卡」2/2 页')
})

test('采回来的东西缺封面就判半采，不许顶着一句「已采集」算过', async () => {
  const { root, w } = fixture()
  w('content/Inbox/采集笔记/a.md', '---\ntitle: 没封面的卡\nsourceImages: n2\n---\n')
  const r = await checkItems({ root, data: { ok: true }, probe: { hasEgo: true, llmKey: 'k', bins: READY_BINS } })
  const it = byId(r, 'collect')
  assert.equal(it.state, 'stale')
  assert.match(it.detail, /缺封面/)
  assert.match(it.next, /重新采集/)
})

test('登录读数超过 2 小时只判「旧」，不谎报成没登录', async () => {
  const { root, w } = fixture()
  w('metrics/login-state.json', JSON.stringify({ platforms: { 小红书: { state: 'ok', checkedAt: iso(3 * 3600_000) } } }))
  const r = await checkItems({ root, data: { ok: true }, probe: { hasEgo: true, llmKey: 'k', bins: READY_BINS } })
  const it = byId(r, 'login')
  assert.equal(it.state, 'stale')
  assert.match(it.detail, /读数超过 2 小时：小红书/)
  assert.doesNotMatch(it.detail, /要重新扫码/)
})

test('粉丝数只在旧快照里也有数：取那份的日期，不报假警报', async () => {
  const { root, w } = fixture()
  w(`metrics/raw/${day(0)}.json`, JSON.stringify({ platforms: { xiaohongshu: { publishedList: [{ title: 'x' }] } } }))
  w(`metrics/raw/${day(2)}.json`, JSON.stringify({ platforms: { xiaohongshu: { followers: 54 } } }))
  const r = await checkItems({ root, data: { ok: true }, probe: { hasEgo: true, llmKey: 'k', bins: READY_BINS } })
  assert.equal(byId(r, 'daily').state, 'ready')
  assert.match(byId(r, 'daily').detail, new RegExp(`${day(2)} 有 1 个平台`))
  assert.equal(byId(r, 'publish-list').state, 'ready')
})

test('数据层没重建成功：第一项就是红的，并说清去改哪', async () => {
  const { root } = fixture()
  const r = await checkItems({ root, data: { ok: false, error: 'R4 违规：某份稿子的账号目录未登记' }, probe: { hasEgo: true, llmKey: 'k', bins: READY_BINS } })
  assert.equal(byId(r, 'data').state, 'missing')
  assert.match(byId(r, 'data').detail, /R4 违规/)
  assert.equal(r.ok, false)
})

test('每一条「下一步」都是大白话：不出现命令、脚本名和路径', async () => {
  const { root } = fixture()
  const r = await checkItems({ root, data: { ok: true }, probe: { hasEgo: false, llmKey: '', bins: () => Promise.resolve([{ tool: 'ffmpeg', ready: false, reason: 'missing' }]) } })
  assert.ok(!r.ok)
  for (const i of r.items) {
    assert.doesNotMatch(`${i.next}${i.detail}`, /npm run|node |scripts\/|\.mjs|metrics\/|content\/|public\//, `${i.id} 的措辞漏了命令或路径`)
    if (i.next) assert.ok(i.next.length >= 8, `${i.id} 的下一步太短，等于没说`)
  }
})
