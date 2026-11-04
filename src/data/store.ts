/**
 * 数据运行时加载：本地服务（vite dev / scripts/serve.mjs / Electron 壳）提供
 * 最新 generated.json，不再构建时打进 bundle——桌面形态下内容改动即所见。
 * 服务在 gen:data 重建完成后经 /__events 推送：外部改动整页刷新（沿用原 Vite 整页 reload 的交互），
 * 界面自己点的写就地换数据（见 holdSelfWrite）。
 */
import { computed, reactive, ref } from 'vue'

/** 首屏数据只此一次机会：读不到就是整页空白，所以本地服务未就绪/正在重建时先重试几次 */
async function loadGenerated(tries: number): Promise<Record<string, any>> {
  try {
    // no-cache 而不是 no-store：每次照样回服务端对一遍（数据改了立刻看见），但没改时只花一次 304，
    // 不用把这 3MB 出头的产物整份重搬一遍——改动由 SSE 广播驱动，这里不承担新鲜度以外的活
    const r = await fetch('generated.json', { cache: 'no-cache' })
    // 服务器上那份对没登录的这一趟给的是游客那一屏（产物里带 viewer:'guest'）。
    // 这里只兜住拿不到演示数据的两种边角——老服务、纯静态托管：照样按游客走，
    // 不许再把界面锁成一屏登录（未登录本来就该逛得进来）。
    if (r.status === 401) return { viewer: 'guest', demo: true }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } catch (e) {
    if (tries <= 1) throw new Error('本地数据服务未就绪，界面数据没读到')
    await new Promise((ok) => setTimeout(ok, 600))
    return loadGenerated(tries - 1)
  }
}
const raw: Record<string, any> = await loadGenerated(4)

/**
 * SSE 整页刷新挂起位。**加载期初值是 true**，不是 false：推送进行中刷新页面时，「页面加载 →
 * 接上服务端推送队列」这条窗口里任何一条 gen:data 广播都会把页面再整页 reload 一次；队列每推完
 * 一版就 refresh 一次，广播密度高时页面反复自重载，进度条永远挂不上，看着就像「一刷新推送就没了」
 * （2026-10-25 实测）。探查给出结论后由 resolveAutoRefreshHold 放行：队列在跑 → 继续挂起等
 * finishPush 收尾；没跑 → 恢复「外部改动自动刷新」。
 * 界面自己原地处理更新时（创作台存图卡文字后要换图）照旧 setHoldAutoRefresh(true)，别把弹层冲掉。
 * 兜底：探查 5 秒没回话（服务异常）自动放行——挂起刷新不该把「外部改动自动刷新」一起陪葬。
 */
let holdRefresh = true
export function setHoldAutoRefresh(on: boolean) {
  holdRefresh = on
}
/** 挂起期间到达的广播先记一笔：放行时补一次整页刷新，外部改动不许被加载窗口吞掉 */
let refreshPending = false
function releaseHold() {
  holdRefresh = false
  if (refreshPending) {
    refreshPending = false
    location.reload()
  }
}
let holdProbeSettled = false
const holdProbeFallback = setTimeout(() => {
  if (!holdProbeSettled) releaseHold()
}, 5000)
/** 页面加载期的推送队列探查结论（store 模块级单发，StudioView 接进度用的是同一个 promise）：
 *  在跑 → 挂起等 finishPush；没跑 → 放行，顺带补跳挂起期间到达的广播 */
export function resolveAutoRefreshHold(running: boolean) {
  holdProbeSettled = true
  clearTimeout(holdProbeFallback)
  if (running) holdRefresh = true
  else releaseHold()
}

/** 界面自己发起的写只动这四张列表（建卡改状态、落稿骨架、归档移文件），
 *  重建完成后就地换掉数组内容即可，不必整页刷——刷一次丢滚动位置、丢筛选，还白屏一下。
 *  外部改动（扩展入库、定时采集、Agent 写卡）照旧整页刷：那些动的是别的列表，说不清变了什么。
 *  开窗而不是只挂一次：一次写常引出两三次重建（归档=移文件+改状态），只吸收第一条广播的话，第二条照样把页面刷掉。 */
const SELF_WRITE_WINDOW = 30_000
let selfWriteUntil = 0
export function holdSelfWrite() {
  selfWriteUntil = Date.now() + SELF_WRITE_WINDOW
}

function swap<T>(into: T[], next: T[]) {
  into.splice(0, into.length, ...next)
}

/** 就地换掉一张表的内容（保留同一个 reactive 对象，订阅方不用重挂） */
function reassign<K extends string, V>(into: Record<K, V>, next: Record<string, V>) {
  for (const k of Object.keys(into)) delete into[k as K]
  Object.assign(into, next)
}

/** 演示与游客那一屏按白名单挑字段，稿面上没有「草稿推到哪个平台、什么时候推的」这一排；
 *  界面按排期算发布状态的地方都直接读它，所以进门处补齐一次，别在每张表上各挡一刀。 */
let cardTable: Record<string, unknown> = (raw as Record<string, any>).cards ?? {}

function toArticles(list: unknown): Article[] {
  return (Array.isArray(list) ? list : []).map((a: any) => {
    const art: any = { ...a, draftPushed: a.draftPushed ?? {} }
    // 图卡在产物里是一张表（一个选题五个平台稿共用一张，内嵌就是五份同样的字）：
    // 按稿上的 cardSlug 补回 card，视图照旧读 a.card；本来带卡的那两份（演示、游客）不动
    if (!art.card && art.cardSlug) art.card = cardTable[art.cardSlug] ?? null
    return art
  })
}

/** 把拉到的数据换进这几张表（保留同一批 reactive 对象，订阅方不用重挂） */
function swapTables(j: Record<string, any>) {
  cardTable = (j.cards ?? cardTable) as Record<string, unknown>
  swap(articles, toArticles(j.articles))
  swap(readings, (j.readings ?? []) as Reading[])
  swap(viral, (j.viral ?? []) as ViralItem[])
  swap(topics, (j.topics ?? []) as TopicCard[])
  // 授权页走完扫码要就地看到新登录态，不能整页刷（弹层会被冲掉）
  swap(accounts, (j.accounts ?? []) as Account[])
  reassign(loginState.platforms, (j.loginState?.platforms ?? {}) as Record<string, LoginEntry>)
  loginState.checkedAt = j.loginState?.checkedAt
  // 口径弹窗保存后服务端会重建广播：这里就地换上新口径，页面不整页刷
  viralScope.value = (j.viralConfig ?? null) as ViralScope | null
  // 产品页存完档案要就地看到新入口/口径，整页刷会把刚填的东西冲没
  swap(products, (j.products ?? []) as string[])
  swap(productProfiles, (j.productProfiles ?? []) as ProductProfile[])
  // 模板选择器存候选/转正/删掉动的是这两张表：就地换上，弹层里立刻看见新条目
  if (j.cardThemes) {
    swap(cardThemes.themes, (j.cardThemes.themes ?? []) as CardTheme[])
    swap(cardThemes.layouts, (j.cardThemes.layouts ?? []) as CardLayout[])
    cardThemes.default = j.cardThemes.default ?? cardThemes.default
    cardThemes.fontStack = j.cardThemes.fontStack ?? cardThemes.fontStack
  }
  if (j.cardTemplates) {
    swap(cardTemplates.templates, (j.cardTemplates.templates ?? []) as CardTemplate[])
    cardTemplates.default = j.cardTemplates.default ?? cardTemplates.default
  }
  if (j.videoTemplates) {
    swap(videoTemplates.templates, (j.videoTemplates.templates ?? []) as VideoTemplate[])
    videoTemplates.default = j.videoTemplates.default ?? videoTemplates.default
  }
}

/** 就地重拉这几张列表；拉不到就退回整页刷，别让用户停在旧数据上。
 *  重建可能连着来第二条广播，所以跑完要补一次，确保最后落在最新数据上。 */
let resyncing = false
let resyncPending = false
async function resync() {
  if (resyncing) {
    resyncPending = true
    return
  }
  resyncing = true
  do {
    resyncPending = false
    try {
      swapTables(await loadGenerated(3))
    } catch {
      location.reload()
      return
    }
  } while (resyncPending)
  resyncing = false
}

/**
 * 界面开着弹层时，把重建广播吸成就地换表。
 * 只靠 30 秒窗口接广播不靠谱：一次写常引出两三次重建（存候选 + 渲小样各一次），队列能排到几十秒后，
 * 窗口一过，迟到的那条就把人正开着的弹层整页刷掉（2026-10-28 实测：存完克隆候选，模板选择器自己没了）。
 * 计数而不是布尔——弹层会套弹层，里面那层关了不能把外面那层的保护一起解掉；
 * 全部关掉之后恢复「外部改动整页刷」，另留 30 秒窗口兜住最后一批尾巴。
 */
let absorbDepth = 0
export function absorbBroadcasts(): () => void {
  absorbDepth++
  return () => { absorbDepth = Math.max(0, absorbDepth - 1) }
}


/** 数据断了：重建失败时 generated.json 还是旧的，界面挂着不动看着一切正常——那一屏必须说出来 */
export const dataError = ref<{ error: string; action?: string } | null>(null)

/** 设置弹层开在哪一屏：任何一站都能把要补的东西指回这里（看板那张接机卡靠它把「填 Key」「装料」收成一个出口） */
export const settingsPanel = ref<'config' | 'machine' | null>(null)

/* ==================== 这一份工作台跑在什么机器上 ====================
 * 服务器上对外那一份没有本机浏览器桥（采集、推草稿、扫码授权、渲染都要它），服务端把那些端点
 * 挡在 409，同时用 /__capabilities 说明自己是远程模式。界面只认这一个结论来降级，
 * 不在各个按钮里各判一次——降级口径改一处就够。 */
export const bridgeMode = ref<'local' | 'remote'>('local')
export const clientDownloadUrl = ref('')
export const isRemote = computed(() => bridgeMode.value === 'remote')

/* 这台机器能用人哪种登录法：GitHub、Google 要凭据、邮箱码要发件箱，缺一样就别在界面上摆一个点了只会报错的按钮。
   默认按本机常见情形给（配了发件箱、没配两家 OAuth），结论由 /__capabilities 覆盖。 */
export const loginViaGithub = ref(false)
export const loginViaGoogle = ref(false)
export const loginViaMail = ref(true)

/** 游客那一屏：手上这份是服务端按身份给的演示产物，跟号主盘上的真东西没关系。
 *  界面照常渲染，谁动手谁登录——写操作吃到 401 会弹那一层（见 useAuth 里的 fetch 守卫）。 */
export const isGuest = computed(() => raw.viewer === 'guest')

/** 演示站那一份（数据由 scripts/build-demo-data.mjs 现造）：站一站不少，但采集、选题、对标、
 *  知识库这几站吃的是 demo-seed.mjs 造的示例数据，真账号名与别人的原文一律不出门。
 *  界面只靠它换顶部那一条横幅与落地页，不在各站里另判一次。 */
export const isDemoSite = computed(() => !!raw.demo)
if (raw.clientDownloadUrl) clientDownloadUrl.value = String(raw.clientDownloadUrl)

/** 这台机器能不能替人把稿子推进平台草稿箱：脚本在盘上是一回事，有没有本机浏览器桥是另一回事。
 *  远程那份两者都算过才算有。 */
export const hasPushBridge = (account: string) =>
  !!accounts.find((a) => a.id === account)?.hasScript && !isRemote.value

/** 结论到手前别起轮询：默认值是按本机给的，远程那份一上来就每 3 秒吃一个 409 是纯浪费 */
export const capabilitiesReady = (async () => {
  try {
    const o = await (await fetch('/__capabilities')).json()
    if (o?.mode === 'local' || o?.mode === 'remote') {
      bridgeMode.value = o.mode
      // 演示站那份是静态的，下载去处写在 generated.json 里：服务端没话说就别把已有答案抹掉
      if (o.downloadUrl) clientDownloadUrl.value = o.downloadUrl
      if (o.auth) {
        loginViaGithub.value = !!o.auth.github
        loginViaGoogle.value = !!o.auth.google
        // 本机没配发件箱也能登：服务端把码打进日志，弹层会说码在哪。只有远程那份才真发不出去
        loginViaMail.value = !!o.auth.mail || o.mode === 'local'
      }
    }
  } catch {
    // 纯静态托管连端点都没有：那种机器同样没有桥，按远程处理，两条登录法都没有
    bridgeMode.value = 'remote'
    loginViaGithub.value = false
    loginViaGoogle.value = false
    loginViaMail.value = false
  }
})()

/* ==================== 起步向导：四步只认盘上产物，判据全在服务端 start-guide.mjs ==================== */
export interface GuideStep {
  n: number
  id: string
  title: string
  state: 'ready' | 'todo'
  detail: string
  next: string
  /** 这一步把人送去哪：'' = 就在这一步里做掉，machine = 设置里的「本机」，accounts = 账号页 */
  jump: string
}
export interface Guide { ok: boolean; at: string; dismissed: boolean; doneAt: string; steps: GuideStep[] }

export const guide = ref<Guide | null>(null)

/** 「把这台机器接上」这张卡只在还没走通、而且没说过「别再给我看」时挂在看板顶上——走通了它就该消失 */
export const guideVisible = computed(() => !!guide.value && !guide.value.ok && !guide.value.dismissed)

export async function loadGuide() {
  try {
    const o = await (await fetch('/__start-guide')).json()
    if (o?.steps) guide.value = o as Guide
  } catch { /* 静态托管等无本地服务场景：这一站不出现就是了 */ }
}

/** 收起/重新打开这一站：只记在本机，不动任何一步的判据 */
export async function setGuideDismissed(on: boolean) {
  await fetch('/__start-guide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: on ? 'dismiss' : 'again' }) }).catch(() => {})
  await loadGuide()
}

// 远程那份没有接机这一说（要装的东西都在你自已电脑上）：结论没到就探只会吃一个 409
void capabilitiesReady.then(() => { if (!isRemote.value) loadGuide() })

try {
  new EventSource('__events').onmessage = (ev) => {
    let msg: { type?: string; error?: string; action?: string } = {}
    try { msg = JSON.parse(ev.data) } catch { /* 旧广播没带 payload */ }
    if (msg.type === 'data-error') {
      dataError.value = { error: msg.error || '数据重建失败', action: msg.action }
      return // 不刷页：刷了拿到的还是旧数据，反而把原因冲掉
    }
    dataError.value = null
    // 加载期的挂起（等推送队列探查结论）：广播先记下，放行时补刷，不吞
    if (holdRefresh) {
      refreshPending = true
      return
    }
    if (absorbDepth > 0 || Date.now() < selfWriteUntil) {
      void resync()
      return
    }
    location.reload()
  }
} catch {
  /* 静态托管等无 SSE 场景：不自动刷新，手动 reload 即可 */
}

export type TopicStatus = 'not_start' | 'creating' | 'ready' | 'published'

/** 落地链接：内容最终把人送到哪。placement 说明该平台怎么放（小红书正文放链接会限流） */
export interface LandingLink {
  url: string
  placement: string
}

export interface Landing {
  primary: string
  byPlatform: Record<string, LandingLink>
  utm: boolean
  /** 本条用的 UTM campaign（手填「活动标识」优先，否则用文章 id） */
  campaign: string
}

export interface ArticleMetrics {
  link: string
  views: number | null
  likes: number | null
  collects: number | null
  comments: number | null
  shares: number | null
  follows: number | null
  /** 视频/图文完播（完读）率原样字符串，如 "2.3%"；缺则空串 */
  completeRate: string
  bounce: string
}

/** 这一版的成果素材：图卡（render-cards 的产物清单，图在 public/cards/<slug>/）或视频成片。
 *  纯视频稿没有卡片 json——video 来自稿上的「视频素材：」行，jsonRel 为空。 */
export interface CardAsset {
  slug: string
  title: string
  /** 卡片 json 相对仓库根；保存文字改动时按它落盘。纯视频稿为空串 */
  jsonRel: string
  /** 卡片 json 本体（逐页文字 + 版式参数）：「编辑文字」的表单源 */
  data?: Record<string, any> | null
  /** json 声明的页数；图还没渲染时用它说「该有几页」 */
  pageCount: number
  /** 视频素材路径（相对仓库根或绝对路径）——卡片 json 的 video 字段或稿上的「视频素材：」行；空 = 本版没有视频 */
  video: string
  /** 素材在 public/ 下时的浏览器可播地址，否则空串 */
  videoUrl: string
  /** 已渲染出图的站点内路径，空数组 = 还没跑 render:card */
  urls: string[]
}

export interface Article {
  id: string
  title: string
  file: string
  date: string | null
  stage: 'pending' | 'scheduled'
  /** 所属账号（发布排期/<账号>/ 目录名）：一稿一号，账号即发布平台 */
  account: string
  status: TopicStatus
  identity: string
  intent: string
  /** 灵感来源（创作信息里的「灵感来源」），可回链到灵感库条目 */
  source: string
  openingType: string
  /** 手填的转化活动标识（UTM campaign）。留空则用文章 id */
  campaign: string
  /** 归属品牌（创作信息「归属品牌」）：多品牌推广的分格字段，空 = 人格内容（不挂品牌） */
  product: string
  body: string
  /** 这一版真正发出去的文字：短文案平台取自己的文案段，长文案平台即 body */
  copy: string
  /** copy 在稿里的段名（正文 / 文案 / 贴图描述），界面标题用它 */
  copyLabel: string
  caption: string
  tags: string
  firstComment: string
  /** 这一版会吃到的默认配乐名（脚本按平台决定配不配）；空 = 这个平台不配乐 */
  music: string
  /** 图文成果：同名卡片 json + public/cards/<slug>/ 渲染产物。纯文字/视频稿为 null */
  card: CardAsset | null
  metrics: ArticleMetrics
  metricsFilled: boolean
  /** 读数状态：filled=有数 / platform_gap=平台给了这篇但没给这项 / not_collected=还没采到 */
  dataState: 'filled' | 'platform_gap' | 'not_collected'
  /** 「## 这篇教会了我们什么」段全文（复盘学习环；数据复盘页可原地写回） */
  lesson: string
  /** 已发布的平台（markdown 里「发布链接-<平台>」非空的平台名） */
  publishedPlatforms: string[]
  /** 平台 → 发布链接 */
  publishLinks: Record<string, string>
  /** 平台 → 草稿推送时间（「草稿已推-<平台>」） */
  draftPushed: Record<string, string>
  /** 平台 → 自动检测命中（后台已发布列表按标题匹配），免人工标记 */
  detected: Record<string, { publishedAt: string | null; url: string }>
  /** 「## 转化数据」段（手填）。内容数据说明传播，转化数据才说明值不值 */
  conversion: Record<string, string>
  /** 本条内容的落地链接（UTM campaign = 本条 id，便于逐条归因） */
  landing: Landing
}

export interface Quote {
  id: string
  category: string
  text: string
  source: string
}

/** 采集卡 AI 拆解块，五层口径见 content/Knowledge/爆款拆解.md */
export interface ReadingAnalysis {
  /** 一句话（40 字内）说清这条为什么火：详情右栏顶部那一行，不在五层里 */
  why?: string
  subject: string
  hook: string
  structure: string
  emotion: string
  mechanism: string
}

/** 拆解五层展示顺序（灵感库/爆款采集/选题详情共用），口径见 content/Knowledge/爆款拆解.md */
export const ANALYSIS_SECTIONS: { key: keyof ReadingAnalysis; label: string }[] = [
  { key: 'subject', label: '① 主题' },
  { key: 'hook', label: '② 钩子' },
  { key: 'structure', label: '③ 结构' },
  { key: 'emotion', label: '④ 情绪' },
  { key: 'mechanism', label: '⑤ 机制' },
]

/** 没有实图的卡（选题库/创作台）封面用色块 + 大字：色由 id 稳定散列，与有实图的采集卡区分开 */
const TONES = ['var(--color-neo-yellow)', 'var(--color-neo-green)', 'var(--color-neo-pink)', 'var(--color-neo-blue)', 'var(--color-neo-purple)']
export function toneOf(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return TONES[h % TONES.length]
}

export interface Reading {
  id: string
  title: string
  file: string
  chars: number
  /** 内容形态：video=视频笔记，image=图文（build-data 按 frontmatter format 或链接/正文线索推断） */
  format: string
  excerpt: string
  /** AI 拆解（frontmatter analysis 块），未拆解为 null */
  analysis: ReadingAnalysis | null
  analyzedAt: string | null
  /** 原笔记自带的话题标签（如「#低能量」） */
  tags: string
  /** 来源（如「小红书 @作者」；链接采集的为 link；收藏搬运的为 favorite） */
  source: string
  /** 采集时登记的源平台中文名（收藏搬运卡靠它标出处） */
  platform: string
  /** 原作者昵称（收藏搬运卡有；手动采集的老卡为空，出处写在 source 里） */
  author: string
  /** 原文链接 */
  url: string
  /** 发布时那篇正文（详情页读回来的原话）；老卡为空 */
  desc: string
  /** 封面图（public/ 下）。无封面的采集卡不进这里 */
  coverImage: string
  /** 原笔记逐页源图（按采集顺序，第一张即原版封面页时以 coverImage 为准） */
  images: string[]
  /** 视频卡的源片（采集时落盘 public/inspiration/<id>/source.mp4）；图文卡与没搬回源片的老卡为空 */
  videoUrl: string
  /** 原笔记互动数据 */
  likes: string | null
  collects: string | null
  comments: string | null
  postedAt: string | null
  /** 笔记全文（详情页展示） */
  body: string
  /** 完整脚本：图文＝逐页图内文字，视频＝全程口播逐字稿（卡的「## 脚本」段，老卡回落全文） */
  script: string
  /** 由它立项的选题 id（build-data 按选题卡的「来源文件」回链填，不是日期）；空 = 未立项 */
  converted: string
  /** 收藏搬运卡的入库日期（frontmatter collected，只有日期无时刻）；手动采集卡为空 */
  collectedAt: string
  /** 收藏列表当时的序号（0 = 最新一条），每次同步重刷；非收藏卡为 null */
  favOrder: number | null
  /** 由它立项的选题卡 id（以选题池「来源文件」回链解析，同一条笔记的其他副本也会带上），空 = 未立项；
   *  收集列表按它隐藏，回看走「历史」 */
  convertedTopic: string
}

/** 爆款采集（自动线）的一张卡：自动搜索只到卡片，完整脚本由拆解那步补采回卡的「## 脚本」段 */
export interface ViralItem {
  id: string
  /** 来源平台，取 PLATFORM_META 的 key；界面按它分组 */
  platform: string
  /** 内容形态：video / image（采集时从搜索卡记录，老卡按链接推断） */
  format: string
  /** 原笔记发布日期（笔记 ID 前 8 位推算）。判断内容新旧看这个，不是 capturedAt */
  publishedAt: string
  title: string
  /** 原笔记作者（卡片 frontmatter author）：详情头栏那一行 */
  author: string
  /** 发布时那篇正文（详情页读回来的原话）；老卡为空 */
  desc: string
  /** 原笔记自带话题（详情页读回来的，一串 #xx）；老卡为空 */
  tags: string
  likes: string
  collects: string
  comments: string
  /** 互动分（赞1/藏2/评3），build-data 算好：0 = 三个读数一个都没采到，不等于「不火」 */
  heat: number
  /** 视频源片时长（秒），老卡没登记为 0 */
  durationSec: number
  coverImage: string
  /** 逐页原图（采集搬回的源料 public/viral/<平台>/<id>/，单页卡回落封面）——弹层里就地翻看原文 */
  images: string[]
  /** 视频源片（public 下相对路径，采集搬回 source.mp4）；图文卡与没搬回源料的老卡为空 */
  videoFile: string
  url: string
  /** 命中它的定位关键词 */
  keyword: string
  capturedAt: string
  /** 立项日期（卡片 frontmatter convertedToTopic），仅作留痕；空 = 未立项 */
  converted: string
  /** 由它立项的选题卡 id（以选题池「来源文件」回链解析，同一条笔记的其他副本也会带上），空 = 未立项；
   *  采集列表按它隐藏，回看走「历史」 */
  convertedTopic: string
  /** AI 拆解（卡片 frontmatter analysis 块，口径见 Knowledge/爆款拆解.md），未拆解为 null */
  analysis: ReadingAnalysis | null
  analyzedAt: string | null
  /** 爆款评分总分（卡片 frontmatter researchScore），未评分为 null */
  researchScore: number | null
  /** 完整脚本（卡片「## 脚本」段）：视频＝全程口播逐字稿，图文＝逐页图内文字；空 = 还没补采 */
  script: string
  file: string
}

/** 草稿已改为文件驱动：content/…/<账号>/待发布/*.md，正文为空 = 草稿态。
 *  「生成选题」由前端 POST /__draft 落文件；浏览器的 localStorage 便签已废弃。 */

// generated.json 的键随平台增减，TS 从 JSON 推出来的 union 带 undefined 分支，直转要经 unknown
export const articles = reactive(toArticles(raw.articles))
export const quotes: Quote[] = (raw.quotes ?? []) as Quote[]
/** 这四张要能被 resync() 就地换掉（见 holdSelfWrite），所以包 reactive；其余列表仍走整页刷新 */
export const readings = reactive((raw.readings ?? []) as Reading[])
export const viral = reactive(((raw as Record<string, unknown>).viral ?? []) as ViralItem[])

/** 最近一次爆款采集的日期（卡上只有日期，无时刻） */
export const lastViralAt: string | null = viral.reduce<string | null>(
  (max, v) => (v.capturedAt && (!max || v.capturedAt > max) ? v.capturedAt : max),
  null,
)

/* ==================== 本机技能 ====================
 * 对话输入框「技能」菜单的唯一来源：能力登记表里 kind=skill 的条目（config/capabilities.json
 * 经 build-data 注入）。菜单只认这张表，不在前端另列一份技能名。 */
export interface SkillItem {
  ref: string
  label: string
  desc: string
}
export const skillItems: SkillItem[] = (
  ((raw.capabilities?.stages ?? []) as { items: Record<string, unknown>[] }[])
    .flatMap((s) => s.items ?? []) as unknown as (SkillItem & { kind: string })[]
).filter((i) => i.kind === 'skill' && i.ref && i.label)

/* ==================== 爆款采集口径 ====================
 * 数据源：config/viral.json（唯一事实源，改关键词/平台/门槛只动它，脚本不硬编码）。
 * 采集页「当前采集口径」条读它：自动线在采什么必须看得见，锁在配置文件里等于黑盒。
 * 配置缺失或读不动时为 null，界面不摆这条（不编造口径）。 */
export interface ViralScope {
  /** 定位关键词（两平台共用同一批） */
  keywords: string[]
  /** 搜索平台（PLATFORM_META 的 key） */
  platforms: string[]
  /** 硬门槛：点赞不到这个数不算爆款 */
  minLikes: number
  /** 评论门槛：详情页读到评论才判，0 = 不判 */
  minComments: number
  /** 时间窗：只要近 N 天发布的 */
  withinDays: number
  /** 每平台每天入库条数上限 */
  dailyLimitPerPlatform: number
  /** 搜索结果滚页轮数（候选池大小） */
  scrollRounds: number
}
export const viralScope = ref<ViralScope | null>(
  ((raw as Record<string, unknown>).viralConfig ?? null) as ViralScope | null,
)
/** 最近一次收藏搬运的日期：认收藏卡 collected 的最大值。跑一轮没新内容就不前进（与爆款同款口径） */
export const lastFavoriteAt: string | null = readings.reduce<string | null>(
  (max, r) => (r.source === 'favorite' && r.collectedAt && (!max || r.collectedAt > max) ? r.collectedAt : max),
  null,
)

/* ==================== 当前推广对象 ====================
 * 来自 config/active-target.mjs，经 build-data 注入。
 * 界面（如侧边栏「配置」面板）只读这里，绝不写死品牌名——换产品只改 config。
 */

export interface PromotionTarget {
  /** app | website | shop | course | service */
  type: string
  brandName: string
  /** 定位单一事实源：content/Knowledge/00-定位.md 全文 */
  positioning: string
  productPerspective: string[]
  signature: string
  brandTag: string
  /** 转化落点：站点级落地链接（每条内容的版本见 article.landing） */
  landing: Landing
}

export const target = (raw as Record<string, unknown>).target as PromotionTarget | undefined

export const STATUS_TEXT: Record<TopicStatus, string> = {
  not_start: '草稿',
  creating: '草稿',
  ready: '待发布',
  published: '已发布',
}

export const STATUS_CLASS: Record<TopicStatus, string> = {
  not_start: 'status-not-start',
  creating: 'status-creating',
  ready: 'status-ready',
  published: 'status-published',
}

export const PLATFORM_COLORS: Record<string, string> = {
  公众号: 'var(--color-neo-purple)',
  小红书: 'var(--color-neo-pink)',
  抖音: 'var(--color-neo-blue)',
  快手: 'var(--color-neo-yellow)',
  B站: 'var(--color-neo-purple)',
  视频号: 'var(--color-neo-green)',
}

/** 一稿一号：账号即发布平台（发布排期/<账号>/ 目录），同一选题多账号=各目录各一份稿 */
export const accountPlatforms = (a: Article): string[] => (a.account ? [a.account] : [])

/** 统一视图条目：全部来自文件（正文为空 = 草稿态） */
export interface TopicItem {
  id: string
  kind: 'draft' | 'article'
  title: string
  status: TopicStatus
  date: string | null
  platforms: string[]
  account: string
  article: Article
}

export const topicItems = (): TopicItem[] =>
  articles.map<TopicItem>((a) => ({
    id: a.id,
    kind: a.status === 'not_start' ? 'draft' : 'article',
    title: a.title,
    status: a.status,
    date: a.date,
    platforms: accountPlatforms(a),
    account: a.account,
    article: a,
  }))

/** 本机日历日 YYYY-MM-DD——和 scripts/day-core.mjs 的 localDay 同一把尺。
 *  不用 toISOString：UTC 截会把东八区凌晨那几趟（07:40 爆款采集、08:42 晨间补检）算到前一天，
 *  快照桶名、卡片采集日期与这里的「今天」就对不上，界面表现为「今天没采到」而文件其实写了。 */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const TODAY = localDay(new Date())

export function articlesOn(date: string) {
  return articles.filter((a) => a.date === date)
}

/* ==================== 账号泳道三态（发布日历与「今日」共用一份口径） ====================
 * 「已发布」不靠人工标记：后台已发布列表按标题自动检测命中（detected）同样算。
 * 一条泳道 = 一个**账号**（不是一个平台）：同平台两个号就是两条泳道，各自的草稿与各自的发布。 */
export interface Lane {
  /** 账号 id（accounts.json） */
  account: string
  /** 泳道显示用：账号名（同平台多号时带昵称） */
  label: string
  platform: string
  article: Article | null
}
export type LaneState = 'published' | 'drafted' | 'pending' | 'missing'

export function lanePublished(a: Article, account: string) {
  return a.publishedPlatforms.includes(account) || !!a.detected[account] || (!!a.metrics.link && !a.publishedPlatforms.length)
}

/** 这一轮能不能判定这个号的发布状态：它的后台已发布列表采到了（登录 ok），或稿子里手填过发布链接。
 *  采不到（掉线 / 接口没读到）时既不能判「已发」也不能判「没发」——摆成灰色未发是撒谎。 */
export function laneJudgeable(l: Lane) {
  return !!l.article && (lanePublished(l.article, l.account) || loginOf(l.account)?.state === 'ok')
}

/** 参与「几/几」分母的泳道：只数判得了的 */
export function judgeableLanes(lanes: Lane[]) {
  return lanes.filter(laneJudgeable)
}

export function laneState(l: Lane): LaneState {
  if (!l.article) return 'missing'
  if (lanePublished(l.article, l.account)) return 'published'
  if (l.article.draftPushed[l.account]) return 'drafted'
  return 'pending'
}

/** 这一版到期未发：日期已到、还没判发布、且稿子已排期或草稿已在平台里。
 *  判不了的泳道不进待办——没采到列表不等于我没发，催出来的是假账。 */
export function laneDue(l: Lane) {
  const a = l.article
  if (!a || !a.date || a.date > TODAY || laneState(l) === 'published') return false
  if (!laneJudgeable(l)) return false
  return a.status === 'ready' || a.status === 'published'
    || (a.status === 'creating' && Object.keys(a.draftPushed).length > 0)
}

/** 指定账号清单 → 泳道：选题卡上过「投放平台」的按那份清单，缺版也占一格 */
export function lanesOf(items: Article[], ids: string[]): Lane[] {
  return [...new Set(ids)].map((id) => ({
    account: id,
    label: accountLabel(id),
    platform: platformOf(id),
    article: items.find((i) => i.account === id) || null,
  }))
}

/** 一组稿（同一选题的各版）→ 泳道：按账号登记顺序，缺版也占一格（显示「缺版」） */
export function lanesFor(items: Article[]): Lane[] {
  const ids = accounts.length ? accounts.map((a) => a.id) : [...new Set(items.map((i) => i.account))]
  return lanesOf(items, [...new Set([...ids, ...items.map((i) => i.account)])])
}

/** 单篇稿自成一条泳道：「今日」的催办行一篇就是一版，不需要按选题聚合 */
export function laneOfArticle(a: Article): Lane {
  return { account: a.account, label: accountLabel(a.account), platform: platformOf(a.account), article: a }
}

export function monthKey(date: string) {
  return date.slice(0, 7)
}

/* ==================== 平台快照 ====================
 * 数据来源：`npm run collect`（ego-browser 读创作者后台）→ metrics/raw/<date>.json
 * → build-data.mjs → generated.json.snapshots
 * 一个快照点 = 一次采集。累计量（粉丝/赞藏）可用于画趋势，周期量为区间值。
 */

export interface PlatformNote {
  title: string
  published: string | null
  rejected: boolean
  exposure: number | null
  views: number | null
  ctr: number | null
  likes: number | null
  comments: number | null
  collects: number | null
  follows: number | null
  shares: number | null
  avgWatch: string | null
}

export interface PlatformSnapshot {
  nickname: string
  followers: number | null
  following: number | null
  likesCollects: number | null
  likes: number | null
  period: string | null
  metrics: Record<string, number | null>
  /** 逐日数据（后台接口原文归一化），空数组 = 该快照采集时还没有日维度能力 */
  daily: DailyPoint[]
  notes: PlatformNote[]
  /** publish-check 采的已发布内容列表（标题匹配自动判发布的输入） */
  publishedList: { title: string; publishedAt: string | null; url: string }[]
}

/** 一日一平台的原子读数，字段缺失为 null（区别于 0） */
export interface DailyPoint {
  date: string
  views: number | null
  exposure: number | null
  likes: number | null
  collects: number | null
  comments: number | null
  shares: number | null
  new_followers: number | null
}

export type DailyMetric = keyof Omit<DailyPoint, 'date'>

export interface Snapshot {
  date: string
  collectedAt: string | null
  /** 最近一次「已发布列表」回认落盘的时间。只跑 publish-check 不会提前 collectedAt */
  publishedListAt?: string | null
  platforms: Record<string, PlatformSnapshot>
}

export const snapshots: Snapshot[] = ((raw as Record<string, unknown>).snapshots ?? []) as Snapshot[]

/** 最近一次采集/体检真正落盘的时间。界面上的「上次同步」只认这个，
 *  不能用数据生成时间 —— 改一个 md 也会重算数据，那个时间不代表数是新采的。 */
export const lastSyncAt: string | null = snapshots.reduce<string | null>(
  (max, s) => (s.collectedAt && (!max || s.collectedAt > max) ? s.collectedAt : max),
  null,
)

/** 发布日历的「上次同步」：指标采集与发布回认写同一份快照，任一落了新时间都要显出来，
 *  否则刚补跑完回认，界面还停在几小时前，看着像根本没同步过。 */
export const lastPublishSyncAt: string | null = snapshots.reduce<string | null>(
  (max, s) => {
    for (const t of [s.collectedAt, s.publishedListAt]) {
      if (t && (!max || t > max)) max = t
    }
    return max
  },
  null,
)

/** 最新一次采集 */
export const latestSnapshot: Snapshot | null = snapshots.length ? snapshots[snapshots.length - 1] : null

/* ==================== 采集运行读数（页头运行条的数据源） ====================
 * 留痕来自 metrics/collect-runs.json：一条 = 一次运行，逐平台结果由产物反推（scripts/collect-runs.mjs），
 * 不是脚本自报。界面只报真实落盘读数——不写频率、不报平安，口径见
 * docs/superpowers/specs/2026-10-22-collect-run-surface.md §五。 */

export type CollectTask = 'collect' | 'viral' | 'favorites' | 'benchmark' | 'publish-check'

/** 单飞队列里每条任务在界面上的名字：页头运行条、右上角浮层与各处「已有任务在跑」都从这里取，
 *  同一个活儿在一屏上出现两次不能是两个字。名字跟着界面上那颗键走（收藏那趟叫「同步收藏」），
 *  服务端 TASK_CN 那份是排班留痕的口径（同一趟叫「收藏搬运」），两边不许在界面上混用。 */
export const SYNC_TASK_LABEL: Record<string, string> = {
  collect: '数据复盘', viral: '爆款采集', 'viral-search': '搜爆款', 'viral-capture': '爆款入库',
  favorites: '同步收藏', benchmark: '对标采集', 'benchmark-one': '对标采集',
  'benchmark-search': '收对标', 'benchmark-capture': '对标建档',
  'publish-check': '发布回认', login: '账号授权', 'login-new': '账号授权',
  'open-backend': '打开后台', 'press-publish': '就地发布',
  note: '笔记采集', 'fetch-bin': '组件下载', backup: '内容备份',
}

export interface RunPlatform {
  state: 'ok' | 'error'
  count: number
  note: string
}

export interface CollectRun {
  task: CollectTask
  /** 落盘日（脚本与留痕同一把尺：UTC 截的日期） */
  day: string
  startedAt: number
  finishedAt: number
  exitCode: number
  stopped: boolean
  ok: boolean
  partial: boolean
  failedPlatforms: string[]
  platforms: Record<string, RunPlatform>
  counts: Record<string, number>
  tail: string
}

const collectRuns: CollectRun[] = ((raw as Record<string, unknown>).collectRuns ?? []) as CollectRun[]

/** 八态里留痕能定死的六种；运行中/被挡要问 /__run-script 的实时态，不在这里判 */
export type RunSurfaceState = 'never' | 'stale' | 'aged' | 'failed' | 'partial' | 'fresh'

export interface RunReading {
  state: RunSurfaceState
  /** 上次采到的时刻（ISO）；没有留痕（改造前跑的历史轮次）时退到产物落盘读数 */
  at: string | null
  /** 距最近一次成功落盘隔了几个自然日；从未落盘为 null */
  gapDays: number | null
  /** 逐平台结果与条数，只有本轮留痕里有的才有 */
  platforms: Record<string, RunPlatform>
  /** 本轮没采到的平台 key */
  failed: string[]
  /** 失败/断档原因，一句话；正常态为空——界面不报平安 */
  reason: string
  /** 本轮是被人工停的 */
  stopped: boolean
}

/** 各任务的应得落盘时刻 = 定义文件的触发时间 + 抖动上限 + 预计耗时（config/cron/*.md）。
 *  只用来判「今天这轮该不该落了」，界面上不显示频率——那是排期文案。 */
const RUN_DUE: Record<CollectTask, { time: string; dueMin: number } | null> = {
  // daily-collect `47 21 * * *` +抖动 0~20 +采集约 10 分
  collect: { time: '21:47', dueMin: 40 },
  // 收藏在同一串链的 collect 之后跑
  favorites: { time: '21:47', dueMin: 60 },
  // viral-collect `40 7 * * *` +抖动 0~25 +搜索搬料 8~15 分
  viral: { time: '07:40', dueMin: 50 },
  // publish-check-morning `42 8 * * *` +抖动 0~20 +五平台约 10 分
  'publish-check': { time: '08:42', dueMin: 45 },
  // benchmark 2026-09-30 起暂停，不给应得时刻：永远不判陈旧，只显产物读数
  benchmark: null,
}

/** 与自检同一把尺（scripts/selfcheck.mjs 的 CRON_DAYS）：隔到第 2 天才算断档，只隔 1 天算陈旧 */
const RUN_GAP_DAYS = 2

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const DAY = 86_400_000
const runLabel = (k: string) =>
  accounts.find((a) => a.key === k)?.platform ?? PLATFORM_META[k]?.label ?? k

/** 今天的应得落盘时刻（本地时区，调度器按本地时间触发）；没到就不判陈旧 */
function dueMoment(task: CollectTask, now: Date): number | null {
  const due = RUN_DUE[task]
  if (!due) return null
  const [h, m] = due.time.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  return d.getTime() + due.dueMin * 60_000
}

const runsOf = (task: CollectTask) => collectRuns.filter((r) => r.task === task)
const lastRunOf = (task: CollectTask) => runsOf(task).pop() ?? null
const lastOkRunOf = (task: CollectTask) => [...runsOf(task)].reverse().find((r) => r.ok) ?? null

/** 产物落盘读数（日期串或 ISO）→ 毫秒；只有日期的按当天零点算 */
const atMs = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)

/**
 * 一个任务的运行读数。优先级按规格 §三：未采集过 → 断档 → 失败 → 部分成功 → 陈旧 → 新鲜。
 * @param fallbackAt 没有留痕时用的产物落盘读数（lastViralAt / lastFavoriteAt / lastSyncAt 等）
 */
export function runReading(task: CollectTask, fallbackAt?: string | null): RunReading {
  const now = new Date()
  const run = lastRunOf(task)
  const okRun = lastOkRunOf(task)
  const fallback = fallbackAt ? { at: fallbackAt, ms: atMs(fallbackAt) } : null
  const fresh = okRun ? { at: new Date(okRun.finishedAt).toISOString(), ms: okRun.finishedAt } : fallback
  if (!run && !fallback) {
    return { state: 'never', at: null, gapDays: null, platforms: {}, failed: [], reason: '', stopped: false }
  }
  /* 留痕是历史，删掉的号在那一轮确实挂过——那是事实，不改写。
   * 但页头报的是「现在还登记的这几个号采到了没」，已经不在登记表上的不算进来，
   * 否则删一个号，那条红色报错会一直留在页顶。 */
  const live = (k: string) => !accounts.length || accounts.some((a) => a.key === k)
  const livePlatforms = Object.fromEntries(Object.entries(run?.platforms ?? {}).filter(([k]) => live(k)))
  const liveFailed = (run?.failedPlatforms ?? []).filter(live)
  const gap = fresh ? Math.max(0, Math.round((startOfDay(now.getTime()) - startOfDay(fresh.ms)) / DAY)) : null
  const base = {
    at: fresh?.at ?? null,
    gapDays: gap,
    platforms: livePlatforms,
    failed: liveFailed,
    stopped: !!run?.stopped,
  }
  // 断档看的是「最近一次成功落盘」，本轮失败与否都不改变它已断档的事实
  if (gap != null && gap >= RUN_GAP_DAYS) {
    const first = liveFailed[0]
    return {
      state: 'stale',
      ...base,
      reason: run && !run.ok && first
        ? `${runLabel(first)}：${run.platforms[first]?.note || run.tail}`
        : '',
    }
  }
  if (run && !run.ok && !run.partial && (liveFailed.length || run.stopped)) {
    const why = liveFailed.length
      ? `${runLabel(liveFailed[0])}：${run.platforms[liveFailed[0]]?.note || run.tail}`
      : run.tail
    return { state: 'failed', ...base, reason: run.stopped ? '人工停止，这轮没跑完' : why }
  }
  if (liveFailed.length) {
    return {
      state: 'partial',
      ...base,
      reason: `${liveFailed.map(runLabel).join('、')} 没采到`,
    }
  }
  const due = dueMoment(task, now)
  const landedToday = !!okRun && startOfDay(okRun.finishedAt) === startOfDay(now.getTime())
  if (!landedToday && due != null && now.getTime() >= due) return { state: 'aged', ...base, reason: '' }
  return { state: 'fresh', ...base, reason: '' }
}

export const PLATFORM_META: Record<string, { label: string; color: string }> = {
  // color 只给图表用：必须是能在米白纸上看得清的颜色，品牌淡色（neo-pink）在这上面等于没画
  xiaohongshu: { label: '小红书', color: '#ff2442' },
  douyin: { label: '抖音', color: '#111111' },
}

/* ==================== 账号登记 ====================
 * 数据源：config/accounts.json。一条 = 一个号，**同一个平台可以挂多个号**。
 * `id` 是这个号在本仓的身份：发布排期目录名、md 里「草稿已推-x」/「发布链接-x」的后缀、
 * 登录态缓存的键、泳道与创作台版本的键。
 * `platform` 只决定版式（短文案段、图文/贴图形态、logo）；`key` 是它在 metrics 快照里的桶名。
 * 老登记没写 id，补齐后 id 就是平台名 —— 一平台一号的历史数据零迁移。
 * 本机授权模型：账号页扫一次码，media-hub 把这个号的登录凭据按号存进本机（metrics/account-cookies/，
 * 不入库）；干活前换成这个号那份，干完换回去。同平台多号靠这个隔离，凭证不出本机。
 */

export interface Account {
  /** 账号身份：目录名 / md 后缀键 / 登录态键 */
  id: string
  platform: string
  /** 快照键（metrics/raw 里的英文桶名），也是本机按号存登录态的文件名。
   *  同平台两个号必须各有各的 key，否则读数和登录态会叠在一起 */
  key: string
  /** 一键推草稿的本地脚本 */
  script?: string
  /** 创作者后台地址：账号页「去后台登录」与 publish-check 共用这一份 */
  backend?: string
  /** 登录页上那枚「不用扫码」的按钮名（视频号=微信快捷登录）；账号页据此在弹层里多给一个按钮 */
  quickLogin?: string
  /** 本机是否真有这个脚本（build-data 查的，缺即只能人工到后台建草稿） */
  hasScript?: boolean
  nickname: string
  note?: string
}

export const accounts = reactive<Account[]>(
  (((raw as Record<string, unknown>).accounts ?? []) as Account[])
    .map((a) => ({ ...a, id: a.id || a.platform })),
)

/** 品牌登记（config/products.json）：多品牌推广的分格清单。发布日历的筛选胶囊与选题「归属品牌」都读它。
 *  手填进稿里的新产品不在清单里也能筛（筛选选项从登记表 + 实际数据取并集）。 */
export const products = reactive<string[]>(
  (((raw as Record<string, unknown>).products ?? []) as string[]),
)

/** 品牌档案（config/products.json 的完整字段）：入口、对外口径、可放图卡的真素材只在这里登记一份。
 *  品牌页与「一键同款」都读它——生成图卡时的事实上限就是这张档案。 */
export interface ProductScreen {
  path: string
  label: string
}
export interface ProductProfile {
  name: string
  /** 推广对象类型（app/website/shop/store/service/course/other）：决定素材槽、「那一行怎么问」、状态词 */
  type?: string
  kind?: string
  status?: string
  oneLiner?: string
  entry?: string
  facts?: string[]
  screens?: ProductScreen[]
  target?: string
}
export const productProfiles = reactive<ProductProfile[]>(
  (((raw as Record<string, unknown>).productProfiles ?? []) as ProductProfile[]),
)
export const productByName = (name: string): ProductProfile | undefined =>
  productProfiles.find((p) => p.name === name)

export interface TargetSlot {
  key: string
  label: string
  /** Tailwind 能吃的比例串，如 "9/19"、"4/3" */
  ratio: string
}
/** 类型注册表投影到浏览器的那一半（build-data 从 config/promotion-target.mjs 的 targetUi() 导出）。
 *  品牌页、新建弹层、类型页签只读这一份，界面里不许再抄第二张类型表。 */
export interface TargetType {
  key: string
  label: string
  slots: TargetSlot[]
  entryLabel: string
  entryHint: string
  statuses: string[]
}
export const targetTypes = reactive<TargetType[]>(
  (((raw as Record<string, unknown>).targetTypes ?? []) as TargetType[]),
)
/** 留空按 app 取：在册档案没写 type 的老数据要长成应用的样子，不是长成空 */
export const targetTypeOf = (key?: string): TargetType | undefined =>
  targetTypes.find((t) => t.key === (key || 'app'))

/** 方案库（config/playbooks.json）：从爆款里拆出来的推广结构。
 *  一条方案 = 页序 + 每页槽位 + 素材槽位，「一键同款」按它换产品出图，骨架不动。 */
export interface PlaybookSource {
  noteId: string
  title: string
  author: string
  likes: number
  cover: string
  url: string
}
export interface PlaybookPage {
  layout: string
  role: string
  shots: number
  edit: string[]
  preset?: Record<string, number | string>
}
export interface PlaybookSamplePageText {
  [slot: string]: string
}
export interface Playbook {
  slug: string
  name: string
  structure: string
  why: string
  source: PlaybookSource
  /** 我们用这条方案跑出来的图卡：slug + 本机真存在的页 + 样张是哪家的产品 + 每页的文字槽位 */
  sample: { slug: string; urls: string[]; product: string; texts: PlaybookSamplePageText[] }
  applies: string[]
  pages: PlaybookPage[]
}
export const playbooks: Playbook[] = ((raw as Record<string, unknown>).playbooks ?? []) as Playbook[]

/** 图文卡片主题（config/card-themes.json）：一套主题=同一版式换一层皮，不动结构。
 *  tokens 的键**就是** CSS 自定义属性名，前端实时预览和渲染器吃同一份，中间没有映射层。 */
export interface CardTheme {
  key: string
  label: string
  tag?: string
  why?: string
  fit?: string[]
  order?: number
  /** candidate=一键克隆出来、人还没转正的皮；没这个键就是手写的在架皮 */
  status?: 'candidate'
  cloned?: boolean
  tokens: Record<string, string>
}
/** 版式登记（config/card-layouts.json）：能选的版式枚举 + 每个版式的真实使用量与字段。
 *  themeReady=false 表示这版式的色值还没抽成变量，给它选主题不会生效。 */
export interface CardLayout {
  layout: string
  label: string
  family: 'value' | 'commercial' | 'promo'
  status: 'live' | 'oneoff' | 'dead'
  used: number
  themeReady: boolean
  fields?: string[]
  requires?: string[]
  notes?: string
}
export interface CardThemes {
  themes: CardTheme[]
  default: string
  /** 卡片字体栈：克隆出来的新皮沿用同一套字，不另立 */
  fontStack: string
  layouts: CardLayout[]
}
/* 包 reactive：存完克隆候选、转正、删掉都要在模板选择器里当场见到结果，
   resync() 靠换这两张表的内容把界面接上（见 holdSelfWrite）。 */
export const cardThemes: CardThemes = reactive(
  ((raw as Record<string, unknown>).cardThemes ?? { themes: [], default: '', fontStack: '', layouts: [] }) as CardThemes,
)
export const cardThemeByKey = (key: string): CardTheme | undefined =>
  cardThemes.themes.find((t) => t.key === key)
/** 版式登记查表：themeReady=false 的版式吃了主题也不会变，界面上要如实说 */
export const cardLayoutByName = (layout: string): CardLayout | undefined =>
  cardThemes.layouts.find((l) => l.layout === layout)
/** 内容意图三档：纯提供价值 / 价值里植入 / 纯推广。缺省时渲染器按有没有填归属品牌推导 */
export type CardIntent = 'value' | 'mixed' | 'promo'

/** 模板（config/card-templates.json）= 一套版式结构 + 一层皮，是用户点的那个按钮。
 *  主题只换皮、版式只管一页，单独拿出都不成稿；「一键同款」和推荐都落到模板这一层。
 *  thumb.status 由 build-data 现算指纹比对：ready=小样是新的，stale=改过皮或版式，missing=没渲过。 */
export interface CardTemplate {
  key: string
  label: string
  theme: string
  layouts: { cover: string; body: string; closing: string }
  shape: string[]
  intents?: CardIntent[]
  /** 这条模板的机制说明——推荐时那句话的理由就来自它，不是界面现编 */
  pick?: string
  order?: number
  status?: 'active' | 'candidate' | 'archived'
  /** 一键克隆来的模板记源笔记，界面上要能说出「这是从哪条爆款收编来的、它凭什么算被验证过」 */
  source?: { platform?: string; noteId?: string; title?: string; url?: string; likes?: string; collects?: string; comments?: string; heat?: number }
  thumb: { url: string; status: 'ready' | 'stale' | 'missing' }
  /** 封面小样的地址（build-data 算好了才给）：cover 与 body 同一个版式时为空串，界面回落到正文页那张 */
  coverThumb?: string
}
export interface CardTemplates {
  default: string
  templates: CardTemplate[]
}
export const cardTemplates: CardTemplates = reactive(
  (raw as Record<string, unknown>).cardTemplates ?? { default: '', templates: [] },
) as CardTemplates
export const cardTemplateByKey = (key: string): CardTemplate | undefined =>
  cardTemplates.templates.find((t) => t.key === key)
/** 只给界面看能选的：candidate（克隆来还没核过）和 archived 都不进默认列表 */
export const selectableCardTemplates = (): CardTemplate[] =>
  cardTemplates.templates
    .filter((t) => !t.status || t.status === 'active')
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
/** 克隆出来还没转正的候选：只在模板选择器的「候选」栏里出现，能预览能套能删，不进推荐位 */
export const candidateCardTemplates = (): CardTemplate[] =>
  cardTemplates.templates
    .filter((t) => t.status === 'candidate')
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

/** 视频模板（config/video-templates.json）= 一个真存在的 Remotion composition。
 *  与图文模板不一样：图文的槽位在 json 里，视频的槽位还在各项目代码里（copy.ts / narration.json /
 *  workbench.ts），所以这里只登记「槽在哪、要什么素材、怎么渲」，界面给的是改词入口和可复制的命令，
 *  不假装能在线改。四个 *Ready 由 build-data 查文件算：小样不在就是这条登记写飘了。 */
export interface VideoSlot {
  /** 相对项目根的文件路径，或 inputProps 的键名 */
  at: string
  what: string
}
export interface VideoTemplate {
  key: string
  label: string
  /** 片子类型：价值片 / 走查 / 快闪 / 口播——决定它投哪儿 */
  kind: string
  composition: string
  project: string
  fps: number
  size: string
  /** 成片秒数；还没渲过的条目给 0，界面显示「未渲」而不是 0 秒 */
  durationSec: number
  poster: string
  preview: string
  film: string
  render: string
  slots: VideoSlot[]
  /** ready＝成片在仓里；candidate＝从爆款逐字稿量出来的节奏规格，还没人点头；active＝转正了，创作时能选 */
  status: 'ready' | 'needs-asset' | 'needs-render' | 'candidate' | 'active'
  /** 收编来的那条爆款：哪条笔记、多少赞藏评，界面上要说得清它凭什么算被验证过 */
  source?: {
    platform?: string
    noteId?: string
    title?: string
    url?: string
    likes?: string
    collects?: string
    comments?: string
    heat?: number
  }
  /** 从带时间码的逐字稿里量的节奏读数（scripts/video-harvest-core.mjs） */
  structure?: {
    durationSec: number
    beats: number
    chars: number
    charsPerSec: number
    beatSec: number
    maxGap: number
    hookSec: number
    hookChars: number
    hookLines: number
    hookText: string
  }
  pick?: string
  note?: string
  order?: number
  posterReady: boolean
  previewReady: boolean
  filmReady: boolean
  projectReady: boolean
}
export interface VideoTemplates {
  default: string
  templates: VideoTemplate[]
}
export const videoTemplates: VideoTemplates = reactive(
  (raw as Record<string, unknown>).videoTemplates ?? { default: '', templates: [] },
) as VideoTemplates
export const videoTemplateByKey = (key: string): VideoTemplate | undefined =>
  videoTemplates.templates.find((t) => t.key === key)
/** 素材库视频分区列的：按 order 排，needs-asset（代码都没齐）不进列表 */
export const selectableVideoTemplates = (): VideoTemplate[] =>
  videoTemplates.templates
    .filter((t) => t.status !== 'needs-asset' && t.status !== 'candidate')
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
/** 从爆款收编来、还没人点头的那批：素材库单独一栏，进不了创作时的可选列表 */
export const candidateVideoTemplates = (): VideoTemplate[] =>
  videoTemplates.templates
    .filter((t) => t.status === 'candidate')
    .slice()
    .sort((a, b) => (b.source?.heat || 0) - (a.source?.heat || 0))

/** 产品页点「看方案」时递给方案库的那个筛选值：跨页带一个筛选，不开全局状态库。
 *  切页时地址栏会被 App 重写（带不上 query），所以走模块级 ref。 */
export const playbookProduct = ref('')

/** 方案选择器现在是创作台里的一个弹层（2026-10-28）：产品页点「看方案」= 跳到创作台并把它打开，
 *  跨页递这一个意图同样走模块级 ref，理由与上面那条一样。 */
export const playbookPick = ref(false)

/** 素材库点「用到创作台」时带过去的那条图文模板 key。跨页只递这一个意图：
 *  素材库不知道创作台当前是哪一稿，所以它只登记「要哪条」，接活的是 AssetPreview。
 *  被接走就清空，不许留着——否则下次进创作台又弹一次选择器。 */
export const materialTemplatePick = ref('')

export const accountById = (id: string): Account | undefined => accounts.find((a) => a.id === id)

/** 账号身份 → 平台名：传进来的可能已经是平台名（老调用方），查不到就原样返回 */
export const platformOf = (id: string): string => accountById(id)?.platform ?? id

/** 按平台取号：同平台多号时拿到的是登记在前的那个（主号）。新代码请按 id 取（accountById） */
export const accountFor = (platform: string): Account | undefined =>
  accounts.find((a) => a.id === platform) ?? accounts.find((a) => a.platform === platform)

/** 界面上的账号名：一个平台只有一个号时只写平台；多号时必须带上昵称，否则两条泳道长得一模一样 */
export function accountLabel(id: string): string {
  const a = accountById(id)
  if (!a) return id
  const rivals = accounts.filter((x) => x.platform === a.platform).length
  return rivals > 1 && a.nickname ? `${a.platform}·${a.nickname}` : a.platform
}

/** 挂了两个以上号的平台：界面上光靠 logo 分不出是谁家的，这些平台才需要额外写账号名 */
export const sharedPlatforms = new Set<string>(
  accounts.map((a) => a.platform).filter((p, i, all) => all.filter((x) => x === p).length > 1 && all.indexOf(p) === i),
)

/** 图表系列的颜色：同平台的第二个号不能跟主号一个色，否则图上分不出是谁家的数 */
const SPARE_COLORS = ['#0ea5e9', '#f59e0b', '#8b5cf6']
export function accountColor(id: string): string {
  const a = accountById(id)
  if (!a) return 'var(--color-neutral-400)'
  const base = PLATFORM_META[a.key]?.color
    ?? PLATFORM_META[accounts.find((x) => x.platform === a.platform)?.key ?? '']?.color
    ?? 'var(--color-neutral-400)'
  if (a.id === accountFor(a.platform)?.id) return base
  const rank = accounts.filter((x) => x.platform === a.platform).findIndex((x) => x.id === a.id)
  return SPARE_COLORS[(rank - 1 + SPARE_COLORS.length) % SPARE_COLORS.length]
}

/* ==================== 登录态 ====================
 * publish-check 每晚采「已发布列表」时顺带落的凭据（metrics/login-state.json，本机本地），键是账号 id。
 * 只有 ok 才是证据，没体检过就显示「未体检」——绝不靠上次成功猜现在还登着。
 */

/** out = 要人工去 Ego Lite 重登；error = 没读到列表（改版/接口异常），不冒充掉线 */
export type LoginState = 'ok' | 'out' | 'error'
/** checkedAt 是这一行读数自己的时间：账号页可以只回认一个号，别拿全局时间冒充 */
/** code 是 error-catalog 的失败类名（如 login_expired）：界面用它预判「点这行去授权会挂在哪一步」 */
/** account 是后台自报的「这台浏览器登的是谁」（昵称 · 平台账号 id），只有抖音/小红书读得到
 *  avatar 是那一刻顺手搬下来的账号头像（站内路径 /accounts/<key>.<ext>），同样只有这两家读得到 */
export type LoginEntry = { state: LoginState; account?: string; avatar?: string; evidence?: string; error?: string; code?: string; label?: string; action?: string; checkedAt?: string }

export const loginState = reactive<{ checkedAt?: string; platforms: Record<string, LoginEntry> }>(
  ((raw as Record<string, unknown>).loginState as { checkedAt?: string; platforms: Record<string, LoginEntry> } | null) ?? { platforms: {} },
)

/** 登录态读数按账号 id 取：同平台两个号各有各的登录态，一个掉线不能把另一个也判成掉线。
 *  兜底再按平台名查一次：老读数写在平台名底下，而这一台机器上那个平台就一个号。
 *  挂了两个号就不兜底——否则「新增账号」刚落下那一行，会直接顶着主号的「已登录」，
 *  而它一次码都没扫过。 */
export const loginOf = (account: string): LoginEntry | undefined => {
  const hit = loginState.platforms?.[account]
  if (hit) return hit
  const a = accountById(account)
  if (!a || accounts.filter((x) => x.platform === a.platform).length > 1) return undefined
  return loginState.platforms?.[a.platform]
}

/** 授权提醒的唯一口径：不在「已登录」上的号按状态归组，右上角浮层与侧栏红点共用一份。
 *  用 computed 才跟着 loginState / accounts 的刷新走，写死一次就再也不变了。 */
export const loginAlerts = computed(() => {
  const stateOf = (id: string) => loginOf(id)?.state ?? 'none'
  return (['out', 'error', 'none'] as const)
    .map((state) => ({
      state,
      items: accounts.filter((a) => stateOf(a.id) === state).map((a) => ({ platform: a.platform, label: accountLabel(a.id) })),
    }))
    .filter((g) => g.items.length > 0)
})

/* ==================== 「这一版现在能不能推」的唯一判据 ====================
 * 创作台页签上的 chip 与起串前的预检都读 loginVerdict，两边不许各算一套：
 * 2026-10-24 那次推送，页面上写着「已登录」的号推挂了，写着「检测异常」的号一次推成，
 * 就是因为 chip 与队列各信各的读数。
 */

/** 只有这几类才算「这个号本身不行」。
 *  browser_takeover / browser_busy / too_slow / page_changed / script_crashed 说的是「这一次没测出来」：
 *  快手体检记的是浏览器被接管，当天推草稿一次成功——拿它挡号会把好号拦在串外。 */
const ACCOUNT_DEAD = new Set([
  'login_expired', 'account_unauthorized', 'wrong_account', 'login_device_limit', 'risk_verify', 'account_unregistered',
])

/** 体检一晚一次，隔过两天以上这条读数就不配再叫「已登录」 */
const LOGIN_FRESH_HOURS = 48

/** 这一类失败说的是「这个号本身不行」，不是「这次没测出来」：界面用它决定给不给「去授权」 */
export const isAccountDeadCode = (code?: string) => !!code && ACCOUNT_DEAD.has(code)

export type LoginVerdict = {
  /** ready 有凭据 / unknown 没测出来（不挡推送）/ blocked 有明确证据推不动（起串前剔出去） */
  level: 'ready' | 'unknown' | 'blocked'
  /** 界面上那几个字 */
  text: string
  /** 悬浮上去的原因 + 这条读数是什么时候测的 */
  tip: string
  code: string
}

export function loginVerdict(account: string): LoginVerdict {
  const ls = loginOf(account)
  const at = ls?.checkedAt
    ? `检测于 ${new Date(ls.checkedAt).toLocaleString('sv-SE', { hour12: false }).slice(5, 16)}`
    : '还没检测过'
  const code = ls?.code || (ls?.state === 'out' ? 'login_expired' : '')
  if (ACCOUNT_DEAD.has(code) || ls?.state === 'out') {
    return { level: 'blocked', text: ls?.label || '推送失败', tip: `${ls?.action || ls?.error || ''} · ${at}`, code }
  }
  if (!ls) return { level: 'unknown', text: '还没测', tip: `重新检测 · ${at}`, code: '' }
  if (ls.state !== 'ok') return { level: 'unknown', text: '没测出来', tip: `${ls.error || '这一趟没读到后台列表'} · ${at}`, code }
  const fresh = Date.now() - new Date(ls.checkedAt || 0).getTime() < LOGIN_FRESH_HOURS * 3600_000
  return {
    level: fresh ? 'ready' : 'unknown',
    text: fresh ? '已登录' : '太久没测',
    tip: `${ls.evidence || '读到后台列表'} · ${at}`,
    code: '',
  }
}

/* ==================== 日维度数据（跨快照合并） ====================
 * 来源：collect 捕获的后台逐日接口 → snapshot.daily。
 * 多次快照按日期去重合并——后采的覆盖先采的（平台会回补最近一天的终值）。
 */

const dailyByPlatformRaw: Record<string, Record<string, DailyPoint>> = {}
for (const s of snapshots) {
  for (const [p, snap] of Object.entries(s.platforms)) {
    const byDate = (dailyByPlatformRaw[p] ??= {})
    for (const d of snap.daily ?? []) byDate[d.date] = d
  }
}
export const dailyByPlatform = dailyByPlatformRaw

/** 所有平台出现过的日期轴（升序） */
export function dailyAxis(): string[] {
  return [...new Set(Object.values(dailyByPlatform).flatMap(Object.keys))].sort()
}

/** 最近一天有日数据的日期（数据截止日，通常为昨日） */
export const dailyLastDate: string | null = (() => {
  let max: string | null = null
  for (const m of Object.values(dailyByPlatform)) {
    for (const d of Object.keys(m)) if (!max || d > max) max = d
  }
  return max
})()

/** 某指标的逐日序列：每行含各平台值与全平台合计（全 null 的天 total 为 null）。
 *  传 buckets 就只算这几个桶——看板顶部那颗号筛选走这条路。 */
export function dailySeries(
  metric: DailyMetric,
  buckets?: string[],
): { date: string; values: Record<string, number | null>; total: number | null }[] {
  return dailyAxis().map((date) => {
    const values: Record<string, number | null> = {}
    let total: number | null = null
    for (const [p, byDate] of Object.entries(dailyByPlatform)) {
      if (buckets && !buckets.includes(p)) continue
      const v = byDate[date]?.[metric] ?? null
      values[p] = v
      if (v != null) total = (total ?? 0) + v
    }
    return { date, values, total }
  })
}

/** goals.json 的中文指标名 → 日维度字段 */
export const DAILY_METRIC_OF: Record<string, DailyMetric> = {
  观看数: 'views', 播放量: 'views', 总播放量: 'views',
  曝光数: 'exposure', 点赞数: 'likes', 总点赞量: 'likes',
  评论数: 'comments', 总评论量: 'comments', 收藏数: 'collects',
  分享数: 'shares', 总分享量: 'shares', 净涨粉: 'new_followers', 粉丝净增: 'new_followers',
}

/* ==================== 周期对比（数据复盘的取数口径） ====================
 * 复盘问的是「这一周比上一周好还是坏」，所以一切都成对算：本周期 / 上周期。
 * 上周期缺天就不算环比——写「上周期缺 N 天」，不要拿 0 当真数（蚁小二在这里撒谎：上周期 0 也显示 环比 0%）。
 */

/** 日粒度数据的截止日（后台 T+1，所以通常是昨天） */
export const DATA_AS_OF: string = dailyLastDate ?? TODAY

/** 日历日加减：只走 Date.UTC，加减的是日历格，不碰时区也不受时区影响 */
export const shiftDay = (iso: string, n: number): string => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** 以截止日结尾的 N 天 = 本周期；它前面那 N 天 = 上周期 */
export function periodPair(days: number): { cur: [string, string]; prev: [string, string] } {
  return {
    cur: [shiftDay(DATA_AS_OF, -(days - 1)), DATA_AS_OF],
    prev: [shiftDay(DATA_AS_OF, -(2 * days - 1)), shiftDay(DATA_AS_OF, -days)],
  }
}

export interface PeriodStat {
  /** 窗口内各平台合计；整窗无数据为 null（区别于 0） */
  total: number | null
  perPlatform: Record<string, number | null>
  /** 窗口内至少有一个平台出数的天数 */
  days: number
  /** 每个平台各自有数的天数，用于说清「这项抖音不给」 */
  daysOf: Record<string, number>
}

export function periodStat(metric: DailyMetric, [from, to]: [string, string], buckets?: string[]): PeriodStat {
  const rows = dailySeries(metric, buckets).filter((r) => r.date >= from && r.date <= to)
  const perPlatform: Record<string, number | null> = {}
  const daysOf: Record<string, number> = {}
  let total: number | null = null
  for (const r of rows) {
    for (const [p, v] of Object.entries(r.values)) {
      if (v == null) continue
      perPlatform[p] = (perPlatform[p] ?? 0) + v
      daysOf[p] = (daysOf[p] ?? 0) + 1
    }
    if (r.total != null) total = (total ?? 0) + r.total
  }
  return { total, perPlatform, days: rows.filter((r) => r.total != null).length, daysOf }
}

/** 环比：本周期 vs 上周期。两种情况不给百分比——
 *  上周期不满窗（基数不全，% 是假的）、上周期是负数（掉粉周期涨回正数，跨零算出来是几百个百分点的假涨幅）。
 *  不给 % 时仍给绝对差，那个数是真的。 */
export function ratio(cur: number | null, prev: number | null, prevComplete: boolean) {
  if (cur == null) return { diff: null as number | null, pct: null as number | null }
  if (prev == null) return { diff: null, pct: null }
  const diff = cur - prev
  if (!prevComplete || prev <= 0) return { diff, pct: null }
  return { diff, pct: (diff / Math.abs(prev)) * 100 }
}

/** 发布数：按稿上的排期日（= 实际发布日）算，不依赖平台读数 */
export function publishStat([from, to]: [string, string]) {
  const inWin = articles.filter(
    (a) => a.status === 'published' && a.date && a.date >= from && a.date <= to,
  )
  const perPlatform: Record<string, number> = {}
  for (const a of inWin) perPlatform[a.account] = (perPlatform[a.account] ?? 0) + 1
  return { total: inWin.length, perPlatform }
}

/* ==================== 每个平台「最近一次采到有效数据」的快照 ====================
 * 最新那份采集可能是残缺的（登录失效、风控、只跑到一半），拿最后一条当准就会出现
 * 「粉丝 —、笔记 0 条」这种假读数。逐平台回退到最近一次真有数的快照。
 */
export interface PlatformAt {
  key: string
  snap: PlatformSnapshot
  /** 这份快照的采集日 */
  date: string
  collectedAt: string | null
}

export const platformLatest: Record<string, PlatformAt> = (() => {
  const out: Record<string, PlatformAt> = {}
  for (const s of snapshots) {
    for (const [key, p] of Object.entries(s.platforms)) {
      const has = p.followers != null || (p.notes?.length ?? 0) > 0 || (p.daily?.length ?? 0) > 0
      if (!has) continue
      const prev = out[key]
      if (prev && prev.date > s.date) continue
      out[key] = { key, snap: p, date: s.date, collectedAt: s.collectedAt }
    }
  }
  return out
})()

/* ==================== 号维度筛选（看板顶部那颗切换器） ====================
 * 读数在快照里按平台桶存，同平台的第二个号还没有自己的桶，所以能筛的粒度就是桶。
 * 只列真采到过东西的桶：一个号一次都没采到，就不该出现在筛选里让人点了看空。
 */

/** 桶名 → 界面上的号名。公众号/快手这些没进 PLATFORM_META 的，从账号登记表取平台名。 */
export function platformLabel(key: string): string {
  return PLATFORM_META[key]?.label ?? accounts.find((a) => a.key === key)?.platform ?? key
}

/** 可筛选的号，按账号登记表的先后排 */
export const platformBuckets: string[] = (() => {
  const out: string[] = []
  for (const a of accounts) if (platformLatest[a.key] && !out.includes(a.key)) out.push(a.key)
  for (const k of Object.keys(platformLatest)) if (!out.includes(k)) out.push(k)
  return out
})()

export const ALL_SCOPES = 'all'

export const scopeBuckets = (scope: string): string[] =>
  scope === ALL_SCOPES ? platformBuckets : [scope]

/** 汇总只算这一期真有该项读数的桶，本周期和上周期用同一批：
 *  某个号这一期断采，不能拿它上期那笔把跌幅做大。 */
export function liveBuckets(metric: DailyMetric, days: number): string[] {
  const from = shiftDay(DATA_AS_OF, -(days - 1))
  return platformBuckets.filter((k) =>
    Object.entries(dailyByPlatform[k] ?? {}).some(([d, p]) => d >= from && d <= DATA_AS_OF && p[metric] != null),
  )
}

export interface ScopedStat {
  /** 本周期合计；整窗一个读数都没有为 null（区别于 0） */
  cur: number | null
  prev: number | null
  diff: number | null
  pct: number | null
  /** 本周期逐日值，按天对齐，缺读数的天 null */
  curDays: (number | null)[]
  /** 上周期同一批桶的逐日值，与 curDays 同下标 */
  prevDays: (number | null)[]
}

/** 大数字、折线、涨跌一次算完——三者必须来自同一批桶，否则图上的高度和旁边的百分比会打架 */
export function scopedStat(metric: DailyMetric, days: number, buckets: string[]): ScopedStat {
  const pick = (offset: number): number | null => {
    const date = shiftDay(DATA_AS_OF, -offset)
    let sum: number | null = null
    for (const k of buckets) {
      const v = dailyByPlatform[k]?.[date]?.[metric] ?? null
      if (v != null) sum = (sum ?? 0) + v
    }
    return sum
  }
  const curDays = Array.from({ length: days }, (_, i) => pick(days - 1 - i))
  const prevDays = Array.from({ length: days }, (_, i) => pick(2 * days - 1 - i))
  const sum = (xs: (number | null)[]) => xs.reduce<number | null>((a, v) => (v == null ? a : (a ?? 0) + v), null)
  const cur = sum(curDays)
  const prev = sum(prevDays)
  const diff = cur == null || prev == null ? null : cur - prev
  // 上周期连一半天数都没采到，百分比是假的，只给绝对差
  const baseSolid = prevDays.filter((v) => v != null).length * 2 >= days
  const pct = cur == null || prev == null || prev <= 0 || !baseSolid ? null : (diff! / prev) * 100
  return { cur, prev, diff, pct, curDays, prevDays }
}

/** 所选号的粉丝合计：每桶取最近一次采到的存量，一桶都没有为 null */
export function followersTotal(buckets: string[]): number | null {
  let t: number | null = null
  for (const k of buckets) {
    const f = platformLatest[k]?.snap.followers
    if (f != null) t = (t ?? 0) + f
  }
  return t
}

/* ==================== 作品榜（逐篇数据） ====================
 * 只有部分后台给逐篇读数（现在是小红的 notes）。每篇尽量挂上本地图卡封面和稿子链接。
 */
export interface Work {
  /** 这个读数属于哪个号（账号 id）—— 同平台两个号的作品不能混在一张榜里 */
  account: string
  platform: string
  title: string
  published: string | null
  /** 这份读数的采集时间——数据新鲜度写在行上，不用猜哪条是旧的 */
  updatedAt: string | null
  exposure: number | null
  views: number | null
  ctr: number | null
  likes: number | null
  collects: number | null
  comments: number | null
  shares: number | null
  follows: number | null
  avgWatch: string | null
  rejected: boolean
  /** 匹配到的本地稿（有则封面用我们渲的图卡，点击进创作台） */
  article: Article | null
  cover: string | null
  /** 作品评分 A 段（数据表现 60 分）——机器按账号基线折算；null = 基线未成型或数据不足 */
  dataScore: number | null
  /** 评分的依据一句（置信度 / 基线篇数 / 缺哪些维度），tooltip 里说清 */
  scoreNote: string
  /** 这篇教会了我们什么（稿 md 同字段；数据复盘页可原地写） */
  lesson: string
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/* ==================== 作品评分 A 段（数据表现 60 分）机器算 ====================
 * 口径：content/Knowledge/评分体系.md §二 A——按账号近 10 篇同指标中位数作基线，
 * 各维度按「本篇÷基线」的相对表现折算。基线未成型（<5 篇有读数）不评分：
 * 宁可不给分，不给假分。人只看 B 段（内容质量）与「教会了我们什么」。 */
const FOLD: [number, number][] = [
  [1.5, 1], [1.2, 0.85], [0.8, 0.65], [0.5, 0.47], [0, 0.3],
]
const fold = (r: number) => FOLD.find(([lo]) => r >= lo)?.[1] ?? 0.3
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 一篇的 A 段得分与依据；dim 缺数据的维度不计入（总分按已评维度占比折算回 60） */
function scoreOne(
  m: { views: number | null; likes: number | null; collects: number | null; comments: number | null; shares: number | null; follows: number | null },
  base: Record<string, number>,
): { score: number; note: string } | null {
  const rate = (v: number | null) => (v != null && m.views ? v / m.views : null)
  const dims: [string, number, number | null][] = [
    ['曝光', 15, m.views != null && base.views ? m.views / base.views : null],
    ['互动', 15, (() => {
      const parts = [rate(m.likes), rate(m.comments)].map((r) => (r != null && base.interact ? r / base.interact : null)).filter((r): r is number => r != null)
      return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null
    })()],
    ['收藏', 10, (() => { const r = rate(m.collects); return r != null && base.collect ? r / base.collect : null })()],
    ['转化', 10, (() => { const r = rate(m.follows); return r != null && base.follow ? r / base.follow : null })()],
    ['传播', 10, (() => { const r = rate(m.shares); return r != null && base.share ? r / base.share : null })()],
  ]
  const got = dims.filter(([, , r]) => r != null)
  if (!got.length) return null
  const weight = got.reduce((s, [, w]) => s + w, 0)
  const point = got.reduce((s, [, w, r]) => s + w * fold(r as number), 0)
  const missing = dims.filter(([, , r]) => r == null).map(([n]) => n)
  return {
    // 缺维度就按缺算：满分随weight缩水，不拿部分维度放大成 60——装全卷比低分更假
    score: Math.round(point * 10) / 10,
    note: `${got.length}/5 维${missing.length ? `，缺${missing.join('/')}` : ''} · 满分 ${weight}`,
  }
}

export const works: Work[] = (() => {
  // 先摊平（账号 × 逐篇读数），基线要按账号全量算完才能逐篇评
  const flat: { account: string; platform: string; note: (typeof platformLatest)[string]['snap']['notes'][number]; art: Article | null }[] = []
  for (const a of accounts) {
    const at = platformLatest[a.key]
    const notes = at?.snap.notes ?? []
    if (!notes.length) continue
    const pool = articles.filter((x) => x.account === a.id)
    for (const n of notes) {
      const nt = normTitle(n.title)
      const art = nt
        ? pool.find((x) => normTitle(x.title) === nt)
          || pool.find((x) => normTitle(x.title).startsWith(nt) || nt.startsWith(normTitle(x.title)))
          || null
        : null
      flat.push({ account: a.id, platform: a.platform, note: n, art })
    }
  }

  // 账号级基线：近 10 篇（按发布时间倒序）有读数的比率中位数
  const baselines = new Map<string, Record<string, number>>()
  for (const a of accounts) {
    const mine = flat
      .filter((f) => f.account === a.id && f.note.views)
      .sort((x, y) => String(y.note.published ?? '').localeCompare(String(x.note.published ?? '')))
      .slice(0, 10)
    if (mine.length < 5) continue // 基线未成型：评分体系 §基线口径
    const rate = (f: (typeof flat)[number], k: 'likes' | 'collects' | 'comments' | 'shares' | 'follows') => {
      const v = f.note[k]
      return v != null && f.note.views ? v / f.note.views : null
    }
    const pick = (xs: (number | null)[]) => xs.filter((x): x is number => x != null)
    const base: Record<string, number> = {
      views: median(mine.map((f) => f.note.views as number)),
      interact: median(pick(mine.map((f) => [rate(f, 'likes'), rate(f, 'comments')]).flat())),
      collect: median(pick(mine.map((f) => rate(f, 'collects')))),
      follow: median(pick(mine.map((f) => rate(f, 'follows')))),
      share: median(pick(mine.map((f) => rate(f, 'shares')))),
    }
    baselines.set(a.id, base)
  }

  return flat
    .map(({ account, platform, note, art }) => {
      const base = baselines.get(account)
      const scored = base
        ? scoreOne(
            {
              views: note.views ?? null,
              likes: note.likes ?? null,
              collects: note.collects ?? null,
              comments: note.comments ?? null,
              shares: note.shares ?? null,
              follows: note.follows ?? null,
            },
            base,
          )
        : null
      return {
        account,
        platform,
        title: note.title,
        published: note.published ?? null,
        updatedAt: platformLatest[accounts.find((a) => a.id === account)!.key]?.collectedAt ?? null,
        exposure: note.exposure ?? null,
        views: note.views ?? null,
        ctr: note.ctr ?? null,
        likes: note.likes ?? null,
        collects: note.collects ?? null,
        comments: note.comments ?? null,
        shares: note.shares ?? null,
        follows: note.follows ?? null,
        avgWatch: note.avgWatch ?? null,
        rejected: !!note.rejected,
        article: art,
        cover: art?.card?.urls?.[0] ?? null,
        dataScore: scored?.score ?? null,
        scoreNote: base ? (scored?.note ?? '本篇数据不足，未评') : '基线未成型（近 10 篇有读数不足 5 篇），不评分',
        lesson: art?.lesson ?? '',
      }
    })
    .sort((a, b) => String(b.published).localeCompare(String(a.published)))
})()

/* ==================== 复盘学习环：待复盘清单与结论索引 ====================
 * 「该复盘哪些」的判据住在 scripts/lesson-core.mjs，由 build-data 算完落成产物，界面只报读数：
 * 前端再算一遍 T+3，页头的数字和弹窗里的清单迟早各信各的。 */
/** 一题待复盘：同题在各平台的那几版稿一起写回，结论不用抄五遍 */
export interface ReviewTopic {
  title: string
  date: string | null
  /** 发布至今的天数：越久没复盘的排越前 */
  days: number
  /** content/ 相对路径，各平台一版 */
  files: string[]
  /** 预答与读数展示的主稿（优先取有读数的那一版） */
  primary: string
}
export interface LessonEntry {
  /** 稿的 content/ 相对路径，点开进创作台看全文 */
  rel: string
  title: string
  account: string
  date: string
  lesson: string
  /** 当时读数的一行读数（缺项不摆 0） */
  metricsText: string
}
export const reviewTopics: ReviewTopic[] = (raw.reviewDue ?? []) as ReviewTopic[]
export const lessonEntries: LessonEntry[] = (raw.lessons ?? []) as LessonEntry[]

/* ==================== 目标层（飞轮起点：播放 / 涨粉 / 变现） ==================== */

/** config/goals.json 透传：一个量化目标 + 取数口径（平台指标或手工记录） */
export interface GoalSource {
  platform: string
  metric: string
}

export interface Goal {
  id: string
  label: string
  window: string
  /** null = 观察值：只读数不判达成 */
  target: number | null
  sources?: GoalSource[]
  /** 有值 = 手工目标，从 metrics/revenue.json 的 months[本月] 取数 */
  manual?: string
  unit?: string
}

export const goals: Goal[] = (((raw as Record<string, unknown>).goals ?? []) as Goal[])
const revenue: Record<string, number> = (((raw as Record<string, unknown>).revenue ?? {}) as Record<string, number>)

/** 目标进度：优先用日维度数据按窗口加总（asOf=数据截止日）；
 *  日数据未覆盖窗口时回退到最新快照的周期指标；manual 目标取本月手工记录 */
export function goalProgress(g: Goal) {
  type Part = { platform: string; metric: string; label: string; value: number | null }
  if (g.manual) {
    const month = TODAY.slice(0, 7)
    const current = revenue[month] ?? null
    return {
      parts: [] as Part[],
      current,
      target: g.target,
      met: g.target != null && current !== null && current >= g.target,
      asOf: current !== null ? TODAY : null,
    }
  }
  const sources = g.sources ?? []
  const days = Number((g.window.match(/(\d+)/) || [])[1]) || 7
  const recent = dailyAxis().slice(-days)
  const metricOf = (m: string): DailyMetric | null => DAILY_METRIC_OF[m] ?? null
  const usable =
    recent.length >= days &&
    sources.every((s) => {
      const k = metricOf(s.metric)
      if (!k) return false
      const byDate = dailyByPlatform[s.platform]
      return byDate && recent.every((d) => byDate[d]?.[k] != null)
    })
  if (usable) {
    const parts = sources.map((s) => ({
      ...s,
      label: PLATFORM_META[s.platform]?.label ?? s.platform,
      value: recent.reduce((sum, d) => {
        const k = metricOf(s.metric)
        return k ? sum + (dailyByPlatform[s.platform][d]?.[k] ?? 0) : sum
      }, 0),
    }))
    const current = parts.reduce((sum, p) => sum + (p.value ?? 0), 0)
    return { parts, current, target: g.target, met: g.target != null && current >= g.target, asOf: recent[recent.length - 1] }
  }
  const parts: Part[] = sources.map((s) => ({
    ...s,
    label: PLATFORM_META[s.platform]?.label ?? s.platform,
    value: latestSnapshot?.platforms[s.platform]?.metrics[s.metric] ?? null,
  }))
  const current = latestSnapshot
    ? parts.reduce((sum, p) => sum + (p.value ?? 0), 0)
    : null
  return {
    parts,
    current,
    target: g.target,
    met: g.target != null && current !== null && current >= g.target,
    asOf: latestSnapshot?.date ?? null,
  }
}

/** 某平台粉丝数时间序列（只保留有值的点） */
export function followerSeries(platform: string): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = []
  for (const s of snapshots) {
    const v = s.platforms[platform]?.followers
    if (v != null) out.push({ date: s.date, value: v })
  }
  return out
}

/* ==================== 对标账号 ==================== */

export interface Benchmark {
  id: string
  nickname: string
  /** 取 PLATFORM_META 的 key；界面按它分组 */
  platform: string
  url: string
  position: string
  /** 账号自我介绍原文（自动线采平台主页/搜索卡上那份） */
  desc: string
  why: string
  /** 站内头像路径（采集时落在 public/benchmarks/ 下），空串 = 还没采到 */
  avatar: string
  /** 建档时的综合分：粉丝量 45% × 近期爆款 35% × 活跃度 20%；未打分（手动卡）为 0 */
  score: number
  /** 以下读数均来自建档时那次主页实测，null = 当时没读到（界面显示 —，不当 0 用） */
  followers: number | null
  likesCollects: number | null
  works: number | null
  /** 近期取样条数：recentTopLikes 是「近 recentSample 条里的最高赞」 */
  recentSample: number | null
  recentTopLikes: number | null
  recentMedianLikes: number | null
  lastPublishDays: number | null
  ipLocation: string
  capturedAt: string
  /** 建档时命中的定位关键词 */
  keywords: string[]
  /** 数据快照行（正文中「## 数据快照」下的列表项，最新在前） */
  snapshots: string[]
  /** 值得偷的模式（正文「## 值得偷的模式」下的列表项） */
  patterns: string[]
  /** 相对 content/ 的档案路径，「不再对标」拿它调归档端点 */
  file: string
}

/** 分数高的排前面：分是这套档案唯一的「谁更值得对标」读数，未建档打分的（手动卡）沉到末尾 */
export const benchmarks: Benchmark[] = (((raw as Record<string, unknown>).benchmarks ?? []) as Benchmark[])
  .slice()
  .sort((a, b) => b.score - a.score)

/** 选题卡（立项闸门产物，build-data 从 content/Projects/选题池/ 生成）。
 *  analysis 是从「来源文件」采集卡 frontmatter 解析出来的拆解——拆解只存采集卡一处，这里带出来给详情/创作台看 */
export interface TopicCard {
  id: string; title: string; status: string; source: string; judge: string; basis: string; platforms: string[]; file: string
  /** 归属品牌（选题卡「归属品牌」）：多品牌推广分格字段，空 = 人格内容；立项时随骨架写进各版稿 */
  product: string
  sourceFile: string
  sourceTitle: string
  /** 来源爆款笔记的原文链接（从来源采集卡 frontmatter url 带出），供选题详情/创作台跳转核对 */
  sourceUrl: string
  analysis: ReadingAnalysis | null
  analyzedAt: string | null
  /** 来源采集卡的完整脚本：视频＝全程口播逐字稿，图文＝逐页图内文字（卡上的「## 脚本」段）。空 = 还没补采，
   *  此时立项与创作都是凭标题猜内容——选题详情要把它亮出来，让人看见这道缺口 */
  script: string
  /** 来源爆款笔记的互动数据与形态（立项依据），从来源采集卡带出；无来源为空串 */
  likes: string
  collects: string
  comments: string
  format: string
  /** 这条选题要产出什么：'image'=图文（各版稿 + 一套图卡），'video'=视频创作，''=还没定。
   *  一条选题只走一条线，创作台整页跟着它走 */
  form: string
}
export const topics = reactive(((raw as Record<string, unknown>).topics ?? []) as TopicCard[])

export const topicById = (id: string): TopicCard | null => topics.find((t) => t.id === id) || null

/** 选题卡「来源文件」回认到的采集卡：历史与选题要把封面、逐页源图、源片从它身上带出来。
 *  两条采集线都认（灵感库的链接/收藏卡、爆款采集卡），归档掉的认不到就返回 null。 */
export const originCardOf = (sourceFile: string): Reading | ViralItem | null =>
  (!sourceFile
    ? null
    : readings.find((r) => `content/${r.file}` === sourceFile)
      || viral.find((v) => `content/${v.file}` === sourceFile)
      || null)

/** 采集卡上的「已立项」标记点下去的家：已送创作的在创作台（#/studio-形态/<短码>），
 *  还躺在选题库的跳选题库。 */
export function openTopicHome(id: string) {
  if (topicById(id)?.status === '待创作') {
    if (location.hash.split('?')[0] === '#/topics') location.reload()
    else location.hash = '#/topics'
  } else gotoStudio(id)
}

/** 选题卡 ↔ 稿组的回认：先按同名（选题 id = 稿文件名剥掉排期日期前缀），
 *  再按各版稿「灵感来源」里写的采集卡路径反查——Agent 按规范重命名稿子后同名就断了，
 *  断了卡底数据与复刻依据全空。所有选题级展示（创作台 / 发布日历）一律走这里。 */
export function cardOf(key: string, sources: (string | undefined | null)[]): TopicCard | null {
  return (
    topics.find((t) => t.id === key)
    || topics.find((t) => t.sourceFile && sources.some((s) => s?.includes(t.sourceFile)))
    || null
  )
}

/* ==================== 选题聚合（创作台） ====================
 * 一个选题 = 各平台一版同名稿，散在 发布排期/<平台>/(待发布|已排期)/ 下。
 * 按文件名（剥掉排期日期前缀）收成一组；应有平台取自选题卡的「投放平台」。
 * 进度按最落后的一版算——还有一版没写完，这条选题就还没到能推草稿的时候。 */

export interface TopicVersion {
  /** 这一版发给哪个号（账号 id = 目录名） */
  account: string
  /** 它属于哪个平台：版式、logo、标题字数上限都看这个 */
  platform: string
  /** null = 这一版还没建出来（立项后骨架缺失） */
  item: TopicItem | null
}

export interface TopicGroup {
  key: string
  title: string
  versions: TopicVersion[]
  status: TopicStatus
  /** 排期日期：各版一致时给值，不一致留空 */
  date: string | null
  /** 选题卡文件（相对 content/）；稿没有对应选题卡时为空 */
  topicFile: string | null
}

const STATUS_LAG = ['not_start', 'creating', 'ready', 'published'] as const

/** 短文案版（抖音/快手/视频号/公众号）另看的「长正文母本」：优先取同选题那条正文即发布文字的版
 *  （通常是小红书版），它才是各版共用的本体；这一组里没有长版才退回本版自己的正文段。
 *  返回 null = 没有母本可看（长版自身、或本版正文与文案同文）。 */
export interface Mother {
  text: string
  /** 母本出自哪一版（账号名） */
  from: string
}

export function motherOf(siblings: Article[], self: Article): Mother | null {
  if (self.copyLabel === '正文') return null
  const long = siblings.find((a) => a !== self && a.copyLabel === '正文' && a.body)
  if (long) return { text: long.body, from: long.account }
  return self.body && self.body !== self.copy ? { text: self.body, from: self.account } : null
}
/** 稿的版本名 = 剥掉排期日期前缀的文件名：同一选题各平台版靠它归组（创作台 / 发布日历 / 今日同口径） */
export const versionKeyOf = (a: Article) =>
  (a.file.split('/').pop() || a.file).replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')

/* ==================== 创作台地址栏短码 ====================
 * 选题 key 是中文标题，`encodeURIComponent` 后是一长串百分号码，裸在地址栏既难读也难看。
 * hash 里改放 key 的定长哈希；跳回来时在本机已知 key 集合（各版本 key + 选题卡 id）反查。
 * 码是纯函数：数据重生成、整页刷新前后同一个 key 的码不变，所以刷新后仍回同一条选题。 */
const fnv1a = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  }
  return (h >>> 0).toString(36)
}
/** 反查用的候选集：选题卡 id 与稿组 key 多数相同，但 Agent 改名后靠 sourceFile 回认，两边都要收 */
const studioKeys = () => [...new Set([...topicGroups().map((g) => g.key), ...topics.map((t) => t.id)])]
const studioCode = (key: string) => fnv1a(key)
export function studioKeyFromHash(): string | null {
  const seg = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[1] || '')
  if (!seg) return null
  return studioKeys().find((k) => fnv1a(k) === seg) || null
}
/** 创作台深链（今日 / 创作台 / 数据复盘 / 任务浮层共用）：整页刷新会停在原 hash，所以同一条要显式 reload */
export function gotoStudio(key: string) {
  const at = studioHashFor(key)
  if (location.hash.split('?')[0] === at) location.reload()
  else location.hash = at
}

/* ==================== 推草稿队列的界面侧模型（服务端 /__push 的镜像） ====================
 * 队列活在服务端：刷新、切页、关窗都不会把剩下的版本丢在半路；一次仍只推一版（共用浏览器登录态与 /tmp 参数文件）。
 * 今日页与创作台都读这一份类型，两边看到的进度口径一致。 */

export type PushStep = {
  platform: string
  rel: string
  /** 排期后的稿路径，等 generated.json 长出该平台的「草稿已推」时用 */
  file: string
  /** queued 排队 / running 脚本在跑 / done 已进草稿箱 / fail 失败（带脚本日志尾巴）/ skipped 连错两版后中止，没轮到 */
  state: 'queued' | 'running' | 'done' | 'fail' | 'skipped'
  /** 平台侧的硬证据（草稿箱计数 before→after 等），用来证明「真进去了」而不是「我点完了」 */
  evidence: string
  error: string
  /** error-catalog 的失败类名：界面用它分清「号不行」与「这次没测出来」，再决定给哪个下一步 */
  code?: string
  /** 服务端 error-catalog 认得出的失败才有一句：现在该点哪。认不出就没有这一行 */
  action?: string
  /** 失败时脚本最后 600 字输出——页面文案长什么样，不用去翻终端 */
  log: string
  startedAt: number | null
  endedAt: number | null
}

export type PushJob = {
  date: string
  startedAt: number
  finishedAt: number | null
  running: boolean
  /** 连错两版提前中止（多半是风控或登录态，继续撞更伤号） */
  aborted?: boolean
  /** 人在界面上按了停止：后面排着的版本没推，已推进草稿箱的那些照在 */
  stopped?: boolean
  /** 版与版之间随机停顿到什么时候（同一账号被紧跟着连发是风控最眼的特征） */
  napUntil?: number
  steps: PushStep[]
}

/** 正在跑的队列（没有则 null）：界面进页面先问一次，别的页签起的推送要能接上 */
/** 服务端队列是唯一事实源：进页面先问一次，别的页签起的推送照接上。
 *  远程那份没有桥，这一问必然落空，所以先等能力结论、远程直接回 null（省一个 409） */
export async function fetchPushJob(): Promise<PushJob | null> {
  await capabilitiesReady
  if (isRemote.value) return null
  try {
    const o = (await (await fetch('/__push')).json()) as { job?: PushJob }
    return o.job ?? null
  } catch {
    return null /* 静态托管等无端点场景 */
  }
}

/** 页面加载即探一次服务端推送队列（只此一次）：结论同时决定「SSE 刷新挂不挂」（见 holdRefresh
 *  那段注释）与各页签能不能接上还在跑的进度。刷新页面会重新探——运行中的队列不因刷新丢在半路。 */
export const pushJobProbe: Promise<PushJob | null> = fetchPushJob()
void pushJobProbe.then((job) => resolveAutoRefreshHold(!!job?.running))

/** 起一串推送；服务端 busy 时把正在跑的队列原样带回来，界面就地接上而不是另起一串 */
export async function startPushQueue(
  items: { rel: string; platform: string }[],
  date: string,
): Promise<{ ok: boolean; busy?: boolean; error?: string; job?: PushJob }> {
  try {
    return await (
      await fetch('/__push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, date }),
      })
    ).json()
  } catch {
    return { ok: false, error: '本地服务未就绪，先 npm run dev' }
  }
}

/* ==================== 跑着的活儿：一处登记，处处能停 ====================
 * 服务端那册（scripts/run-jobs.mjs）是「正在跑」的唯一事实源：采集、生成、推草稿、渲染、补扒脚本
 * 各自登记一条 stop。界面凡是要显「正在跑」的地方，都从这两条走——有读数就必须有停止，不给只显不显的余地。 */

export type RunningJob = {
  id: string
  /** 这一格里具体跑的是哪条任务（采集种类下是 viral / favorites…），按停时要递回服务端核对 */
  key: string
  label: string
  startedAt: number
  limitMs: number
  elapsed: number
  /** 已按停但还没退干净：采集等当前平台、推草稿等当前版 */
  stopping: boolean
}

/** 现在在跑什么：远程那份没有桥，服务端也不会登记任何东西，这一问直接回空 */
export async function fetchRunningJobs(): Promise<RunningJob[]> {
  await capabilitiesReady
  if (isRemote.value) return []
  try {
    const o = (await (await fetch('/__jobs')).json()) as { jobs?: RunningJob[] }
    return o.jobs ?? []
  } catch {
    return [] /* 静态托管等无端点场景 */
  }
}

/** 按停：task 只给采集那一类带上（一个种类里具体跑的是哪条任务），其余种类服务端自己认 */
export async function stopRunningJob(id: string, task?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await (
      await fetch('/__stop-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: id, ...(task ? { task } : {}) }),
      })
    ).json()
  } catch {
    return { ok: false, error: '停止请求没送到本地服务' }
  }
}

export const topicGroups = (): TopicGroup[] => {
  const byKey = new Map<string, TopicItem[]>()
  for (const i of topicItems()) {
    const key = versionKeyOf(i.article)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(i)
  }
  return [...byKey.entries()].map<TopicGroup>(([key, items]) => {
    const card = cardOf(key, items.map((i) => i.article.source))
    // 版本按**账号**排：卡上的立项清单存的就是账号 id（一平台一号时它等于平台名）
    const ids = card?.platforms.length ? [...new Set(card.platforms)] : [...new Set(items.map((i) => i.account))]
    const versions: TopicVersion[] = [...new Set([...ids, ...items.map((i) => i.account)])]
      .map((id) => ({ account: id, platform: platformOf(id), item: items.find((i) => i.account === id) || null }))
    const dates = [...new Set(items.map((i) => i.date).filter((d): d is string => !!d))]
    return {
      key,
      title: items[0]!.title,
      versions,
      // 取最落后的一版：缺版本 = 还没动笔，所以从 published 往小里收
      status: versions.reduce<TopicStatus>((worst, v) => {
        const s = v.item ? v.item.status : 'not_start'
        return STATUS_LAG.indexOf(s) < STATUS_LAG.indexOf(worst) ? s : worst
      }, 'published'),
      date: dates.length === 1 ? dates[0]! : null,
      topicFile: card?.file || null,
    }
  })
}

/* ==================== 一条选题走哪条线：图文创作还是视频创作 ====================
 * 顶栏那两档页签、深链落在哪一档、创作台这一屏筛哪些选题都读这一份，不许在视图里另算一套。
 * 认选题卡上那行「产出形态」；卡没写才按已经产出的素材倒推，稿还没成形就不判（空串）。 */
export function topicFormat(g: TopicGroup): 'image' | 'video' | '' {
  const declared = cardOf(g.key, g.versions.map((v) => v.item?.article.source))?.form
  if (declared === 'video' || declared === 'image') return declared
  if (g.versions.some((v) => !!v.item?.article.card?.video)) return 'video'
  if (g.versions.some((v) => !!v.item?.article.card?.urls.length)) return 'image'
  return ''
}

/** 图文与视频各有各的一屏（未定形态的还没选队，两屏都进得去） */
export const studioViewOf = (format: 'image' | 'video') => (format === 'video' ? 'studio-video' : 'studio-image')
type StudioTab = 'studio-image' | 'studio-video'

/** 一条选题该落哪一档：定了形态就按形态，没定就留在人当前这一档（点进去不该被页签弹走） */
export const studioTabFor = (key: string, cur: StudioTab = 'studio-image'): StudioTab => {
  const g = topicGroups().find((x) => x.key === key)
  const f = g ? topicFormat(g) : ''
  return f ? studioViewOf(f) : cur
}

/** 一条选题的完整深链，含它所在的那一档页签 */
export function studioHashFor(key: string, cur: StudioTab = 'studio-image') {
  return `#/${studioTabFor(key, cur)}/${studioCode(key)}`
}

/** 地址栏第一段该落哪一档：带选题短码的（含旧链接 #/studio/<短码>）按这条选题的形态归位；
 *  形态还没定的、以及没带短码的（人在页签之间切），尊重 cur 那一档。 */
export function studioViewFromHash(cur: StudioTab = 'studio-image'): StudioTab {
  const key = studioKeyFromHash()
  return key ? studioTabFor(key, cur) : cur
}

/** 哪些号拿不到逐篇读数、各拿不到几篇（账号登记与 works 都就位后才能算）。 */
export const workGaps: { account: string; platform: string; count: number }[] = (() => {
  const have = new Set(works.map((w) => w.account))
  const out: { account: string; platform: string; count: number }[] = []
  for (const a of accounts) {
    if (have.has(a.id)) continue
    out.push({
      account: a.id,
      platform: a.platform,
      count: articles.filter((x) => x.account === a.id && x.status === 'published').length,
    })
  }
  return out
})()

/* ==================== 知识库 ====================
 * 「知识库」页用：content/Knowledge/*.md 由 build-data 切成结构化块透传（R1 唯一知识源），
 * 前端只读渲染，正文不复制——要改就去改 md。
 */

export interface MdBlock {
  t: 'p' | 'h' | 'ul' | 'quote' | 'code' | 'hr' | 'table'
  text?: string
  items?: string[]
  /** 源文件里是编号列表：前端保留 1. 2. 3.，因为条目互相引用序号 */
  ordered?: boolean
  head?: string[]
  rows?: string[][]
}

export interface KnowledgeDoc {
  file: string
  title: string
  /** false = `_` 前缀页，只给人看，不进 AI 注入 */
  ai?: boolean
  /** 源文件 mtime 的本地日期（YYYY-MM-DD），界面展示「更新于」 */
  updated?: string
  intro: MdBlock[]
  sections: { name: string; blocks: MdBlock[] }[]
}

export const knowledge: KnowledgeDoc[] = ((raw as Record<string, unknown>).knowledge ?? []) as KnowledgeDoc[]

/**
 * 环比：最新快照里某字段的值 − 上一个有值快照的同字段值。
 * 快照不足 2 个或当前值缺失时返回 null（无处可比）。
 */
export function snapshotDelta(
  platform: string,
  key: 'followers' | 'likesCollects' | 'likes',
  current: number | null,
): number | null {
  if (current == null || snapshots.length < 2) return null
  let seen = 0
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const v = snapshots[i].platforms[platform]?.[key]
    if (v == null) continue
    if (++seen === 2) return current - v
  }
  return null
}
