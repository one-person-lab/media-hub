import test from 'node:test'
import assert from 'node:assert/strict'
import { guestData, guestStaticOk } from './guest-core.mjs'

/** 一份最小的真产物：号主的经营数、机器路径、没发布的稿子和真账号名一样不缺 */
const fake = () => ({
  target: { brandName: '醒醒老己', positioning: '# 账号定位\n\n「地球 Online」的创造者。', landing: 'https://x.app' },
  articles: [
    {
      id: 'a1', title: '已发过的那篇', file: '发布排期/小红书/已发布/2026-10-20-a1.md', status: 'published',
      account: '小红书', body: '真稿子的正文', lesson: '这篇教会了我们什么',
      card: { slug: 'a1', urls: ['/cards/a1/01.png'], images: ['/Users/ethan/x/public/cards/a1/01.png'] },
    },
    {
      id: 'a2', title: '还没发的那篇', file: '发布排期/小红书/待发布/a2.md', status: 'ready', account: '小红书',
      body: '正文', card: { slug: 'a2', urls: ['/cards/a2/01.png'] },
    },
  ],
  accounts: [
    { id: '小红书', platform: '小红书', key: 'xiaohongshu', nickname: '醒醒老己', backend: 'https://creator.xiaohongshu.com' },
    { id: '抖音', platform: '抖音', key: 'douyin', nickname: '醒醒老己' },
    { id: '抖音-晓丸子君', platform: '抖音', key: 'douyin-2', nickname: '晓丸子君' },
  ],
  snapshots: [{ date: '2026-10-20', platforms: { xiaohongshu: { nickname: '醒醒老己', followers: 31 } } }],
  goals: [{ id: 'plays', label: '播放', target: 100000 }],
  revenue: { months: [{ month: '2026-10', amount: 8600 }] },
  capabilities: { collect: { ok: true, script: 'scripts/viral-collect.mjs' } },
  knowledge: [{ file: 'Knowledge/创作规范.md', title: '创作规范', intro: [{ t: 'p', text: '本页是本仓唯一的方法源，逐条照着做。' }] }],
  productProfiles: [{ name: '醒醒老己小程序', entry: '微信搜「醒醒老己」', screens: [{ path: 'public/shots/home.png', label: '首页' }], target: 'xingxing.mjs' }],
  site: { contentRoot: '/Users/ethan/workspace/content', llm: { baseUrl: 'https://dashscope.example/api', keyPath: '~/.config/llm.yml' } },
})

test('游客那份不带号主的经营读数与这台机器的配置', () => {
  const { guest } = guestData(fake())
  assert.equal(guest.viewer, 'guest')
  assert.equal(guest.demo, true, '界面靠 demo 这一条把落地点换成看板并标明是演示')
  for (const key of ['snapshots', 'goals', 'revenue', 'capabilities']) {
    assert.equal(guest[key], undefined, `${key} 不该出现在游客产物里`)
  }
  const body = JSON.stringify(guest)
  // 品牌名是号主自己对外挂的，游客这一屏留着；第二个号的真昵称、机器路径、方法与正文私货都不留
  for (const needle of ['/Users/', 'contentRoot', 'dashscope.example', '~/.config/llm.yml', '晓丸子君', 'creator.xiaohongshu.com', '本页是本仓唯一的方法源', '这篇教会了我们什么', 'scripts/viral-collect.mjs']) {
    assert.ok(!body.includes(needle), `游客产物里读到了不该出门的东西：${needle}`)
  }
})

test('号主的稿子一篇都不进游客那一屏：连已发布也换成示例稿', () => {
  const { guest } = guestData(fake())
  assert.ok(guest.articles.length, '创作台与历史不能空着')
  assert.ok(guest.articles.every((a) => a.title.startsWith('示例')), '标题一律是示例的')
  assert.ok(guest.articles.every((a) => a.id !== 'a1' && a.id !== 'a2'))
  assert.ok(!JSON.stringify(guest).includes('真稿子的正文'))
  // 示例稿没有配图可引用，所以内容目录一个都不该给游客开
  assert.equal(guest.articles.some((a) => a.card), false)
})

test('站一站不少：游客那一屏照样有东西可逛', () => {
  const { guest, leaks } = guestData(fake())
  assert.deepEqual(leaks, [], '游客产物没过泄漏自查就别往下发')
  for (const key of ['topics', 'readings', 'viral', 'benchmarks', 'knowledge', 'playbooks']) {
    assert.ok(Array.isArray(guest[key]) && guest[key].length, `${key} 空着等于这一站没做`)
  }
})

test('静态层按引用放行：界面壳照常，内容目录只认引用清单', () => {
  const { referenced } = guestData(fake())
  for (const open of ['/assets/index-abc.js', '/favicon.svg', '/icons.svg', '/index.html', '/__capabilities']) {
    assert.ok(guestStaticOk(open, referenced), `${open} 是界面自己的文件，挡了页面就白屏`)
  }
  // 示例稿没有配图，所以卡片目录整个关门；档案截图是这一屏真请求的，引用了就得分开
  assert.ok(guestStaticOk('/shots/home.png', referenced), '产品页那张截图在引用清单里，挡了就是裂图')
  for (const blocked of ['/cards/a1/01.png', '/cards/a2/01.png', '/shots/secret.png', '/viral/小红书/x.jpg', '/inspiration/n/page-01.png', '/benchmarks/b/01.png']) {
    assert.ok(!guestStaticOk(blocked, referenced), `${blocked} 不是游客这一屏用到的文件`)
  }
  // 清单里有的才放得开（引用清单带前导斜杠，与产物 JSON 里写的地址一个写法）
  const withCard = new Set(['/cards/demo-1/01.png'])
  assert.ok(guestStaticOk('/cards/demo-1/01.png', withCard))
  assert.ok(guestStaticOk('cards/demo-1/01.png', withCard))
  assert.ok(!guestStaticOk('/cards/demo-1/02.png', withCard))
  assert.ok(!guestStaticOk('/cards/demo-1/01.png', new Set()))
  assert.ok(!guestStaticOk('/cards/demo-1/01.png', null))
})
