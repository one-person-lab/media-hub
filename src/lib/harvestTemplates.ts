/**
 * 爆款批量收编：把采集回来的小红书图文爆款，按互动分从高到低逐条读皮，存成候选模板。
 *
 * 跟弹层里那条手动的「收进模板库」共用同一套读皮原语（readImage / candidateTheme /
 * nearestExisting / structureHint），差别只有三点：
 *  1. 封面那页定皮，正文版式看第二页的结构——一条笔记的多页本来就是一套版式，
 *     拿封面猜正文会把它自己的对照页、步骤页读丢；
 *  2. 名字由读数自己报（底色说调性 + 结构说排法），别人的标题进不了模板库，那是内容不是版式；
 *  3. 判重命中就走 baseTheme 另存版式，不再新增一层皮，否则库里两天就长满近似重复的皮。
 *
 * 只搬皮和排法，一个字都不搬：产出的每条都带 source（哪条笔记、多少赞藏评），
 * 界面上说得出「这是从哪条爆款收编来的、它凭什么算被验证过」。
 */
import { cardThemes, candidateCardTemplates, holdSelfWrite, selectableCardTemplates, type ViralItem } from '../data/store'
import { candidateTheme, nearestExisting, readImage, structureHint, type Reading } from './cardClone'
import { LAYOUT_SHAPE } from './cardDesign'

/** 收编过的判据：模板的 source.noteId。同一条笔记再点一次不会重复入库 */
export function harvestedNoteIds(): Set<string> {
  return new Set(
    [...selectableCardTemplates(), ...candidateCardTemplates()]
      .map((t) => t.source?.noteId || '')
      .filter(Boolean),
  )
}

/** 能收编的池子：图文形态、本机有源图、还没收过，按互动分从高到低排 */
export function harvestPool(items: ViralItem[]): ViralItem[] {
  const done = harvestedNoteIds()
  return items
    .filter((v) => v.format === 'image' && v.images.length > 0 && !done.has(v.id))
    .slice()
    .sort((a, b) => (b.heat || 0) - (a.heat || 0) || b.publishedAt.localeCompare(a.publishedAt))
}

const toRgb = (h: string): [number, number, number] => {
  const s = String(h || '').replace('#', '')
  const x = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [parseInt(x.slice(0, 2), 16) || 0, parseInt(x.slice(2, 4), 16) || 0, parseInt(x.slice(4, 6), 16) || 0]
}

/** 强调色的色名：库里现有的皮都叫「番茄奶油」「抹茶米白」这种「色+底」，收编来的也得是这个样子 */
const colorWord = (r: Reading): string => {
  const [rr, rg, rb] = toRgb(r.accent)
  const max = Math.max(rr, rg, rb)
  const min = Math.min(rr, rg, rb)
  if (max - min < 28) return ''
  let h = 0
  if (max === rr) h = ((rg - rb) / (max - min)) * 60
  else if (max === rg) h = 60 + (2 + (rb - rr) / (max - min)) * 60
  else h = 240 + (4 + (rr - rg) / (max - min)) * 60
  if (h < 0) h += 360
  if (h >= 345 || h < 12) return '红'
  if (h < 40) return '橙'
  if (h < 70) return '黄'
  if (h < 160) return '绿'
  if (h < 200) return '青'
  if (h < 255) return '蓝'
  if (h < 290) return '紫'
  return '粉'
}

/**
 * 给这条皮起名：底色说明暗，强调色说色相，两样都是读数里量出来的。
 * 名字只描述我们看得见的东西（奶油底绿、深底橙），不写「爆款风」「高级感」这种没法验证的词，
 * 也不把正文排法塞进来——那是标签后缀的活，塞进来就长成「奶油底清单·清单」。
 */
export function nameSkin(r: Reading): string {
  const [rr, rg, rb] = toRgb(r.page)
  const lum = (0.2126 * rr + 0.7152 * rg + 0.0722 * rb) / 255
  const sat = (Math.max(rr, rg, rb) - Math.min(rr, rg, rb)) / (255 * (lum > 0.5 ? 2 - lum : lum) || 1)
  const tone = lum < 0.42 ? '深底' : sat > 0.1 ? '重彩底' : sat > 0.04 ? '奶油底' : '素白'
  return `${tone}${colorWord(r)}`
}

/** 读一张本机页图的皮：长边压到 1000 再取像素，与手动收编那条路同一尺度 */
async function readPage(url: string): Promise<Reading> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`这一页的图没取到（${url.split('/').pop()}）`)
  const blob = await res.blob()
  const src = URL.createObjectURL(blob)
  try {
    const im = new Image()
    im.src = src
    await new Promise((r, j) => {
      im.onload = () => r(1)
      im.onerror = () => j(new Error('这张图打不开'))
    })
    const scale = Math.min(1, 1000 / Math.max(im.naturalWidth, im.naturalHeight))
    const w = Math.max(1, Math.round(im.naturalWidth * scale))
    const h = Math.max(1, Math.round(im.naturalHeight * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('这台机器开不了画布，取不了色')
    ctx.drawImage(im, 0, 0, w, h)
    return readImage(ctx.getImageData(0, 0, w, h))
  } finally {
    URL.revokeObjectURL(src)
  }
}

export interface HarvestedOne {
  templateKey: string
  label: string
  /** 判重命中：没新增皮，只是把这条的版式另存在现有皮上 */
  reusedTheme: boolean
  /** 库里已有一条同皮同排法的（来自另一条爆款）：这条没入库，服务端也没动盘 */
  duplicate: boolean
}

/** 收一条：封面定皮、第二页定正文版式 → 存候选 → 顺手补小样。
 *  服务端存完会广播重建，调用方先 holdSelfWrite 开窗，这里再开一次兜住尾巴。 */
export async function harvestOne(item: ViralItem, labelOf: (p: string) => string): Promise<HarvestedOne> {
  const cover = await readPage(item.images[0])
  const bodyReading = item.images[1] ? await readPage(item.images[1]) : cover
  const name = nameSkin(cover)
  const cand = candidateTheme(cover, name, cardThemes.fontStack)
  const dup = nearestExisting(cover, cand.tokens, cardThemes.themes)
  const hint = structureHint(bodyReading)
  const body = hint.layout || 'items'

  // 同名再加个号：库里出现两个「奶油底绿·清单」，界面就没法说清选的是哪个
  const taken = new Set([...selectableCardTemplates(), ...candidateCardTemplates()].map((t) => t.label))
  const shapeWord = LAYOUT_SHAPE[body] || '清单'
  let label = `${name}·${shapeWord}`
  for (let n = 2; taken.has(label) && n < 20; n++) label = `${name}·${shapeWord} ${n}`

  holdSelfWrite()
  const r = await fetch('/__clone-visual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'save',
      name,
      tokens: cand.tokens,
      baseTheme: dup.duplicate ? dup.top?.key || '' : '',
      layouts: { cover: 'cover', body, closing: 'closing' },
      shape: [shapeWord],
      source: {
        platform: labelOf(item.platform),
        noteId: item.id,
        title: item.title,
        url: item.url,
        likes: item.likes,
        collects: item.collects,
        comments: item.comments,
        heat: item.heat || 0,
      },
      swatches: { page: cover.page, ink: cover.ink, accent: cover.accent },
    }),
  }).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || '这条没存进去')
  // 撞库里已有那条：皮和排法一模一样，没写盘也就不必渲小样
  if (r.duplicate) {
    return { templateKey: String(r.templateKey), label: String(r.duplicateLabel || ''), reusedTheme: !!r.reusedTheme, duplicate: true }
  }

  holdSelfWrite()
  await fetch('/__template-thumb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templates: [r.templateKey] }),
  }).catch(() => null)

  return { templateKey: String(r.templateKey), label, reusedTheme: !!r.reusedTheme, duplicate: false }
}
