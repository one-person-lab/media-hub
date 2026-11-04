<script setup lang="ts">
/**
 * 创作台 = 选题的工作队列。图文与视频各占顶栏一档页签，同一组件按 form 只筛自己那一档（2026-11-04）。
 * 一条选题一张卡（各平台一版同名稿）；点开是一页独立的详情页，不弹层。
 * 详情页照 Buffer 的 composer 排：页顶一条步骤轨说清走到哪，中间一个三栏外壳——
 * 左=渠道（各版与登录态）、中=这一版要发出去的标题与正文、右=平台里看到的真图；
 * 页底钉一条动作条，队列进度与「下一件事」都在那儿。一屏只有一个主动作。
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  topicGroups, accounts, accountById, loginVerdict, isAccountDeadCode, TODAY,
  STATUS_CLASS, ANALYSIS_SECTIONS,
  cardOf as findCard, setHoldAutoRefresh, motherOf, studioKeyFromHash, studioHashFor, studioViewOf, pushJobProbe, hasPushBridge, isRemote, topicFormat,
  holdSelfWrite, stopRunningJob,
} from '../data/store'
import type { LoginVerdict, TopicGroup, TopicItem, TopicVersion, TopicCard, Article, PushJob, PushStep } from '../data/store'
import AssetPreview from '../components/AssetPreview.vue'
import PlatformPreview from '../components/PlatformPreview.vue'
import { formOf } from '../lib/platformForm'
import PlatformLogo from '../components/PlatformLogo.vue'
import RichText from '../components/RichText.vue'
import NoteCard from '../components/NoteCard.vue'
import CardChip from '../components/CardChip.vue'
import SearchField from '../components/SearchField.vue'
import FilterSelect from '../components/FilterSelect.vue'
import PublishModal from '../components/PublishModal.vue'
import PublishCheckModal from '../components/PublishCheckModal.vue'
import PublishPreviewModal from '../components/PublishPreviewModal.vue'
import ClientOnly from '../components/ClientOnly.vue'
import DetailModal from '../components/DetailModal.vue'
import ExportModal from '../components/ExportModal.vue'
import { useGenerate } from '../lib/useGenerate'
import { diffWords, diffRatio } from '../lib/diffText'
import type { DiffSeg } from '../lib/diffText'
import { useConfirm } from '../lib/useConfirm'
import { useToast } from '../lib/useToast'
import { Check as IconCheck, ChevronDown as IconChevronDown, CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, CircleX as IconCircleX, Copy as IconCopy, Download as IconDownload, ExternalLink as IconExternalLink, Eye as IconEye, Images as IconImages, Link as IconLink, LoaderCircle as IconLoaderCircle, MoreHorizontal as IconMoreHorizontal, Music as IconMusic, Plus as IconPlus, QrCode as IconQrCode, RotateCw as IconRotateCw, ScrollText as IconScrollText, Send as IconSend, Sparkles as IconSparkles, Square as IconSquare, Trash2 as IconTrash2, WandSparkles as IconWandSparkles, X as IconX } from 'lucide-vue-next'

/** 创作台三级状态，全部由已发生的事实推出来（写完 / 草稿已推 / 已发布），不靠人工标记：
 *  草稿   = 还差稿没写或没全推齐草稿箱 → 该动笔、补图、推草稿
 *  待发布 = 每一版都写完且都推进了草稿箱，一版都没发出去 → 只剩去平台点发布，可批量干
 *  发布中 = 已发出至少一版（publish-check T+1 检测）→ 把剩下的点完
 *  已发布 = 全部版本已发出 → 自动离开这里，去「发布日历」按时间看。 */
type Stage = 'draft' | 'todo' | 'going'

/** 顶栏那两档页签把创作分成两条线：这一屏只看走本档形态的选题。
 *  还没定形态的两屏都进得来——它正等着人在这一屏把形态定下来。 */
const props = withDefaults(defineProps<{ form?: 'image' | 'video' }>(), { form: 'image' })

const isWritten = (v: TopicVersion) => !!v.item && v.item.status !== 'not_start'
const isPushed = (v: TopicVersion) => {
  const a = v.item
  if (!a) return false
  if (a.status === 'published') return true
  const pushed = a.article.draftPushed
  return !!(pushed[v.platform] || pushed[a.article.account] || Object.keys(pushed).length)
}
const isPublished = (v: TopicVersion) => v.item?.status === 'published'

const stageOf = (g: TopicGroup): Stage | 'done' => {
  const vs = g.versions
  if (!vs.length) return 'draft'
  if (vs.every(isPublished)) return 'done'
  if (vs.some(isPublished)) return 'going'
  return vs.every((v) => isWritten(v) && isPushed(v)) ? 'todo' : 'draft'
}

const STAGE_TEXT: Record<Stage, string> = { draft: '草稿', todo: '待发布', going: '发布中' }

const stages: Stage[] = ['draft', 'todo', 'going']

/** 每个平台停在哪一步：还没建 / 没写完 / 写完待推 / 草稿已推 / 已发布。选题级状态由它推出来。 */
function verChip(v: TopicVersion) {
  if (!v.item) return { text: '还没建', cls: '!bg-tone-idle text-neutral-600' }
  if (v.item.status === 'published') return { text: '已发布', cls: STATUS_CLASS.published }
  if (!isWritten(v)) return { text: '没写完', cls: STATUS_CLASS.not_start }
  return isPushed(v)
    ? { text: '草稿已推', cls: STATUS_CLASS.ready }
    : { text: '待推草稿', cls: STATUS_CLASS.creating }
}

const filter = ref<Stage>('draft')
/** 打开的选题记在地址栏第二段（#/studio-image/<短码>）：图卡重渲后本地服务会整页刷新，刷新完要回到同一条 */
const selectedKey = ref<string | null>(studioKeyFromHash())
// 已在创作台时从别处跳来（右上角任务浮层）：hash 第一段没变、整页不会刷新，这里就地切过去
function onStudioHash() {
  const k = studioKeyFromHash()
  if (k && k !== selectedKey.value) selectedKey.value = k
}
window.addEventListener('hashchange', onStudioHash)
onBeforeUnmount(() => window.removeEventListener('hashchange', onStudioHash))

/** 停在创作台的选题（三级状态各归各的）；全部发完的整条退出，去发布日历看。
 *  先按这一屏的形态筛：图文与视频不混在同一个队列里。 */
const staged = computed(() => {
  const out: { g: TopicGroup; stage: Stage }[] = []
  for (const g of topicGroups()) {
    const f = topicFormat(g)
    if (f && f !== props.form) continue
    const stage = stageOf(g)
    if (stage !== 'done') out.push({ g, stage })
  }
  return out
})
const countOf = (s: Stage) => staged.value.filter((x) => x.stage === s).length

/* ==================== 列表的细筛与分页（口径照灵感库/选题库那一条吸顶头） ====================
 * 只筛创作台真有的三个维度：发去哪几个号、挂的哪个品牌、排没排期。
 * 形态不在这里——它是顶栏那两档页签，一台秤只称一次。阶段也不在——它是页签下面那三档。 */
const q = ref('')
const fPlatform = ref('')
const fProduct = ref('')
const fSchedule = ref('')

const platformOptions = computed(() => {
  const set = new Set<string>()
  for (const { g } of staged.value) for (const v of g.versions) set.add(v.platform)
  return [{ value: '', label: '全部平台' }, ...[...set].map((p) => ({ value: p, label: p }))]
})
const productOptions = computed(() => {
  const set = new Set<string>()
  for (const { g } of staged.value) for (const v of g.versions) {
    const p = v.item?.article.product
    if (p) set.add(p)
  }
  return [{ value: '', label: '全部品牌' }, ...[...set].map((p) => ({ value: p, label: p }))]
})
const scheduleOptions = [
  { value: '', label: '全部排期' },
  { value: 'today', label: '今天发' },
  { value: 'week', label: '七天内' },
  { value: 'none', label: '未排期' },
]
/** 排期档比的是日历日：稿上的 date 就是要发的那天，未排期是「还差定日子」那一档 */
function schedMatch(d: string | null) {
  if (fSchedule.value === 'none') return !d
  if (!d) return false
  if (fSchedule.value === 'today') return d === TODAY
  const days = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a)) / 864e5)
  return days(TODAY, d) >= 0 && days(TODAY, d) <= 6
}

const filterOn = computed(() => !!(fPlatform.value || fProduct.value || fSchedule.value))
function clearFilters() {
  fPlatform.value = ''
  fProduct.value = ''
  fSchedule.value = ''
}

/** 这一档空了但别的档有货：空态直接把人送到那一档去，不给一句「没有选题」就完事 */
const otherStage = computed<Stage | null>(() => stages.find((s) => s !== filter.value && countOf(s) > 0) || null)
const otherStageText = computed(() => {
  const s = otherStage.value
  return s ? `去看${STAGE_TEXT[s]}的 ${countOf(s)} 条` : ''
})
function jumpToOtherStage() {
  const s = otherStage.value
  if (s) filter.value = s
}
const goTopics = () => (location.hash = '#/topics')

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const rows = staged.value.filter(({ g, stage }) => {
    if (stage !== filter.value) return false
    if (fPlatform.value && !g.versions.some((v) => v.platform === fPlatform.value)) return false
    if (fProduct.value && !g.versions.some((v) => v.item?.article.product === fProduct.value)) return false
    if (fSchedule.value && !schedMatch(g.date)) return false
    if (kw) {
      const hay = `${g.title} ${g.versions.map((v) => `${v.account} ${v.item?.article.product || ''} ${v.item?.article.source || ''}`).join(' ')}`
      if (!hay.toLowerCase().includes(kw)) return false
    }
    return true
  })
  // 排期近的先做，没排期的沉到底：它们不是今天的活，插在队列里只会让人先看见最远的
  return [...rows].sort((a, b) => (a.g.date || '9999').localeCompare(b.g.date || '9999'))
})

/** 一次铺 24 张，滚到底前 320px 就取下一批（与灵感库同一条） */
const PAGE = 24
const limit = ref(PAGE)
const loadingMore = ref(false)
const visible = computed(() => shown.value.slice(0, limit.value))
const hasMore = computed(() => shown.value.length > limit.value)
const sentinelEl = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
function loadMore() {
  if (!hasMore.value || loadingMore.value) return
  loadingMore.value = true
  setTimeout(() => {
    limit.value += PAGE
    loadingMore.value = false
  }, 250)
}
watch(sentinelEl, (el) => el && io?.observe(el))
watch(shown, () => (limit.value = PAGE))
onMounted(() => {
  io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '320px' })
  if (sentinelEl.value) io.observe(sentinelEl.value)
})
onBeforeUnmount(() => io?.disconnect())

const group = computed<TopicGroup | null>(() =>
  topicGroups().find((g) => g.key === selectedKey.value) || null,
)

/* 右栏只看结果：图卡长什么样、发出去前还差什么。 */
const exportOpen = ref(false)
/** 这一条选题渲出来的那套图卡：哪一版先有图就用哪一版 */
const deck = computed(() => {
  const g = group.value
  if (!g) return null
  for (const v of g.versions) {
    const c = v.item?.article.card
    if (c && c.urls.length) return { slug: c.slug, title: c.title || g.title, images: c.urls }
  }
  return null
})

const wanted = ref('')
watch(selectedKey, (k) => {
  wanted.value = ''
  editError.value = ''
  syncStudioHash(k)
})
/** 选题落在哪一档页签下，跟着它的形态走：定完形态地址栏就搬到那一档；形态还没定的留在人进来这一档 */
function syncStudioHash(k: string | null, form?: 'image' | 'video') {
  const cur = props.form === 'video' ? 'studio-video' : 'studio-image'
  const target = k ? studioHashFor(k, form ? studioViewOf(form) : cur).slice(1) : `/${cur}`
  if (location.hash !== `#${target}`) location.hash = target
}
const active = computed<TopicVersion | null>(() => {
  const vs = group.value?.versions ?? []
  // 按账号 id 选版本：同平台多号时「抖音」与「抖音-二号」是两条版本，靠 id 区分
  return vs.find((v) => v.account === wanted.value) || vs.find((v) => v.item) || vs[0] || null
})
const item = computed<TopicItem | null>(() => active.value?.item || null)
/** 这一版属于哪个平台：中栏的字段表与右栏的预览壳都按那张表摆 */
const form = computed(() => formOf(active.value?.platform || '', active.value?.account || ''))
const tagList = computed(() => (item.value?.article.tags || '').split(/\s+/).filter(Boolean))
const pageCount = computed(() => item.value?.article.card?.urls.length || 0)
/** 这一版真带了的字段才摆出来：首评、小程序链接是选填，空栏位比不摆更像没写完 */
const shownBlocks = computed(() =>
  form.value.blocks.filter((b) => {
    if (b.key === 'firstComment') return !!item.value?.article.firstComment
    if (b.key === 'weapp') return !!(item.value?.article.landing?.byPlatform?.['公众号']?.url || item.value?.article.landing?.primary)
    return true
  }),
)
/** 标题/正文两栏的上限跟平台表走，脚本截断用的是同一份数 */
const titleLimit = computed(() => form.value.blocks.find((b) => b.key === 'title')?.max || 0)
const bodyLimit = computed(() => form.value.blocks.find((b) => b.key === 'body')?.max || 0)
/** 公众号那一栏挂的就是这条内容自己的落地链接（UTM campaign 按条归因） */
const landingUrl = computed(() => item.value?.article.landing?.byPlatform?.['公众号']?.url || item.value?.article.landing?.primary || '')

/** 短文案版（抖音/快手/视频号/公众号）默认只展示真正发出去的那一段；
 *  长正文母本按需要才摊开——它不发布，摆在最显眼的位置会盯错东西。 */
const showMother = ref(false)
watch(() => active.value?.account, () => { showMother.value = false })
const mother = computed(() => {
  const a = item.value?.article
  if (!a) return null
  const siblings = (group.value?.versions ?? []).map((v) => v.item?.article).filter(Boolean) as Article[]
  return motherOf(siblings, a)
})

/** 这条选题的选题卡：创作台从这里带出「复刻依据」（原文脚本 + 爆款拆解）与两段创作提示词。
 *  选题卡送去创作后状态变「创作中」、从选题库收起，但文件留在 选题池/ 不删——就是为了让这里读得回来。
 *  回认口径（同名 → 靠「灵感来源」反查）收在 store 的 cardOf，发布日历用同一个。 */
const cardOf = (g: TopicGroup) => findCard(g.key, g.versions.map((v) => v.item?.article.source))
const topicCard = computed(() => (group.value ? cardOf(group.value) : null))
/** 这条选题的形态：图文 or 视频，整页只按它走一条线 */
const topicForm = computed(() => (group.value ? topicFormat(group.value) : ''))

/* ==================== 详情页的流水线：整页只摊开「下一件要做的事」 ====================
 * 四段读数全部由已发生的事实推出来，不引入新状态。素材段只读数、不成段——
 * 补图就在左侧预览里做，另开一段只会让人以为那里有按钮。 */
const pipeline = computed(() => {
  const g = group.value
  if (!g) return null
  const f = formatOf(g)
  const isFilm = f.format === 'video'
  const total = g.versions.length
  const need = g.versions.filter((v) => v.item?.article.card)
  const rendered = need.filter((v) => v.item!.article.card!.urls.length)
  return {
    total,
    write: doneCount(g),
    form: f.format,
    cards: isFilm ? { need: 0, ok: 0 } : { need: need.length, ok: rendered.length },
    film: isFilm ? { need: 1, ok: f.hasVideo ? 1 : 0 } : { need: 0, ok: 0 },
    pushed: pushedCount(g),
    published: pubCount(g),
  }
})

/** 当前阶段 = 步骤轨上第一件没干完的事 */
const pipeCurrent = computed(() => {
  const p = pipeline.value
  if (!p) return 0
  if (p.write < p.total) return 0
  if (p.cards.need !== p.cards.ok || p.film.need !== p.film.ok) return 1
  if (p.pushed < p.total) return 2
  return 3
})

/** 步骤轨四段：一条线只回答「这一步走完没有」，当前段涂黄，不带读数。
 *  中间那段跟着形态换：图文选题盯图卡，视频选题盯成片。
 *  skip ≠ done：图文选题一份图卡都没声明时是「还没轮到有」，画成绿点会让人以为图渲完了。 */
const pipeSegs = computed(() => {
  const p = pipeline.value
  if (!p) return []
  const noCard = !p.cards.need
  const media = p.film.need
    ? { label: '成片', done: p.film.ok === p.film.need, skip: false }
    : { label: '图卡', done: !noCard && p.cards.ok === p.cards.need, skip: noCard }
  return [
    { label: '写稿', done: p.write === p.total, skip: false },
    media,
    { label: '推草稿', done: p.pushed === p.total, skip: false },
    { label: '点发布', done: p.published === p.total, skip: false },
  ].map((seg, i) => ({ ...seg, current: i === pipeCurrent.value }))
})

/** 底栏那颗主动作只看「当前这一版下一件要干的事」：一屏一个，而且永远点得动。
 *  没建版先补建，没稿先出稿，图没渲先渲图，进了草稿箱才谈发布——
 *  不把「发布」摆成一颗点不动的灰按钮，让人去猜它还差哪一步。 */
const activeMove = computed<'none' | 'build' | 'create' | 'cards' | 'push' | 'publish'>(() => {
  const v = active.value
  if (!v) return 'none'
  if (!v.item) return 'build'
  if (v.item.kind === 'draft' || !v.item.article.copy?.trim()) return 'create'
  if (v.item.article.card && !v.item.article.card.urls.length) return 'cards'
  if (!isPushed(v)) return 'push'
  return 'publish'
})
/** 补建这一版是稿子跟前的事（卡片空态自己带入口），不进动作条 */
const barAction = computed(() => (activeMove.value === 'build' || activeMove.value === 'none' ? 'none' : activeMove.value))

// 按账号 id 取后台地址：同平台多号时各号的 backend 相同，但按 id 取才不依赖「平台→主号」的隐式映射
const backendOf = (account: string) => accountById(account)?.backend || ''

/* ==================== 就地发布：弹层里核对平台回读的那一版，按下才让脚本点平台的「发布」 ====================
 * 只接实测过草稿箱回读的平台（抖音的编辑器形态还没实测过——手上没有已推进它草稿箱的稿子可探，
 * 脚本对它的确认档会直接拦下），所以这里先只挂小红书；公众号/视频号/快手/抖音一键打开后台。 */
const PRESSABLE = ['小红书']
/** 定时那一档只接实测过控件的平台：翻开开关、填上时间、核对读回的值，缺一样脚本就不点 */
const SCHEDULABLE = ['小红书']
const press = ref<{ account: string; platform: string; rel: string; backend: string; how: 'publish' | 'schedule' } | null>(null)
/** 发布预览：按账号逐个看脚本会往草稿箱里填什么。只读，不排期、不推。 */
const previewAccount = ref<string | null>(null)

/** 发出去这件事本地数据不会自己变（谁已发布要靠回认），所以一确认就补一次该平台的回认：
 *  日历和状态 chip 自己翻成已发布，不留「那您再去点一下检测」这第二步。 */
async function onPublished(key: string) {
  try {
    await fetch('/__run-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'publish-check', arg: key }),
    })
  } catch { /* 回认没排上（别的同步在跑）：晨间补检会补上这一格 */ }
}

/** 创作依据（原文脚本 + 爆款拆解 + 这一稿的记录）只在弹层里看：
 *  摊在页面上，每一屏都要先滚过两屏原料，才摸得着真正要发出去的那份稿。 */
const basisOpen = ref(false)

/** 记录字段只摆有值的那几行：空字段一排破折号等于把「这条没填」说五遍 */
const recordRows = computed(() => {
  const a = item.value?.article
  if (!a) return []
  return [
    { label: '日期', value: a.date },
    { label: '身份主题', value: a.identity },
    { label: '创作意图', value: a.intent },
    { label: '开头类型', value: a.openingType },
  ].filter((r) => String(r.value ?? '').trim())
})

/** 脚本按「### 第 N 页」切段显示：markdown 记号不摆到界面上，页号当小标题自己占一行 */
const scriptBlocks = computed(() => {
  const raw = String(topicCard.value?.script ?? '')
  if (!raw) return [] as { title: string; body: string }[]
  const out: { title: string; body: string }[] = []
  let cur: { title: string; body: string } | null = null
  for (const line of raw.split('\n')) {
    const head = line.match(/^#{2,4}\s+(.+?)\s*$/)
    if (head) {
      cur = { title: head[1], body: '' }
      out.push(cur)
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line
    } else if (line.trim()) {
      cur = { title: '', body: line }
      out.push(cur)
    }
  }
  return out.map((b) => ({ title: b.title, body: b.body.replace(/\n{3,}/g, '\n\n').trim() })).filter((b) => b.body)
})

/** 图卡没渲出来时，动作条那颗按钮只把人送到渲染位跟前——出图要逐页跑，不当一键按下 */
function gotoCards() {
  document.querySelector('[data-block="images"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** 标题栏读数：常驻报「几/上限」，超了直接说超几个字，不只变红（GPT 第 16 轮判 4） */
const titleOverBy = computed(() => {
  const lim = titleLimit.value
  return lim && titleNow.value.length > lim ? titleNow.value.length - lim : 0
})
/** 正文栏读数同一条规则：平台后台那个框右下角就是这么计数的 */
const copyOverBy = computed(() => {
  const lim = bodyLimit.value
  return lim && editCopy.value.length > lim ? editCopy.value.length - lim : 0
})

/** 顶栏「⋯」：低频又危险的操作不占常驻位，三份提示词也收在这里 */
const menuOpen = ref(false)
/** 推草稿段的「⌄」：范围（整组 / 只这一版）与重推都挂在这里 */
const pushMenu = ref(false)
/** 推送范围只有一个状态：主按钮上的字跟着它走，不让人猜上一次推的是哪一版（GPT 第 14 轮判 3） */
const pushScope = ref<'all' | 'one'>('all')
/** 推送时间也进 ⌄：默认今天推；选「定时推送」才露日期，选完主按钮上就写着排到哪天（GPT 第 15 轮判 2） */
const pushWhen = ref<'now' | 'later'>('now')
/** 检查项只在点开的面板里逐条出现，底栏那颗图标负责把它弹出来。
 *  有号卡在授权上时先切到那一版：点红色图标是去找那个号的，不该只给个面板。 */
const checkOpen = ref(false)
async function showChecks() {
  const bad = group.value ? blockedPush(group.value) : []
  if (bad.length) {
    wanted.value = bad[0].account
    await nextTick()
    document.querySelector(`[data-chan="${CSS.escape(bad[0].account)}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  checkOpen.value = true
}
function backToList() {
  selectedKey.value = null
}

/** 列表卡封面：哪版渲染出了图卡就用哪版的第一页真图，都没有就色块大字（与选题库同款骨架） */
function coverOf(g: TopicGroup) {
  for (const v of g.versions) {
    const c = v.item?.article.card
    if (c?.urls.length) return c.urls[0]
  }
  return ''
}

/** 一条选题只做一种形态：图文选题出图卡稿，视频选题出视频成片（平台外渲染，界面只收成品）。
 *  形态判据在 store 的 topicFormat（顶栏页签、深链、这一屏的筛法共用一份），这里只补它两个读数。 */
function formatOf(g: TopicGroup) {
  const format = topicFormat(g)
  const pages = g.versions.find((v) => v.item?.article.card?.urls.length)?.item?.article.card?.urls.length || 0
  const hasVideo = g.versions.some((v) => !!v.item?.article.card?.video)
  return { format, pageCount: format === 'image' ? pages : 0, hasVideo }
}

/** 卡面 hover 静音播的是这一条已渲出的成片：与形态角标同源，取第一个有素材的版 */
function videoOf(g: TopicGroup) {
  for (const v of g.versions) {
    const u = v.item?.article.card?.videoUrl
    if (u) return u
  }
  return ''
}

/** 卡底赞·藏·评：与选题库同口径——展示来源爆款笔记的数据（创作台自己的稿还没发，无数据可看） */
function srcStatsOf(g: TopicGroup) {
  const t = cardOf(g)
  return { likes: t?.likes ?? '', collects: t?.collects ?? '', comments: t?.comments ?? '' }
}

const { toast } = useToast()

/** 写完的号数（正文非空）：卡面用它说还差几个号 */
function doneCount(g: TopicGroup) {
  return g.versions.filter(isWritten).length
}

/** 已推进平台草稿箱的版本数：区分「还在写」和「写完等你去点发布」 */
function pushedCount(g: TopicGroup) {
  return g.versions.filter(isPushed).length
}

/** 已发布的版本数（部分平台先发出去了）：卡上标 N/M 已发布 */
function pubCount(g: TopicGroup) {
  return g.versions.filter(isPublished).length
}

/** 缺的那一版：送去创作端点会跳过已有稿、只补建缺失骨架 */
function addVersion(g: TopicGroup, platform: string) {
  const card = cardOf(g)
  if (!card) return toast('找不到对应选题卡，去选题库重新送去创作')
  fetch('/__topic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: `content/${card.file}`, platforms: [...g.versions.map((v) => v.platform), platform] }),
  })
    .then((r) => r.json())
    .then((o) => toast(o.ok ? `已补建「${platform}」的稿骨架，刷新后可见` : o.error || '补建失败'))
}

async function deleteDraftFile(t: TopicItem) {
  const resp = await fetch(`/__draft?file=${encodeURIComponent(`content/${t.article.file}`)}`, { method: 'DELETE' })
  const out = await resp.json()
  toast(out.ok ? '已删除' : out.error || '删除失败')
  if (out.ok) selectedKey.value = null
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`已复制：${label}`, 'ok')
  } catch {
    toast('复制失败，请手动选择文本', 'fail')
  }
}

/* 产出形态：图文 or 视频，写回选题卡那一行；改完整页的步骤轨、创作按钮与发布前检查跟着换，
 * 地址栏也搬到对应那一档页签。 */
const formMenu = ref(false)
async function setForm(form: 'image' | 'video') {
  formMenu.value = false
  const card = topicCard.value
  if (!card) return toast('这条选题还没有选题卡，定不了形态')
  if (topicFormat(group.value!) === form) return
  holdSelfWrite() // 写完服务端会重建数据，这段窗口内原地换列表，不整页刷
  const r = await fetch('/__topic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: `content/${card.file}`, form }),
  }).then((x) => x.json()).catch(() => null)
  toast(r?.ok ? (form === 'video' ? '已改走视频创作' : '已改走图文') : '没改成：服务未就绪', r?.ok ? 'ok' : 'fail')
  if (r?.ok && selectedKey.value) syncStudioHash(selectedKey.value, form)
}

/* 内置生成：主路径直接调 /__generate（拆解走 chat 模型，创作走本机 Agent CLI）；复制提示词降为备用入口 */
const gen = useGenerate()
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

async function startCreate(prompt: string) {
  const err = await gen.agentTask('create', prompt, group.value?.title || '', group.value?.key || '')
  if (err) toast(err)
}

/* ==================== 发布前检查：底栏一颗按钮点开面板，不常驻右栏页签 ==================== */
type CheckLevel = 'block' | 'warn' | 'ok'
type CheckGroup = 'content' | 'rule' | 'schedule'
interface Check { level: CheckLevel; label: string; group: CheckGroup }

/** 只看当前选中的这一版：六套平台规则同时铺满正文区，等于把说明文档常驻在版面上 */
const publishChecks = computed<Check[]>(() => {
  const v = active.value
  if (!v || !v.item || v.item.kind === 'draft') return []
  const a = v.item.article
  const plat = v.platform
  const out: Check[] = []
  out.push(a.copy?.trim()
    ? { group: 'content', level: 'ok', label: `${a.copyLabel}已写好（${[...a.copy].length} 字）` }
    : { group: 'content', level: 'block', label: `${a.copyLabel}还是空的` })
  const lim = formOf(plat, v.account).blocks.find((b) => b.key === 'title')?.max || 0
  const tl = [...a.title].length
  if (lim) {
    out.push(tl > lim
      ? { group: 'rule', level: 'block', label: `标题 ${tl} 字，超 ${plat} 的 ${lim} 字上限` }
      : { group: 'rule', level: 'ok', label: `标题 ${tl}/${lim} 字` })
  }
  if (topicForm.value === 'video') {
    const got = !!group.value && formatOf(group.value).hasVideo
    out.push(got
      ? { group: 'content', level: 'ok', label: '视频创作已收到' }
      : { group: 'content', level: 'block', label: '视频创作还没收到' })
  } else if (a.card) {
    out.push(a.card.urls.length
      ? { group: 'content', level: 'ok', label: `图卡 ${a.card.urls.length} 页已出图` }
      : { group: 'content', level: 'block', label: '图卡还没出图' })
  } else {
    out.push({ group: 'content', level: 'warn', label: '没挂图卡' })
  }
  const withLink = /https?:\/\//.test(`${a.copy || ''} ${a.caption || ''}`)
  out.push(withLink
    ? { group: 'rule', level: 'warn', label: `${plat} 的文字里带外链` }
    : { group: 'rule', level: 'ok', label: '文字里没有外链' })
  out.push(a.date
    ? { group: 'schedule', level: 'ok', label: `排期 ${a.date}` }
    : { group: 'schedule', level: 'warn', label: '还没排期' })
  const chip = loginChipOf(v.account)
  out.push(chip.level === 'blocked'
    ? { group: 'schedule', level: 'block', label: `${v.account}${chip.action}` }
    : { group: 'schedule', level: 'ok', label: `${v.account}${chip.action}` })
  return out
})
const CHECK_GROUP_LABEL: Record<CheckGroup, string> = { content: '内容', rule: '平台规则', schedule: '排期' }
const checkGroups = computed(() =>
  (Object.keys(CHECK_GROUP_LABEL) as CheckGroup[])
    .map((key) => ({ label: CHECK_GROUP_LABEL[key], items: publishChecks.value.filter((c) => c.group === key) }))
    .filter((g) => g.items.length),
)
/* ==================== 手改这一版：标题与正文就是平台发布页上那两个框，一直能改 ====================
 * 不再分「看稿 / 编辑」两态：平台后台的发布页从来都是直接填的。
 * 落盘只在离开焦点时做——一边打字一边写文件会把每次退格都存一遍。 */
const editTitle = ref('')
const editCopy = ref('')
const editSaving = ref(false)
const editError = ref('')
const titleNow = computed(() => editTitle.value)
const editDirty = computed(() => {
  const a = item.value?.article
  if (!a) return false
  return editTitle.value !== a.title || editCopy.value !== (a.copy || '')
})
// 切版本、以及数据刷新后回到同一条选题，两个框都要对齐到这一版真正发出去的文字
watch(item, (it) => {
  editTitle.value = it?.article.title || ''
  editCopy.value = it?.article.copy || ''
  editError.value = ''
}, { immediate: true })
function saveOnBlur() {
  if (editDirty.value && !editSaving.value) editSave()
}
async function editSave() {
  const a = item.value?.article
  if (!a || editSaving.value) return
  if (!editTitle.value.trim()) { editError.value = '标题还空着'; return }
  if (!editCopy.value.trim()) { editError.value = '正文空着，发出去就是一张白卡'; return }
  editSaving.value = true
  editError.value = ''
  holdSelfWrite()
  try {
    const r = await (await fetch('/__article', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: `content/${a.file}`, title: editTitle.value, copy: editCopy.value }),
    })).json()
    if (!r.ok) { editError.value = r.error || '没存下'; return }
    toast('已存下', 'ok')
  } catch (e) {
    editError.value = String((e as Error).message || e)
  } finally {
    editSaving.value = false
  }
}

const checkTodo = computed(() => publishChecks.value.filter((c) => c.level !== 'ok').length)

/* ==================== 局部优化：一句意见，命中的整段重写一遍 ====================
 * 「局部」说的是动手范围，不是眼光：换掉一个例子会让承接句、配文、首评、图卡那一行一起失焦，
 * 所以一次把所有版的可改段 + 图卡行 + 来源脚本都交出去，要求牵连处一并捋顺——只改一版会留下说岔话的版。
 * 落盘是整段替换（模型交整段新文字，原文我们从盘上读），界面用词级 diff 把动过的地方标出来。 */
interface RefineEdit {
  target: number; kind: 'md' | 'card'; rel: string; label: string; where: string
  section?: string; path?: (string | number)[]; before: string; after: string; why?: string
}
const refineOpen = ref(false)
const refineText = ref('')
const refineBusy = ref(false)
const refineError = ref('')
const refineNote = ref('')
const refineEdits = ref<(RefineEdit & { keep: boolean; segs: DiffSeg[]; ratio: number })[]>([])

/** 这一条选题当前可改的所有文字：各版稿 + 去重后的图卡 json（一份卡服务五版） */
function refineTargetsOf(g: TopicGroup) {
  const ts: { kind: 'md' | 'card'; rel: string; label: string }[] = []
  const cards = new Set<string>()
  for (const v of g.versions) {
    const a = v.item?.article
    if (!a) continue
    ts.push({ kind: 'md', rel: `content/${a.file}`, label: v.account })
    const j = a.card?.jsonRel
    if (j && !cards.has(j)) { cards.add(j); ts.push({ kind: 'card', rel: j, label: '图卡' }) }
  }
  return ts
}

function refineToggle() {
  refineOpen.value = !refineOpen.value
  if (!refineOpen.value) { refineEdits.value = []; refineError.value = ''; refineNote.value = '' }
}

async function refineAsk() {
  const g = group.value
  if (!g || refineBusy.value || !refineText.value.trim()) return
  const targets = refineTargetsOf(g)
  if (!targets.length) { refineError.value = '稿子还都是空的，先完成创作'; return }
  refineBusy.value = true
  refineError.value = ''
  refineNote.value = ''
  refineEdits.value = []
  try {
    const o = await fetch('/__refine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'plan', instruction: refineText.value, targets,
        basis: topicCard.value?.script || '',
      }),
    }).then((r) => r.json())
    if (!o.ok) { refineError.value = o.error || '模型没给出方案'; return }
    refineEdits.value = (o.edits || []).map((e: RefineEdit) => ({
      ...e, keep: true, segs: diffWords(e.before, e.after), ratio: diffRatio(e.before, e.after),
    }))
    refineNote.value = o.note || ''
    if (!refineEdits.value.length) refineError.value = refineNote.value || '没在这些稿里找到对应的位置，说得更具体一点再试'
  } catch (e) {
    refineError.value = String((e as Error).message || e)
  } finally {
    refineBusy.value = false
  }
}

async function refineApply() {
  const picked = refineEdits.value.filter((e) => e.keep)
  if (!picked.length || refineBusy.value) return
  refineBusy.value = true
  refineError.value = ''
  try {
    const o = await fetch('/__refine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'apply', edits: picked }),
    }).then((r) => r.json())
    if (!o.ok) { refineError.value = o.error || '写回失败'; return }
    const failed = (o.results || []).filter((r: { error?: string }) => r.error)
    const okCount = (o.results || []).length - failed.length
    // 写回完就是整页刷新，内存里的提示活不过那一秒——递进推送结果那条横幅（它本来就是为刷新准备的）
    pushResult.value = {
      ok: !failed.length,
      text: `${okCount} 段已写回${o.rendered?.length ? `，图卡已更新第 ${o.rendered.join('、')} 页` : ''}`
        + (failed.length ? `；${failed.length} 段没落进去：${failed.map((f: { error: string }) => f.error).join(' / ')}` : ''),
    }
    sessionStorage.setItem('mh-push-result', JSON.stringify(pushResult.value))
  } catch (e) {
    refineError.value = String((e as Error).message || e)
  } finally {
    refineBusy.value = false
  }
}

/* ==================== 创作：一条选题只走一条线——图文在这页生成稿与图卡，视频只复制提示词、成片在平台外做 ====================
 * 选题卡一旦送去创作就从选题库收起，所以「复刻依据」（脚本 + 拆解）和创作提示词都要在创作台齐活。 */

/** 视频工程名要 ascii 安全（npm package name 限制）：选题卡文件名可能是中文，这里只留字母数字与连字符 */
const slugOf = (card: TopicCard) => (card.file.split('/').pop() || card.title).replace(/\.md$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'topic'

/** 各版稿的实际路径（已排期的带日期前缀、在 已排期/ 下，只能用真实 file，不能按文件名猜） */
function draftRels(g: TopicGroup) {
  return g.versions.filter((v): v is TopicVersion & { item: TopicItem } => !!v.item)
    .map((v) => ({ account: v.account, rel: `content/${v.item.article.file}` }))
}

/** 图文与视频共用第 1–7 步：读依据、按各平台规范写文案与标题；差别只在第 5 步说内容靠什么承载。 */
function draftBrief(card: TopicCard, g: TopicGroup, form: 'image' | 'video'): string[] {
  const rels = draftRels(g)
  const list = rels.length ? rels.map((r) => r.account) : accounts.map((a) => a.platform)
  return [
    `你是这个自媒体仓库的创作助手。当前工作目录 = media-hub 仓库根。`,
    ``,
    `任务：把这一个选题写成 ${list.length} 个账号版本，分别写进已建好的稿骨架。`,
    `同一套事实与观点，各平台按自己的规范重写——不是把一份稿复制 ${list.length} 遍。`,
    ``,
    `- 选题卡：content/${card.file}`,
    `- 目标稿（骨架已建好，直接往里写）：`,
    ...(rels.length
      ? rels.map((r) => `  · ${r.account}：${r.rel}`)
      : list.map((p) => `  · ${p}：content/Projects/发布排期/${p}/待发布/${card.file.split('/').pop()}`)),
    ``,
    `步骤：`,
    `1. 读选题卡的「来源文件」直达采集卡（没有这行就按「来源信号」的标题去 Inbox/ 找），连脚本、逐页源图与 AI 拆解一起读。采集卡没有「## 脚本」整段就先补采：视频要全程口播逐字稿，图文要把每一页图上的文字全部读出来按页序写回卡里——拆和写都只认这份脚本，不许凭标题猜内容。frontmatter 没有 analysis 块时，再按 content/Knowledge/爆款拆解.md 的框架把拆解补上（写回采集卡）。`,
    `2. 读 content/Knowledge/ 全部规范，写稿按 创作规范.md 执行（标题与封面看它的 §五），00-定位.md 是最高口径；图文文案 SOP 看 .agents/skills/。`,
    `2.1 读 metrics/lessons.md（复盘结论台账，机器从各篇「这篇教会了我们什么」段攒出来）。里面的结论和选题卡「依据经验」引的那一条是**硬约束**：验证过的做法要沿用，踩过同型的坑要避开。台账与选题卡冲突时以台账为准；本篇确实不适用，就在稿的「创作信息」段后补一行说明为什么没照做，别默默改掉。`,
    `3. 写法：来源是爆款时，爆款就复刻爆款——拆解的②钩子里最狠的话上封面，③结构的排布就是图卡页序，主体用原文原话；自己动笔的只有账号视角的「联想/实例」页（①的平移结论）和收尾行动页（⑤的互动位）。原文不好才自己写。没有来源的原创选题按规范自由写。`,
    `4. 案例口径（Knowledge/创作规范.md §二.6）：客观事实、类比、机制、链条直接复刻；**原作者的个人经历／个人案例一律不许搬**，换成我们自己的或虚拟的案例（不写可被核对的硬数字、不冒充亲历）。`,
    `5. ${list.length} 版共用一个事实口径（数字、出处、结论不许各说各话）；${form === 'video' ? '内容主体在这条选题的视频里' : '长内容由图卡承载'}，正文只写小红书那一版，抖音 / 快手 / 视频号 / 公众号各写自己的短文案段。`,
    `6. 每版写进对应小节：小红书 = 正文 + 话题；抖音 = ## 抖音文案；快手 = ## 快手文案；视频号 = ## 视频号文案；公众号 = ## 贴图描述（贴图没有话题，#️ 话题不要塞进描述）。**短文案版（抖音 / 快手 / 视频号 / 公众号）的 \`## 正文\` 段一律留空**——那一段不会进任何草稿箱，写了只是多出一份没人看的压缩摘要；要看长正文，工作台从长文案版取。`,
    `7. 标题各版各起一条，写进该版 md 第一行的 H1（\`# …\`）。来源爆款的原标题**可以直接搬**——那是被市场验证过的钩子，不用重新发明（口径见 Knowledge/创作规范.md §五.1）；搬过来要去掉 \`#话题\`，并且正文第一屏就得兑现它的承诺。原标题撑不住正文时，按步骤 2 读的四种钩子（反常识断言 / 反常识提问 / 数字+信息差 / 人群点名）自己起一条，回答"我为什么点进来"而不是"这篇讲什么"。五版标题不许撞成同一句：同一句话发五个平台，平台判同质，读者也看不出各版差别在哪。字数红线：小红书 / 抖音 / 公众号 ≤20 字，视频号 ≤22 字符（视频号没有标题框，文案首行当标题用），超了会被发布脚本直接截成半句话。**只改 H1，文件名和路径都不要动**——文件名是这条选题各平台版本的聚合键。`,
  ]
}

/** 图文选题：各版文案之外还要一份图卡，并把真图渲出来供发布与验收 */
function writePrompt(card: TopicCard, g: TopicGroup): string {
  const slug = slugOf(card)
  return [
    ...draftBrief(card, g, 'image'),
    `8. 图卡在创作环节就要备齐：写**一份**多页卡片 json 到 content/Projects/卡片/<slug>.json（{slug, brand, title, pages[]}，版式与字段见 .agents/skills/reverse-copy 和该目录既有 json）。卡面 title 与封面大字跟第 7 步选定的那条稿标题同一个口径（原标题或自起都可以，但别带 \`#话题\`），封面大字用那条钩子或其压缩版。一份图卡服务这个选题的各平台稿——稿旁不放复制件，各稿末尾挂一行声明，一字不差地照抄（全角冒号、文件名同行）：卡片数据：${slug}.json 。写成「## 卡片数据」分节、或把文件名另起一行，工作台都读不到，成果预览会显示成纯文字稿。`,
    `9. 写完立刻渲染出图：node scripts/run-ego.mjs scripts/render-cards.mjs --args --card content/Projects/卡片/${slug}.json → public/cards/${slug}/NN.png。图没渲染不算创作完成——我要在创作台翻页预览、验收全部发布内容。图上文字要改就在创作台「编辑文字」里改，保存会自动重渲那一页，不用回终端。`,
  ].join('\n')
}

/** 视频选题：文案之外只要一条成片。视频在平台外渲染，创作台只等成品挂回来。 */
function videoPrompt(card: TopicCard, g: TopicGroup): string {
  const slug = slugOf(card)
  return [
    ...draftBrief(card, g, 'video'),
    `8. 这条选题不写图卡 json、不渲图卡。视频按 content/Knowledge/视频创作.md 在平台外做：用 uni-workbench/skills/video-factory/scripts/init-video-project.mjs 起工程到 media-hub/videos/promo-video-${slug}/（9:16 竖屏、一条选题一条片），品牌与署名读 videos/brand-kit.json。`,
    `9. 成片复制一份到 media-hub/public/videos/${slug}.mp4，再在主稿（有小红书那版就小红书，否则第一版）末尾补一行，一字不差照抄（全角冒号、路径同行）：视频素材：public/videos/${slug}.mp4 。有这一行，创作台才把这条选题认成视频、左侧才播得起来。`,
  ].join('\n')
}

/** 脚本在采集入库时本机自动出；缺源料的旧卡在这里就地重跑一次 */
const scriptBusy = ref(false)
const scriptError = ref('')
function captureScript(card: TopicCard) {
  if (scriptBusy.value || !card.sourceFile) return
  scriptBusy.value = true
  scriptError.value = ''
  fetch('/__script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: card.sourceFile }),
  })
    .then((r) => r.json())
    .then((o) => {
      if (!o.ok) { scriptError.value = o.error || '服务未就绪'; return toast(`出稿失败：${o.error || '服务未就绪'}`, 'fail') }
      toast(`已出稿 ${o.chars} 字`, 'ok')
    })
    .catch(() => toast('出稿失败：服务未就绪', 'fail'))
    .finally(() => (scriptBusy.value = false))
}

async function copyScriptText(card: TopicCard) {
  try {
    await navigator.clipboard.writeText(card.script)
    toast('已复制原文脚本', 'ok')
  } catch {
    toast('复制失败，请手动选择文本', 'fail')
  }
}

function teardownPrompt(card: TopicCard): string {
  return [
    `你是这个自媒体仓库的创作助手。当前工作目录 = media-hub 仓库根。`,
    ``,
    `任务：拆解这个选题的来源采集卡，把结论写回采集卡本身（选题卡只读不写）。`,
    `- 选题卡：content/${card.file}`,
    `- 来源采集卡：${card.sourceFile}（原文链接看它的 frontmatter url）`,
    ``,
    `步骤：`,
    `1. 先读 content/Knowledge/爆款拆解.md（拆解框架与写回格式）和 content/Knowledge/00-定位.md（判断主题能不能平移到我们）。`,
    `2. 采集卡没有「## 脚本」段就先补采（创作台详情里点「补扒脚本」，或自己开 ego-browser 打开原笔记：视频要全程口播逐字稿、图文要把每一页图上的文字全部读出来按页序写回卡里），连逐页源图与高赞评论一起存。拆只认脚本，不许凭标题猜内容。`,
    `3. 按框架逐层拆：每层一句话、30 字内，只写「下次怎么用」的结论——③结构写页序规律不逐页复述、⑤机制写收藏型还是传播型不抄数字，不许写"内容不错"这种废话。`,
    `4. 把五层结论写回采集卡 frontmatter 的 analysis: 块（why/subject/hook/structure/emotion/mechanism），加 analyzedAt: 今天日期。写完即可——工作台会自动刷新，创作台「创作依据」弹层自动带上这份拆解。`,
  ].join('\n')
}

/* ==================== 发布到草稿：日期在这里定，排期 + 推草稿由下面的按钮直接执行 ==================== */
const publishDate = ref(TODAY)

/** 图卡必须创作环节就渲染好：缺图的版出现时拦推草稿入口，回创作台补图验收 */
function missingCards(g: TopicGroup) {
  return g.versions.filter((v) => v.item?.article.card && !v.item.article.card.urls.length)
}

/** 这一题还有几版没进过草稿箱：大按钮的读数与禁用态都看它 */
const todoPush = (g: TopicGroup) => g.versions.filter((v) => canPush(v) && !isPushed(v))

/** 这一步在我们这条链上就叫「推进草稿箱」。平台后台那句「暂存离开」是它自己发布页上的叫法，
 *  搬过来没人认得出它就是「把这一版送进草稿箱」，也就没人明白发布为什么还点不动。 */
const PUSH_LABEL = '推进草稿箱'

/** 范围与时间落在主按钮的字上：只推某个号时报账号名，排了期就写哪天（GPT 第 14 轮判 3、第 15 轮判 2） */
const scopeOne = computed(() => pushScope.value === 'one' && !!active.value && canPush(active.value))
const pushDate = computed(() => (pushWhen.value === 'later' ? publishDate.value || TODAY : TODAY))
const pushScopeHint = () =>
  `${scopeOne.value ? `只推「${active.value!.account}」` : '全部平台'} · ${
    pushWhen.value === 'later' ? `排到 ${pushDate.value}` : '今天进日历'
  }`
/** 发布台底部那颗的字：动作名是平台后台的叫法，后面缀上这次的例外（只推哪个号、排到哪天）。
 *  不报「几版」：分母跟着平台增减，一键推的是全部能推的，报数只让人多做一次减法 */
const saveLabelTail = computed(() => {
  const parts: string[] = []
  if (scopeOne.value && active.value) parts.push(active.value.account)
  if (pushWhen.value === 'later') parts.push(`排到 ${pushDate.value.slice(5).replace('-', '/')}`)
  return parts.join(' · ')
})
function pushByScope(g: TopicGroup) {
  if (scopeOne.value) return pushOne(active.value!)
  return pushAll(g)
}
// 换到推不动的那一版时不带着旧范围走：回到整组，别悄悄沿用
watch(active, (v) => { if (pushScope.value === 'one' && (!v || !canPush(v))) pushScope.value = 'all' })

/* ==================== 逐版「能不能推」：脚本在不在本机 + 登录证据 ====================
 * 判据只有一份，在 data/store 的 loginVerdict：页面上的字与起串前的预检必须同进同退。
 * 登录态不单独开浏览器去探：publish-check 每晚能读到鉴权列表，即已登录的证据（一次五开后台本身就是风控面）。
 * 界面只取 action 那三个字组：后台那句「登录态掉了」和「去工作台重新扫码」都不上版面——
 * 差什么由图标说，怎么补由按钮说。 */
function loginChipOf(account: string): { level: LoginVerdict['level']; action: string } {
  if (!hasPushBridge(account)) {
    return { level: 'blocked', action: isRemote.value ? '要在客户端推' : '要人工发' }
  }
  const v = loginVerdict(account)
  return { level: v.level, action: v.level === 'blocked' ? '要授权' : '可推草稿' }
}

/** 这个号的登录证据不支持推草稿。本机压根没有推送桥的号不算在这里——
 *  那种号不走这条链，五个页签全挂红点等于没说。
 *  页签上不写字：一排挂五句「登录掉了」是把后台状态抄进界面，既不是这一步的动作，也不是只有这里能看到的读数。 */
const authBlocked = (v: TopicVersion) => hasPushBridge(v.account) && loginVerdict(v.account).level === 'blocked'
const authDown = (v: TopicVersion) => !!v.item && isWritten(v) && authBlocked(v)

/** 待推且有明确证据推不动的版：掉线、没扫码、本机没脚本。
 *  「没测出来」（浏览器被接管、正忙、超时）不算在这里——那种读数挡不住一个好号，2026-10-24 快手实测。 */
const blockedPush = (g: TopicGroup) =>
  g.versions.filter((v) => canPush(v) && !isPushed(v) && loginChipOf(v.account).level === 'blocked')

/** 有几个号卡在授权上：只在底栏那颗检查图标上说一次，左栏渠道行不另立一台秤 */
const authTodo = computed(() => (group.value ? blockedPush(group.value).filter(authBlocked).length : 0))

/** 底栏这颗图标亮红还是亮绿：当前这一版差几项，或这一题里有号推不动 */
const checkBad = computed(() => checkTodo.value > 0 || authTodo.value > 0)

/** 渠道行那颗状态灯：这一版走到哪一步。
 *  配色跟页顶进度轨同一套（tone 令牌），轨上绿点在这里还是绿，不用重新学一遍。 */
const verDotCls = (v: TopicVersion) =>
  !v.item || !isWritten(v) ? 'bg-tone-idle'
    : isPublished(v) ? 'bg-tone-published'
      : isPushed(v) ? 'bg-accent' : 'bg-line-strong'

/* ==================== 推草稿：整串交给服务端队列（/__push），页面只渲染进度 ====================
 * 队列活在服务端：刷新、切页、关窗都不会把剩下的版本丢在半路（一次仍只推一版，共用浏览器与参数文件）。 */
const { confirm } = useConfirm()
/** 刷新会冲掉内存状态，推送结果用 sessionStorage 递到刷新后的横幅。
 *  读时不清 key：队列收尾的 gen:data 会再触发一次 SSE 整页刷新，清了就等于横幅闪一下自己没了。 */
const pushResult = ref<{ ok: boolean; text: string; detail?: string } | null>(
  JSON.parse(sessionStorage.getItem('mh-push-result') || 'null'),
)
function dismissPushResult() {
  pushResult.value = null
  sessionStorage.removeItem('mh-push-result')
}

/* 队列的界面侧模型（PushJob / PushStep）住在 data/store，与「看板」页共用一份 */

const pushJob = ref<PushJob | null>(null)
const pushSteps = computed<PushStep[]>(() => pushJob.value?.steps ?? [])
/** 全部推完但 gen:data 还没重建完：这段时间按钮保持禁用，否则用户会拿旧数据再推一遍 */
const pushWaitingData = ref(false)
const pushingPlatform = computed(() => pushSteps.value.find((s) => s.state === 'running')?.platform || '')
const pushBusy = computed(() => pushWaitingData.value || !!pushJob.value?.running)
/** 队列真在跑的那一段（数据刷新那截不算）：只有它可停 */
const pushRunning = computed(() => !!pushJob.value?.running && !pushWaitingData.value)
const pushSettled = computed(() => pushSteps.value.filter((s) => s.state !== 'queued' && s.state !== 'running').length)
/** 推完一轮后还留着的失败项：底栏读数旁边那颗「重试失败项」只看它，不看正在跑的 */
const pushFailed = computed(() => pushBusy.value ? [] : pushSteps.value.filter((s) => s.state === 'fail' || s.state === 'skipped'))

/** 动作条只在有动作可做、或有话要说时钉住：全发完了还留一条空杠就是噪音 */
const barLive = computed(() =>
  barAction.value !== 'none'
  || pushSteps.value.length > 0 || gen.busy.value || !!pushResult.value)

const nowTick = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
let poll: ReturnType<typeof setInterval> | null = null
function startClock() {
  if (clock) return
  clock = setInterval(() => (nowTick.value = Date.now()), 1000)
}
/** 跑着的版按墙上时间计秒，已落定的用服务端记的起止 */
function secsOf(s: PushStep) {
  if (!s.startedAt) return 0
  return Math.max(0, Math.round(((s.endedAt || nowTick.value) - s.startedAt) / 1000))
}
function stopPushWatch() {
  if (poll) clearInterval(poll)
  if (clock) clearInterval(clock)
  poll = clock = null
}

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}

/* 跑着的两路都要能就地按停（规矩：scripts/run-jobs.mjs——有读数就必须有停止）。
   推草稿是「这一版推完就收手」，绝不掐在平台发布页半路；生成是那一条 Agent 任务收 SIGTERM。 */
const genStopping = ref(false)
watch(() => gen.busy.value, (on) => { if (!on) genStopping.value = false })
async function stopGenJob() {
  if (genStopping.value) return
  const r = await stopRunningJob('gen')
  if (r.ok) genStopping.value = true
  else toast(r.error || '停止请求没送到本地服务')
}
async function stopPushQueue() {
  const r = await stopRunningJob('push')
  if (!r.ok) toast(r.error || '停止请求没送到本地服务')
}

/** 接上服务端正在跑的队列：挂进度、盯住刷新，跑完再落横幅 */
function adoptPush(job: PushJob) {
  pushJob.value = job
  dismissPushResult()
  setHoldAutoRefresh(true)
  startClock()
  if (poll) clearInterval(poll)
  poll = setInterval(pollPush, 2000)
}

async function pollPush() {
  let o: { job?: PushJob }
  try {
    o = await (await fetch('/__push')).json()
  } catch {
    return /* 服务瞬断，下一轮再问 */
  }
  if (!o.job) return
  pushJob.value = { ...o.job }
  if (!o.job.running) {
    stopPushWatch()
    await finishPush(o.job)
  }
}


/** 重推语义各平台不同（2026-09-25 实测），确认弹层里说清会发生什么 */
const REPUSH_HINT: Record<string, string> = {
  抖音: '草稿箱是单槽，会直接覆盖旧草稿',
  小红书: '会新增一条草稿，旧的那条要去平台草稿箱手动删除',
  公众号: '会新增一条贴图草稿，旧的那条要去草稿箱手动删除',
  快手: '没有网页草稿箱，会重新打开发布页把内容再填一遍',
  视频号: '会新增一条草稿，旧的那条要去草稿箱手动删除',
}

/** 已发布也允许重推（改了标题/补了图要覆盖旧草稿）；但「全部推」只推还没进过草稿箱的版本 */
const canPush = (v: TopicVersion) => !!v.item && isWritten(v)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** gen:data 有 1.2s 防抖 + 重建耗时，抢先刷新会读到旧数据——页签还是「待推草稿」，看着就像没推成。
 *  轮询到这些平台的「草稿已推」真的出现在数据里才刷新。 */
async function waitForDataFresh(checks: PushStep[]) {
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000) {
    try {
      const raw = await (await fetch('generated.json', { cache: 'no-store' })).json()
      if (checks.every((s) => raw.articles?.find((a: any) => a.file === s.file)?.draftPushed?.[s.platform])) return
    } catch { /* 正在重建，下一轮再试 */ }
    await sleep(1500)
  }
}

/** 队列结果写成横幅文字：sessionStorage 留一份，整页刷新后仍看得见刚才跑到哪 */
function showPushResult(job: PushJob) {
  const okList = job.steps.filter((s) => s.state === 'done')
  const badList = job.steps.filter((s) => s.state === 'fail')
  const leftList = job.steps.filter((s) => s.state === 'skipped')
  pushResult.value = {
    ok: !badList.length && !leftList.length,
    // 摘要说人话：几版进箱、哪几个平台要处理；技术原因（TypeError 原文那类）收进 detail 折叠展示
    text: badList.length || leftList.length
      ? `已推送 ${okList.length} 个 · ${badList.length + leftList.length} 个待处理`
        + (badList.length ? `：${badList.map((s) => s.platform).join('、')}` : '')
        + (job.stopped ? `。人按了停止，后面 ${leftList.length} 版没推` : '')
        + (job.aborted ? '。连错两次已中止，剩下的在下面单独推' : '')
        + (!job.aborted && okList.length ? `（${okList.map((s) => s.platform).join('、')} 已进草稿箱）` : '')
      : `已进草稿箱：${okList.map((s) => `${s.platform}${s.evidence ? ` ${s.evidence}` : ''}`).join('、')}。`,
    detail: badList.length ? badList.map((s) => `${s.platform}：${s.error}`).join('\n') : undefined,
  }
  sessionStorage.setItem('mh-push-result', JSON.stringify(pushResult.value))
}

/** 队列跑完：有版本进箱才等界面数据重建到位后整页刷新（hash 记着选题 key，回来仍停在这条）；
 *  一版都没进箱时不刷——失败原因、脚本日志、「重试这一版」都留在原地的进度卡上 */
async function finishPush(job: PushJob) {
  showPushResult(job)
  setHoldAutoRefresh(false)
  const okList = job.steps.filter((s) => s.state === 'done')
  if (!okList.length) return
  pushWaitingData.value = true
  await waitForDataFresh(okList)
  location.reload()
}

/** 起一串推送：交排给服务端，界面从这一刻起只是渲染它的进度 */
async function startPush(items: { rel: string; platform: string }[]) {
  const o = await postJson('/__push', { items, date: pushDate.value })
    .catch(() => ({ ok: false, error: '服务未就绪' }))
  // busy 时服务端会把正在跑的队列原样带回来：就地接上，不另起一串
  if (o.job?.running) return adoptPush(o.job)
  if (!o.ok) return toast(o.error || '启动推送失败')
  // 头一版在起手上就失败（缺脚本 / 正文为空）：队列已经收工，亮在页面上即可，不必刷页
  pushJob.value = o.job
  showPushResult(o.job)
}

const goAccountsPage = () => { location.hash = '#/accounts' }

/** 推不动的版点下去不空跑两分钟：只说差哪一步，确认就跳到能补那一屏的地方 */
async function goAuth(account: string, action: string) {
  const toAuth = action === '要授权'
  const ok = await confirm({
    title: `「${account}」现在推不动`,
    message: `${action}。`,
    confirmText: toAuth ? '去授权' : '知道了',
    cancelText: '先不推',
  })
  if (ok && toAuth) goAccountsPage()
}

async function pushOne(v: TopicVersion) {
  if (!v.item || !canPush(v) || pushBusy.value) return
  if (v.item.article.card && !v.item.article.card.urls.length) return toast('图卡还没渲染，先补图再推')
  const chip = loginChipOf(v.account)
  if (chip.level === 'blocked') return goAuth(v.account, chip.action)
  if (v.item.article.draftPushed[v.account]) {
    const ok = await confirm({
      title: `重新推送「${v.account}」`,
      message: REPUSH_HINT[v.account] || '旧草稿需人工清理',
      confirmText: '重新推送',
    })
    if (!ok) return
  }
  // 推草稿的目标是账号 id（不是平台）：同平台多号时「抖音」与「抖音-二号」各推各的号
  await startPush([{ rel: `content/${v.item.article.file}`, platform: v.account }])
}

/** 只重试失败的那一版：稿可能已被这一串排进 /已排期/，用 step 记的当前路径交回队列 */
async function retryStep(s: PushStep) {
  if (pushBusy.value) return
  await startPush([{ rel: s.file ? `content/${s.file}` : s.rel, platform: s.platform }])
}

/** 全部推：一次交排，服务端逐版串行（共用浏览器登录态、抖音单槽）；某版失败只标它，剩下的接着推。
 *  起串前先把「有明确证据推不动」的版剔出去：它们撞一次要两分钟，还可能把整串带进「连错两版中止」。 */
async function pushAll(g: TopicGroup) {
  if (pushBusy.value) return
  if (missingCards(g).length) return toast('还有图卡没渲染，先补齐再推')
  const bad = blockedPush(g)
  const vs = g.versions.filter((v): v is TopicVersion & { item: TopicItem } =>
    canPush(v) && !isPushed(v) && !bad.includes(v))
  if (!vs.length) {
    if (!bad.length) return
    const ok = await confirm({
      title: '这几个号推不动',
      message: bad.map((v) => `${v.account}：${loginChipOf(v.account).action}`).join('\n'),
      confirmText: '去授权',
      cancelText: '先不推',
    })
    if (ok) goAccountsPage()
    return
  }
  const ok = await confirm({
    title: '确认批量推送',
    message: '将向所选账号推送草稿。'
      + (bad.length ? `\n\n先不推：\n${bad.map((v) => `· ${v.account}：${loginChipOf(v.account).action}`).join('\n')}` : ''),
    confirmText: '开始推送',
  })
  if (!ok) return
  await startPush(vs.map((v) => ({ rel: `content/${v.item.article.file}`, platform: v.account })))
}

// 刷新或切回这一页时，服务端那串还在跑就接上进度；刚跑完且有失败版也接回来——失败原因与日志只活在这一串里。
// 用 store 模块级那次共享探查（pushJobProbe）：SSE 刷新挂起也是按它的结论放的，两边必须同一个答案——
// 各探各的会在毫秒级错位里一个说在跑一个说跑完，把挂起位卡死。
pushJobProbe.then((job) => {
  if (!job) return
  if (job.running) return adoptPush(job)
  if (Date.now() - (job.finishedAt || 0) < 10 * 60_000
    && job.steps.some((s) => s.state === 'fail' || s.state === 'skipped')) {
    pushJob.value = { ...job }
  }
})
</script>

<template>
  <!-- ==================== 详情：一条选题 = 一个创作台 ====================
       版面照 Buffer 的 composer 走：左=渠道（各版 / 登录态），中=正文，右=真图预览，底=队列与主动作。
       以前是一串卡片自上而下排（创作段、页签、预览、正文、动作条），一屏里五块白底互相不说话；
       现在收成一个外壳三栏，选中哪一版，中栏与右栏一起跟着换。 -->
  <div v-if="group" class="flex flex-col gap-3">
    <!-- ==================== 页顶：一条吸顶头说完「这是哪条 / 走到哪 / 能做什么」 ====================
         版式照列表那几页的 .station-toolbar：贴住工作区页签条下沿，三栏从它底下滚过去。
         标题不再重复两遍——面包屑那一行只留「创作台」当回退，标题本体独占一行。 -->
    <header class="station-toolbar !gap-2 pb-2.5">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="flex shrink-0 items-center gap-1 text-sm leading-5 text-ink-3">
          <button class="transition-colors hover:text-ink hover:underline" @click="backToList">创作台</button>
          <span aria-hidden="true">/</span>
        </span>
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h1 class="max-w-[46ch] truncate text-[17px] font-semibold leading-6 tracking-tight" :title="group.title">{{ group.title }}</h1>
          <!-- 形态由顶栏页签决定，标题旁不再复读一遍；只有还没定形态的选题需要这一颗入口 -->
          <div v-if="topicCard && !topicForm" class="relative shrink-0">
            <button class="chip !py-0.5 transition-colors hover:bg-surface-2" title="还没定形态" @click="formMenu = !formMenu">
              定形态
              <IconChevronDown :size="13" class="shrink-0" />
            </button>
            <template v-if="formMenu">
              <div class="fixed inset-0 z-20" @click="formMenu = false" />
              <div class="absolute left-0 top-full z-30 mt-1 flex w-36 flex-col gap-1 rounded-lg border border-line bg-surface p-1.5 shadow-neo">
                <button class="btn-ghost !justify-start" @click="setForm('image')">图文</button>
                <button class="btn-ghost !justify-start" @click="setForm('video')">视频创作</button>
              </div>
            </template>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <button v-if="topicCard || item" class="btn shrink-0 !px-2 !py-1" aria-label="创作依据" title="创作依据"
            @click="basisOpen = true">
            <IconScrollText :size="15" class="shrink-0" />
          </button>
          <button v-if="deck" class="btn shrink-0 !px-2 !py-1" aria-label="导出图卡" title="导出图卡" @click="exportOpen = true">
            <IconDownload :size="15" class="shrink-0" />
          </button>
          <a v-if="topicCard?.sourceUrl" :href="topicCard.sourceUrl" target="_blank" rel="noopener"
            class="btn-ghost shrink-0 !px-2" aria-label="看原文" title="看原文">
            <IconExternalLink :size="15" class="shrink-0" />
          </a>
          <div class="relative shrink-0">
            <button class="btn !px-2 !py-1" aria-label="更多操作" title="更多操作" @click="menuOpen = !menuOpen">
              <IconMoreHorizontal :size="15" class="shrink-0" />
            </button>
            <template v-if="menuOpen">
              <div class="fixed inset-0 z-20" @click="menuOpen = false" />
              <div class="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col gap-1 rounded-lg border border-line bg-surface p-1.5 shadow-neo">
                <!-- 复制提示词是给外部 Agent 用的备用入口：内置生成能用时不该占正文区两颗按钮 -->
                <button v-if="topicCard && group" class="btn-ghost !justify-start"
                  @click="copyText(topicForm === 'video' ? videoPrompt(topicCard, group) : writePrompt(topicCard, group), topicForm === 'video' ? '视频创作提示词' : '图文创作提示词'); menuOpen = false">
                  <IconCopy :size="13" class="shrink-0" /> {{ topicForm === 'video' ? '复制视频提示词' : '复制图文提示词' }}
                </button>
                <button v-if="topicCard && !topicCard.analysis" class="btn-ghost !justify-start"
                  @click="copyText(teardownPrompt(topicCard), '拆解提示词'); menuOpen = false">
                  <IconCopy :size="13" class="shrink-0" /> 复制拆解提示词
                </button>
                <button v-if="item && item.status !== 'published' && item.article.file.includes('/待发布/')"
                  class="btn-ghost !justify-start !text-red-700"
                  @click="menuOpen = false; deleteDraftFile(item)">
                  <IconTrash2 :size="13" class="shrink-0" /> 删除这份稿
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 进度轨：一条线回答「这一步走完没有」，当前段用强调色；段与段之间用连线接，不摆箭头 -->
      <div class="flex flex-wrap items-center gap-y-1.5 text-sm text-ink-2">
        <template v-for="(seg, i) in pipeSegs" :key="seg.label">
          <span class="flex items-center gap-1.5" :class="seg.current && 'font-medium text-accent'"
            :title="seg.skip ? '这条选题不出图卡' : seg.done ? '已完成' : '未完成'">
            <i class="block h-1.5 w-1.5 shrink-0 rounded-full"
              :class="seg.skip ? 'bg-tone-idle'
                : seg.done ? 'bg-tone-published'
                  : seg.current ? 'bg-accent ring-2 ring-accent/20' : 'bg-line-strong'" />
            {{ seg.label }}
          </span>
          <span v-if="i < pipeSegs.length - 1" class="mx-2 h-px w-8 shrink-0"
            :class="seg.done ? 'bg-tone-published/45' : 'bg-line'" aria-hidden="true" />
        </template>
      </div>
    </header>

    <!-- ==================== 发布台：左=这个平台自己的发布表单，右=发出去在平台里长什么样 ====================
         渠道从左边那条窄栏挪到表单头顶一排页签，跟平台后台的「上传视频 / 上传图文」同一个位置；
         字段按 src/lib/platformForm.ts 那张表摆——各平台自己的顺序、自己的叫法、自己的字数上限。 -->
    <div ref="createEl" class="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_312px]">
      <section class="card flex min-w-0 flex-col overflow-hidden !p-0">
        <!-- 渠道页签：一排切版本，图标和账号名横着排（平台后台的发布页页签就是这个排法），
             行尾那颗点是这一版走到哪了，选中态只加一条下划线、图标不变粗 -->
        <div class="flex shrink-0 items-end gap-x-4 overflow-x-auto border-b border-line px-4 pb-0 pt-1.5">
          <button v-for="vv in group.versions" :key="vv.account" :data-chan="vv.account"
            class="relative flex shrink-0 items-center gap-1.5 whitespace-nowrap pb-2 pt-1.5 text-sm transition-colors"
            :class="vv.account === active?.account ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink'"
            :title="`${vv.account}：${verChip(vv).text}${authDown(vv) ? ' · 要授权' : ''}`"
            @click="wanted = vv.account">
            <IconLoaderCircle v-if="pushingPlatform === vv.account" :size="15" class="shrink-0 animate-spin" />
            <PlatformLogo v-else :platform="vv.platform" :size="15" />
            <span>{{ vv.account }}</span>
            <IconCircleAlert v-if="authDown(vv)" :size="13" class="shrink-0 text-red-600" />
            <i class="block h-1.5 w-1.5 shrink-0 rounded-full" :class="verDotCls(vv)" />
            <span class="absolute inset-x-0 -bottom-px h-[3px] rounded-full transition-opacity"
              :class="vv.account === active?.account ? 'bg-accent' : 'opacity-0'" aria-hidden="true" />
          </button>
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <!-- 这一版还没建出来 -->
          <div v-if="active && !active.item" class="flex flex-col items-start gap-3 p-6">
            <h2 class="text-[15px] font-semibold">「{{ active.account }}」还没有稿</h2>
            <button class="btn btn-primary !px-4" @click="addVersion(group, active.platform)">
              <IconPlus :size="15" class="shrink-0" /> 补建
            </button>
          </div>

          <!-- 空骨架：正文还没写 -->
          <div v-else-if="item && item.kind === 'draft'" class="p-6">
            <div class="mb-2 flex flex-wrap gap-2">
              <span class="chip status-not-start">草稿</span>
              <span class="chip">{{ active!.platform }}</span>
              <span v-if="item.article.source" class="chip">来自 {{ item.article.source }}</span>
            </div>
            <p class="text-sm leading-6 text-ink-2">正文还没写。</p>
          </div>

          <!-- 成稿：这一版就是那个平台自己的发布页——字段按 src/lib/platformForm.ts 摆，
               顺序、叫法、字数上限都跟后台一致；标题和正文一直能改，后台的发布页从不分「看稿 / 编辑」。 -->
          <div v-else-if="item" class="flex min-w-0 flex-col">
            <div class="max-w-[54rem] px-5 pb-5 pt-4">
              <section v-for="b in shownBlocks" :key="b.key" :data-block="b.key" class="mb-5 last:mb-0">
                <div class="mb-1.5 flex items-baseline justify-between gap-3">
                  <h3 class="text-sm font-medium">{{ b.label }}</h3>
                  <span v-if="b.key === 'title'" class="text-sm tabular-nums" :class="titleOverBy ? 'text-red-600' : 'text-ink-3'">
                    {{ titleNow.length }}<template v-if="b.max">/{{ b.max }}</template> 字<template v-if="titleOverBy"> · 超 {{ titleOverBy }} 字</template>
                  </span>
                  <span v-else-if="b.key === 'body'" class="text-sm tabular-nums" :class="copyOverBy ? 'text-red-600' : 'text-ink-3'">
                    {{ editCopy.length }}<template v-if="b.max">/{{ b.max }}</template> 字<template v-if="copyOverBy"> · 超 {{ copyOverBy }} 字</template>
                  </span>
                  <span v-else-if="b.key === 'images' && pageCount && b.max" class="text-sm tabular-nums text-ink-3">{{ pageCount }}/{{ b.max }}</span>
                  <span v-else-if="b.key === 'images' && pageCount" class="text-sm tabular-nums text-ink-3">{{ pageCount }} 张</span>
                </div>

                <AssetPreview v-if="b.key === 'images'" :article="item.article" bare />

                <input v-else-if="b.key === 'title'" v-model="editTitle"
                  class="input w-full !px-3 !py-2 text-[16px] font-semibold" :disabled="editSaving"
                  :placeholder="'写' + b.label" @blur="saveOnBlur" />

                <template v-else-if="b.key === 'body'">
                  <textarea v-model="editCopy" rows="12" class="input w-full resize-y !px-3 !py-2.5 text-[15px] leading-7"
                    :disabled="editSaving" :placeholder="'一行一句写下要发出去的' + b.label" @blur="saveOnBlur" />
                  <p v-if="editError" class="mt-1.5 text-sm leading-5 text-red-700">{{ editError }}</p>
                  <p v-else-if="editSaving" class="mt-1.5 text-sm leading-5 text-ink-3">存下中…</p>
                  <!-- 改字这件事跟在字跟前：优化、以及那份不会发出去的完整文案，都收在这排图标里 -->
                  <div class="mt-1.5 flex items-center gap-1">
                    <button class="btn-ghost !px-2 !py-1" :class="refineOpen && 'is-selected'"
                      :aria-label="refineOpen ? '收起优化' : 'AI 优化'"
                      :title="refineOpen ? '收起优化' : '说一句哪里不满意，模型重出这几段'" @click="refineToggle">
                      <IconWandSparkles :size="15" class="shrink-0" />
                    </button>
                    <button v-if="mother || item.article.caption" class="btn-ghost !px-2 !py-1"
                      :aria-label="showMother ? '收起完整文案' : '查看完整文案'"
                      :title="showMother ? '收起完整文案' : '完整文案（这一版不会发出去）'" @click="showMother = !showMother">
                      <IconChevronDown :size="15" class="shrink-0 transition-transform" :class="showMother && '-rotate-180'" />
                    </button>
                  </div>
                  <div v-if="showMother && (mother || item.article.caption)"
                    class="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 p-3">
                    <RichText v-if="mother" :text="mother.text" class="text-sm text-ink-2" />
                    <p v-if="item.article.caption" class="text-sm leading-6 text-ink-2">{{ item.article.caption }}</p>
                  </div>
                </template>

                <!-- 话题：脚本把它拼在文案尾巴上进平台，这里只回读这一版带了哪几个 -->
                <div v-else-if="b.key === 'tags'" class="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                  <span v-for="t in tagList" :key="t" class="chip !bg-accent-soft !text-accent">{{ t }}</span>
                  <p v-if="!tagList.length" class="text-sm leading-5 text-ink-3">没带话题。</p>
                </div>

                <div v-else-if="b.key === 'music'" class="flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-sm">
                  <IconMusic :size="15" class="shrink-0 text-ink-3" />
                  <span v-if="item.article.music">{{ item.article.music }}</span>
                  <span v-else class="text-ink-3">没配乐</span>
                </div>

                <div v-else-if="b.key === 'weapp'" class="flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-sm">
                  <IconLink :size="15" class="shrink-0 text-ink-3" />
                  <span v-if="landingUrl" class="break-all">{{ landingUrl }}</span>
                  <span v-else class="text-ink-3">不挂小程序</span>
                </div>

                <pre v-else-if="b.key === 'firstComment'"
                  class="whitespace-pre-wrap rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 font-sans text-sm leading-6">{{ item.article.firstComment }}</pre>
              </section>
            </div>
          </div>

          <!-- 优化面板：一句意见 → 逐段新文字（词级标出动了哪）→ 勾选采纳才落盘 -->
          <div v-if="refineOpen" class="border-t border-line bg-surface-2/40 px-5 py-2.5">
            <div class="flex items-start gap-2">
              <textarea v-model="refineText" rows="2" class="input min-w-0 flex-1 !py-2 leading-6"
                placeholder="说一句哪里不满意，例如：Hello World 那个例子太程序员了，换个不写代码的人也看得懂的"
                @keydown.meta.enter.prevent="refineAsk" />
              <button class="btn shrink-0 !px-3 !py-2" :disabled="refineBusy || !refineText.trim()"
                title="出方案" @click="refineAsk">
                <IconLoaderCircle v-if="refineBusy" :size="13" class="animate-spin" />
                <IconSparkles v-else :size="13" class="shrink-0" />
                {{ refineBusy ? '模型在改…' : '出方案' }}
              </button>
            </div>
            <p v-if="refineError" class="mt-2 text-sm font-medium leading-5 text-red-700">{{ refineError }}</p>
            <template v-if="refineEdits.length">
              <p class="mt-2.5 text-sm font-medium text-ink-2">
                {{ refineNote ? refineNote + ' ｜' : '' }}重写 {{ refineEdits.length }} 段，勾上要写回的
              </p>
              <ul class="mt-2 flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
                <li v-for="(e, i) in refineEdits" :key="i"
                  class="rounded-lg border border-line bg-surface p-2" :class="e.keep ? '!border-line-strong' : 'opacity-50'">
                  <label class="flex cursor-pointer items-center gap-2 text-sm font-medium">
                    <input v-model="e.keep" type="checkbox" class="h-3.5 w-3.5 shrink-0 accent-accent" />
                    <span class="chip !px-1.5 !py-0">{{ e.label }}</span>
                    <span>{{ e.where }}</span>
                    <span class="ml-auto text-ink-2">动了 {{ e.ratio }}%</span>
                  </label>
                  <p class="mt-1.5 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words px-1.5 py-1 text-sm leading-6">
                    <span v-for="(seg, j) in e.segs" :key="j"
                      :class="seg.t === 'del' ? 'bg-red-50 text-red-700 line-through'
                        : seg.t === 'ins' ? 'bg-green-50 px-0.5 text-green-700' : 'text-ink-2'">{{ seg.s }}</span>
                  </p>
                  <p v-if="e.why" class="mt-1 text-sm leading-4 text-ink-2">理由：{{ e.why }}</p>
                </li>
              </ul>
              <div class="mt-2">
                <button class="btn !px-3 !py-1.5" :disabled="refineBusy || !refineEdits.some((e) => e.keep)"
                  title="写回并更新图卡" @click="refineApply">
                  <IconRotateCw v-if="refineBusy" :size="13" class="animate-spin" />
                  应用方案
                </button>
              </div>
            </template>
          </div>
        </div>

        </section>

        <!-- ---------- 右：发出去在平台里长什么样（手机壳 / 图文消息卡，跟着这一版的渠道换） ---------- -->
        <aside class="card flex min-w-0 flex-col overflow-hidden !p-0 md:col-span-2 xl:col-span-1">
          <div class="min-w-0 flex-1 p-2.5">
            <PlatformPreview v-if="item && active" :article="item.article" :platform="active.platform" :account="active.account" />
            <p v-else class="px-1 py-6 text-sm leading-6 text-ink-3">还没有内容可预览。</p>
          </div>
        </aside>
    </div>

    <!-- ==================== 页底：队列与主动作 ====================
         队列是这一条选题唯一的状态区：逐版一行，失败的那行就地展开原因与日志。
         主动作永远只有一个（推 / 发），排期收在它左边。 -->
    <div v-if="barLive" class="sticky bottom-0 z-10 -mt-1 border-t border-line bg-canvas pt-2.5">
      <ul v-if="pushSteps.length" class="mb-2 max-h-[30vh] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface text-sm">
        <li v-for="s in pushSteps" :key="s.platform" class="px-3 py-1.5">
          <div class="flex items-center gap-2">
            <span class="flex w-4 shrink-0 justify-center">
              <IconLoaderCircle v-if="s.state === 'running'" :size="13" class="animate-spin" />
              <IconCircleCheck v-else-if="s.state === 'done'" :size="13" class="text-green-700" />
              <IconCircleX v-else-if="s.state === 'fail'" :size="13" class="text-red-600" />
              <IconCircleAlert v-else :size="13" class="text-ink-3" />
            </span>
            <PlatformLogo :platform="s.platform" :size="14" />
            <span class="w-16 shrink-0 truncate font-medium">{{ s.platform }}</span>
            <span class="min-w-0 flex-1 truncate"
              :class="s.state === 'fail' ? 'text-red-700' : s.state === 'done' ? 'text-green-700' : 'text-ink-2'">
              <template v-if="s.state === 'queued'">
                {{ pushJob?.napUntil && pushJob.napUntil > nowTick ? `歇 ${Math.ceil((pushJob.napUntil - nowTick) / 1000)}s` : '排队中' }}
              </template>
              <template v-else-if="s.state === 'running'">正在浏览器里填平台后台…</template>
              <template v-else-if="s.state === 'done'">{{ s.evidence || '已进草稿箱' }}</template>
              <template v-else-if="s.state === 'skipped'">连错两次后中止，没轮到</template>
              <template v-else>{{ s.error }}</template>
            </span>
            <span v-if="s.startedAt" class="shrink-0 text-sm tabular-nums text-ink-3">{{ secsOf(s) }}s</span>
            <!-- 号本身不行时不给「重试」：再重试一次还是撞在两分钟后的同一句报错上 -->
            <button v-if="(s.state === 'fail' || s.state === 'skipped') && !pushBusy && isAccountDeadCode(s.code)"
              class="btn shrink-0 !px-2 !py-0" title="去账号页重新授权"
              @click="goAccountsPage">
              <IconQrCode :size="13" class="shrink-0" /> 去授权
            </button>
            <button v-else-if="(s.state === 'fail' || s.state === 'skipped') && !pushBusy"
              class="btn shrink-0 !px-2 !py-0" :title="`重推「${s.platform}」`"
              @click="retryStep(s)">
              <IconRotateCw :size="13" class="shrink-0" /> 重试
            </button>
          </div>
          <p v-if="s.state === 'fail' && s.action" class="ml-[26px] text-xs leading-5 text-ink-2">{{ s.action }}</p>
          <details v-if="s.state === 'fail' && s.log" class="ml-[26px]">
            <summary class="cursor-pointer text-xs leading-5 text-ink-3">脚本输出尾巴</summary>
            <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-2 text-xs leading-4 text-ink-2">{{ s.log }}</pre>
          </details>
        </li>
      </ul>

      <!-- 内置生成跑在这条选题上时，进度得报在这儿 -->
      <div v-if="gen.busy.value" class="flex items-center gap-2 py-0.5 text-sm font-medium">
        <IconLoaderCircle :size="15" class="animate-spin shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ gen.runningText.value }}进行中{{ gen.progress.value ? '：' + gen.progress.value : '' }}</span>
        <span class="shrink-0 tabular-nums font-medium text-ink-2">
          {{ genStopping ? '已按停，正在收尾' : `已跑 ${mmss(gen.elapsed.value)}${gen.limitMs.value ? ` / 上限 ${Math.round(gen.limitMs.value / 60000)} 分` : ''}` }}
        </span>
        <button
          class="shrink-0 rounded-md p-0.5 text-ink-3 hover:text-ink"
          :class="genStopping && 'cursor-not-allowed opacity-50'"
          :title="genStopping ? '已经在收了' : `停止${gen.runningText.value}`"
          :aria-label="`停止${gen.runningText.value}`"
          @click="stopGenJob"
        >
          <IconSquare :size="13" />
        </button>
      </div>

      <template v-else>
        <!-- 上一次推送的结论（刷新后从 sessionStorage 递回来）：摘要一行，技术原因折叠 -->
        <div v-if="pushResult && !pushSteps.length" class="mb-2 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm leading-5">
          <IconCircleCheck v-if="pushResult.ok" :size="15" class="mt-0.5 shrink-0 text-green-700" />
          <IconCircleAlert v-else :size="15" class="mt-0.5 shrink-0 text-red-600" />
          <div class="min-w-0 flex-1">
            <span class="font-medium" :class="pushResult.ok ? 'text-ink' : 'text-red-700'">{{ pushResult.text }}</span>
            <details v-if="pushResult.detail" class="mt-0.5">
              <summary class="cursor-pointer text-xs text-ink-3">技术细节</summary>
              <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-2 text-xs leading-4 text-ink-2">{{ pushResult.detail }}</pre>
            </details>
          </div>
          <button class="shrink-0 rounded-md p-0.5 text-ink-3 hover:text-ink" aria-label="知道了" title="知道了" @click="dismissPushResult()"><IconX :size="15" /></button>
        </div>

        <!-- 一条动作栏：左边发布前的两只眼（检查、预览），右边只有一颗主动作。
             主动作只看「这一版下一件要干的事」，永远点得动——差哪一步由它自己说，不摆灰按钮让人猜。 -->
        <div class="flex flex-wrap items-center gap-2 pb-1">
          <button v-if="publishChecks.length && !isRemote" class="btn-ghost !px-1.5 !py-1.5" :class="checkBad ? '!text-red-600' : ''"
            :aria-label="checkBad ? '发布前检查' : '检查通过'"
            :title="authTodo ? `${authTodo} 个号要授权` : checkTodo ? `${checkTodo} 项待处理` : '检查通过'"
            @click="showChecks">
            <IconCircleAlert v-if="checkBad" :size="15" class="shrink-0" />
            <IconCircleCheck v-else :size="15" class="shrink-0 text-green-700" />
          </button>

          <button v-if="!isRemote && group.versions.some((v) => v.item)" class="btn-ghost !px-1.5 !py-1.5"
            aria-label="发布预览" title="发布预览"
            @click="previewAccount = active && active.item ? active.account : (group.versions.find((v) => v.item)?.account || '')">
            <IconEye :size="15" class="shrink-0" />
          </button>

          <!-- 推草稿与发布要本机浏览器：网页版这台机器上没有你的浏览器，整组动作收在客户端提示里 -->
          <ClientOnly v-if="isRemote" what="推草稿与发布" class="ml-auto" />
          <div v-else-if="barAction !== 'none' && active && item" class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            <!-- 这一版还没成稿：图文交给内置创作一次写全，视频在平台外做，只把提示词交出去 -->
            <template v-if="barAction === 'create' && topicCard && group">
              <button v-if="topicForm === 'video'" class="btn btn-primary !px-3.5 !py-1.5" title="复制视频创作提示词"
                @click="copyText(videoPrompt(topicCard, group), '视频创作提示词')">
                <IconCopy :size="15" class="shrink-0" /> 复制视频提示词
              </button>
              <button v-else class="btn btn-primary !px-3.5 !py-1.5" :disabled="gen.busy.value" title="一次写完并渲好图卡"
                @click="startCreate(writePrompt(topicCard, group))">
                <IconLoaderCircle v-if="gen.runningKind.value === 'create'" :size="15" class="animate-spin" />
                <IconSparkles v-else :size="15" class="shrink-0" />
                {{ gen.runningKind.value === 'create' ? '创作中…' : '生成图文稿' }}
              </button>
            </template>

            <!-- 图卡没渲：把人送到渲染位跟前。出图逐页要跑，不在这儿一键替人决定 -->
            <template v-else-if="barAction === 'cards'">
              <button class="btn btn-primary !px-3.5 !py-1.5" :title="`「${active.account}」的图卡还没出图`" @click="gotoCards">
                <IconImages :size="15" class="shrink-0" /> 渲图卡
              </button>
            </template>

            <!-- 还没进草稿箱：主动作就是把这一版（或整组）送进去，范围与时间收在它的 ⌄ 里 -->
            <template v-else-if="barAction === 'push'">
              <div class="relative flex shrink-0">
                <button class="btn btn-primary !py-1.5 !pl-3.5 !pr-1.5 rounded-r-none" :disabled="pushBusy"
                  :title="pushFailed.length ? '有号没推进草稿箱'
                    : blockedPush(group).length === todoPush(group).length ? '有号推不动'
                      : '按平台排期并推草稿'"
                  @click="pushByScope(group)">
                  <IconLoaderCircle v-if="pushBusy" :size="15" class="animate-spin" />
                  <IconRotateCw v-else-if="pushFailed.length" :size="15" />
                  <IconSend v-else :size="15" />
                  {{ pushBusy
                    ? (pushWaitingData ? '已进草稿箱，正在刷新数据…' : `正在推送 ${pushSettled}/${pushSteps.length}${pushingPlatform ? `（${pushingPlatform}）` : ''}…`)
                    : pushFailed.length ? `${PUSH_LABEL} · 重推` : `${PUSH_LABEL}${saveLabelTail ? ` · ${saveLabelTail}` : ''}` }}
                  <IconChevronDown :size="13" class="ml-1 shrink-0 opacity-70" />
                </button>
                <!-- 跑着的时候这一格换成停止（范围菜单在跑动中改没有意义），停法是「这一版推完就收手」 -->
                <button v-if="pushRunning" class="btn !px-1.5 !py-1.5 rounded-l-none border-l border-line"
                  aria-label="停止推送" title="停止推送" @click="stopPushQueue">
                  <IconSquare :size="15" class="shrink-0" />
                </button>
                <button v-else class="btn !px-1.5 !py-1.5 rounded-l-none border-l border-line" aria-label="推送范围与时间"
                  title="推送范围与时间" @click="pushMenu = !pushMenu">
                  <span class="sr-only">推送范围与时间</span>
                </button>
                <template v-if="pushMenu">
                  <div class="fixed inset-0 z-20" @click="pushMenu = false" />
                  <div class="absolute bottom-full right-0 z-30 mb-1 flex w-64 flex-col gap-0.5 rounded-lg border border-line bg-surface p-1.5 shadow-neo">
                    <p class="px-2 pt-0.5 text-sm leading-5 text-ink-3">推送范围</p>
                    <button class="btn-ghost !justify-start" @click="pushScope = 'all'; pushMenu = false">
                      <IconCheck :size="13" class="shrink-0" :class="scopeOne ? 'opacity-0' : 'opacity-100'" />
                      全部平台
                    </button>
                    <button v-if="active && canPush(active)" class="btn-ghost !justify-start"
                      @click="pushScope = 'one'; pushMenu = false">
                      <IconCheck :size="13" class="shrink-0" :class="scopeOne ? 'opacity-100' : 'opacity-0'" />
                      仅「{{ active.account }}」
                    </button>
                    <p class="mt-1 px-2 text-sm leading-5 text-ink-3">推送时间</p>
                    <button class="btn-ghost !justify-start" @click="pushWhen = 'now'">
                      <IconCheck :size="13" class="shrink-0" :class="pushWhen === 'now' ? 'opacity-100' : 'opacity-0'" />
                      立即推送
                    </button>
                    <button class="btn-ghost !justify-start" @click="pushWhen = 'later'">
                      <IconCheck :size="13" class="shrink-0" :class="pushWhen === 'later' ? 'opacity-100' : 'opacity-0'" />
                      定时推送
                    </button>
                    <label v-if="pushWhen === 'later'" class="mb-0.5 flex items-center gap-1.5 pl-6 text-sm text-ink-2">
                      排到
                      <input v-model="publishDate" type="date" :min="TODAY" class="input !px-2 !py-1" />
                    </label>
                    <p class="mt-1 border-t border-line px-2 pt-1 text-sm leading-5 text-ink-3">{{ pushScopeHint() }}</p>
                    <button v-if="active && canPush(active)" class="btn-ghost !justify-start"
                      @click="pushMenu = false; pushOne(active)">
                      <IconRotateCw :size="13" class="shrink-0" /> 重新推送「{{ active.account }}」
                    </button>
                  </div>
                </template>
              </div>
            </template>

            <!-- 每一版都进了草稿箱：这一步才是发布。能回读草稿箱的平台由脚本核对后代点，其余打开后台 -->
            <template v-else-if="barAction === 'publish'">
              <template v-if="PRESSABLE.includes(active.platform)">
                <button v-if="SCHEDULABLE.includes(active.platform)" class="btn !px-3.5 !py-1.5" :disabled="!!press"
                  :title="`挂到${active.account}的定时发布`"
                  @click="press = { account: active.account, platform: active.platform, rel: `content/${item.article.file}`, backend: backendOf(active.account), how: 'schedule' }">
                  {{ form.actions.schedule }}
                </button>
                <button class="btn btn-primary !px-3.5 !py-1.5" :disabled="!!press"
                  :title="`核对${active.account}草稿箱，由它点发布`"
                  @click="press = { account: active.account, platform: active.platform, rel: `content/${item.article.file}`, backend: backendOf(active.account), how: 'publish' }">
                  {{ form.actions.publish }}
                </button>
              </template>
              <a v-else :href="backendOf(active.account) || undefined" target="_blank" rel="noopener"
                class="btn btn-primary !px-3.5 !py-1.5" :title="`打开${active.account}后台草稿箱`">
                {{ form.actions.publish }}
                <IconExternalLink :size="13" class="shrink-0" />
              </a>
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>

  <!-- ==================== 列表：一卡一选题（版式照灵感库：吸顶头 + 封面墙 + 触底加载） ==================== -->
  <div v-else class="flex flex-col">
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜标题、账号、品牌、来源" label="搜索创作中的选题" />
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex flex-wrap items-center gap-1">
          <button
            v-for="s in stages"
            :key="s"
            class="seg"
            :class="filter === s ? 'is-selected' : ''"
            :title="s === 'draft' ? '还在写或没推齐' : s === 'todo' ? '都在草稿箱' : '已发出一部分'"
            @click="filter = s"
          >{{ STAGE_TEXT[s] }} <span class="ml-1 font-medium tabular-nums">{{ countOf(s) }}</span></button>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <FilterSelect v-model="fPlatform" placeholder="平台" :options="platformOptions" />
          <FilterSelect v-model="fProduct" placeholder="品牌" :options="productOptions" />
          <FilterSelect v-model="fSchedule" placeholder="排期" :options="scheduleOptions" />
          <button v-if="filterOn" class="btn-ghost !px-2" aria-label="清除筛选" title="清除筛选" @click="clearFilters">
            <IconCircleX :size="15" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="!shown.length && filterOn" class="py-16 text-center text-sm text-ink-2">
      这个组合下没有选题——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="clearFilters">清掉筛选</button>
      看全部。
    </p>
    <p v-else-if="!shown.length && otherStage" class="py-16 text-center text-sm text-ink-2">
      {{ STAGE_TEXT[filter] }}这一档清空了——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="jumpToOtherStage">
        {{ otherStageText }}
      </button>。
    </p>
    <p v-else-if="!shown.length" class="py-16 text-center text-sm text-ink-2">
      创作台还没有活——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="goTopics">去选题库送去创作</button>。
    </p>

    <!-- 封面墙：卡面与 hover 动效都在 NoteCard。整卡就是一个入口（点开接着做这条），所以不铺操作按钮 -->
    <div v-if="shown.length" class="columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5">
      <NoteCard
        v-for="{ g, stage } in visible"
        :key="g.key"
        :seed="g.key"
        :heading="g.title"
        :cover-image="coverOf(g)"
        :format="formatOf(g).format"
        :page-count="formatOf(g).pageCount"
        :likes="srcStatsOf(g).likes"
        :video-url="videoOf(g)"
        :title="`接着做这一条：${STAGE_TEXT[stage]}`"
        @click="selectedKey = g.key"
      >
        <template #chip>
          <!-- 阶段不上卡面：这一屏只看得到当前页签那一档，每张卡挂同一个「草稿」等于把页签抄一遍 -->
          <CardChip v-if="missingCards(g).length" tone="warn" label="图卡还没渲出来，推草稿前先补"><IconCircleAlert :size="13" /></CardChip>
        </template>
        <template #foot>
          <span class="shrink-0">{{ g.date || '未排期' }}</span>
          <!-- 只说还差几个号，不报 N/M：分母跟着平台表长，写死一个分数明年就是废话 -->
          <span v-if="g.versions.length - doneCount(g)" class="ml-auto shrink-0 tabular-nums">
            还差 {{ g.versions.length - doneCount(g) }} 个号
          </span>
        </template>
      </NoteCard>
    </div>

    <!-- 触底哨兵：常驻不消失，滚到这里就再铺一批 -->
    <div ref="sentinelEl" class="flex h-12 items-center justify-center">
      <span v-if="loadingMore" class="flex items-center gap-2 text-sm text-ink-3">
        <IconLoaderCircle :size="15" class="animate-spin" />
        加载中
      </span>
    </div>
  </div>

  <PublishModal v-if="press" v-bind="press" @close="press = null" @published="onPublished" />

  <!-- ==================== 创作依据：脚本与拆解都收进弹层，正文区不留噪音 ==================== -->
  <DetailModal v-if="basisOpen && (topicCard || item)" @close="basisOpen = false">
    <template #title>
      <span class="font-medium">创作依据</span>
      <span v-if="topicCard" class="ml-1.5 font-normal text-ink-3">
        {{ topicCard.script ? `${topicCard.script.length} 字脚本` : '缺脚本' }} ·
        {{ topicCard.analysis ? '已拆解' : '未拆解' }}
      </span>
    </template>

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <!-- 爆款拆解：五层一行一层，长文不摊开 -->
      <section v-if="topicCard">
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-sm font-semibold">爆款拆解</h2>
          <span v-if="topicCard.analysis" class="ml-auto flex items-center gap-1 text-sm font-normal text-ink-3">
            <IconSparkles :size="13" />{{ topicCard.analyzedAt }}
          </span>
          <button v-else-if="topicCard.sourceFile" class="btn ml-auto !px-2.5 !py-1" :disabled="gen.busy.value"
            title="读脚本出五层结论" @click="gen.teardown(topicCard.sourceFile!).then((e) => e && toast(e))">
            <IconLoaderCircle v-if="gen.runningKind.value === 'teardown'" :size="13" class="animate-spin" />
            <IconSparkles v-else :size="13" class="shrink-0" />
            {{ gen.runningKind.value === 'teardown' ? '拆解中…' : '内置拆解' }}
          </button>
        </div>
        <dl v-if="topicCard.analysis" class="flex flex-col divide-y divide-line text-sm">
          <div v-for="sec in ANALYSIS_SECTIONS" :key="sec.key" class="flex gap-3 py-2">
            <dt class="w-14 shrink-0 text-ink-3">{{ sec.label }}</dt>
            <dd class="min-w-0 flex-1 leading-6">{{ topicCard.analysis![sec.key] }}</dd>
          </div>
        </dl>
        <p v-else-if="!topicCard.sourceFile" class="py-6 text-center text-sm text-ink-3">这一条没有来源采集卡。</p>

        <button v-if="topicCard.analysis" class="btn-ghost mt-2 !px-2 !py-0.5 text-sm font-normal text-ink-3"
          :disabled="gen.busy.value" title="重跑一次拆解" @click="gen.teardown(topicCard.sourceFile!).then((e) => e && toast(e))">
          <IconRotateCw :size="13" class="shrink-0" />重新拆解
        </button>
      </section>

      <!-- 原文脚本：整段可滚，复制走图标 -->
      <section v-if="topicCard">
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-sm font-semibold">原文脚本</h2>
          <span v-if="topicCard.script" class="text-sm font-normal text-ink-3">
            {{ topicCard.format === 'video' ? '口播逐字稿' : topicCard.format === 'image' ? '逐页图内文字' : '来源脚本' }}
          </span>
          <button v-if="topicCard.script" class="btn-ghost ml-auto !px-1.5 !py-1" aria-label="复制完整脚本" title="复制完整脚本"
            @click="copyScriptText(topicCard)">
            <IconCopy :size="15" />
          </button>
        </div>
        <div v-if="topicCard.script" class="max-h-[46vh] space-y-3 overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
          <div v-for="(b, bi) in scriptBlocks" :key="bi">
            <p v-if="b.title" class="mb-1 text-sm font-medium leading-5 text-ink-3">{{ b.title }}</p>
            <p class="whitespace-pre-wrap text-sm leading-6">{{ b.body }}</p>
          </div>
        </div>
        <div v-else-if="topicCard.sourceFile" class="rounded-lg border border-dashed border-line p-4">
          <p class="mb-2 text-sm text-ink-3">脚本还没扒回来。</p>
          <button class="btn !px-3 !py-1" :disabled="scriptBusy" @click="captureScript(topicCard)">
            <IconLoaderCircle v-if="scriptBusy" :size="13" class="animate-spin" />
            {{ scriptBusy ? '扒取中…' : '补扒脚本' }}
          </button>
          <p v-if="scriptError" class="mt-2 text-sm font-medium text-red-600">{{ scriptError }}</p>
        </div>
        <p v-else class="py-6 text-center text-sm text-ink-3">这一条没有来源采集卡。</p>
      </section>

      <!-- 记录：只有稿子带这些字段才占位，空值不摆一排破折号 -->
      <dl v-if="item && recordRows.length" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-line pt-4 text-sm lg:col-span-2">
        <template v-for="r in recordRows" :key="r.label">
          <dt class="text-ink-3">{{ r.label }}</dt>
          <dd class="leading-6">{{ r.value }}</dd>
        </template>
      </dl>
    </div>
  </DetailModal>
  <PublishPreviewModal v-if="previewAccount && group" :versions="group.versions" :initial="previewAccount"
    @close="previewAccount = null" />
  <ExportModal v-if="exportOpen && deck" :slug="deck.slug" :title="deck.title" :images="deck.images"
    @close="exportOpen = false" />
  <PublishCheckModal v-if="checkOpen" :groups="checkGroups" @close="checkOpen = false" />
</template>
