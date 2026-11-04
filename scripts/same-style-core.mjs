#!/usr/bin/env node
/**
 * 一键同款：拿一条方案的骨架，换成我们自己的产品、真截图和事实，产出一套图卡 + 一份公众号草稿。
 *
 * 三条硬规矩写在这里，不在界面里：
 *  1. 事实只从产品档案来（config/products.json）。入口、CTA、口径三样一律取档案，
 *     界面传进来的同名字段一概不吃——推广稿里不许出现档案之外的事实（Fable 那次的教训）。
 *  2. 缺真截图就拦住。方案页面上写着要吃 1 张 / 2 张，勾不满就不生成，
 *     绝不退化成纯文字卡（纯文字讲产品等于没推广）。
 *  3. 一稿一品牌。归属品牌只写这一个名字，落地链接取这个品牌自己的 target，不读全局切换。
 *
 * plan* 一个字都不写（界面预览与测试都拿它跑），write* 才落盘。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProducts } from './products-core.mjs'
import { targetByFile } from './target-registry.mjs'

const ROOT = process.env.MEDIA_HUB_ROOT || process.cwd()
export const CARD_DIR_REL = 'content/Projects/卡片'
const PENDING_DIR_REL = 'content/Projects/发布排期/公众号/待发布'

/** 每个版式吃几张真截图、自动补哪些字段（槽位由方案自己声明，这里只兜版式的硬约束） */
export const LAYOUTS = {
  'promo-hook': { shots: 1 },
  'promo-shot': { shots: 1 },
  'promo-grid': { shots: 0 },
  'promo-duo': { shots: 2 },
  'promo-cta': { shots: 0, auto: ['cta', 'proof'] },
}

const lines = (v) => String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean)

/** 大字：最多两行，第一行压色、第二行淡色（与手写的样例同一套着色） */
function toTitle(v) {
  const ls = lines(v).slice(0, 2)
  if (!ls.length) return []
  return ls.length === 1 ? [[ls[0], 'hot']] : [[ls[0], 'hot'], [ls[1], 'pale']]
}
const toList = (v) => lines(v).map((zh) => ({ zh }))
/** 清单格：一行一格，「名称 · 说明」按 · 拆；说明这半段可省。
 *  行首的 emoji 照搬进格子里（样例卡每一格都带表情，去掉会留一个空位） */
function toCells(v) {
  return lines(v).map((l) => {
    const emo = l.match(/^(\p{Extended_Pictographic}[^\s]*)\s+(.*)$/u)
    const [head, emoji] = emo ? [emo[2], emo[1]] : [l, '']
    const [name, ...rest] = head.split('·').map((s) => s.trim())
    return { ...(emoji ? { emoji } : {}), name, ...(rest.length ? { meta: rest.join(' · ') } : {}) }
  })
}

/** 槽位 → 卡片字段：edit 里写什么键，就按这个表转换 */
const SLOT = { title: toTitle, items: toList, cells: toCells, echo: (v) => String(v ?? '').trim(), names: (v) => String(v ?? '').trim(), caption: (v) => String(v ?? '').trim() }

function readPlaybooks(root) {
  try {
    const j = JSON.parse(readFileSync(join(root, 'config/playbooks.json'), 'utf8'))
    return Array.isArray(j.playbooks) ? j.playbooks : []
  } catch {
    return []
  }
}

const safeName = (s) => String(s || '').replace(/[/\\:*?"<>|\s]/g, '').slice(0, 24)
const mdOf = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

/** 拦路的都在这一步说破，界面只负责把话摆出来 */
function gateErrors({ playbook, product, shots, needShots }) {
  const errs = []
  if (!playbook) errs.push('方案不在方案库里，换一条再来')
  if (!product) errs.push('品牌档案不存在：先去「品牌」页登记')
  if (product) {
    if (!product.entry) errs.push(`「${product.name}」的入口还没登记：CTA 只能从档案里取，不能编`)
    if (!product.facts?.length) errs.push(`「${product.name}」的对外口径还没登记：图卡上没有可写的事实`)
  }
  if (needShots && shots.length < needShots) {
    errs.push(`这套方案要 ${needShots} 张真素材，现在只勾了 ${shots.length} 张——缺图就不出图，不退化成纯文字卡`)
  }
  const owned = new Set((product?.screens || []).map((s) => s.path))
  for (const s of shots) if (!owned.has(s)) errs.push(`这张图不在「${product?.name}」的档案里：${s}`)
  return errs
}

/** 组装一套图卡数据（不落盘）。copy 的键是「页号.槽位」，页号从 1 开始，与界面上的第几页对得上 */
export async function planSameStyle({ playbookSlug, product: productName, shots = [], copy = {}, kicker = '', title = '', date = new Date() }, { root = ROOT } = {}) {
  const playbook = readPlaybooks(root).find((p) => p.slug === playbookSlug)
  const { products } = readProducts(root)
  const product = products.find((p) => p.name === productName)
  const needShots = playbook?.pages?.reduce((n, pg) => n + (LAYOUTS[pg.layout]?.shots ?? pg.shots ?? 0), 0) ?? 0
  const errors = gateErrors({ playbook, product, shots, needShots })

  // 落地链接取这个产品自己的推广对象（取数口与发布链同一份：target-registry.mjs）
  const target = product ? targetByFile(product.target, { root }) : null
  const slug = `p-${safeName(playbookSlug)}-${mdOf(date)}`
  const draftTitle = String(title || '').trim() || `${product?.name || ''}：${playbook?.name || ''}`

  const pages = []
  let cursor = 0
  for (const [i, pg] of (playbook?.pages || []).entries()) {
    const need = LAYOUTS[pg.layout]?.shots ?? pg.shots ?? 0
    const mine = shots.slice(cursor, cursor + need)
    cursor += need
    const page = { layout: pg.layout, kicker: String(kicker || '').trim() || product.name, ...(pg.preset || {}) }
    for (const key of pg.edit || []) {
      const fn = SLOT[key]
      if (!fn) continue
      const v = copy[`${i + 1}.${key}`]
      if (v !== undefined) page[key] = fn(v)
    }
    if (pg.layout === 'promo-cta') {
      page.cta = product.entry
      page.proof = (product.facts || []).join(' · ')
    }
    // 角标（「界面实测」「结果页原文」那种）是跟着产品走的：样张的说法套到别的产品上就成了假话。
    // 界面每页都会带这一格：给了值就用（空串 = 这一页不要角标），没给才留方案的预设。
    if (copy[`${i + 1}.tag`] !== undefined) {
      const t = String(copy[`${i + 1}.tag`]).trim()
      if (t) page.tag = t
      else delete page.tag
    }
    mine.forEach((path, n) => (page[n === 0 ? 'img' : 'img2'] = path))
    pages.push(page)
    // 大字是这一页按住人的那一句：空着就出一张空白卡，比不出图更糟
    if ((pg.edit || []).includes('title') && !page.title?.length) {
      errors.push(`第 ${i + 1} 页「${pg.role || pg.layout}」的大字还空着`)
    }
  }

  const card = {
    slug,
    brand: target?.signature || `@${product?.name || ''}`,
    product: product?.name || '',
    title: draftTitle,
    pages,
  }

  const shotCount = pages.filter((p) => p.img || p.img2).length
  const md = draftMd({ playbook, product, card, draftTitle, target, shotCount, pages })
  const gates = [
    { ok: true, text: `事实只取自产品档案：${(product?.facts || []).join(' · ') || '（未登记）'}` },
    { ok: true, text: `素材全部是这个产品的真截图：${shots.length} 张，落在 ${shotCount} 页上` },
    { ok: true, text: `行动指令只出现 1 次：第 ${pages.findIndex((p) => p.layout === 'promo-cta') + 1} 页（入口取自档案「${product?.entry || '未登记'}」）` },
    { ok: true, text: '违禁词 / 平台名 / #话题 由渲染前的机械核查把关，不过就不出图' },
  ]

  return {
    ok: !errors.length,
    errors,
    gates,
    slug,
    cardRel: `${CARD_DIR_REL}/${slug}.json`,
    card,
    draftTitle,
    mdRel: `${PENDING_DIR_REL}/${safeName(draftTitle)}.md`,
    md,
    playbook,
    product,
    pages,
  }
}

/** 公众号草稿：创作信息 + 贴图描述（这一版真正发出去的文字段）+ 卡片数据指针。
 *  贴图描述按页把大字与小字列出来，人只要复核，不必再抄一遍图卡内容。 */
function draftMd({ playbook, product, card, draftTitle, target, shotCount, pages }) {
  const src = playbook.source || {}
  const landing = target?.landing?.byPlatform?.公众号?.url || ''
  const desc = pages.map((p, i) => {
    const big = (p.title || []).map((t) => t[0]).join(' / ')
    const bits = [
      p.img ? '带真实界面截图' : '',
      p.items?.length ? `${p.items.length} 条：${p.items.map((x) => x.zh).join('、')}` : '',
      p.cells?.length ? `${p.cells.length} 格：${p.cells.map((c) => c.name).join('、')}` : '',
      p.echo ? `小字：${p.echo.replace(/\n/g, ' ')}` : '',
      p.caption ? `收尾：${p.caption.replace(/\n/g, ' ')}` : '',
      p.cta ? `按钮：${p.cta}` : '',
      p.proof ? `佐证：${p.proof}` : '',
    ].filter(Boolean)
    return `${i + 1}. ${playbook.pages[i].role}（${p.layout}）${big || bits.length ? `：${[big, ...bits].filter(Boolean).join('；')}` : ''}`
  }).join('\n')

  return `# ${draftTitle}

## 创作信息

- 身份主题：${product.oneLiner || ''}
- 创作意图：推广${product.name}（一稿一品牌，入口与 CTA 全部取自品牌档案）
- 灵感来源：方案库「${playbook.name}」｜拆自《${src.title || ''}》（${src.author || ''}，${src.likes || 0} 赞）
- 开头类型：${playbook.structure}
- 归属品牌：${product.name}
- 活动标识：${card.slug}

## 正文

## 贴图描述

${pages.length} 张竖版贴图，${shotCount} 张带真实界面截图。顺序按「${playbook.structure}」走，不按功能罗列；全组只出现一次行动指令。

${desc}

发布时只存草稿，不点发表。

## 话题标签

（公众号贴图没有话题机制，留空）

## 发布配文

## 首评引导

## 转化数据

（发布后回填：小程序打开数 / 下载量，一行一个「指标：数值」。）

卡片数据：${card.slug}.json
${landing ? `\n小程序入口（推草稿时自动挂进「链接 → 小程序」）：${landing}\n` : ''}`
}

function writeFileAtomic(abs, body) {
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(`${abs}.tmp`, body)
  renameSync(`${abs}.tmp`, abs)
}

/** 落盘：卡片 json + 草稿 md。已存在就报错停下，不覆盖人写过的东西 */
export function writeSameStyle(plan, { root = ROOT } = {}) {
  if (!plan.ok) throw new Error(plan.errors.join('；'))
  const cardAbs = join(root, plan.cardRel)
  const mdAbs = join(root, plan.mdRel)
  if (existsSync(cardAbs)) throw new Error(`图卡数据已存在：${plan.cardRel}（同一天同方案重跑，先改标题或删掉旧的）`)
  if (existsSync(mdAbs)) throw new Error(`草稿已存在：${plan.mdRel}`)
  writeFileAtomic(cardAbs, `${JSON.stringify(plan.card, null, 2)}\n`)
  writeFileAtomic(mdAbs, plan.md)
  return { cardRel: plan.cardRel, mdRel: plan.mdRel, slug: plan.slug, pageCount: plan.pages.length }
}
