/**
 * 图文卡片的纯函数层：皮肤解析、占位符填充、机械核查、截图与产物校验。
 *
 * 为什么单独一层：真实卡片（scripts/render-cards.mjs）和模板小样
 * （scripts/render-template-thumbs.mjs）吃的是同一套 30 个占位符、同一套色值 token、
 * 同一道内容闸门。两边各写一遍，加版式时就会只改一边，另一边静默渲出空壳。
 *
 * ego 内嵌 Node 的 cwd 恒为 /，调用方一律用 pathToFileURL(join(ROOT, ...)) 绝对路径 import 这里。
 */
import { readFile, writeFile, access, stat } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { createHash } from 'node:crypto'

export const CARD_SIZE = { width: 1242, height: 1660 }

/** 产物里图卡是一张表（build-data 按短码收进 cards，稿上只留 cardSlug）——一个选题五个平台稿共用同一张卡，
 *  以前每张稿内嵌一份，110 篇稿里 610KB 有 475KB 是重复的。
 *  读数据的一方进来先调这个把 card 补回稿上，下游照旧读 a.card，不用到处改成查表。已经内嵌的不动。 */
export function hydrateCards(raw) {
  const table = raw?.cards
  if (!table || !Array.isArray(raw.articles)) return raw
  for (const a of raw.articles) {
    if (!a.card && a.cardSlug && table[a.cardSlug]) a.card = table[a.cardSlug]
  }
  return raw
}

export const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 转义后支持 **重点** 行内加粗：只有包了星号的片段加粗，其余走正文常规字重；换行符落成 <br>（卡片文案要手工断行时用） */
export const em = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b class="em">$1</b>').replace(/\n/g, '<br>')

/** 条目行：中文（出处）+ 英文对照(出处)。源笔记的出处是逐条挂中文全角括号、英文半角括号 */
export const rowHtml = (it) => {
  const zhSrc = list(it.src).map((s) => `<span class="src">（${esc(s)}）</span>`).join('')
  const enSrc = list(it.srcEn).map((s) => ` (${esc(s)})`).join('')
  const en = it.en ? `<div class="en">${em(it.en)}${enSrc}</div>` : ''
  return `<div class="item"><div class="zh">${em(it.zh)}${zhSrc}</div>${en}</div>`
}
/** 分栏页（split）的一栏：栏名（可带英文对照）+ 条目。tone 选皮：hot=描边强调栏，pale=淡底。
 *  条目包一层 citems：两栏等高时短的那栏不许顶在上半截、下面空一片，靠它把行距摊开。 */
export const colHtml = (c) => {
  if (!c) return ''
  const en = c.nameEn ? `<span class="cen">${esc(c.nameEn)}</span>` : ''
  const tone = c.tone === 'hot' || c.tone === 'pale' ? ` ${c.tone}` : ''
  const items = (c.items || []).map(rowHtml).join('')
  return `<div class="col${tone}"><div class="cname">${esc(c.name)}${en}</div><div class="citems">${items}</div></div>`
}
/** 标题：[[文字, 色块类名], …] 逐行压色块 */
export const titleHtml = (lines) =>
  lines.map((l) => {
    const [text, tone] = Array.isArray(l) ? l : [l, '']
    return `<span class="ln"><b${tone ? ` class="${tone}"` : ''}>${esc(text)}</b></span>`
  }).join('')

/** 真机截图内联成 data URI：模板文件渲在 /tmp，相对路径会失配；file:// 又受 Chromium 本地文件策略限制 */
const SHOT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
export async function shotDataUri(root, rel) {
  const abs = resolve(root, rel)
  let buf
  try {
    buf = await readFile(abs)
  } catch {
    throw new Error(`截图不存在：${rel}`)
  }
  const mime = SHOT_MIME[extname(abs).toLowerCase()] || 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/* ==================== 皮肤层 ==================== */

/** 卡片声明的 theme → { id, css }。colors 覆盖只认这套 token 里已登记的键，值必须像颜色或长度。
 *  没写 theme 时 css 为空串：模板里 var(--x, 兜底) 的兜底就是抽变量前那个字面量，一个字不注入 = 存量卡片逐像素不变。 */
export function resolveTheme(themes, decl) {
  if (!decl || typeof decl !== 'object') return { id: '', css: '', warnings: [] }
  const id = String(decl.id || '').trim()
  const base = (themes?.themes || []).find((t) => t.key === id)
  if (!base) {
    return { id: '', css: '', warnings: [{ page: 0, rule: '主题不存在', detail: `theme.id="${id}" 不在 config/card-themes.json 里，按默认主题渲` }] }
  }
  const tokens = { ...base.tokens }
  const warnings = []
  for (const [k, v] of Object.entries(decl.colors && typeof decl.colors === 'object' ? decl.colors : {})) {
    const val = String(v ?? '').trim()
    if (!(k in base.tokens)) warnings.push({ page: 0, rule: '未知色位', detail: `theme.colors.${k} 不是已登记的 token，忽略` })
    else if (!/^(#[0-9a-f]{3,8}$|[a-z]+|[\d.]+px)$/.test(val)) warnings.push({ page: 0, rule: '色值不合法', detail: `theme.colors.${k}="${val}" 不像颜色或长度，忽略` })
    else tokens[k] = val
  }
  const css = `:root{${Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';')}}`
  return { id, css, warnings }
}

/** 版式接没接皮肤层：themeReady=false 的选主题不生效，如实说而不是静默忽略。
 *  selfSkinned=true 是 prod 与 promo 那两族——自带产品皮是设计决定，不是没做完的活，所以两句分开说。 */
export function themeLayoutWarnings(layouts, pages, themeId) {
  if (!themeId || !Array.isArray(layouts?.layouts) || !Array.isArray(pages)) return []
  return pages
    .map((p, i) => ({ p, no: i + 1, l: layouts.layouts.find((x) => x.layout === p.layout) }))
    .filter(({ l }) => l && l.themeReady === false)
    .map(({ p, no, l }) => ({
      page: no,
      rule: l.selfSkinned ? '版式自带皮' : '版式未接主题',
      detail: l.selfSkinned
        ? `${p.layout} 是产品主视觉版式，色值写死在产品皮里，主题「${themeId}」对它不生效（要换它得改版式）`
        : `${p.layout} 的色值还没抽成变量，主题「${themeId}」对它不生效`,
    }))
}

/** 模板只套了一半：json 写了 template 却没把逐页 layout 换成那条模板的版式，
 *  渲出来就是「换了张皮没换骨头」——手写的稿子最容易漏这一步，所以渲之前机器盯一遍。
 *  带真机截图的页与自带皮的版式（prod 与 promo 那两族）本来就不跟随模板，不算漏。 */
export function templateHalfWarnings(templates, layouts, card) {
  const pages = Array.isArray(card?.pages) ? card.pages : []
  const key = String(card?.template || '').trim()
  if (!key || !pages.length) return []
  const def = (Array.isArray(templates?.templates) ? templates.templates : []).find((t) => t.key === key)
  if (!def) {
    return [{ page: 0, rule: '模板不存在', detail: `template="${key}" 不在 config/card-templates.json 里，版式按 json 写的渲` }]
  }
  const last = pages.length - 1
  return pages
    .map((p, i) => {
      const role = i === 0 ? 'cover' : i === last ? 'closing' : 'body'
      const target = def.layouts?.[role]
      if (!target || p.layout === target || p.img || p.img2) return null
      const def_ = (Array.isArray(layouts?.layouts) ? layouts.layouts : []).find((x) => x.layout === p.layout)
      if (def_?.selfSkinned) return null
      return {
        page: i + 1,
        rule: '模板只套了一半',
        detail: `这一稿挂「${def.label}」，${role === 'cover' ? '封面' : role === 'closing' ? '收尾' : '正文'}该用「${target}」，这页写的却是「${p.layout || '无'}」`,
      }
    })
    .filter(Boolean)
}

export function layoutByName(layouts, name) {
  return (Array.isArray(layouts?.layouts) ? layouts.layouts : []).find((l) => l.layout === name)
}

/* ==================== 占位符填充 ==================== */

/** 一页 → 完整 HTML。themeCss 传空串就是不注入皮肤。 */
export async function buildPageHtml({ root, templatesDir, page, index, total, brand, themeCss }) {
  let html
  try {
    html = await readFile(join(templatesDir, `${page.layout}.html`), 'utf8')
  } catch {
    throw new Error(`版式不存在：templates/cards/${page.layout}.html`)
  }
  /* 收尾角色读 lines，其余读 items。判据从「版式名等于 closing」放宽成「这页带了 lines」：
     素材库里的收尾版式不止 closing 一个（closing-strip 也走 lines），写死名字等于每加一版收尾就要回来改一次。 */
  const wantLines = page.layout === 'closing' || (Array.isArray(page.lines) && page.lines.length > 0)
  const fill = {
    __TITLE__: titleHtml(page.title || []),
    __ECHO__: em(page.echo || ''),
    __ROWS__: wantLines
      ? (page.lines || []).map((l) => `<div class="line">${em(l.zh)}${list(l.src).map((s) => `<span class="src">（${esc(s)}）</span>`).join('')}</div>`).join('')
      : (page.items || []).map(rowHtml).join(''),
    __QUOTE__: page.quote ? esc(page.quote).replace(`「${page.hl}」`, `<span class="hl">${page.hl}</span>`) : '',
    __LEFT__: colHtml(page.left),
    __RIGHT__: colHtml(page.right),
    __VERDICT__: em(page.verdict || ''),
    __VERDSIZE__: page.verdictZh ? `${page.verdictZh}px` : '46px',
    __QUOTE_EN__: esc(page.quoteEn || ''),
    __WHO__: esc(page.who || ''),
    __ROLE__: page.role ? `<span class="role">${esc(page.role)}</span>` : '',
    __KICKER__: esc(page.kicker || ''),
    __SRC__: em(page.src || ''),
    __SRCEN__: esc(page.srcEn || ''),
    __HEAD__: titleHtml(page.head || []).replace(/<span class="ln">/g, '').replace(/<\/span>/g, ''),
    __CTA__: esc(page.cta || ''),
    __BRAND__: esc(page.brand || brand),
    __PAGENO__: `${index + 1} / ${total}`,
    __ZH__: page.zh ? `${page.zh}px` : '46px',
    __EN__: page.en ? `${page.en}px` : '42px',
    __GAP__: page.gap ? `${page.gap}px` : '84px',
    __ECHOSIZE__: page.echoZh ? `${page.echoZh}px` : '40px',
    __IMG__: page.img ? await shotDataUri(root, page.img) : '',
    __IMG2__: page.img2 ? await shotDataUri(root, page.img2) : '',
    __CAPTION__: em(page.caption || ''),
    __LABEL1__: esc(page.label1 || '微信小程序'),
    __LEAD1__: em(page.lead1 || ''),
    __LABEL2__: esc(page.label2 || '安卓 App'),
    __LEAD2__: em(page.lead2 || ''),
    __BADGE__: esc(page.badge || '已上架'),
    __TAG__: esc(page.tag || ''),
    __PROOF__: em(page.proof || ''),
    __NAMES__: em(page.names || ''),
    __CELLS__: (page.cells || []).map((c) =>
      `<div class="cell ${esc(c.tone || '')}"><div class="emoji">${esc(c.emoji || '')}</div><div class="text"><div class="name">${esc(c.name || '')}</div><div class="meta">${em(c.meta || '')}</div></div></div>`
    ).join(''),
  }
  for (const [k, v] of Object.entries(fill)) html = html.split(k).join(v)
  // 出处是可选项（创作规范 §三）：没挂权威观点出处的页，整行金字删掉，不留「出处 ·」空壳
  if (!page.src && !page.srcEn) html = html.replace(/<div class="cite">[\s\S]*?<\/div>/, '')
  // 皮肤整块插进已有的那个 <style> 里：模板都是单 style、无外链，插这里最省事且不必加占位符
  if (themeCss) html = html.replace('<style>', `<style>\n  ${themeCss}`)
  return html
}

/* ==================== 机械核查：创作规范 §八——机器答得了的不占用人眼 ==================== */

/** 互动引导话术（规范 §六 收尾禁止）——只收内容语境里几乎不会正当出现的词；
 *  「收藏」「评论」的内容义远大于引导义（「不许再收藏」是主题、「《睡眠医学评论》」是期刊），误报免查 */
export const BANNED_WORDS = ['点赞', '关注', '转发', '双击', '蹲一个', '蹲后续', '码住']
/** 平台名（规范 §三 出处禁止；来源只走采集卡/选题卡内部字段） */
export const PLATFORM_NAMES = ['小红书', '抖音', '快手', '公众号', '视频号', 'B站', 'bilibili']
/** 产品与品牌转化词（规范 §七 本体禁产品 CTA；「地球Online」是水印/kicker 的正当露出，不查）。
 *  ⚠ 这张表是硬编码的品牌词，不含 config/products.json 里登记的产品名——「醒醒老己」既是账号人格名
 *  又是商店上架名，自动并进禁词会把纯价值稿的署名位一起打掉，所以名单怎么并要人先定命名口径。 */
export const PRODUCT_WORDS = ['BuildHub', 'Build in Public', '一人公司']
export const INTENTS = ['value', 'mixed', 'promo']

/** 收一页里所有会被读者看到的文案字段（品牌水印除外）→ [位置, 文本][] */
export function pageTexts(p) {
  const out = []
  const push = (label, v) => { const s = String(v ?? '').trim(); if (s) out.push([label, s]) }
  const bare = (l) => (Array.isArray(l) ? l[0] : l)
  list(p.title).forEach((t, i) => push(`标题第${i + 1}行`, bare(t)))
  push('echo', p.echo)
  push('quote', p.quote)
  push('quoteEn', p.quoteEn)
  push('who', p.who)
  push('role', p.role)
  push('kicker', p.kicker)
  push('src', p.src)
  push('caption', p.caption)
  push('label1', p.label1)
  push('lead1', p.lead1)
  push('label2', p.label2)
  push('lead2', p.lead2)
  push('badge', p.badge)
  push('tag', p.tag)
  push('proof', p.proof)
  push('names', p.names)
  push('cta', p.cta)
  list(p.items).forEach((it, i) => {
    push(`第${i + 1}条·中文`, it.zh)
    push(`第${i + 1}条·英文`, it.en)
    push(`第${i + 1}条·出处`, list(it.src).join('；'))
  })
  list(p.lines).forEach((l, i) => push(`收尾第${i + 1}行`, l.zh))
  push('结论', p.verdict)
  // 分栏页（对比测评）的文字走 left/right，不在 items 里——核查漏了这栏就等于没查
  for (const [side, col] of [['左栏', p.left], ['右栏', p.right]]) {
    if (!col || typeof col !== 'object') continue
    push(`${side}名`, col.name)
    push(`${side}英文`, col.nameEn)
    list(col.items).forEach((it, i) => {
      push(`${side}第${i + 1}条`, it.zh)
      push(`${side}第${i + 1}条·英文`, it.en)
      push(`${side}第${i + 1}条·出处`, list(it.src).join('；'))
    })
  }
  list(p.cells).forEach((c, i) => {
    push(`第${i + 1}格·名称`, c.name)
    push(`第${i + 1}格·备注`, c.meta)
  })
  push('head', list(p.head).map(bare).join('\n'))
  return out
}

/** 违规清单 → 一行给人看的汇总（前端 toast 直接显示，最多 5 处防刷屏） */
export function summarize(violations) {
  const head = violations.slice(0, 5).map((x) => `第${x.page}页 ${x.rule}（${x.detail}）`).join('；')
  return `机械核查不过：${head}${violations.length > 5 ? `；等共 ${violations.length} 处` : ''}`
}

/** 内容核查 → { violations: 硬违规[{ page, rule, detail }]（打回）, warnings: 软提示（不拦渲染） } */
export function checkCard(card) {
  const violations = []
  const warnings = []
  /* 内容意图三档。缺省按 product 推导（填了归属品牌=promo，没填=value），与改造前那个二值开关行为完全一致：
     value=纯提供价值，产品词全组拦；mixed=提供价值的同时推广产品，产品词只许出现在标了 "commercial": true 的页；
     promo=纯推广，产品词全组放行。 */
  const productShot = String(card.product || '').trim()
  const declared = String(card.intent || '').trim()
  const intent = INTENTS.includes(declared) ? declared : productShot ? 'promo' : 'value'
  if (declared && !INTENTS.includes(declared)) {
    warnings.push({ page: 0, rule: '意图不认识', detail: `intent="${declared}" 只认 ${INTENTS.join(' / ')}，按 ${intent} 处理` })
  }
  if (intent === 'mixed' && !list(card.pages).some((p) => p?.commercial === true)) {
    warnings.push({ page: 0, rule: 'mixed 没有植入页', detail: 'intent=mixed 但没有任何一页标 "commercial": true，产品词会按纯价值稿全组拦截' })
  }
  list(card.pages).forEach((p, i) => {
    const no = i + 1
    const items = list(p.items)
    // 植入页整页都是自写文案（规范 §七 例外），不要求英文对照；纯价值稿照旧逐条提
    const wantEn = intent === 'value' || (intent === 'mixed' && p.commercial !== true)
    const productWordsAllowed = intent === 'promo' || (intent === 'mixed' && p.commercial === true)
    if (p.layout !== 'closing' && items.length > 5) {
      violations.push({ page: no, rule: '每页 ≤5 条', detail: `本页 ${items.length} 条，拆页再来（规范 §二.4）` })
    }
    // 分栏页的条目挂在 left/right：同样受 ≤5 约束，否则一栏塞八条照样渲出来
    for (const [side, col] of [['左栏', p.left], ['右栏', p.right]]) {
      const n = list(col?.items).length
      if (n > 5) violations.push({ page: no, rule: '每页 ≤5 条', detail: `${side} ${n} 条，拆页再来（规范 §二.4）` })
    }
    items.forEach((it, j) => {
      // 缺 en 是警告级：自写页（联想/收尾）按规范不要求英文，机器分不出源观点与自写，只提示不打回
      if (wantEn && String(it.zh || '').trim() && !String(it.en || '').trim()) {
        warnings.push({ page: no, rule: '缺英文对照', detail: `第 ${j + 1} 条只有中文：源观点补 en，自写页可忽略` })
      }
      // 整行加粗：整行只有一对 **（「**环境**决定**圈层**」是多处关键词加粗，不算）
      const zh = String(it.zh || '').trim()
      if (zh.startsWith('**') && zh.endsWith('**') && zh.length > 4 && !zh.slice(2, -2).includes('**')) {
        violations.push({ page: no, rule: '整行加粗', detail: `第 ${j + 1} 条整行只有一处加粗：只加粗关键词（规范 §五.4）` })
      }
    })
    if (p.layout === 'cover') {
      if (!list(p.title).length) violations.push({ page: no, rule: '封面缺标题', detail: '封面至少包含标题（规范 §五.3）' })
      if (!String(p.echo || '').trim()) violations.push({ page: no, rule: '封面缺 echo', detail: '封面至少包含一句 echo（规范 §五.3）' })
      if (!items.length) violations.push({ page: no, rule: '封面缺核心观点', detail: '封面至少包含 1–2 条核心观点（规范 §五.3）' })
    }
    for (const [label, text] of pageTexts(p)) {
      for (const w of BANNED_WORDS) {
        if (text.includes(w)) violations.push({ page: no, rule: '互动引导词', detail: `${label}含「${w}」：规范收尾禁互动话术` })
      }
      if (/读《[^》]+》/.test(text)) violations.push({ page: no, rule: '「读《……」」', detail: `${label}：出处只写概念/书名（规范 §三）` })
      if (/评论区[^。；，\n]{0,10}赞/.test(text)) violations.push({ page: no, rule: '「评论区 N 赞」', detail: `${label}：禁引导向数据（规范 §三）` })
      if (/#[\u4e00-\u9fa5]/.test(text)) violations.push({ page: no, rule: '标题带 #话题', detail: `${label}含 #话题：去掉再上卡面（规范 §五.1）` })
      for (const w of PLATFORM_NAMES) {
        if (text.includes(w)) violations.push({ page: no, rule: '平台名', detail: `${label}含「${w}」：来源走内部字段（规范 §三）` })
      }
      if (!productWordsAllowed) {
        for (const w of PRODUCT_WORDS) {
          if (text.includes(w)) {
            violations.push({
              page: no,
              rule: '产品/品牌词',
              detail: intent === 'mixed'
                ? `${label}含「${w}」：mixed 稿只许在标了 "commercial": true 的页植入，这页没标（规范 §七）`
                : `${label}含「${w}」：规范 §七禁产品转化，水印走 kicker/brand 字段`,
            })
          }
        }
      }
    }
  })
  return { violations, warnings }
}

/* ==================== 模板小样：指纹与状态 ==================== */

/** 一条模板的小样由什么决定：皮肤 token 正文 + 用到的每个版式 HTML + 那版式的示例文案。
 *  渲图脚本算一次写进 manifest，build-data 用同一个函数现算比对——两边各写一遍就会漂移，
 *  漂移的后果是选择器拿旧图冒充新皮，那正是这个功能最不能犯的错。
 *  为什么把封面的示例也算进来：素材库现在一条模板两张小样（封面 + 正文页），
 *  只算 body 的话改了封面文案小样不会过期，库里就会拿旧封面冒充新模板。 */
export async function templateFingerprint({ template, themes, demo, templatesDir }) {
  const names = [template?.layouts?.cover, template?.layouts?.body, template?.layouts?.closing].filter(Boolean)
  const htmls = []
  for (const n of names) {
    htmls.push(await readFile(join(templatesDir, `${n}.html`), 'utf8').catch(() => `缺失:${n}`))
  }
  const theme = (themes?.themes || []).find((x) => x.key === template?.theme)
  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    template,
    theme,
    htmls,
    demo: { body: demo?.[template?.layouts?.body] ?? null, cover: demo?.[template?.layouts?.cover] ?? null },
  }))
  return hash.digest('hex').slice(0, 16)
}

/* ==================== 截图与产物校验 ==================== */

export const hasFile = (p) => access(p).then(() => true, () => false)

/** 一页一张：整幅截图要走 CDP 并自带超时——page.screenshot 的默认超时在这台机器上会
 *  掐断第二页之后的截图（实测单页 10-15s）。 */
export async function shootPage(page, htmlPath, png) {
  await page.goto(`file://${htmlPath}`)
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 8000 })
  await page.waitForTimeout(260)
  const r = await page.cdp(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: CARD_SIZE.width, height: CARD_SIZE.height, scale: 1 } },
    { timeout: 90000 },
  )
  await writeFile(png, Buffer.from(r.data, 'base64'))
}

/** 渲染后核查：图在不在、是不是空截图（<10KB 基本就是字体没加载）、页数齐不齐 */
export async function verifyImages(images, pageCount) {
  const violations = []
  for (const [i, png] of images.entries()) {
    if (!(await hasFile(png))) { violations.push({ page: i + 1, rule: '缺 PNG', detail: png }); continue }
    const st = await stat(png)
    if (st.size < 10_000) violations.push({ page: i + 1, rule: 'PNG 过小', detail: `${png.split('/').pop()} 仅 ${st.size} 字节，疑似空截图` })
  }
  if (pageCount != null && images.length !== pageCount) {
    violations.push({ page: 0, rule: '页数不齐', detail: `卡片 ${pageCount} 页，产物 ${images.length} 张` })
  }
  return violations
}
