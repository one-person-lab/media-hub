import raw from './generated.json'

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
  follows: number | null
  bounce: string
}

export interface Article {
  id: string
  title: string
  file: string
  date: string | null
  stage: 'pending' | 'scheduled'
  status: TopicStatus
  identity: string
  intent: string
  /** 灵感来源（创作信息里的「灵感来源」），可回链到灵感库条目 */
  source: string
  openingType: string
  /** 手填的转化活动标识（UTM campaign）。留空则用文章 id */
  campaign: string
  body: string
  caption: string
  tags: string
  firstComment: string
  metrics: ArticleMetrics
  metricsFilled: boolean
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

export interface ReadingAnalysis {
  titleStructure: string
  hook: string
  structure: string
  steal: string
  topics: string
}

export interface Reading {
  id: string
  title: string
  file: string
  chars: number
  excerpt: string
  /** AI 拆解（frontmatter analysis 块），未拆解为 null */
  analysis: ReadingAnalysis | null
  analyzedAt: string | null
  /** 原笔记自带的话题标签（如「#低能量」），本地创建的为空 */
  tags: string
  /** 来源（如「小红书 @作者」），本地创建的为空 */
  source: string
  /** 原文链接（采集的笔记才有） */
  url: string
  /** 封面图路径（public/ 下，采集的笔记才有） */
  coverImage: string
  /** 采集笔记的互动数据（本地创建的为 null） */
  likes: string | null
  collects: string | null
  comments: string | null
  postedAt: string | null
  /** 笔记全文（详情页展示） */
  body: string
}

/** 草稿已改为文件驱动：content/…/待发布/*.md，正文为空 = 草稿态。
 *  「生成选题」由前端 POST /__draft 落文件；浏览器的 localStorage 便签已废弃。 */

export const articles: Article[] = raw.articles as Article[]
export const quotes: Quote[] = raw.quotes as Quote[]
export const readings: Reading[] = raw.readings as Reading[]
export const generatedAt = raw.generatedAt

/* ==================== 当前推广对象 ====================
 * 来自 config/active-target.mjs，经 build-data 注入。
 * 界面（如侧边栏「配置」面板）只读这里，绝不写死品牌名——换产品只改 config。
 */

export interface PromotionTarget {
  /** app | website | shop | course | service */
  type: string
  brandName: string
  accountPositioning: string
  productPerspective: string[]
  tone: string
  topics: string[]
  signature: string
  brandTag: string
  handbookPath: string
  /** 转化落点：站点级落地链接（每条内容的版本见 article.landing） */
  landing: Landing
}

export const target = (raw as Record<string, unknown>).target as PromotionTarget | undefined

/* ==================== 站点/数据信息 ====================
 * 「数据」面板读这里：数据落在哪、生成了多少、AI 走哪个模型。
 */

export interface SiteInfo {
  contentRoot: string
  contentDir: string
  fileCount: Record<string, number>
  llm: { baseUrl: string; model: string; keyPath: string; keyConfigured: boolean }
}

export const site = (raw as Record<string, unknown>).site as SiteInfo | undefined

export const STATUS_TEXT: Record<TopicStatus, string> = {
  not_start: '草稿',
  creating: '待排期',
  ready: '已排期',
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
  B站: 'var(--color-neo-purple)',
  视频号: 'var(--color-neo-green)',
}

/** 日更文章默认多平台同步（正文/配文/话题 三平台各有变体） */
export const articlePlatforms = (_a: Article): string[] => ['公众号', '小红书', '抖音']

/** 统一视图条目：全部来自文件（正文为空 = 草稿态） */
export interface TopicItem {
  id: string
  kind: 'draft' | 'article'
  title: string
  status: TopicStatus
  date: string | null
  platforms: string[]
  article: Article
}

export const topicItems = (): TopicItem[] =>
  articles.map<TopicItem>((a) => ({
    id: a.id,
    kind: a.status === 'not_start' ? 'draft' : 'article',
    title: a.title,
    status: a.status,
    date: a.date,
    platforms: articlePlatforms(a),
    article: a,
  }))

export const TODAY = new Date().toISOString().slice(0, 10)

export function articlesOn(date: string) {
  return articles.filter((a) => a.date === date)
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
  notes: PlatformNote[]
}

export interface Snapshot {
  date: string
  collectedAt: string | null
  platforms: Record<string, PlatformSnapshot>
}

export const snapshots: Snapshot[] = ((raw as Record<string, unknown>).snapshots ?? []) as Snapshot[]

/** 最新一次采集 */
export const latestSnapshot: Snapshot | null = snapshots.length ? snapshots[snapshots.length - 1] : null

export const PLATFORM_META: Record<string, { label: string; color: string }> = {
  xiaohongshu: { label: '小红书', color: 'var(--color-neo-pink)' },
  douyin: { label: '抖音', color: 'var(--color-neo-blue)' },
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
  platform: string
  url: string
  position: string
  why: string
  /** 数据快照行（正文中「## 数据快照」下的列表项，最新在前） */
  snapshots: string[]
  /** 值得偷的模式（正文「## 值得偷的模式」下的列表项） */
  patterns: string[]
}

export const benchmarks: Benchmark[] = (((raw as Record<string, unknown>).benchmarks ?? []) as Benchmark[])
  .slice()
  .reverse()

/* ==================== 封面参考 ==================== */

export interface Cover {
  id: string
  title: string
  source: string
  style: string
  scene: string
  why: string
  /** 图片路径（public/ 下），空表示未配图 */
  image: string
}

export const covers: Cover[] = (raw as Record<string, unknown>).covers as Cover[] ?? []

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
