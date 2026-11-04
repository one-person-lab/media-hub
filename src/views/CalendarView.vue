<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { articles, lastPublishSyncAt, TODAY, platformOf, ANALYSIS_SECTIONS, cardOf, motherOf, lanesOf, laneState, laneDue, laneJudgeable, judgeableLanes, versionKeyOf, products, type Article, type Lane, type Mother, type TopicCard } from '../data/store'
import PlatformLogo from '../components/PlatformLogo.vue'
import LandingLinks from '../components/LandingLinks.vue'
import SyncButton from '../components/SyncButton.vue'
import BentoSegmented from '../components/BentoSegmented.vue'
import DetailModal from '../components/DetailModal.vue'
import AssetPreview from '../components/AssetPreview.vue'
import RichText from '../components/RichText.vue'
import { CalendarDays as IconCalendarDays, ChevronDown as IconChevronDown, ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight, Copy as IconCopy, ExternalLink as IconExternalLink } from 'lucide-vue-next'

/** 发布日历 = 周/月两档排期面 + 右栏当日泳道（原发布中心已并入本页）。
 *  一篇内容一条（各平台版本按「剥掉日期前缀的文件名」归组，与创作台同口径），
 *  点日期格或点卡都在右栏落到那一天——卡内一个平台一条泳道，logo 认平台、状态只读。 */

// ---------- 内容归组（一内容一组，组内平台泳道） ----------
interface PubGroup {
  key: string
  title: string
  /** 归属品牌（组内各版一致——立项时从选题卡写进每一版骨架）；空 = 人格内容 */
  product: string
  lanes: Lane[]
  items: Article[]
  card: TopicCard | null
}

const allGroups = computed<PubGroup[]>(() => {
  const byKey = new Map<string, Article[]>()
  for (const a of articles) {
    const k = versionKeyOf(a)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(a)
  }
  return [...byKey.entries()].map<PubGroup>(([key, items]) => {
    const card = cardOf(key, items.map((i) => i.source))
    const ids = card?.platforms.length
      ? card.platforms
      : [...new Set(items.map((i) => i.account))]
    return {
      key,
      title: items[0]!.title,
      product: items[0]!.product || '',
      items,
      card: card || null,
      lanes: lanesOf(items, ids),
    }
  })
})

// ---------- 品牌筛选（多品牌推广防冲突：同一时间窗只主推一个品牌） ----------
/** 空品牌的显示名：人格内容是养信任的主菜，不挂任何品牌 */
const PERSONAL = '人格内容'
const productFilter = ref('')
/** 筛选胶囊 = config/products.json 登记的 + 稿里实际写过的（后者让手填的新品牌立刻可筛，不必先改 config） */
const productOptions = computed(() => {
  const names = [...products]
  for (const g of allGroups.value) if (g.product && !names.includes(g.product)) names.push(g.product)
  return names
})
const groups = computed<PubGroup[]>(() => {
  const f = productFilter.value
  if (!f) return allGroups.value
  if (f === PERSONAL) return allGroups.value.filter((g) => !g.product)
  return allGroups.value.filter((g) => g.product === f)
})

function dueDate(g: PubGroup) {
  const dates = g.items.map((a) => a.date).filter((d): d is string => !!d)
  return dates.length ? dates.sort()[0]! : ''
}

/** 这一条还差几个号没发：只数判得了的泳道，「没采到」不算「没发」 */
function unpublishedCount(g: PubGroup) {
  return judgeableLanes(g.lanes).filter((l) => laneState(l) !== 'published').length
}

/** 分母只数判得了的泳道：某平台后台登录掉了，那一格是「没采到」不是「没发」 */
function scoredLanes(g: PubGroup) {
  return judgeableLanes(g.lanes)
}
const allPublished = (g: PubGroup) => {
  const judged = scoredLanes(g)
  return judged.length > 0 && judged.every((l) => laneState(l) === 'published')
}

/** 一条内容在版面上的颜色只看一件事：到期了还没发＝红，全发完＝绿，其余按推进程度 */
type GroupStatus = 'overdue' | 'published' | 'draft' | 'pending' | 'unknown'
function groupStatus(g: PubGroup): GroupStatus {
  if (g.lanes.some(laneDue)) return 'overdue'
  if (allPublished(g)) return 'published'
  const judged = scoredLanes(g)
  if (!judged.length) return 'unknown'
  if (judged.some((l) => laneState(l) === 'drafted')) return 'draft'
  return 'pending'
}
const STATUS_BAR: Record<GroupStatus, string> = {
  overdue: 'cal-overdue', published: 'cal-published', draft: 'cal-draft',
  pending: 'cal-pending', unknown: 'cal-pending',
}
const STATUS_TIP: Record<GroupStatus, string> = {
  overdue: '到期未发', published: '全部已发', draft: '草稿已推', pending: '待推草稿', unknown: '未检测',
}

/** 读数缺口一句话：机器还没采到 ≠ 平台没给这项 ≠ 人的活——三种说清，别把没采到说成未回填 */
function dataGapLabel(g: PubGroup) {
  const gaps = g.items.filter((a) => !a.metricsFilled)
  if (gaps.every((a) => a.dataState === 'platform_gap')) return '平台没给这项'
  if (gaps.every((a) => a.dataState === 'not_collected')) return '还没采到'
  return '部分数据未回填'
}
function dataGapTitle(g: PubGroup) {
  const gaps = g.items.filter((a) => !a.metricsFilled)
  const noCollect = gaps.filter((a) => a.dataState === 'not_collected').length
  const platformGap = gaps.filter((a) => a.dataState === 'platform_gap').length
  const parts: string[] = []
  if (noCollect) parts.push(`${noCollect} 篇还没采到（后台没有逐篇数据或没采到）`)
  if (platformGap) parts.push(`${platformGap} 篇平台没给这项`)
  return parts.join('；')
}
const dueToday = computed(() => groups.value.filter((g) => g.lanes.some(laneDue)))

// ---------- 日期算式：一切都从「锚定那一天」推 ----------
const p2 = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}
const addDays = (s: string, n: number) => {
  const d = fromIso(s)
  d.setDate(d.getDate() + n)
  return toIso(d)
}
/** 先归到 1 号再加月，月底锚定时不会跳进下个月（10-31 +1 月 ≠ 12-01） */
const addMonths = (s: string, n: number) => {
  const d = fromIso(s)
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  return toIso(d)
}
/** 周一为一周开始 */
const mondayOf = (s: string) => addDays(s, -((fromIso(s).getDay() + 6) % 7))
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const weekdayOf = (s: string) => WEEKDAYS[(fromIso(s).getDay() + 6) % 7]!

type Mode = 'week' | 'month'
const mode = ref<Mode>('month')
const MODE_ITEMS: { id: Mode; label: string }[] = [{ id: 'week', label: '周' }, { id: 'month', label: '月' }]
const anchor = ref<string>(TODAY)
const selected = ref<string>(TODAY)
/** 从日历点进右栏的那一条：右栏跟着高亮，人才找得着刚点的那张卡 */
const activeKey = ref('')

const monthLabel = computed(() => {
  const a = fromIso(anchor.value)
  return `${a.getFullYear()} 年 ${a.getMonth() + 1} 月`
})
const rangeLabel = computed(() => {
  if (mode.value === 'month') return monthLabel.value
  const s = fromIso(mondayOf(anchor.value))
  const e = fromIso(addDays(mondayOf(anchor.value), 6))
  const y = s.getFullYear() === e.getFullYear() ? `${s.getFullYear()} 年 ` : ''
  return s.getMonth() === e.getMonth()
    ? `${y}${s.getMonth() + 1} 月 ${s.getDate()} – ${e.getDate()} 日`
    : `${y}${s.getMonth() + 1} 月 ${s.getDate()} 日 – ${e.getMonth() + 1} 月 ${e.getDate()} 日`
})

/** 一组挂在它最早有日期的那一格 */
const byDate = computed(() => {
  const map: Record<string, PubGroup[]> = {}
  for (const g of groups.value) {
    const d = dueDate(g)
    if (!d) continue
    ;(map[d] ||= []).push(g)
  }
  return map
})

interface Cell {
  iso: string
  day: number
  inMonth: boolean
  items: PubGroup[]
}

const cells = computed<Cell[]>(() => {
  const a = fromIso(anchor.value)
  const start = mode.value === 'month'
    ? new Date(a.getFullYear(), a.getMonth(), 1 - ((new Date(a.getFullYear(), a.getMonth(), 1).getDay() + 6) % 7))
    : fromIso(mondayOf(anchor.value))
  const out: Cell[] = []
  for (let i = 0; i < (mode.value === 'month' ? 42 : 7); i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = toIso(d)
    out.push({ iso, day: d.getDate(), inMonth: d.getMonth() === a.getMonth(), items: byDate.value[iso] || [] })
  }
  return out
})

/** 月格窄，一格只摊两条；周日历宽，摊到四条 */
const cellCap = computed(() => (mode.value === 'month' ? 2 : 4))

function shift(n: number) {
  anchor.value = mode.value === 'month' ? addMonths(anchor.value, n) : addDays(anchor.value, n * 7)
}

// ---------- 右栏：选中那一天 ----------
const railBody = ref<HTMLElement | null>(null)
const drawerGroups = computed(() => byDate.value[selected.value] || [])
const dayLabel = computed(() => {
  const d = fromIso(selected.value)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
})

// 点格子就把锚定一起带走：切视图档时落在选中的那一天，右栏和版面不会各说一段
function pickDay(c: Cell) {
  selected.value = c.iso
  anchor.value = c.iso
  activeKey.value = ''
}

async function pickGroup(iso: string, g: PubGroup) {
  selected.value = iso
  anchor.value = iso
  activeKey.value = g.key
  await nextTick()
  const esc = g.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  railBody.value?.querySelector(`[data-day-card="${esc}"]`)?.scrollIntoView({ block: 'nearest' })
}

function gotoToday() {
  anchor.value = TODAY
  selected.value = TODAY
  activeKey.value = ''
}

function jumpTo(g: PubGroup) {
  const d = dueDate(g)
  if (!d) return
  anchor.value = d
  void pickGroup(d, g)
}

// 吸顶工具条的高度右栏要知道：它贴着工具条下沿停住，工具条换行时不会露出一道缝
const toolbar = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
onMounted(() => {
  const el = toolbar.value
  if (!el) return
  const write = () => document.documentElement.style.setProperty('--cal-toolbar-h', `${el.offsetHeight}px`)
  write()
  ro = new ResizeObserver(write)
  ro.observe(el)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  document.documentElement.style.removeProperty('--cal-toolbar-h')
})

// ---------- 泳道展示 ----------
function laneLink(l: Lane) {
  const a = l.article
  if (!a) return ''
  // 键是账号 id：同平台两个号的发布链接各归各
  return a.publishLinks[l.account] || a.detected[l.account]?.url || ''
}

/** 这一格现在什么状态：界面上只出这四个词，「没采到」与「没建」另说 */
function laneLabel(l: Lane) {
  if (!l.article) return '还没建'
  if (laneState(l) === 'published') {
    const at = l.article.detected[l.account]?.publishedAt
    return at ? `已发布 · ${at.slice(5, 10)}` : '已发布'
  }
  if (laneState(l) === 'drafted') return `草稿已推 · ${l.article.draftPushed[l.account].slice(5, 10)}`
  if (!laneJudgeable(l)) return '未检测'
  return '未推草稿'
}
function laneInk(l: Lane) {
  if (!l.article || !laneJudgeable(l)) return 'text-ink-3'
  if (laneState(l) === 'published') return 'text-success'
  return 'text-ink-2'
}

function publishPack(a: Article) {
  return [a.copy, '', '—— 发布配文 ——', a.caption, '', a.tags, a.firstComment && ['—— 首评引导 ——', a.firstComment].join('\n')].filter(Boolean).join('\n')
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用时不打扰 */ }
}

// 查看内容弹层：点整条泳道打开——成品（图卡/视频 + 正文 + 配文 + 创作信息）为主，
// 复刻依据默认收起在底部，要给「成品 ↔ 原料」留一条回看的路。
const viewing = ref<{ article: Article; account: string; card: TopicCard | null; mother: Mother | null } | null>(null)
const basisOpen = ref(false)
/** 短文案版的长正文母本默认收起：发出去的是文案段，母本只供回看 */
const motherOpen = ref(false)

function openView(g: PubGroup, a: Article, account: string) {
  viewing.value = { article: a, account, card: g.card, mother: motherOf(g.items, a) }
  basisOpen.value = false
  motherOpen.value = false
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div ref="toolbar" class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <div class="flex shrink-0 items-center gap-1">
          <button class="btn-ghost !px-2 !py-1" aria-label="上一页" title="上一页" @click="shift(-1)">
            <IconChevronLeft :size="15" />
          </button>
          <span class="min-w-[11rem] text-center text-[15px] font-medium tabular-nums text-ink">{{ rangeLabel }}</span>
          <button class="btn-ghost !px-2 !py-1" aria-label="下一页" title="下一页" @click="shift(1)">
            <IconChevronRight :size="15" />
          </button>
        </div>
        <BentoSegmented label="视图" :items="MODE_ITEMS" :model-value="mode" @update:model-value="mode = $event as Mode" />

        <div class="ml-auto flex shrink-0 items-center gap-2">
          <SyncButton task="publish-check" :at="lastPublishSyncAt" quiet />
          <button class="btn-ghost !px-2" aria-label="回到今天" title="回到今天" @click="gotoToday">
            <IconCalendarDays :size="15" />
          </button>
        </div>
      </div>

      <!-- 品牌筛选：多品牌推广，一个时间窗只主推一个品牌 -->
      <div v-if="productOptions.length" class="flex flex-wrap items-center gap-1">
        <span class="mr-1 shrink-0 text-sm text-ink-3">品牌</span>
        <button
          v-for="p in ['全部', PERSONAL, ...productOptions]"
          :key="p"
          class="seg"
          :class="(p === '全部' ? '' : p) === productFilter && 'is-selected'"
          :title="p === PERSONAL ? '品牌内容' : `只看归属品牌「${p}」的排期`"
          @click="productFilter = p === '全部' ? '' : p"
        >{{ p }}</button>
      </div>
    </div>

    <div class="flex flex-col items-stretch gap-4 lg:flex-row lg:items-start lg:gap-5">
      <!-- ============ 排期面：一张表格，格与格只用发丝线分开，整面撑满一屏 ============ -->
      <div class="flex min-h-[520px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-neo lg:h-[calc(100vh-var(--station-tabs-h,0px)-var(--cal-toolbar-h,0px)-36px)]">
        <!-- 周历每一列自己报「几号·星期几」，上面那行星期头就是重复 -->
        <div v-if="mode === 'month'" class="grid shrink-0 grid-cols-7 border-b border-line bg-surface-2">
          <div
            v-for="(w, i) in WEEKDAYS"
            :key="w"
            class="px-2 py-2 text-xs font-medium text-ink-3"
            :class="i === 6 ? '' : 'border-r border-line'"
          >{{ w }}</div>
        </div>

        <div class="grid flex-1 auto-rows-fr grid-cols-7">
          <div
            v-for="(c, i) in cells"
            :key="c.iso"
            class="flex min-h-0 flex-col gap-1 overflow-hidden p-1.5 transition-colors"
            :class="[
              i % 7 !== 6 && 'border-r border-line',
              i < cells.length - 7 && 'border-b border-line',
              c.iso === selected ? 'bg-surface-2' : 'hover:bg-surface-2/70',
              !c.inMonth && 'bg-canvas/40',
            ]"
            @click="pickDay(c)"
          >
            <!-- 日期头：今天是一颗实心块，选中那一天只把数字提亮，跨月的只压暗数字 -->
            <div class="flex shrink-0 items-center gap-1.5 px-0.5 pt-0.5">
              <span
                class="grid size-[22px] shrink-0 place-items-center rounded-md text-xs tabular-nums"
                :class="c.iso === TODAY
                  ? 'bg-accent font-medium text-accent-ink'
                  : c.iso === selected
                    ? 'font-medium text-ink'
                    : c.inMonth ? 'text-ink-2' : 'text-ink-3 opacity-60'"
              >{{ c.day }}</span>
              <span v-if="mode === 'week'" class="text-xs text-ink-3">{{ weekdayOf(c.iso) }}</span>
            </div>

            <!-- 一篇内容一条：左边一条状态色，右下角平台标记 -->
            <button
              v-for="g in c.items.slice(0, cellCap)"
              :key="g.key"
              data-cal-chip
              class="relative flex min-w-0 shrink-0 flex-col gap-1 rounded-md py-1 pl-3 pr-1.5 text-left transition-colors"
              :class="g.key === activeKey && c.iso === selected ? 'bg-surface ring-1 ring-accent/70' : 'hover:bg-surface-2'"
              :title="`${g.title} · ${STATUS_TIP[groupStatus(g)]}${g.product ? ` · ${g.product}` : ''}`"
              @click.stop="pickGroup(c.iso, g)"
            >
              <span class="absolute bottom-1 left-1 top-1 w-[3px] rounded-full" :class="STATUS_BAR[groupStatus(g)]" />
              <span class="min-w-0 text-xs leading-4 text-ink" :class="mode === 'month' ? 'truncate' : 'line-clamp-2'">{{ g.title }}</span>
              <span class="flex items-center gap-0.5">
                <span
                  v-for="l in g.lanes"
                  :key="l.account"
                  class="inline-flex"
                  :class="[
                    laneState(l) === 'published' ? '' : laneJudgeable(l) ? 'opacity-25' : 'rounded-sm opacity-40 outline-1 outline-dashed outline-line-strong',
                  ]"
                  :title="`${l.platform}${!l.article ? '（还没建）' : laneJudgeable(l) ? '' : '（未检测）'}`"
                >
                  <PlatformLogo :platform="l.platform" :size="10" />
                </span>
              </span>
            </button>
            <span v-if="c.items.length > cellCap" class="shrink-0 pl-3 text-xs tabular-nums text-ink-3">
              还有 {{ c.items.length - cellCap }} 条
            </span>
          </div>
        </div>
      </div>

      <!-- ============ 右栏：选中那一天 + 到期未发 ============ -->
      <aside
        ref="railBody"
        class="flex w-full shrink-0 flex-col gap-4 lg:sticky lg:max-h-[calc(100vh-var(--station-tabs-h,0px)-var(--cal-toolbar-h,0px)-44px)] lg:overflow-y-auto lg:w-[340px]"
        :style="{ top: 'calc(var(--station-tabs-h,0px) + var(--cal-toolbar-h,0px) + 16px)' }"
      >
        <section class="card !p-0 overflow-hidden">
          <header class="flex items-baseline gap-2 border-b border-line px-3.5 py-2.5">
            <h3 class="text-sm font-medium tabular-nums text-ink">{{ dayLabel }}</h3>
            <span class="text-xs text-ink-3">{{ weekdayOf(selected) }}</span>
          </header>

          <div v-if="drawerGroups.length" class="flex flex-col divide-y divide-line">
            <article
              v-for="g in drawerGroups"
              :key="g.key"
              data-day-card
              class="flex flex-col gap-2 px-3.5 py-3"
              :class="g.key === activeKey ? 'bg-surface-2' : ''"
            >
              <div class="flex items-start gap-2">
                <h4 class="min-w-0 flex-1 text-sm font-medium leading-5 text-ink">{{ g.title }}</h4>
                <span v-if="g.product" class="chip shrink-0 !px-1.5 !py-0" :title="`归属品牌：${g.product}`">{{ g.product }}</span>
              </div>
              <p v-if="unpublishedCount(g)" class="text-xs tabular-nums text-ink-2">
                差 {{ unpublishedCount(g) }} 个号没发
              </p>
              <p
                v-else-if="g.items.length && !g.items.every((a) => a.metricsFilled) && allPublished(g)"
                class="text-xs text-ink-3"
                :title="dataGapTitle(g)"
              >{{ dataGapLabel(g) }}</p>

              <!-- 平台泳道：logo 认平台，整行点开这一版的全貌 -->
              <div class="flex flex-col">
                <div
                  v-for="l in g.lanes"
                  :key="l.account"
                  class="group/lane flex items-center gap-2 rounded-md px-1.5 py-1.5"
                  :class="l.article ? 'cursor-pointer hover:bg-surface-2' : ''"
                  @click="l.article && openView(g, l.article, l.account)"
                >
                  <PlatformLogo :platform="l.platform" :size="16" />
                  <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ l.label }}</span>
                  <span class="shrink-0 text-xs tabular-nums" :class="laneInk(l)">{{ laneLabel(l) }}</span>
                  <span v-if="l.article" class="hidden shrink-0 items-center gap-0.5 group-hover/lane:flex">
                    <a
                      v-if="laneLink(l)"
                      :href="laneLink(l)"
                      target="_blank"
                      class="btn-ghost !px-1 !py-1"
                      aria-label="平台原文"
                      title="平台原文"
                      @click.stop
                    >
                      <IconExternalLink :size="13" />
                    </a>
                    <button
                      class="btn-ghost !px-1 !py-1"
                      aria-label="复制发布包"
                      title="复制发布包"
                      @click.stop="copy(publishPack(l.article))"
                    >
                      <IconCopy :size="13" />
                    </button>
                  </span>
                </div>
              </div>

              <LandingLinks :landing="g.items[0]!.landing" />
            </article>
          </div>
          <p v-else class="px-3.5 py-10 text-center text-sm text-ink-3">这一天没有排期</p>
        </section>

        <section v-if="dueToday.length" class="card !p-0 overflow-hidden">
          <header class="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <span class="size-1.5 shrink-0 rounded-full cal-overdue" />
            <h3 class="text-sm font-medium text-ink">到期未发</h3>
          </header>
          <div class="flex flex-col divide-y divide-line">
            <button
              v-for="g in dueToday"
              :key="g.key"
              class="flex flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
              @click="jumpTo(g)"
            >
              <span class="min-w-0 truncate text-sm text-ink">{{ g.title }}</span>
              <span class="flex items-center gap-2 text-xs tabular-nums">
                <span class="text-ink-3">{{ dueDate(g).slice(5).replace('-', '/') }}</span>
                <span class="text-ink-2">差 {{ unpublishedCount(g) }} 个号</span>
              </span>
            </button>
          </div>
        </section>
      </aside>
    </div>

    <!-- ============ 查看内容弹层：图卡/视频成果 + 正文 + 配文 ============ -->
    <DetailModal v-if="viewing" @close="viewing = null">
      <template #title>{{ viewing.article.title }}</template>
      <div class="flex flex-col gap-5">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="flex items-center gap-2 text-sm text-ink">
            <PlatformLogo :platform="platformOf(viewing.account)" :size="18" />
            {{ platformOf(viewing.account) }}
          </span>
          <span class="text-sm text-ink-2 tabular-nums">{{ viewing.article.date || '未排期' }}</span>
          <a
            v-if="viewing.article.publishLinks[viewing.account] || viewing.article.detected[viewing.account]?.url"
            :href="viewing.article.publishLinks[viewing.account] || viewing.article.detected[viewing.account]!.url"
            target="_blank"
            class="text-sm text-accent hover:underline"
          >平台原文 ↗</a>
        </div>

        <div class="grid grid-cols-1 items-start gap-5 lg:grid-cols-[380px_1fr]">
          <div class="lg:sticky lg:top-[var(--station-tabs-h,0px)]">
            <AssetPreview :article="viewing.article" />
          </div>
          <div class="flex flex-col gap-6">
            <section>
              <h3 class="mb-2 text-sm font-medium text-ink">{{ viewing.article.copyLabel }}</h3>
              <RichText :text="viewing.article.copy" class="max-h-[60vh] overflow-y-auto" />
              <template v-if="viewing.mother">
                <button class="btn-ghost mt-2 !px-2" :title="'各平台共用的长正文，不会发布'"
                  @click="motherOpen = !motherOpen">
                  <IconChevronDown :size="15" class="shrink-0 transition-transform" :class="motherOpen && '-rotate-180'" />
                  完整文案
                </button>
                <RichText v-if="motherOpen" :text="viewing.mother.text" class="mt-2 max-h-[40vh] overflow-y-auto text-ink-2" />
              </template>
            </section>
            <section v-if="viewing.article.caption">
              <h3 class="mb-2 text-sm font-medium text-ink">发布配文</h3>
              <p class="text-sm leading-6">{{ viewing.article.caption }}</p>
              <p v-if="viewing.article.tags" class="mt-2 text-sm text-ink-2">{{ viewing.article.tags }}</p>
              <template v-if="viewing.article.firstComment">
                <h4 class="mb-1 mt-4 text-sm font-medium text-ink">首评引导</h4>
                <pre class="whitespace-pre-wrap font-sans text-sm leading-6 text-ink-2">{{ viewing.article.firstComment }}</pre>
              </template>
            </section>

            <section>
              <h3 class="mb-2 text-sm font-medium text-ink">创作信息</h3>
              <dl class="grid grid-cols-[76px_1fr] gap-y-2 text-sm">
                <dt class="text-ink-2">日期</dt>
                <dd>{{ viewing.article.date || '未排期' }}</dd>
                <dt class="text-ink-2">身份主题</dt>
                <dd>{{ viewing.article.identity || '—' }}</dd>
                <dt class="text-ink-2">创作意图</dt>
                <dd class="leading-6">{{ viewing.article.intent || '—' }}</dd>
                <dt class="text-ink-2">灵感来源</dt>
                <dd class="leading-6">{{ viewing.article.source || '—' }}</dd>
                <dt class="text-ink-2">开头类型</dt>
                <dd>{{ viewing.article.openingType || '—' }}</dd>
                <dt class="text-ink-2">归属品牌</dt>
                <dd>{{ viewing.article.product || '—（人格内容，不挂品牌）' }}</dd>
              </dl>
            </section>

            <!-- 复刻依据：脚本与拆解的本体在来源采集卡上，选题卡只带回链——发完后从这里回看原料 -->
            <section v-if="viewing.card && (viewing.card.script || viewing.card.analysis)" class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 class="text-sm font-medium text-ink">复刻依据</h3>
                <template v-if="!basisOpen">
                  <span class="text-sm text-ink-3">{{ viewing.card.script ? `脚本 ${viewing.card.script.length} 字` : '缺脚本' }}</span>
                  <span class="text-sm text-ink-3">· {{ viewing.card.analysis ? '已拆解' : '未拆解' }}</span>
                </template>
                <a
                  v-if="viewing.card.sourceUrl"
                  :href="viewing.card.sourceUrl"
                  target="_blank"
                  class="btn-ghost !px-2"
                  title="打开来源爆款原文，核对拆解与脚本"
                  @click.stop
                >来源原文 ↗</a>
                <button class="btn-ghost ml-auto !px-2" :aria-label="basisOpen ? '收起依据' : '展开原文脚本与爆款拆解'" :title="basisOpen ? '收起依据' : '展开原文脚本与爆款拆解'" @click="basisOpen = !basisOpen">
                  <IconChevronDown :size="15" class="shrink-0 transition-transform" :class="basisOpen && '-rotate-180'" />
                </button>
              </div>
              <template v-if="basisOpen">
                <template v-if="viewing.card.script">
                  <div class="flex items-center gap-2 text-sm text-ink">
                    原文脚本
                    <span class="ml-auto text-sm text-ink-2">
                      {{ viewing.card.format === 'video' ? '视频 · 全程口播逐字稿' : viewing.card.format === 'image' ? '图文 · 逐页图内文字' : '来源脚本' }}
                    </span>
                  </div>
                  <pre class="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-sm leading-6">{{ viewing.card.script }}</pre>
                </template>
                <template v-if="viewing.card.analysis">
                  <div class="mt-2 flex items-center gap-2 text-sm text-ink">
                    爆款拆解
                    <span v-if="viewing.card.analyzedAt" class="ml-auto text-sm text-ink-2">{{ viewing.card.analyzedAt }}</span>
                  </div>
                  <dl class="grid grid-cols-[92px_1fr] gap-y-2 text-sm">
                    <template v-for="sec in ANALYSIS_SECTIONS" :key="sec.key">
                      <dt class="text-ink-2">{{ sec.label }}</dt>
                      <dd class="leading-6">{{ viewing.card.analysis![sec.key] }}</dd>
                    </template>
                  </dl>
                </template>
                <p class="mt-1 text-sm leading-6 text-ink-3">
                  来自《{{ viewing.card.sourceTitle || viewing.card.source }}》——脚本与拆解只存来源采集卡一份。
                </p>
              </template>
            </section>
          </div>
        </div>
      </div>
    </DetailModal>
  </div>
</template>
