import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditLeaks, demoProduct } from './demo-data-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 一份最小的假产物：该漏的东西一样不缺——没发布的稿、第二个号的真人名、后台地址、脚本路径、定位全文 */
const fake = () => ({
  target: { brandName: '醒醒老己', positioning: '# 账号定位\n\n「地球 Online」的创造者。' },
  articles: [
    {
      id: 'a1', title: '已发过的那篇', file: '发布排期/小红书/已发布/2026-10-20-a1.md', status: 'published',
      account: '小红书', body: '正文', lesson: '这篇教会了我们什么', source: 'content/Inbox/爆款采集/x.md',
      card: { slug: 'a1', urls: ['/cards/a1/01.png'], images: ['/Users/ethan/x/public/cards/a1/01.png'], jsonRel: 'content/Projects/卡片/a1.json' },
    },
    { id: 'a2', title: '还没发的那篇', file: '发布排期/小红书/待发布/a2.md', status: 'ready', account: '小红书' },
    { id: 'a3', title: '抖音那篇也发过', file: '发布排期/抖音/已发布/2026-10-21-a3.md', status: 'published', account: '抖音', body: '正文' },
  ],
  accounts: [
    { id: '小红书', platform: '小红书', key: 'xiaohongshu', nickname: '醒醒老己', backend: 'https://creator.xiaohongshu.com', script: 'scripts/publish-xhs.mjs' },
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '醒醒老己', backend: 'https://creator.douyin.com' },
    { id: '抖音-晓丸子君', platform: '抖音', key: 'douyin-2', nickname: '晓丸子君', backend: 'https://creator.douyin.com' },
  ],
  snapshots: [{ date: '2026-10-20', platforms: { xiaohongshu: { nickname: '醒醒老己', followers: 31 } } }],
  productProfiles: [{ name: '醒醒老己小程序', entry: '微信搜「醒醒老己」', screens: [{ path: 'public/shots/home.png', label: '首页' }], target: 'xingxing.mjs', _entry出处: '口述' }],
  viral: [{ id: 'v1', title: '别人的爆款', author: '别人的博主名', file: 'Inbox/爆款采集/xiaohongshu/v1.md' }],
  benchmarks: [{ id: 'b1', nickname: '对标的真人', platform: 'douyin' }],
  knowledge: [{ file: 'Knowledge/创作规范.md', title: '创作规范', intro: [{ t: 'p', text: '本页是本仓唯一的方法源，逐条照着做。' }] }],
  site: { contentRoot: '/Users/ethan/content', llm: { baseUrl: 'https://dashscope.example/api', keyPath: '~/.config/llm.yml' } },
})

/** 演示站的每一站都要有东西可看：这几张表空着就等于那一站没做 */
test('站一站不少：收集、选题、创作、产品、知识库都摆上示例数据', () => {
  const { demo } = demoProduct(fake())
  for (const key of ['readings', 'viral', 'benchmarks', 'topics', 'quotes', 'knowledge', 'playbooks', 'collectRuns']) {
    assert.ok(demo[key].length, `${key} 不该空着`)
  }
  assert.ok(Object.keys(demo.loginState.platforms).length)
  assert.ok(demo.viralConfig.keywords.length)
})

test('示例数据一眼就是示例：标题与账号名都带「示例」', () => {
  const { demo } = demoProduct(fake())
  assert.ok(demo.readings.every((r) => r.title.startsWith('示例')))
  assert.ok(demo.viral.every((v) => v.title.startsWith('示例')))
  assert.ok(demo.topics.every((t) => t.title.startsWith('示例')))
  assert.ok(demo.benchmarks.every((b) => b.nickname.startsWith('示例账号')))
  assert.ok(demo.knowledge.every((k) => k.title.startsWith('示例')))
  // 演示数据里凡是写正文的地方都挂着「（演示数据）」，没人会把示例读成实绩
  assert.ok(demo.readings.every((r) => r.excerpt.includes('演示数据')))
  assert.ok(demo.topics.every((t) => t.judge.includes('演示数据')))
})

test('创作台不空一屏：一条待推、一条已进草稿箱，选题库与历史的回链接得上', () => {
  const { demo } = demoProduct(fake())
  const [one, two] = ['demo-draft-1', 'demo-draft-2'].map((id) => demo.articles.find((a) => a.id === id))
  assert.ok(one && two, '演示站要有两条示例稿：创作台三个档各摆一样')
  assert.equal(one.publishedPlatforms.length, 0)
  // 没推的这条排今天，进「待推草稿」；推过的排明天，同时进「待发布」和「已排期」
  assert.deepEqual(Object.keys(one.draftPushed), [])
  assert.deepEqual(Object.keys(two.draftPushed), [two.account])
  assert.ok(two.date > one.date)
  assert.notEqual(one.title, two.title, '两条稿要各搬一篇：同题会在日历上排成两格一样的字')
  // 版本名 = 文件名剥掉日期前缀，它必须等于选题卡 id，创作台才认这一组
  const keys = [one, two].map((a) => a.file.split('/').pop().replace(/\.md$/, ''))
  assert.equal(new Set(keys).size, 2, '两条稿各占一条选题，才会分成两张卡')
  for (const key of keys) assert.ok(demo.topics.some((t) => t.id === key))
  // 「历史」站按 content/<采集卡路径> 回认来源卡
  const sources = [...demo.viral, ...demo.readings].map((c) => `content/${c.file}`)
  assert.ok(demo.topics.every((t) => sources.includes(t.sourceFile)))
})

test('演示站只搬已发布的真稿子，没发的那篇连标题都不出门', () => {
  const { demo } = demoProduct(fake())
  assert.equal(JSON.stringify(demo).includes('还没发的那篇'), false)
  assert.deepEqual(demo.articles.filter((a) => !a.id.startsWith('demo-')).map((a) => a.id), ['a1', 'a3'])
})

test('真账号、后台地址、脚本路径、别人的爆款与知识库原文一律不带', () => {
  const { demo, body, leaks } = demoProduct(fake())
  assert.deepEqual(leaks, [])
  assert.equal(body.includes('晓丸子君'), false)
  assert.equal(body.includes('creator.douyin.com'), false)
  assert.equal(body.includes('publish-xhs.mjs'), false)
  assert.equal(body.includes('jsonRel'), false)
  assert.equal(body.includes('account-cookies'), false)
  assert.equal(body.includes('别人的博主名'), false)
  assert.equal(body.includes('对标的真人'), false)
  assert.equal(body.includes('本页是本仓唯一的方法源'), false)
  assert.equal(body.includes('dashscope.example'), false)
  // 本机绝对路径换成公开地址：图卡搬得走，路径不跟着出门
  assert.equal(body.includes('/Users/'), false)
  assert.deepEqual(demo.articles[0].card, { slug: 'a1', urls: ['/cards/a1/01.png'] })
  // 同平台两个号只留一行，昵称统一示例号
  assert.deepEqual(demo.accounts.map((a) => a.platform), ['小红书', '抖音'])
  assert.ok(demo.accounts.every((a) => a.nickname === '示例号'))
  assert.equal(demo.snapshots[0].platforms.xiaohongshu.nickname, '示例号')
  // 定位全文与产品档案的内部字段留在家里（截图是对外那一面，跟着档案出门）
  assert.equal(demo.target.positioning, '')
  assert.deepEqual(Object.keys(demo.productProfiles[0]), ['name', 'entry', 'screens'])
})

test('资源按引用收：产物点到哪个文件才搬哪个', () => {
  const { referenced } = demoProduct(fake())
  // 图卡写的是 /cards/…，档案截图写的是 public/shots/…：两种都得归成浏览器请求的那个地址
  assert.deepEqual([...referenced].sort(), ['/cards/a1/01.png', '/shots/home.png'])
})

test('自查真拦得住：白名单哪天漏了字段，auditLeaks 当场报', () => {
  const raw = fake()
  assert.deepEqual(auditLeaks(raw, demoProduct(raw).demo), [])
  // 模拟一次误带：以后给 accounts 加回 backend，这条就是红的
  const bad = { ...demoProduct(raw).demo, accounts: [{ ...raw.accounts[2] }] }
  assert.ok(auditLeaks(raw, bad).length >= 2)
})

test('拿真产物跑一遍：白名单挡不住新字段时这里先红', { skip: !existsSync(join(ROOT, 'src/data/generated.json')) }, () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'src/data/generated.json'), 'utf8'))
  const { demo, body, leaks } = demoProduct(raw)
  assert.deepEqual(leaks, [], `演示产物里还有不该出门的字段：${leaks.join('、')}`)
  assert.ok(demo.articles.filter((a) => !a.id.startsWith('demo-')).every((a) => a.status === 'published'))
  assert.equal(body.includes('晓丸子'), false)
  assert.equal(body.includes('"backend"'), false)
})
