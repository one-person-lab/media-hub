import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startSteps } from './start-guide.mjs'

function fixture() {
  const root = join(tmpdir(), `start-guide-${Math.random().toString(36).slice(2)}`)
  const w = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  w('config/accounts.json', JSON.stringify([
    { platform: '小红书', key: 'xiaohongshu', script: './scripts/publish-xhs.mjs' },
    { platform: '公众号', key: 'mp', script: './scripts/publish-mp.mjs' },
  ]))
  w('scripts/publish-xhs.mjs', '')
  w('scripts/publish-mp.mjs', '')
  return { root, w }
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const byId = (r, id) => r.steps.find((s) => s.id === id)

/** 一张采全的卡：封面、逐页原图、赞藏评三样都在（判据只认盘上文件） */
const fullCard = (w) => {
  w('content/Inbox/采集笔记/a.md', '---\ntitle: 测试卡\ncoverImage: /inspiration/n1.jpg\nsourceImages: n1\nnoteData:\n  likes: 1.2万\n  collects: 300\n  comments: 12\n---\n\n# 测试卡\n')
  w('public/inspiration/n1.jpg', 'x')
  w('public/inspiration/n1/01.png', 'x')
}

test('四步都过的机器：整体判过，并把「走通过」记在本机', async () => {
  const { root, w } = fixture()
  w('metrics/login-state.json', JSON.stringify({ platforms: { 小红书: { state: 'ok', checkedAt: iso(60_000) }, 公众号: { state: 'out', checkedAt: iso(60_000) } } }))
  fullCard(w)
  const r = await startSteps({ root, probe: { hasEgo: true } })
  assert.equal(r.ok, true, JSON.stringify(r.steps.filter((s) => s.state !== 'ready')))
  assert.equal(r.steps.length, 4)
  assert.equal(byId(r, 'login').state, 'ready')
  assert.equal(byId(r, 'login').detail, '已登录：小红书 · 要重新扫码：公众号') // 有一个号登着就放行，但掉的要照说
  assert.match(readFileSync(join(root, 'metrics/start-guide.json'), 'utf8'), /doneAt/)
})

test('没装执行器：第一步没过，并把人指回设置里的「本机」那一屏', async () => {
  const { root, w } = fixture()
  fullCard(w)
  const r = await startSteps({ root, probe: { hasEgo: false } })
  const s = byId(r, 'bin')
  assert.equal(s.state, 'todo')
  assert.equal(s.jump, 'machine')
  assert.match(s.next, /重新检查/)
  assert.equal(r.ok, false)
})

test('缺封面或没读数都算半采：第四步不判过，并说清缺哪样', async () => {
  const { root, w } = fixture()
  w('content/Inbox/采集笔记/a.md', '---\ntitle: 半条卡\nsourceImages: n2\nnoteData:\n  likes: 5\n---\n')
  const r = await startSteps({ root, probe: { hasEgo: true } })
  const s = byId(r, 'collect')
  assert.equal(s.state, 'todo')
  assert.match(s.detail, /缺封面/)
  assert.doesNotMatch(s.detail, /赞藏评/) // 读数在，就不重复报
})

test('登录读数全过期：判「还没登着」，不算过；同一原因只念一遍', async () => {
  const { root, w } = fixture()
  w('metrics/login-state.json', JSON.stringify({ platforms: { 小红书: { state: 'ok', checkedAt: iso(3 * 3600_000) }, 公众号: { state: 'ok', checkedAt: iso(3 * 3600_000) } } }))
  fullCard(w)
  const r = await startSteps({ root, probe: { hasEgo: true } })
  assert.equal(byId(r, 'login').state, 'todo')
  assert.equal(byId(r, 'login').detail, '读数超过 2 小时：小红书、公众号')
})

test('一个号都没登记：第二步红，第三步跟着说清为什么没得扫', async () => {
  const { root, w } = fixture()
  w('config/accounts.json', '[]')
  const r = await startSteps({ root, probe: { hasEgo: true } })
  assert.equal(byId(r, 'accounts').state, 'todo')
  assert.match(byId(r, 'login').detail, /先把号登记上/)
})

test('号登记的表缺发布脚本：判没过，点名缺哪个号', async () => {
  const { root, w } = fixture()
  w('config/accounts.json', JSON.stringify([{ platform: '快手', key: 'kuaishou', script: './scripts/publish-ks.mjs' }]))
  const r = await startSteps({ root, probe: { hasEgo: true } })
  assert.equal(byId(r, 'accounts').state, 'todo')
  assert.match(byId(r, 'accounts').detail, /缺发布脚本：快手/)
})

test('每一步的话都是大白话：不出现命令、脚本名和路径', async () => {
  const { root } = fixture()
  const r = await startSteps({ root, probe: { hasEgo: false } })
  for (const s of r.steps) {
    assert.doesNotMatch(`${s.next}${s.detail}`, /npm run|node |scripts\/|\.mjs|metrics\/|content\/|public\//, `${s.id} 的措辞漏了命令或路径`)
    if (s.next) assert.ok(s.next.length >= 8, `${s.id} 的下一步太短，等于没说`)
    assert.ok(['', 'machine', 'accounts'].includes(s.jump), `${s.id} 跳去了没登记的地方`)
  }
})
