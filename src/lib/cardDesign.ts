/**
 * 卡片设计解析层：把「这一稿是什么内容」和「该按哪条模板」算成可追踪的结论。
 *
 * 为什么放在前端而不是渲染器：模板是选的时候定的，不是渲的时候猜的——
 * 选完把 theme.id 和逐页 layout 写回卡片 json，卡片自描述，渲染器不需要知道模板这层存在
 * （所以 23 份老 json 一行不改也照原样渲）。
 *
 * 三条硬规矩：
 * 1) 只吃确定性信号（页数、字段、文字里的标记词），每条结论都带证据句；信号不足或打架就报 uncertain，
 *    界面显示「没把握，手选一次」，不拿一个猜出来的形态冒充推荐。
 * 2) intent 是创作意图不是内容形态（promo 稿也可能是清单），所以它只用来把产品稿摘出去。
 * 3) 换模板时结构装不下的页一律跳过并说明原因——宁可只换皮，也不能把有字的页换成会空掉的版式。
 */
import {
  cardThemes,
  cardThemeByKey,
  cardTemplates,
  cardLayoutByName,
  selectableCardTemplates,
  type CardIntent,
  type CardTemplate,
} from '../data/store'

export type CardPage = Record<string, any>
export interface CardData {
  slug?: string
  brand?: string
  title?: string
  intent?: CardIntent
  product?: string
  theme?: { id?: string; colors?: Record<string, string> }
  template?: string
  shape?: string
  pages?: CardPage[]
  [k: string]: any
}

/** 内容形态：与 config/card-templates.json 的 shape 同一套词，多出来的「产品」不给价值类模板推荐。
 *  「数据」是素材库这一批补上的：判定层永远投不出它（detectShape 只看结构信号），
 *  所以数据大字这类只能由人在库页上手选——一旦选过，json 里存了 shape，后面就认它。 */
export type Shape = '清单' | '观点' | '步骤' | '测评' | '金句' | '数据' | '产品' | ''

export interface ShapeCall {
  shape: Shape
  /** 命中这条判据时看到的那句原文/字段，界面原样显示，用户才知道推荐不是凭空来的 */
  evidence: string
  uncertain: boolean
}

const textOf = (p: CardPage): string => {
  const out: string[] = []
  const walk = (v: any) => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const k of ['title', 'head', 'echo', 'items', 'lines', 'quote', 'left', 'right', 'verdict', 'caption']) {
    if (p[k] != null) walk(p[k])
  }
  return out.join(' ')
}
const zhChars = (s: string) => (s.match(/[\u4e00-\u9fff]/g) || []).length
const bodyPages = (data: CardData) =>
  (data.pages || []).slice(1, Math.max(1, (data.pages || []).length - 1))
const hasShot = (data: CardData) => (data.pages || []).some((p) => p.img || p.img2)

const STEP_MARK = /[①②③⑤⑥⑦⑧⑨]|第[一二三四五六七八九十0-9]+[步招天]|\d+\s*[)）.、]/
const STEP_WORD = /(先.+再.+最后|第一步|按顺序|照着做)/
const SPLIT_MARK = /(还是|对比|区别|哪个|vs\.?|比起)/
const QUOTE_MARK = /[「」“”]/

/** 一页投一票：只看这一页自己长什么样。
 *  整稿形态靠多数定——一稿四页正文、其中一页是金句收尾，不能就说整稿是金句。 */
function pageShape(p: CardPage): { shape: Shape; why: string } | null {
  if (p.img || p.img2) return null // 截图页说明的是产品，不定内容形态
  if (p.quote) return { shape: '金句', why: '整页就是一句引文' }
  if (p.left || p.right) return { shape: '测评', why: '左右两栏对照' }
  const items = Array.isArray(p.items) ? p.items : []
  const t = textOf(p)
  if (items.length >= 2 && (STEP_MARK.test(t) || STEP_WORD.test(t))) {
    return { shape: '步骤', why: `${items.length} 条带顺序号` }
  }
  if (items.length >= 2) {
    const per = items.reduce((n, i) => n + zhChars(String(i.zh || '')), 0) / items.length
    const hasSrc = items.some((i: any) => String(i.src || '').trim())
    return per <= 26 && !hasSrc
      ? { shape: '清单', why: `${items.length} 条短句、每条 ${Math.round(per)} 字` }
      : { shape: '观点', why: `${items.length} 条、每条 ${Math.round(per)} 字${hasSrc ? '且挂了出处' : ''}` }
  }
  if (SPLIT_MARK.test(t)) return { shape: '测评', why: `文里有对照问法「${t.match(SPLIT_MARK)?.[0]}」` }
  if (QUOTE_MARK.test(t) && zhChars(t) <= 40) return { shape: '金句', why: '一页一句带引号的话' }
  return null
}

/** 内容形态判定：先认用户手选过的，再按整稿结构（产品稿摘出去），最后逐页投票取多数 */
export function detectShape(data: CardData): ShapeCall {
  const pages = data.pages || []
  if (!pages.length) return { shape: '', evidence: '这份卡片还没有页面内容', uncertain: true }

  if (data.shape) return { shape: data.shape as Shape, evidence: '这一稿的形态是你上次手选过的', uncertain: false }

  const intent = data.intent || (data.product ? 'promo' : 'value')
  if (intent === 'promo' && hasShot(data)) {
    return { shape: '产品', evidence: '这一稿挂了产品、页面上放的是真实截图', uncertain: false }
  }

  const bodies = bodyPages(data)
  const votes = (bodies.length ? bodies : pages).map(pageShape).filter(Boolean) as { shape: Shape; why: string }[]
  if (!votes.length) return { shape: '', evidence: '正文页里没有可判形态的结构', uncertain: true }

  const tally = new Map<Shape, number>()
  for (const v of votes) tally.set(v.shape, (tally.get(v.shape) || 0) + 1)
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
  const [top, n] = ranked[0]
  const why = votes.filter((v) => v.shape === top)[0].why
  if (ranked.length > 1 && n / votes.length < 0.6) {
    return {
      shape: '',
      evidence: `这一稿是混着写的：${ranked.map(([s, c]) => `${s} ${c} 页`).join('、')}`,
      uncertain: true,
    }
  }
  return { shape: top, evidence: `${votes.length} 页正文里 ${n} 页是${top}（${why}）`, uncertain: false }
}

export interface TemplateRec {
  /** 推出来的那条；没把握或不该自动推时为 null */
  template: CardTemplate | null
  shape: Shape
  reason: string
  uncertain: boolean
  /** 同形态下别的可选模板（界面放在「换一条」里，不当默认答案） */
  alternatives: CardTemplate[]
}

/**
 * 推荐：先定形态，再在「形态对得上 + 意图不冲突 + status=active」的模板里挑。
 * 产品贴图稿一律不推——那条线有自己的皮，套账号模板正是用户明确否掉的事。
 */
export function recommendTemplate(data: CardData): TemplateRec {
  const call = detectShape(data)
  const pool = selectableCardTemplates()
  if (call.shape === '产品') {
    return { template: null, shape: call.shape, reason: '产品稿走自己的皮，不套账号模板', uncertain: false, alternatives: [] }
  }
  if (call.uncertain || !call.shape) {
    return { template: null, shape: call.shape, reason: call.evidence, uncertain: true, alternatives: pool }
  }
  const intent = (data.intent || (data.product ? 'promo' : 'value')) as CardIntent
  const hits = pool.filter((t) => t.shape?.includes(call.shape) && (!t.intents || t.intents.includes(intent)))
  if (!hits.length) {
    return { template: null, shape: call.shape, reason: `没有为「${call.shape}」准备的模板`, uncertain: true, alternatives: pool }
  }
  return {
    template: hits[0],
    shape: call.shape,
    reason: `${call.evidence}；${hits[0].pick || hits[0].label}`,
    uncertain: false,
    alternatives: hits.slice(1),
  }
}

/* ==================== 套用 ==================== */

/** 形态 → 正文该用哪个版式：从现有模板目录现取，不另立一份映射表（改了模板这里跟着变） */
export function bodyLayoutForShape(shape: Shape): string {
  const hit = selectableCardTemplates().find((t) => t.shape?.includes(shape))
  return hit?.layouts?.body || 'items'
}

/** 正文版式 → 形态词：没有稿子可判形态时（从爆款图收皮），形态跟着版式走，别一律写死成清单。
 *  弹层手动收一条和素材库批量收一批共用这张表，两处各写一份迟早对不上。 */
export const LAYOUT_SHAPE: Record<string, string> = {
  items: '清单',
  'checklist-mark': '清单',
  'sticky-note': '清单',
  'note-shot': '清单',
  points: '观点',
  steps: '步骤',
  split: '测评',
  quote: '金句',
  'stat-poster': '数据',
}

/** 一个版式能不能吃下这页的字段：换过去会空掉的页一律不动 */
function fits(layout: string, page: CardPage): boolean {
  const def = cardLayoutByName(layout)
  if (!def) return false
  const need = (def.requires || []).concat(
    layout === 'items' || layout === 'points' || layout === 'steps' ? ['items']
      : layout === 'closing' ? ['lines']
      : layout === 'quote' ? ['quote']
      : layout === 'split' ? ['left', 'right']
      : [],
  )
  if (layout === 'split') return !!(page.left && page.right)
  return need.every((f) => {
    const v = (page as any)[f]
    if (f === 'items' || f === 'lines') return Array.isArray(v) && v.length > 0
    return v != null && v !== ''
  })
}

export interface ApplyResult {
  data: CardData
  /** 真正被改了 layout 的页号（1 起，给状态文案用） */
  changed: number[]
  /** 没动的页和原因——界面必须逐条说出来，否则用户以为模板没生效 */
  skipped: { page: number; why: string }[]
}

/**
 * 套用模板：写 theme.id + template + shape，再按角色逐页写 layout。
 * 返回新对象（不改传入的，Vue reactive 上也别原地改）。
 */
export function applyTemplate(data: CardData, tpl: CardTemplate): ApplyResult {
  const pages: CardPage[] = JSON.parse(JSON.stringify(data.pages || []))
  const changed: number[] = []
  const skipped: { page: number; why: string }[] = []
  const last = pages.length - 1

  pages.forEach((page, i) => {
    const role: 'cover' | 'body' | 'closing' = i === 0 ? 'cover' : i === last ? 'closing' : 'body'
    const target = tpl.layouts[role]
    const def = cardLayoutByName(page.layout)
    if (page.img || page.img2) {
      skipped.push({ page: i + 1, why: '这一页放的是真机截图，换版式会把图丢掉' })
      return
    }
    if (def && def.family !== 'value') {
      skipped.push({ page: i + 1, why: `这一页是${def.family === 'promo' ? '宣传' : '产品'}版式，自带皮不跟随模板` })
      return
    }
    if (!target || page.layout === target) return
    if (!fits(target, page)) {
      skipped.push({ page: i + 1, why: `这一页的内容装不进「${target}」版式，缺字段就不硬换` })
      return
    }
    pages[i] = { ...page, layout: target }
    changed.push(i + 1)
  })

  return {
    data: {
      ...JSON.parse(JSON.stringify(data)),
      pages,
      theme: { ...(data.theme || {}), id: tpl.theme },
      template: tpl.key,
      shape: data.shape || tpl.shape?.[0] || '',
    },
    changed,
    skipped,
  }
}

/* ==================== 当前设计 ==================== */

export interface DesignState {
  themeId: string
  themeLabel: string
  /** 声明的模板 key（json 里写的那个），没写为空 */
  declared: string
  /** 界面显示名：模板名 / 自定义 / 未选模板 */
  label: string
  /** true=逐页 layout 与皮肤都和声明的模板一致；手改过任何一项就是 false */
  matches: boolean
}

/** 卡片现在到底按的是哪条钮：手改过皮或任一页版式就如实显示「自定义」，不继续冒充那个模板 */
export function designState(data: CardData | null | undefined): DesignState {
  const key = String(data?.template || '')
  const tpl = selectableCardTemplates().find((t) => t.key === key) || cardTemplateAny(key)
  const themeId = data?.theme?.id || cardThemes.default
  const themeLabel = cardThemeByKey(themeId)?.label || themeId
  if (!tpl) {
    return { themeId, themeLabel, declared: key, label: key || '未选模板', matches: false }
  }
  const pages = data?.pages || []
  const last = pages.length - 1
  const matches =
    themeId === tpl.theme &&
    pages.every((p, i) => {
      const def = cardLayoutByName(p.layout)
      if (def && def.family !== 'value') return true // 产品/宣传页本来就不归模板管
      if (p.img || p.img2) return true
      const role = i === 0 ? 'cover' : i === last ? 'closing' : 'body'
      return !tpl.layouts[role] || p.layout === tpl.layouts[role]
    })
  return { themeId, themeLabel, declared: key, label: matches ? tpl.label : `${tpl.label}（已改过）`, matches }
}

/** candidate / archived 模板不在可选列表里，但历史卡片可能正引用着它们——查名还得能查到 */
function cardTemplateAny(key: string): CardTemplate | undefined {
  return cardTemplates.templates.find((t) => t.key === key)
}
