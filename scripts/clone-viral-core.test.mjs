import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findUnverifiedClaims, planClone, writeClone } from './clone-viral-core.mjs'

/** 造一份隔离仓库：只把克隆要读的三张配置和一张采集卡复制进去，别拿真内容试写。
 *  brand 非空时：产品清单里追加第二个品牌（排在「醒醒老己」之后），采集卡上多一行「归属品牌：<brand>」——
 *  用来验 planClone 真按卡上那一行取数，而不是落到 products[0] 兜底。 */
function fixture({ script = '## 脚本（拆解与创作的唯一材料）\n第一条：把手机放到看不见的地方。\n第二条：给自己一个 25 分钟的开局。', analysis = true, brand = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clone-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'content/Inbox/爆款采集/xiaohongshu'), { recursive: true })
  mkdirSync(join(root, 'content/Projects/选题池'), { recursive: true })
  mkdirSync(join(root, 'content/Projects/发布排期/小红书/待发布'), { recursive: true })
  writeFileSync(join(root, 'config/accounts.json'), JSON.stringify([{ id: '小红书', platform: '小红书', key: 'xhs', nickname: '醒醒老己' }]))
  const products = [{ name: '醒醒老己', kind: '微信小程序', status: '已上架', oneLiner: '24 道题叫醒自己', facts: ['24 道题', '约 5 分钟', '8 种生命力状态'] }]
  if (brand) products.push({ name: brand, kind: '微信小程序', status: '已上架', oneLiner: '品牌行取数专用档案', facts: ['24 道题', '约 5 分钟', '8 种生命力状态'] })
  writeFileSync(join(root, 'config/products.json'), JSON.stringify({ products }))
  writeFileSync(join(root, 'content/Inbox/爆款采集/xiaohongshu/abc.md'), [
    '---', 'title: "生活无聊怎么办？？？"', 'platform: 小红书',
    analysis ? 'analysis:\n  subject: "编号清单卡片"\n  hook: "封面第一句最狠"\n  structure: "顶部横幅＋编号条目"\n  emotion: "给掌控感"\n  mechanism: "一个可当场执行的动作"\nanalyzedAt: 2026-09-23' : '',
    '---', '', '# 生活无聊怎么办？？？', '', brand ? `- 归属品牌：${brand}` : '', script, '',
  ].filter(Boolean).join('\n'))
  return root
}

/** 三段模型输出一次给全：按调用顺序返回，跑不出顺序就是内核串了段 */
function fakeChat(responses) {
  const calls = []
  const chat = async ({ system, user }) => { calls.push({ system, user }); return responses.shift() }
  chat.calls = calls
  return chat
}

const STRUCTURE = JSON.stringify({
  hook: '第一句就把读者的处境说破', audience: '下班后不知道自己怎么了的人群', pain: '不是累，是提不起劲',
  beats: [{ role: '开场', move: '说出一个对方没说出口的处境', why: '被说中才会往下看' }, { role: '给动作', move: '一个当场能做的最小动作', why: '可执行才有收藏价值' }],
  turn: '从抱怨转到动手', evidence: '亲历', cta: '评论区留一句',
})
const MAPPING = JSON.stringify({
  angle: '用我自己的小程序把这一步做实', avoid: '对方的原句和截图',
  beats: [{ role: '开场', mine: '写我上周三晚上的那次', need: '' }, { role: '给动作', mine: '引到小程序的 24 道题', need: '真实使用人数' }],
})
const VERSIONS = JSON.stringify({
  title: '晚上十点还醒着的，进来', coverText: '晚上十点\n还醒着的进来', shortCopy: '一个 5 分钟的开局',
  body: ['上周三我十一点还在刷手机。', '后来我只做一件事：打开小程序答 24 道题。', '约 5 分钟就能把自己叫醒。'],
  tags: ['#自我管理'], firstComment: '你一般几点睡？', cta: '想试的从评论区开始',
  video: { shots: [{ sec: 4, visual: '手机屏幕', voice: '晚上十点你还醒着吗', subtitle: '晚上十点' }], voiceover: '晚上十点你还醒着吗，我给你一个 5 分钟的开局。', outro: '评论区见' },
})

test('缺脚本的采集卡不跑模型，直接要人先补采', async () => {
  const { root } = (() => ({ root: fixture({ script: '' }) }))()
  const chat = fakeChat([])
  const r = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书' }, { root, chat })
  assert.equal(r.ok, false)
  assert.match(r.error, /补采脚本/)
  assert.equal(chat.calls.length, 0)
})

test('未知账号不白跑模型', async () => {
  const root = fixture()
  const r = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '不存在号' }, { root, chat: fakeChat([]) })
  assert.equal(r.ok, false)
  assert.match(r.error, /未知账号/)
})

test('三段跑完出可预览计划，映射步骤数对不上就报错', async () => {
  const root = fixture()
  const ok = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书', form: 'both' }, { root, chat: fakeChat([STRUCTURE, MAPPING, VERSIONS]) })
  assert.equal(ok.ok, true, ok.errors?.join('\n'))
  assert.equal(ok.structure.beats.length, 2)
  assert.equal(ok.versions.image.body.length, 3)
  assert.equal(ok.versions.video.shots.length, 1)
  assert.deepEqual(ok.gates.needFacts, ['真实使用人数'])

  const bad = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书' }, {
    root, chat: fakeChat([STRUCTURE, JSON.stringify({ angle: 'x', beats: [{ role: '开场', mine: '只给一步' }], avoid: '' }), VERSIONS]),
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /步骤数和骨架对不上/)
})

test('采集卡上写了「归属品牌」就按那一行取数：不落到产品清单第一条兜底', async () => {
  const root = fixture({ brand: '夜跑打卡小程序' })
  const plan = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书' }, { root, chat: fakeChat([STRUCTURE, MAPPING, VERSIONS]) })
  assert.equal(plan.ok, true, plan.errors?.join('\n'))
  // 正则读不到这一行时 want 为空，会回落 products[0]（醒醒老己）——取名必须落在卡上那个品牌
  assert.equal(plan.product.name, '夜跑打卡小程序')
  const w = writeClone(plan, { root })
  assert.equal(w.ok, true, w.error)
  assert.match(readFileSync(join(root, w.topicRel), 'utf8'), /^- 归属品牌：夜跑打卡小程序$/m)
  assert.match(readFileSync(join(root, w.draftRel), 'utf8'), /^- 归属品牌：夜跑打卡小程序$/m)
})

test('档案里没有的数字效果说法拦住，存不进去', async () => {
  const root = fixture()
  const chat = fakeChat([STRUCTURE, MAPPING, JSON.stringify({
    ...JSON.parse(VERSIONS), body: ['我们帮 3000 个用户涨回了作息。'],
  })])
  const r = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书' }, { root, chat })
  assert.equal(r.ok, false)
  assert.equal(r.gates.unverifiedClaims.length, 1)
  assert.match(r.errors[0], /产品档案/)
  const w = writeClone(r, { root })
  assert.equal(w.ok, false)
  assert.deepEqual(readdirSync(join(root, 'content/Projects/选题池')), [])
  assert.deepEqual(readdirSync(join(root, 'content/Projects/发布排期/小红书/待发布')), [])
})

test('存进创作台：选题卡回链来源，稿里正文/配文/标签/首评都填上，采集卡打转化标记', async () => {
  const root = fixture()
  const plan = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书', form: 'both' }, { root, chat: fakeChat([STRUCTURE, MAPPING, VERSIONS]) })
  const w = writeClone(plan, { root })
  assert.equal(w.ok, true, w.error)

  const topic = readFileSync(join(root, w.topicRel), 'utf8')
  assert.match(topic, /- 来源文件：content\/Inbox\/爆款采集\/xiaohongshu\/abc\.md/)
  assert.match(topic, /- 归属品牌：醒醒老己/)

  const draft = readFileSync(join(root, w.draftRel), 'utf8')
  assert.match(draft, /## 备忘录正文\n上周三我十一点还在刷手机。/)
  assert.match(draft, /### 分镜\n\n1\. 4s｜手机屏幕｜晚上十点你还醒着吗/)
  assert.match(draft, /### 口播全文\n\n晚上十点你还醒着吗/)
  assert.match(draft, /## 话题标签\n#自我管理/)
  assert.match(draft, /## 首评引导\n你一般几点睡？/)
  assert.match(draft, /- 开头类型：第一句就把读者的处境说破/)
  assert.match(draft, /- 灵感来源：生活无聊怎么办？？？（克隆结构）/)

  const card = readFileSync(join(root, 'content/Inbox/爆款采集/xiaohongshu/abc.md'), 'utf8')
  assert.match(card, /^convertedToTopic: \d{4}-\d{2}-\d{2}$/m)
})

test('重复保存不覆盖已有稿，报得清楚', async () => {
  const root = fixture()
  const plan = await planClone({ file: 'content/Inbox/爆款采集/xiaohongshu/abc.md', account: '小红书' }, { root, chat: fakeChat([STRUCTURE, MAPPING, VERSIONS]) })
  assert.equal(writeClone(plan, { root }).ok, true)
  const again = writeClone(plan, { root })
  assert.equal(again.ok, false)
  assert.match(again.error, /已有同名/)
})

test('带数字但档案里有出处的说法不算违规', () => {
  const facts = '24 道题\n约 5 分钟\n8 种生命力状态'
  assert.deepEqual(findUnverifiedClaims('打开小程序答 24 道题，约 5 分钟就能把自己叫醒。', facts), [])
  assert.equal(findUnverifiedClaims('我们靠它变现 12 万元。', facts).length, 1)
})
