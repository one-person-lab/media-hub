import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { planSameStyle } from './same-style-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OPT = { root: ROOT }

/* 下面这些断言吃的是本机那两份真数据：config/products.json（品牌档案）与它挂的推广对象。
   开源副本不带这两份（是自家商业文案，见 scripts/publish-oss.mjs 的排除清单），
   在别人机器上它们没有被测对象——整组跳过，本机照跑。 */
const LOCAL_BRANDS = existsSync(join(ROOT, 'config/products.json'))
const BRAND_SKIP = LOCAL_BRANDS ? {} : { skip: '需要本机品牌档案 config/products.json，开源副本不带' }
const PAGES = JSON.parse(readFileSync(join(ROOT, 'config/playbooks.json'), 'utf8')).playbooks

/** 醒醒老己小程序档案里真登着的截图，够五页方案用的那四张 */
const SHOTS = [
  'public/shots/real-result-neet.png',
  'public/shots/real-question.png',
  'public/shots/real-result.png',
  'public/shots/real-challenge.png',
]

/** 把每一页的大字填满：界面预填的就是这些，测试不靠预填也要能自己写出来 */
function fullCopy(slug, extra = {}) {
  const pb = PAGES.find((p) => p.slug === slug)
  const copy = {}
  pb.pages.forEach((pg, i) => {
    if (pg.edit.includes('title')) copy[`${i + 1}.title`] = `${pg.role}的第一行\n${pg.role}的第二行`
  })
  return { ...copy, ...extra }
}

test('五页方案配四张截图：版式顺序、截图分配、CTA 取自档案', BRAND_SKIP, async () => {
  const plan = await planSameStyle({ playbookSlug: 'quote-open', product: '醒醒老己小程序', shots: SHOTS, copy: fullCopy('quote-open') }, OPT)
  assert.equal(plan.ok, true, plan.errors.join('；'))
  assert.deepEqual(plan.pages.map((p) => p.layout), ['promo-hook', 'promo-shot', 'promo-grid', 'promo-duo', 'promo-cta'])
  assert.equal(plan.pages[0].img, SHOTS[0])
  assert.equal(plan.pages[1].img, SHOTS[1])
  assert.equal(plan.pages[2].img, undefined)
  assert.equal(plan.pages[3].img, SHOTS[2])
  assert.equal(plan.pages[3].img2, SHOTS[3])
  // 入口与口径只从产品档案来，界面没机会塞第二套说法
  assert.equal(plan.pages[4].cta, '微信搜「醒醒老己」')
  assert.match(plan.pages[4].proof, /24 道题/)
  assert.match(plan.slug, /^p-quote-open-\d{4}$/)
})

test('缺图就拦住：说清要几张、现在几张，并拒绝生成', BRAND_SKIP, async () => {
  const plan = await planSameStyle({ playbookSlug: 'quote-open', product: '醒醒老己小程序', shots: SHOTS.slice(0, 2), copy: fullCopy('quote-open') }, OPT)
  assert.equal(plan.ok, false)
  const why = plan.errors.join('；')
  assert.match(why, /要 4 张真素材，现在只勾了 2 张/)
  assert.match(why, /不退化成纯文字卡/)
})

test('档案里没这张图就拦住：截图必须挂在产品名下', BRAND_SKIP, async () => {
  const plan = await planSameStyle(
    {
      playbookSlug: 'name-the-feeling',
      product: '醒醒老己小程序',
      shots: ['public/shots/real-question.png', 'public/shots/real-result.png', 'public/images/logo.png'],
      copy: fullCopy('name-the-feeling'),
    },
    OPT,
  )
  assert.equal(plan.ok, false)
  assert.match(plan.errors.join('；'), /这张图不在「醒醒老己小程序」的档案里：public\/images\/logo\.png/)
})

test('没登记入口与口径的产品拦住，并把三条都报出来', async () => {
  // 真档案里现在每个产品都登记齐了，这一条要拦的是「没登记」的那种，所以搭一个临时仓库根
  const root = join(tmpdir(), `same-style-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  copyFileSync(join(ROOT, 'config/playbooks.json'), join(root, 'config/playbooks.json'))
  writeFileSync(
    join(root, 'config/products.json'),
    JSON.stringify({ products: [{ name: '地球 Online', kind: '安卓 App', entry: '', facts: [], screens: [], target: '' }] }),
  )
  const plan = await planSameStyle({ playbookSlug: 'quote-open', product: '地球 Online', shots: [] }, { root })
  assert.equal(plan.ok, false)
  const why = plan.errors.join('；')
  assert.match(why, /入口还没登记/)
  assert.match(why, /对外口径还没登记/)
  assert.match(why, /要 4 张真素材，现在只勾了 0 张/)
})

test('大字空着就拦住：五页只填两页，报出还缺哪几页', BRAND_SKIP, async () => {
  const plan = await planSameStyle(
    { playbookSlug: 'quote-open', product: '醒醒老己小程序', shots: SHOTS, copy: { '1.title': '不是不想活，\n是没力气活', '2.title': '不是你懒' } },
    OPT,
  )
  assert.equal(plan.ok, false)
  const why = plan.errors.join('；')
  assert.match(why, /第 3 页「对号入座」的大字还空着/)
  assert.match(why, /第 5 页「一个动作」的大字还空着/)
  assert.doesNotMatch(why, /第 2 页/)
})

test('文案槽位按「页.字段」填，大字两行分色、清单按 · 拆格', BRAND_SKIP, async () => {
  const plan = await planSameStyle(
    {
      playbookSlug: 'quote-open',
      product: '今晚整花活小程序',
      shots: [
        'public/shots/huohua/01-index-top.png',
        'public/shots/huohua/02-index-games.png',
        'public/shots/huohua/03-game-card.png',
        'public/shots/huohua/06-result.png',
      ],
      title: '聚会冷场，怪谁',
      copy: fullCopy('quote-open', {
        '1.title': '不是不会玩，\n是没人给题',
        '2.items': '一桌人各自看手机\n轮流敬酒很尴尬',
        '3.cells': '💀 行尸走肉 · 全国 8%\n🔥 开火车',
      }),
    },
    OPT,
  )
  assert.equal(plan.ok, true, plan.errors.join('；'))
  assert.deepEqual(plan.pages[0].title, [['不是不会玩，', 'hot'], ['是没人给题', 'pale']])
  assert.deepEqual(plan.pages[1].items, [{ zh: '一桌人各自看手机' }, { zh: '轮流敬酒很尴尬' }])
  assert.deepEqual(plan.pages[2].cells, [
    { emoji: '💀', name: '行尸走肉', meta: '全国 8%' },
    { emoji: '🔥', name: '开火车' },
  ])
  // preset 里的版式参数照抄，人不用管字号与间距
  assert.equal(plan.pages[1].zh, 76)
  assert.equal(plan.pages[1].tag, '界面实测')
})

test('角标跟着产品走：样张那句「结果页原文」不套到别的产品头上', BRAND_SKIP, async () => {
  const HUOHUA = [
    'public/shots/huohua/01-index-top.png',
    'public/shots/huohua/02-index-games.png',
    'public/shots/huohua/03-game-card.png',
  ]
  const one = { playbookSlug: 'name-the-feeling', product: '今晚整花活小程序', shots: HUOHUA }
  // 界面换产品时每页都带一格角标：空串 = 这一页不画角标，别样的说法不留
  const cleared = await planSameStyle({ ...one, copy: { ...fullCopy('name-the-feeling'), '1.tag': '', '2.tag': '真机截图', '3.tag': '' } }, OPT)
  assert.equal(cleared.ok, true, cleared.errors.join('；'))
  assert.equal(cleared.pages[0].tag, undefined)
  assert.equal(cleared.pages[1].tag, '真机截图')
  // 完全没带这一格（旧调用方）才留方案预设
  const preset = await planSameStyle({ ...one, copy: fullCopy('name-the-feeling') }, OPT)
  assert.equal(preset.pages[0].tag, '结果页原文')
})

test('草稿里写清方案出处与归属品牌，一个品牌都不多写', BRAND_SKIP, async () => {
  const plan = await planSameStyle(
    {
      playbookSlug: 'three-questions',
      product: '醒醒老己小程序',
      shots: SHOTS,
      copy: fullCopy('three-questions', {
        '1.title': '不是你懒\n是你没看清自己在哪',
        '1.items': '想做的事先收藏，然后就没有然后',
      }),
    },
    OPT,
  )
  assert.equal(plan.ok, true, plan.errors.join('；'))
  assert.match(plan.md, /^- 归属品牌：醒醒老己小程序$/m)
  assert.doesNotMatch(plan.md, /醒醒老己小程序 \/|\/ 醒醒 App/)
  assert.match(plan.md, /灵感来源：方案库「三问点名」｜拆自《一晚上整理自己的人生》（梨梨依子，50328 赞）/)
  assert.match(plan.md, /卡片数据：p-three-questions-\d{4}\.json/)
  assert.match(plan.md, /#小程序:\/\/醒醒老己/)
  assert.match(plan.md, /只存草稿，不点发表/)
  // 贴图描述把每一页的文字抄进草稿，人复核即可，不必再去翻图卡 json
  assert.match(plan.md, /^1\. 三问点名（promo-shot）：不是你懒 \/ 是你没看清自己在哪；带真实界面截图；1 条：想做的事先收藏，然后就没有然后$/m)
  assert.doesNotMatch(plan.md, /：；/)
})
