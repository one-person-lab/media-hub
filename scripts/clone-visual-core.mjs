/**
 * 一键克隆爆款视觉的落盘层：候选皮与候选模板的存在、转正、删掉。
 *
 * 为什么要有「候选」这一层：机器从一张图上取出来的色，跟人手调出来的皮不是同一种东西。
 * 直接进 active 列表，模板库两天就长满近似重复的皮（用户要的「模板多」不是「垃圾多」）。
 * 所以克隆出来的东西先挂 status=candidate：能预览、能套、不进推荐位，人点头才转正。
 *
 * 判重命中时不新增皮，只新增一条模板——同一层皮配另一个版式确实是新东西，
 * 同一层皮再存一遍不是。
 *
 * 写盘一律 tmp+rename：gen:data 会被文件监听立刻触发，半截 JSON 会让界面白屏到下次改动。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const THEMES_REL = 'config/card-themes.json'
const TPLS_REL = 'config/card-templates.json'
const THUMB_DIR_REL = 'public/cards/_templates'
const MANIFEST_REL = `${THUMB_DIR_REL}/manifest.json`

/** 色位值只认这两类（跟渲染器 resolveTheme 同一把尺子）：颜色，或带 px 的长度 */
const TOKEN_VAL = /^(#[0-9a-fA-F]{3,8}$|[a-z]+|[\d.]+px)$/
/** --font 是字体栈不是颜色，得单独放行；但 token 是原样拼进 :root 的，
 *  放一个分号或尖括号进去就能把样式块撑破，所以只留字母数字空格逗号引号括号连字符 */
const FONT_VAL = /^[A-Za-z0-9 ,.'"()-]+$/

const readJson = (root, rel, fallback = null) => {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写：先落 .tmp 再 rename，读的一方永远看不到半截文件 */
function writeJson(root, rel, obj) {
  const abs = join(root, rel)
  const tmp = `${abs}.${process.pid}.tmp`
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  renameSync(tmp, abs)
}

/** 已登记的色位名：以现有皮里出现过的键为准，界面递来的野键一律不收 */
export function registeredTokenKeys(themesCfg) {
  const keys = new Set()
  for (const t of themesCfg?.themes || []) Object.keys(t.tokens || {}).forEach((k) => keys.add(k))
  return keys
}

/** 候选皮进配置前的把关：只留登记过的键 + 合法值，其余原样报回，界面不许静默丢色 */
export function sanitizeTokens(tokens, themesCfg) {
  const allowed = registeredTokenKeys(themesCfg)
  const clean = {}
  const rejected = []
  for (const [k, raw] of Object.entries(tokens || {})) {
    const v = String(raw ?? '').trim()
    if (!allowed.has(k)) rejected.push(`${k}（没登记过的色位）`)
    else if (!(k === '--font' ? FONT_VAL : TOKEN_VAL).test(v)) rejected.push(`${k}="${v}"（${k === '--font' ? '不像字体栈' : '不像颜色或长度'}）`)
    else clean[k] = v
  }
  return { tokens: clean, rejected }
}

/** 皮的 key 由色值本身决定：同一条克隆存两次只会落一条，改一个色才算另一条皮 */
export function cloneThemeKey(tokens) {
  const s = Object.keys(tokens).sort().map((k) => `${k}:${tokens[k]}`).join(';')
  return 'clone-' + createHash('sha1').update(s).digest('hex').slice(8, 16)
}

const LAYOUT_CN = {
  cover: '封面', items: '清单', points: '观点', steps: '步骤', split: '对照', quote: '金句', closing: '收尾',
}
/* 模板名的后缀用库里那套形态词，跟筛选栏一字不差（split 的版式叫对照，形态叫测评），
   否则「重彩底黄·对照」挂在测评那一档下面，人按名字找和按筛选找会指向两个词。
   与前端 src/lib/cardDesign.ts 的 LAYOUT_SHAPE 同一套对应关系。 */
const SHAPE_CN = {
  items: '清单', 'checklist-mark': '清单', 'sticky-note': '清单', 'note-shot': '清单',
  points: '观点', steps: '步骤', split: '测评', quote: '金句', 'stat-poster': '数据',
}

/**
 * 存一条克隆：{ name, tokens, baseTheme, layouts, shape, source }
 *  - 给了 baseTheme（判重命中、人选择「基于现有皮另存」）→ 只加模板，不加皮
 *  - 否则加一条 status=candidate 的皮 + 一条 status=candidate 的模板
 * 返回 { themeKey, templateKey, reusedTheme }
 */
export function saveClone(input, opt = {}) {
  const root = opt.root || ROOT
  const themes = readJson(root, THEMES_REL)
  const tpls = readJson(root, TPLS_REL)
  if (!themes?.themes || !tpls?.templates) throw new Error(`${THEMES_REL} 或 ${TPLS_REL} 读不到，先别克隆`)

  const name = String(input.name || '').trim().slice(0, 24)
  if (!name) throw new Error('得给这条克隆起了名字才知道以后在哪认它')
  const layouts = input.layouts || {}
  const body = String(layouts.body || '').trim()
  if (!body) throw new Error('没说要克隆成正文用哪个版式')

  let themeKey = String(input.baseTheme || '').trim()
  let reusedTheme = !!themeKey
  if (themeKey && !themes.themes.some((t) => t.key === themeKey)) throw new Error(`现有皮肤里没有「${themeKey}」`)

  if (!themeKey) {
    const { tokens, rejected } = sanitizeTokens(input.tokens, themes)
    if (rejected.length) throw new Error(`这些色位收不下：${rejected.join('；')}`)
    if (!Object.keys(tokens).length) throw new Error('一个色位都没取到，这条克隆没有皮可存')
    themeKey = cloneThemeKey(tokens)
    if (!themes.themes.some((t) => t.key === themeKey)) {
      themes.themes.push({
        key: themeKey,
        label: name,
        tag: '克隆候选',
        why: `从一张参考图的像素里取的色${input.source?.title ? `（源：${input.source.title}）` : ''}`,
        fit: [],
        order: 900 + themes.themes.length,
        status: 'candidate',
        cloned: true,
        tokens,
      })
    }
  }

  const tplKey = `${themeKey}-${body}`
  const cover = String(layouts.cover || 'cover').trim() || 'cover'
  const closing = String(layouts.closing || 'closing').trim() || 'closing'
  const entry = {
    key: tplKey,
    label: `${name}·${SHAPE_CN[body] || LAYOUT_CN[body] || body}`,
    theme: themeKey,
    layouts: { cover, body, closing },
    shape: Array.isArray(input.shape) && input.shape.length ? input.shape.slice(0, 3) : ['清单'],
    intents: ['value', 'mixed'],
    pick: reusedTheme
      ? `参考图的皮跟现有皮肤是同一条，只把版式搬过来（${LAYOUT_CN[cover] || cover} / ${LAYOUT_CN[body] || body} / ${LAYOUT_CN[closing] || closing}）`
      : `整层皮从参考图取：底色 ${input.swatches?.page || '?'}、字 ${input.swatches?.ink || '?'}、强调 ${input.swatches?.accent || '?'}`,
    order: 900 + tpls.templates.length,
    status: 'candidate',
    source: input.source || {},
  }
  const at = tpls.templates.findIndex((t) => t.key === tplKey)
  /* 同一个 key 上已经挂着另一条爆款：皮和正文版式跟库里这条一模一样，再写一次只会把上一条的来源
   * 读数（哪条笔记、多少赞）盖没。批量收编一天就能撞上几回，这里报「已有」不动盘。
   * 同一条笔记重收（noteId 相同）算刷新，照旧覆盖。 */
  const prevNote = String(tpls.templates[at]?.source?.noteId || '')
  const nextNote = String(entry.source?.noteId || '')
  if (at >= 0 && prevNote && nextNote && prevNote !== nextNote) {
    return { themeKey, templateKey: tplKey, reusedTheme, duplicate: true, duplicateLabel: tpls.templates[at].label }
  }
  if (at >= 0) tpls.templates[at] = entry
  else tpls.templates.push(entry)

  writeJson(root, THEMES_REL, themes)
  writeJson(root, TPLS_REL, tpls)
  return { themeKey, templateKey: tplKey, reusedTheme }
}

/** 转正：候选 → 在架。在架数顶到 maxActive 就挡住，让人先下线一条，而不是悄悄挤掉谁的模板。 */
export function promoteClone(input, opt = {}) {
  const root = opt.root || ROOT
  const themes = readJson(root, THEMES_REL)
  const tpls = readJson(root, TPLS_REL)
  const t = tpls?.templates?.find((x) => x.key === String(input.template || ''))
  if (!t) throw new Error(`模板目录里没有「${input.template}」`)
  if (t.status !== 'candidate') throw new Error(`「${t.label}」不是候选，不用转正`)
  const active = tpls.templates.filter((x) => !x.status || x.status === 'active').length
  const cap = Number(tpls.maxActive) || 24
  if (active >= cap) throw new Error(`在架模板已经 ${active} 条（上限 ${cap}），先下线一条再转正`)
  t.status = 'active'
  t.order = Math.max(...tpls.templates.map((x) => Number(x.order) || 0)) + 1
  const th = (themes?.themes || []).find((x) => x.key === t.theme)
  if (th && th.status === 'candidate') delete th.status
  writeJson(root, THEMES_REL, themes)
  writeJson(root, TPLS_REL, tpls)
  return { templateKey: t.key, label: t.label, themeKey: th?.key || '' }
}

/** 删掉候选：模板连它独占的那层皮一起删，小样和 manifest 记录也一起清——留着的孤儿图迟早被人当成还在架 */
export function dropClone(input, opt = {}) {
  const root = opt.root || ROOT
  const themes = readJson(root, THEMES_REL)
  const tpls = readJson(root, TPLS_REL)
  const at = tpls?.templates?.findIndex((x) => x.key === String(input.template || '')) ?? -1
  if (at < 0) throw new Error(`模板目录里没有「${input.template}」`)
  const [gone] = tpls.templates.splice(at, 1)
  let droppedTheme = ''
  const stillUsed = tpls.templates.some((x) => x.theme === gone.theme)
  const th = (themes?.themes || []).find((x) => x.key === gone.theme)
  if (!stillUsed && th?.cloned) {
    themes.themes.splice(themes.themes.indexOf(th), 1)
    droppedTheme = th.key
  }
  writeJson(root, THEMES_REL, themes)
  writeJson(root, TPLS_REL, tpls)
  const thumb = join(root, THUMB_DIR_REL, `${gone.key}.png`)
  if (existsSync(thumb)) rmSync(thumb)
  const mf = readJson(root, MANIFEST_REL)
  if (mf?.items && gone.key in mf.items) {
    delete mf.items[gone.key]
    writeJson(root, MANIFEST_REL, mf)
  }
  return { templateKey: gone.key, droppedTheme }
}
