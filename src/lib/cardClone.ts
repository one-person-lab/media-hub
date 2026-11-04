/**
 * 一键克隆爆款视觉（受约束版）。
 *
 * 只做两件事：从一张参考图的像素里读出「这套皮」和「这套结构像哪个现成版式」。
 * 刻意不生成新版式 HTML——生成出来的版式没人维护，两天就变垃圾；
 * 现有 8 个价值版式已经能装下绝大多数爆款排版，克隆要做的是把颜色和层级搬过来。
 *
 * 全部只吃 ImageData（浏览器 canvas 给的东西），不依赖任何图像库，也不上传任何图。
 */

export interface Reading {
  /** 取到的皮（15 个 token 里能由像素决定的那几个） */
  page: string
  surface: string
  surface2: string
  ink: string
  ink2: string
  accent: string
  accentInk: string
  rule: string
  ruleW: string
  /** 结构读数 */
  density: number
  titleScale: number
  columns: number
  align: 'left' | 'center'
  /** 左边那根贯穿的细竖线：步骤页的连接线。清单页和步骤页都有序号，只有它有这根线 */
  spine: boolean
  /** 一段一段数出来的：一条清单是一行一段，一条观点是一段好几行 */
  bands: number
  avgBandH: number
  /** 这两个色位是「真在图上看到了」还是机器兜底的——兜出来的不能拿去判重 */
  hasAccent: boolean
  hasSurface: boolean
  /** 每条读数怎么来的：界面要能把证据摆出来，不然是用户在猜机器 */
  evidence: string[]
  /** 取色失败时的实话（图太小、纯色、全黑之类） */
  warnings: string[]
}

type Rgb = [number, number, number]

const hex = (c: Rgb) =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()
/** 配置里 '#111' 这种三位写法是存在的，比较距离前一律展开 */
const toRgb = (h: string): Rgb | null => {
  const s = String(h || '').trim().replace('#', '')
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(s)) return null
  const x = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]
}
const lum = (c: Rgb) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
/** HSL 的 S：判「这个色块是不是强调色」用饱和度，不用色相 */
const sat = (c: Rgb) => {
  const [r, g, b] = c.map((v) => v / 255) as Rgb
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  return mx === mn ? 0 : (mx - mn) / (mx > 0.5 ? 2 - mx - mn : mx + mn)
}
const mix = (c: Rgb, k: number, toward: Rgb): Rgb => c.map((v, i) => v + (toward[i] - v) * k) as Rgb
/** 色相角（0–360）：强调色要按族合，量化后的桶只剩 R/G/B，不折成角度就没法把同一个红并到一起 */
const hue = (c: Rgb) => {
  const [r, g, b] = c.map((v) => v / 255) as Rgb
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  if (!d) return 0
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}
const far = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const GRID = 48
/** 每格取 3×3 里最暗/最亮的那一头不划算，直接按步长扫全图像素，格子只做统计 */
function scan(img: ImageData) {
  const { data, width, height } = img
  if (!width || !height) return null
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / 60000)))
  const px: Rgb[] = []
  const gx: number[] = []
  const gy: number[] = []
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 128) continue
      px.push([data[i], data[i + 1], data[i + 2]])
      gx.push(Math.min(GRID - 1, Math.floor((x / width) * GRID)))
      gy.push(Math.min(GRID - 1, Math.floor((y / height) * GRID)))
    }
  }
  return px.length ? { px, gx, gy, step } : null
}

/** 按 /12 粗量化分桶，返回按票数排好序的色族（票数就是它占画面的比例） */
function buckets(px: Rgb[], keep: (c: Rgb) => boolean) {
  const map = new Map<string, { c: Rgb; n: number }>()
  let total = 0
  for (const c of px) {
    if (!keep(c)) continue
    const k = `${Math.round(c[0] / 12)},${Math.round(c[1] / 12)},${Math.round(c[2] / 12)}`
    const hit = map.get(k)
    if (hit) {
      hit.c = [(hit.c[0] * hit.n + c[0]) / (hit.n + 1), (hit.c[1] * hit.n + c[1]) / (hit.n + 1), (hit.c[2] * hit.n + c[2]) / (hit.n + 1)]
      hit.n++
    } else map.set(k, { c, n: 1 })
    total++
  }
  return { list: [...map.values()].sort((a, b) => b.n - a.n), total }
}

/**
 * 读一张参考图。img 由 canvas getImageData 得到；调用方按长边 900–1200 画，太小结构就糊。
 */
export function readImage(img: ImageData): Reading {
  const evidence: string[] = []
  const warnings: string[] = []
  const s = scan(img)
  const base: Reading = {
    page: '#FFFFFF', surface: '#F2F2F2', surface2: '#E8E8E8', ink: '#111111', ink2: '#5A5A5A',
    accent: '#111111', accentInk: '#FFFFFF', rule: '#111111', ruleW: '5px',
    density: 0, titleScale: 0, columns: 1, align: 'left', spine: false,
    bands: 0, avgBandH: 0, hasAccent: false, hasSurface: false, evidence, warnings,
  }
  if (!s || s.px.length < 3000) {
    warnings.push('图太小，取不出可靠的色与结构')
    return base
  }
  const { px, gx, gy } = s
  const pct = (n: number) => Math.round(n * 100) + '%'

  // 底色：画面最大的那一族
  const all = buckets(px, () => true)
  const page = all.list[0].c
  const pageL = lum(page)
  const dark = pageL < 0.45
  const share0 = all.list[0].n / all.total
  if (share0 < 0.18) warnings.push(`最大的色块只占 ${pct(share0)}，这张图没有干净的底色（照片或多色拼贴），取到的皮仅供参考`)

  // 字色：跟底色反差大的那族里，再取反差最大的三成——整幅取众数会被细笔画的抗锯齿灰边带跑
  const contrastOf = (c: Rgb) => (dark ? lum(c) - pageL : pageL - lum(c))
  const strong = px.filter((c) => contrastOf(c) > 0.3).sort((a, b) => contrastOf(b) - contrastOf(a))
  let ink: Rgb | null = null
  let inkFrom = 0
  for (const frac of [0.3, 0.5, 1]) {
    const sub = strong.slice(0, Math.ceil(strong.length * frac))
    const f = buckets(sub, () => true)
    const top = f.list[0]
    if (top && top.n >= 60) {
      ink = top.c
      inkFrom = top.n / all.total
      break
    }
  }
  if (!ink) {
    ink = dark ? mix(page, 0.9, [255, 255, 255]) : mix(page, 0.9, [0, 0, 0])
    warnings.push('没取到与底色反差够大的字色，按底色深浅兜底')
  }
  const inkL = lum(ink)

  /* 强调色：先按色相合族量面积，再从赢的那一族里取最浓的一档当代表色。
     为什么合族：/12 量化会把一个视觉上的红散进好几个桶（实测我们自己杂志红的标题字占 4 个桶、
     每桶只有 0.02–0.14% 画面），逐桶卡面积会把真强调色判成「没有」。
     为什么不拿整族平均：平均会把抗锯齿的浅边算进来，实测一张红标题爆款平均出 #E09E8D（灰粉）。
     亮度差卡 0.15：压不住底色就谈不上强调——亮黄底上取一条略深的黄，渲出来根本看不见。 */
  const famN = new Map<number, number>()
  for (const c of px) {
    if (!(sat(c) > 0.24 && Math.abs(lum(c) - pageL) > 0.15 && far(c, ink) > 40 && dist(c, page) > 24)) continue
    const h = Math.round(hue(c) / 15) % 24
    famN.set(h, (famN.get(h) || 0) + 1)
  }
  let acc: { c: Rgb; n: number } | null = null
  for (const [h, n] of [...famN.entries()].sort((a, b) => b[1] - a[1])) {
    if (n / all.total <= 0.001) break
    const deep = buckets(px, (c) => sat(c) > 0.42 && Math.round(hue(c) / 15) % 24 === h && Math.abs(lum(c) - pageL) > 0.15 && far(c, ink) > 40 && dist(c, page) > 24).list[0]
    if (deep && Math.max(...deep.c) - Math.min(...deep.c) > 40) {
      acc = { c: deep.c, n }
      break
    }
  }
  const accent = acc ? acc.c : ink
  // 淡底：第二常见的「比底色暗一点点」那族——源笔记的色带、卡片底都靠它。
  // 强调色块必须排除：一条黄色高亮跟底色也「只差一点」，不排就会被当成淡底。
  const surf = buckets(px, (c) => dist(c, page) > 6 && Math.abs(lum(c) - pageL) < 0.16 && Math.abs(lum(c) - inkL) > 0.2 && far(c, accent) > 40)
    .list.filter((b) => b.n / all.total > 0.02)[0]
  const surface = surf ? surf.c : mix(page, 0.08, ink)
  // 更淡的那层没有第三种色可取，按「底色到淡底的距离再走一倍」推
  const surface2 = page.map((v, i) => v + 2 * (surface[i] - v)) as Rgb

  evidence.push(`底色 ${hex(page)}（占画面 ${pct(share0)}）`)
  evidence.push(`字色 ${hex(ink)}（与底色亮度差 ${Math.abs(pageL - inkL).toFixed(2)}，占 ${pct(inkFrom || 0)}）`)
  evidence.push(acc ? `强调色 ${hex(accent)}（饱和度 ${sat(accent).toFixed(2)}，占 ${(acc.n / all.total * 100).toFixed(1)}%）` : `没找到独立的强调色，色块沿用字色 ${hex(ink)}`)
  if (surf) evidence.push(`淡底 ${hex(surface)}（比底色略暗的第二大面积色，占 ${pct(surf.n / all.total)}）`)

  /* ---- 结构：逐格数「这个格子里有多少像素明显不是底色」 ---- */
  const N = GRID * GRID
  const cnt = new Int32Array(N)
  const inkCnt = new Int32Array(N)
  for (let i = 0; i < px.length; i++) {
    const id = gy[i] * GRID + gx[i]
    cnt[id]++
    if ((dark ? lum(px[i]) - pageL : pageL - lum(px[i])) > 0.24) inkCnt[id]++
  }
  const cellInk: boolean[] = []
  for (let id = 0; id < N; id++) cellInk.push(cnt[id] > 0 && inkCnt[id] >= Math.max(2, cnt[id] * 0.2))
  const density = cellInk.filter(Boolean).length / N

  const rowInk: number[] = []
  for (let y = 0; y < GRID; y++) {
    let n = 0
    for (let x = 0; x < GRID; x++) if (cellInk[y * GRID + x]) n++
    rowInk.push(n / GRID)
  }
  // 最长的一坨有字行 = 标题；爆款封面的大字通常占 15%–30% 高
  let run = 0, best = 0
  for (const r of rowInk) {
    run = r > 0.15 ? run + 1 : 0
    if (run > best) best = run
  }
  const titleScale = best / GRID

  /* 分栏：滑窗找「横向有几块文字」质量最高的那一段。
     先把「通高的竖列」剔掉——两栏中间那道分隔线、卡片描边都会把缝隙桥住，不剔就永远看不出两栏。
     两块都得是真文字柱：每列平均有 2.5 行以上有墨（英文小字行那种一格一格的断口过不了），
     并且两块加起来要占掉六成宽度（一页里挤在一块的空格断口过不了）。 */
  const colSpan: number[] = []
  for (let x = 0; x < GRID; x++) {
    let n = 0
    for (let y = 0; y < GRID; y++) if (cellInk[y * GRID + x]) n++
    colSpan.push(n)
  }
  const isRuleCol = colSpan.map((n) => n / GRID >= 0.5)
  const WIN = 12
  const clustersIn = (top: number) => {
    const prof: number[] = []
    for (let x = 0; x < GRID; x++) {
      if (isRuleCol[x]) { prof.push(0); continue }
      let n = 0
      for (let y = top; y < top + WIN; y++) if (cellInk[y * GRID + x]) n++
      prof.push(n)
    }
    const cs: { a: number; b: number }[] = []
    let start = -1
    for (let x = 0; x <= GRID; x++) {
      if (x < GRID && prof[x] > 0) { if (start < 0) start = x }
      else if (start >= 0) {
        if (x - start >= GRID * 0.2) cs.push({ a: start, b: x - 1 })
        start = -1
      }
    }
    return cs.map((c) => ({ ...c, w: c.b - c.a + 1, avg: prof.slice(c.a, c.b + 1).reduce((s, v) => s + v, 0) / (c.b - c.a + 1) }))
  }
  const clusters: { a: number; b: number; w: number; avg: number }[] = []
  for (let top = 0; top + WIN <= GRID; top++) {
    if (rowInk.slice(top, top + WIN).filter((v) => v > 0.06).length < 4) continue
    const cs = clustersIn(top).filter((c) => c.avg >= 2.5)
    const wide = cs.reduce((n, c) => n + c.w, 0) >= GRID * 0.6
    if (cs.length >= 2 && wide && cs.length > clusters.length) clusters.splice(0, clusters.length, ...cs)
  }
  // 两栏要两块都够宽才算：右侧的点赞图标、页码也会断开，但它们不成栏
  const columns = clusters.length >= 2 ? 2 : 1

  /* 竖脊：左段里一根贯穿大半个页面的细线——步骤页的连接线就是这个东西。
     「有没有序号列」分不开步骤页和清单页（两者左边都有一列短墨，实测一样），
     所以判步骤页靠这根线，不靠序号。色条/描边不算：它挨着页面边缘或自己就有两三列通高。 */
  let spineX = -1
  for (let x = 2; x < GRID * 0.35; x++) {
    if (colSpan[x] / GRID < 0.55) continue
    if (colSpan[x - 1] / GRID > 0.5 || (colSpan[x + 1] || 0) / GRID > 0.5) continue
    let right = 0
    for (let y = 0; y < GRID; y++) for (let xx = x + 2; xx < Math.min(GRID, x + 20); xx++) if (cellInk[y * GRID + xx]) right++
    if (right >= 30) { spineX = x; break }
  }
  const spine = spineX >= 0

  // 对齐：有字格子的质心离中线多近
  let sx = 0, sn = 0
  cellInk.forEach((v, id) => { if (v) { sx += id % GRID; sn++ } })
  const centroid = sn ? sx / sn / (GRID - 1) : 0
  const align: 'left' | 'center' = Math.abs(centroid - 0.5) < 0.07 ? 'center' : 'left'

  // 分段：连续有字的行并成一段，一段≈条目的一条。段数与每段行高是「一条讲一句还是一段讲一层」的读数
  const bands: { top: number; bottom: number }[] = []
  {
    let start = -1
    for (let y = 0; y <= GRID; y++) {
      const on = y < GRID && rowInk[y] > 0.06
      if (on && start < 0) start = y
      else if (!on && start >= 0) { bands.push({ top: start, bottom: y - 1 }); start = -1 }
    }
  }
  const avgBandH = bands.length ? bands.reduce((n, b) => n + (b.bottom - b.top + 1), 0) / bands.length : 0

  // 分隔线：整行几乎都有墨、但只占一两行高——那是线，不是字
  let hair = 0
  {
    let r = 0
    for (const v of rowInk) {
      r = v > 0.9 ? r + 1 : 0
      if (r > hair) hair = r
    }
  }
  const hairline = hair > 0 && hair <= 2
  const ruleW = hairline ? (hair === 1 ? '2px' : '3px') : '5px'

  evidence.push(`文字密度 ${pct(density)}、${bands.length} 段文字、平均每段 ${avgBandH.toFixed(1)} 行高、最高一坨字占页面高 ${pct(titleScale)}`)
  evidence.push(columns === 2 ? `横向有 ${clusters.length} 块并排的文字、合计占宽 ${pct(clusters.reduce((n, c) => n + c.w, 0) / GRID)} → 左右对照` : '整幅一条通栏')
  evidence.push(align === 'center' ? `墨的质心在横向 ${pct(centroid)}，居中` : `墨的质心在横向 ${pct(centroid)}，靠左`)
  if (spine) evidence.push(`左边第 ${pct(spineX / GRID)} 处有一根贯穿 ${pct(colSpan[spineX] / GRID)} 页高的细竖线，正文都在它右边 → 步骤/时间轴结构`)
  if (hairline) evidence.push(`有一条通宽细线（占 ${hair} 行高），按分隔线处理`)
  if (density > 0.5) warnings.push('这张图墨太多（可能是满屏照片或深色底），取到的结构不一定准')
  if (titleScale > 0.5) warnings.push('标题占了一半以上高度，更像单张海报而不是多页卡片')

  // accent 上压的字色：黑或白谁反差大用谁，绝不允许跟 accent 同色
  const accentInk = Math.abs(lum(accent) - 0.07) > Math.abs(lum(accent) - 0.97) ? '#111111' : '#FFFFFF'

  return {
    ...base,
    page: hex(page),
    surface: hex(surface),
    surface2: hex(surface2),
    ink: hex(ink),
    ink2: hex(mix(ink, 0.42, page)),
    accent: hex(accent),
    accentInk,
    rule: hex(ink),
    ruleW,
    density,
    titleScale,
    columns,
    align,
    spine,
    bands: bands.length,
    avgBandH,
    hasAccent: !!acc,
    hasSurface: !!surf,
  }
}

/** 读数 → 一条候选皮肤。键名与 config/card-themes.json 的 15 个 token 对齐。 */
export function candidateTheme(r: Reading, name: string, fontStack: string) {
  const ink = toRgb(r.ink)!
  const page = toRgb(r.page)!
  const accent = toRgb(r.accent)!
  // 金字位（--accent-deep）要压在底色上读得清，所以从强调色往字色方向压深
  const deep0 = mix(accent, 0.45, ink)
  const deep = Math.abs(lum(deep0) - lum(page)) > 0.28 ? deep0 : mix(accent, 0.7, ink)
  return {
    key: 'clone-' + Math.abs(hash(r.page + r.ink + r.accent + r.ruleW)).toString(36),
    label: name,
    status: 'candidate' as const,
    cloned: true,
    tokens: {
      '--page': r.page,
      '--surface': r.surface,
      '--surface-2': r.surface2,
      '--ink': r.ink,
      '--ink-2': r.ink2,
      '--ink-2b': hex(mix(ink, 0.2, page)),
      '--ink-3': hex(mix(ink, 0.6, page)),
      '--ink-4': hex(mix(ink, 0.5, page)),
      '--accent': r.accent,
      '--accent-ink': r.accentInk,
      '--accent-deep': hex(deep),
      '--accent-soft': hex(mix(deep, 0.4, page)),
      '--rule': r.rule,
      '--rule-w': r.ruleW,
      '--font': fontStack,
    } as Record<string, string>,
  }
}

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}

export interface StructureHint {
  /** 像素只证明得了这两件事；分不出来时如实返回 null，交回稿子自己的形态去定 */
  layout: 'split' | 'steps' | null
  why: string
}

/**
 * 结构线索：两栏和那根贯穿的竖线是几何特征，看得准；
 * 清单页与观点页的差别在字号和每条讲几句，不在格子里——12 张小样实测两者密度/段数几乎一样，
 * 所以那两档不拿像素冒充判据，交给稿子自己的形态（cardDesign.detectShape）。
 */
export function structureHint(r: Reading): StructureHint {
  if (r.columns === 2) return { layout: 'split', why: '横向有两块并排的文字、合计占掉六成宽，只有对照页是两栏' }
  if (r.spine) return { layout: 'steps', why: '左边有一根贯穿大半个页面的细竖线、正文全在它右边——步骤页那条连接线就是这个结构' }
  return { layout: null, why: `通栏、左边没有连接线（${r.bands} 段、每段 ${r.avgBandH.toFixed(1)} 行高）；清单还是观点要按稿子内容定，像素分不出来` }
}

/** 皮肤距离：逐 token 比色，取每个色位的最大通道差再求均值——用来判「这条克隆跟现有的对不对是不是同一条」 */
export function themeDistance(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a).filter((k) => k in b && toRgb(a[k]) && toRgb(b[k]))
  if (!keys.length) return 1
  let sum = 0
  for (const k of keys) {
    const pa = toRgb(a[k])!
    const pb = toRgb(b[k])!
    sum += far(pa, pb) / 255
  }
  return sum / keys.length
}

export interface DupHit {
  key: string
  label: string
  distance: number
}

/** 判重只看真在图上取到的色位：淡底/强调色是兜底出来的，比了等于拿机器的猜测去撞库；
 *  --rule 也不比——它是我们从字色推的，而深色皮肤习惯把线画成强调色，一比就误判成两套皮。 */
function coreKeys(r: Reading) {
  return ['--page', '--ink', ...(r.hasSurface ? ['--surface'] : []), ...(r.hasAccent ? ['--accent'] : [])]
}

/** 跟已有皮肤逐条比：距离小于阈值就是「这不是新皮，是 X 的近似」，界面据此劝人别攒重复模板 */
export function nearestExisting(
  r: Reading,
  tokens: Record<string, string>,
  themes: { key: string; label?: string; tokens: Record<string, string> }[],
  threshold = 0.03,
) {
  const core = Object.fromEntries(coreKeys(r).filter((k) => k in tokens).map((k) => [k, tokens[k]]))
  const hits: DupHit[] = themes
    .map((t) => ({ key: t.key, label: t.label || t.key, distance: themeDistance(core, t.tokens) }))
    .sort((a, b) => a.distance - b.distance)
  return { top: hits[0] || null, duplicate: !!hits[0] && hits[0].distance < threshold, hits: hits.slice(0, 3) }
}
