/** 演示站那一份的「挑数据 + 造数据」：真产物里只搬已经公开发出去的那部分，
 *  空掉的站由 demo-seed.mjs 造一批带「示例」字样的演示数据顶上。
 *  单独成模块是为了能被测试直接喂一份假产物，不用碰盘。 */
import { demoSeed, draftFromPublished, demoDraftFiles, publishedSeed } from './demo-seed.mjs'
import { hydrateCards } from './card-core.mjs'

/** 稿面上要摆的就这些：标题、正文、文案、图卡、发布后的真数据与真链接。
 *  没列进去的（内部路径、扒来的出处、改写判断、这一篇教会我们什么、落地页口径）是方法和私货，不给看。 */
export const ARTICLE_FIELDS = [
  'id', 'title', 'file', 'date', 'stage', 'account', 'status',
  'body', 'copy', 'copyLabel', 'caption', 'tags', 'firstComment',
  'metrics', 'metricsFilled', 'dataState', 'publishedPlatforms', 'publishLinks', 'detected',
]

/** 图卡只留能上网的那一半：`images`/`video` 是本机绝对路径（只有桌面客户端读得到），
 *  `jsonRel` 指向仓库里的卡片数据，`urls`/`videoUrl` 才是公开地址。 */
export const CARD_FIELDS = ['slug', 'title', 'data', 'pageCount', 'videoUrl', 'urls']

/** 品牌档案只留对外那一面：真入口、真素材、真卖点。
 *  `target`（内部脚本文件名）和 `_entry出处`（这条是从哪抄的）都不该给外人看。 */
export const PROFILE_FIELDS = ['name', 'type', 'kind', 'status', 'oneLiner', 'entry', 'facts', 'screens']

const pick = (obj, fields) => {
  const out = {}
  for (const k of fields) if (obj?.[k] !== undefined) out[k] = obj[k]
  return out
}

const uniq = (xs) => [...new Set(xs.filter((v) => typeof v === 'string' && v.length >= 4))]

/** 白名单之外再兜一层：这些串一旦进产物，说明有字段被误带出门，当场停，别把东西发出去。
 *  机器路径与内部字段按**键名**查（演示数据不会写出这些键）；人名按**真产物里的值**查。
 *  真稿子的正文与文案里点到的名字不拦——那是他自己公开发出去的致谢（「逐帧扒自 @某某」），
 *  演示站搬的就是那几篇，拦不住也不该拦。 */
export const leakNeedles = (raw) => {
  const published = (raw.articles || []).filter((a) => a.status === 'published')
  const publicText = JSON.stringify(published.map((a) => [a.title, a.body, a.copy, a.tags, a.card?.data]))
  const notPublic = (v) => v && !publicText.includes(v)
  return [
    '/Users/', 'account-cookies', 'contentRoot', 'quickLogin', '"backend":', '"jsonRel":"', './scripts/publish',
    ...uniq((raw.accounts || [])
      .filter((a) => a.id !== a.platform)
      .flatMap((a) => [a.id, a.nickname])),
    ...uniq([...(raw.viral || []), ...(raw.readings || [])].map((x) => x.author).filter(notPublic)),
    ...uniq((raw.benchmarks || []).map((b) => b.nickname).filter(notPublic)),
    ...uniq((raw.accounts || []).map((a) => a.note).filter(notPublic)),
    ...uniq([
      String(raw.target?.positioning || '').slice(0, 40),
      raw.site?.contentRoot, raw.site?.llm?.baseUrl, raw.site?.llm?.keyPath,
      // 知识库那几页是这套工作台的方法，正文一句都不该出门：每页取开头一句当反例
      ...(raw.knowledge || []).flatMap((k) => [
        String(k.intro?.[0]?.text || '').slice(0, 30),
        String(k.sections?.[0]?.blocks?.[0]?.text || '').slice(0, 30),
      ]),
    ]),
  ]
}

/** 对着真账号清单查一遍演示产物：白名单哪天漏了字段，这里当场报出来 */
export function auditLeaks(raw, demo) {
  const body = JSON.stringify(demo)
  return leakNeedles(raw).filter((n) => n && body.includes(n))
}

/** 演示站的两条示例稿：从真已发布里各挑一版（优先挑带图卡的那篇），只把状态改回示例——
 *  一条待推草稿、一条已推进草稿箱，创作台与看板的卡口才各有东西可点。 */
function demoDrafts(published, seed) {
  const taken = new Set()
  // 两条稿各搬一篇、优先搬带图卡的：同一条文案常跨平台重发，按标题去重才不会在日历上排成两格一样的字
  const pickFor = (id) =>
    published.find((a) => a.account === id && a.card && !taken.has(a.title)) ||
    published.find((a) => a.account === id && !taken.has(a.title)) ||
    published.find((a) => a.account === id) || null
  return demoDraftFiles(seed.day, seed.ids, seed.iso).flatMap((spec, i) => {
    const draft = pickFor(spec.account)
    if (!draft) return []
    taken.add(draft.title)
    return [draftFromPublished(draft, { ...spec, id: `demo-draft-${i + 1}` })]
  })
}

/** 方案库的样张：用一条真图卡的页地址，套在真产品档案名下（这两样演示站本来就公开）。
 *  游客那一屏的稿子是现造的、没有配图，这时候样张只剩产品名——界面按「只有结构」画，方案库不该整块空掉。 */
function sampleOf(published, profiles) {
  const hit = published.find((a) => a.card?.urls?.length)
  return {
    slug: hit?.card.slug ?? '',
    urls: hit?.card.urls ?? [],
    product: profiles[0]?.name || '',
    texts: [],
  }
}

/* 内容资源的几个目录：产物 JSON 里点到哪个文件，才算「这份产物用得上它」。
   同一份目录里既有演示要搬的图卡，也有号主没发布的稿子配图，所以这条引用口径既是搬运口径，
   也是游客态的隔离口径（见 guest-core.mjs）——按引用放行，其余一律要登录。 */
export const CONTENT_ASSET_DIRS = ['cards', 'shots', 'videos', 'inspiration', 'viral', 'accounts', 'benchmarks']

const ASSET_REF_RE = new RegExp(`"(?:/|public/)(${CONTENT_ASSET_DIRS.join('|')})/[^"]+"`, 'g')

/** 一份产物引用到哪几个内容文件：集合里的键带前导斜杠，与浏览器实际请求的地址一个写法。
 *  产物里两种写法都有——图卡与封面是 `/cards/…`，产品档案的截图是 `public/shots/…`，
 *  界面按后者拼出 `/shots/…` 再请求，两种都得收进来才算这一屏真用到的文件。 */
export const assetRefs = (payload) =>
  new Set([...JSON.stringify(payload).matchAll(ASSET_REF_RE)].map((m) => {
    const rel = m[0].slice(1, -1)
    return rel.startsWith('public/') ? `/${rel.slice('public/'.length)}` : rel
  }))

/** 真产物 → 演示产物。`leaks` 非空就是造完自查发现还有东西不该出门，调用方决定停不停。
 *  `seededArticles: true` 是游客那一屏的口径：稿子一篇真的都不搬，连「已发布」也现造
 *  （演示站那份是号主自己决定公开的快照，游客这份没有这个前提，见 guest-core.mjs）。 */
export function demoProduct(raw, { downloadUrl = '', now = new Date(), seededArticles = false } = {}) {
  // 图卡在产物里是一张表，先按引用补回每条稿上，下面挑字段照旧读 a.card
  hydrateCards(raw)
  /** 账号只留「这个平台接进来了」这一件事：一平台一行，昵称、后台地址、脚本路径全部换掉或删掉 */
  const accounts = []
  for (const a of raw.accounts || []) {
    if (accounts.some((x) => x.platform === a.platform)) continue
    accounts.push({ id: a.id, platform: a.platform, key: a.key, nickname: '示例号', hasScript: false })
  }

  const published = seededArticles
    ? publishedSeed(accounts.map((a) => a.id), now)
    : (raw.articles || [])
        .filter((a) => a.status === 'published')
        .map((a) => ({ ...pick(a, ARTICLE_FIELDS), ...(a.card ? { card: pick(a.card, CARD_FIELDS) } : {}) }))

  /** 快照只留日粒度读数，逐平台的真实昵称一并换成示例号 */
  const snapshots = (raw.snapshots || []).map((s) => ({
    date: s.date,
    collectedAt: s.collectedAt,
    platforms: Object.fromEntries(Object.entries(s.platforms || {}).map(([k, p]) => [
      k, { ...p, ...(p.nickname ? { nickname: '示例号' } : {}) },
    ])),
  }))

  const profiles = (raw.productProfiles || []).map((p) => pick(p, PROFILE_FIELDS))
  const seed = demoSeed({ now, cardSample: sampleOf(published, profiles), ids: accounts.map((a) => a.id) })
  const drafts = demoDrafts(published, seed)

  const demo = {
    demo: true,
    generatedAt: now.toISOString(),
    // 静态托管没有 /__capabilities，界面那一圈「回桌面客户端」的出口只能从数据里拿
    clientDownloadUrl: downloadUrl,
    // 推广口径里那条 00-定位.md 全文是全仓唯一的定位事实源，不随演示站出门
    target: raw.target ? { ...raw.target, positioning: '' } : undefined,
    articles: [...published, ...drafts],
    accounts,
    snapshots,
    goals: raw.goals ?? [],
    revenue: raw.revenue ?? {},
    capabilities: raw.capabilities ?? null,
    cardThemes: raw.cardThemes ?? { themes: [], default: '', layouts: [] },
    products: raw.products ?? [],
    productProfiles: profiles,
    viralConfig: seed.viralConfig,
    loginState: seed.loginState,
    // 以下由 demo-seed.mjs 现造：界面上每一条都带「示例」或「（演示数据）」
    topics: seed.topics,
    quotes: seed.quotes,
    readings: seed.readings,
    viral: seed.viral,
    benchmarks: seed.benchmarks,
    knowledge: seed.knowledge,
    playbooks: seed.playbooks,
    collectRuns: seed.collectRuns,
    site: {},
  }

  /* 资源按引用收：产物 JSON 里点到哪个文件，才把那个文件搬进演示站。
     没发布的稿子其图卡不在 JSON 里，自然也就不会被搬走。 */
  const referenced = assetRefs(demo)

  const body = JSON.stringify(demo)
  return { demo, body, referenced, leaks: auditLeaks(raw, demo) }
}
