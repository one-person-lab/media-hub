<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  accounts, articles, platformLatest, publishStat, periodPair, periodStat, ratio, platformLabel, liveBuckets,
  accountLabel, lastSyncAt, PLATFORM_META, dailySeries, dailyAxis, dailyByPlatform, versionKeyOf,
  works, workGaps, reviewTopics,
  gotoStudio,
  type DailyMetric, type PeriodStat, type Work,
} from '../data/store'
import PageHeader from '../components/PageHeader.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import ReviewModal from '../components/ReviewModal.vue'
import SyncButton from '../components/SyncButton.vue'
import BentoBars, { type BarSeries } from '../components/BentoBars.vue'
import BentoDelta from '../components/BentoDelta.vue'
import BentoSegmented from '../components/BentoSegmented.vue'
import CountUp from '../components/CountUp.vue'
import { useToast } from '../lib/useToast'
import { CircleAlert as IconCircleAlert, Notebook as IconNotebook } from 'lucide-vue-next'

/* 版式跟看板同一套 bento（2026-11-01）：一卡一件事，大数字 + 内嵌图表面板；
   取数口径不动，还是 store 里那套「本周期 vs 上周期、基数不全不给环比」。 */

/* ---------------- 页内分区 ---------------- */
type Section = 'overview' | 'works' | 'accounts'
const section = ref<Section>('overview')
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'works', label: '作品榜' },
  { id: 'accounts', label: '账号' },
]

/* ---------------- 时间窗：本周期 vs 上周期 ---------------- */
const RANGES = [7, 14, 30]
const range = ref(7)
const pair = computed(() => periodPair(range.value))
const fmt = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'))
/** 万位换算成「1.2万」，与看板同一个口径：40px 那档数字放不下七位数 */
function big(n: number | null | undefined) {
  if (n == null) return null
  return Math.abs(n) >= 10000 ? { v: n / 10000, digits: 1, unit: '万' } : { v: n, digits: 0, unit: '' }
}
const stamp = (t: string | null) => {
  if (!t) return null
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* PLATFORM_META 只登记「有逐日读数接口」的平台，判某个后台采没采到不能看它 ——
 * 要分别看 dailyByPlatform（有逐日读数）和 platformLatest（至少采到过存量）。
 * dailyByPlatform 会为空快照也建 key，所以真判据是「有没有采到过一个日期」。 */
const hasDaily = (key: string) => Object.keys(dailyByPlatform[key] ?? {}).length > 0
const dailyPlatforms = accounts.map((a) => a.key).filter(hasDaily)

/* ---------------- ① 六张 KPI ---------------- */
interface Kpi {
  key: string
  label: string
  cur: number | null
  prev: number | null
  diff: number | null
  pct: number | null
  split: string
  /** 环比算不出来时的人话原因 */
  caveat: string
}
const METRIC_KPIS: { key: DailyMetric; label: string }[] = [
  { key: 'new_followers', label: '新增粉丝' },
  { key: 'views', label: '新增播放（阅读）' },
  { key: 'likes', label: '新增点赞' },
  { key: 'collects', label: '新增收藏' },
  { key: 'comments', label: '新增评论' },
]

const kpis = computed(() => {
  const { cur, prev } = pair.value
  const pubC = publishStat(cur)
  const pubP = publishStat(prev)
  const pubSplit = Object.entries(pubC.perPlatform)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} ${n}`)
    .join(' / ')
  const list: Kpi[] = [{
    key: 'publish',
    label: '发布数',
    cur: pubC.total,
    prev: pubP.total,
    diff: pubC.total - pubP.total,
    pct: pubP.total ? ((pubC.total - pubP.total) / pubP.total) * 100 : null,
    split: pubSplit || '无',
    caveat: pubP.total === 0 ? '上周期 0 篇，环比不可算' : '',
  }]
  for (const m of METRIC_KPIS) {
    // 汇总只算这一期真有该项读数的号，两个周期同一批 —— 与看板那颗号筛选同一个算法
    const keys = liveBuckets(m.key, range.value)
    const c = periodStat(m.key, cur, keys)
    const p = periodStat(m.key, prev, keys)
    const { diff, pct } = ratio(c.total, p.total, p.days >= range.value)
    const split = Object.entries(c.perPlatform)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([k, v]) => `${accountLabel(k)} ${fmt(v)}`)
      .join(' / ')
    const noField = Object.keys(PLATFORM_META).filter((k) => !c.daysOf[k] && !p.daysOf[k])
      .map((k) => PLATFORM_META[k].label)
    list.push({
      key: m.key,
      label: m.label,
      cur: c.total,
      prev: p.total,
      diff,
      pct,
      split,
      caveat: p.total != null && p.total < 0
        ? '上周期是负数，环比不可算'
        : p.days < range.value
          ? p.days ? `上周期只有 ${p.days} 天，环比不可信` : '上周期无数据，环比不可算'
          : noField.length ? `${noField.join('、')} 无此项` : '',
    })
  }
  return list.map((k) => ({ ...k, big: big(k.cur) }))
})

/* ---------------- ② 逐日趋势 + 账号环比 ---------------- */
const DETAIL_METRICS: { id: DailyMetric; label: string }[] = [
  { id: 'views', label: '播放' },
  { id: 'new_followers', label: '粉丝' },
  { id: 'likes', label: '点赞' },
  { id: 'collects', label: '收藏' },
  { id: 'comments', label: '评论' },
  { id: 'shares', label: '分享' },
  { id: 'exposure', label: '曝光' },
]
const detailMetric = ref<DailyMetric>('views')
const detailLabel = computed(() => DETAIL_METRICS.find((m) => m.id === detailMetric.value)?.label ?? '')
const detailDates = computed(() => {
  const { cur, prev } = pair.value
  return dailyAxis().filter((d) => d >= prev[0] && d <= cur[1])
})
const detailRows = computed(() => dailySeries(detailMetric.value))
/** 一平台一色，按序号取主题令牌：品牌色在暗底上会隐形（抖音 = #111） */
const CHART_COLORS = ['var(--app-chart-1)', 'var(--app-chart-2)', 'var(--app-chart-3)', 'var(--app-chart-4)', 'var(--app-chart-5)']
const barSeries = computed<BarSeries[]>(() =>
  dailyPlatforms.map((key, i) => ({
    name: platformLabel(key),
    color: CHART_COLORS[i % CHART_COLORS.length],
    values: detailDates.value.map(
      (d) => detailRows.value.find((r) => r.date === d)?.values[key] ?? null,
    ),
  })),
)
const splitAt = computed(() => {
  const start = pair.value.cur[0]
  const i = detailDates.value.indexOf(start)
  return i > 0 ? i : null
})

interface RankRow {
  platform: string
  /** 行名：同平台挂了两个号时必须带上昵称，否则两行「抖音」长得一样 */
  label: string
  key: string
  cur: number | null
  prev: number | null
  diff: number | null
  pct: number | null
  note: string
}
const rankRows = computed<RankRow[]>(() => {
  const { cur, prev } = pair.value
  const c = periodStat(detailMetric.value, cur)
  const p = periodStat(detailMetric.value, prev)
  const rows = accounts.map((a) => {
    const key = a.key
    const daily = hasDaily(key)
    const { diff, pct } = ratio(c.perPlatform[key] ?? null, p.perPlatform[key] ?? null, p.days >= range.value)
    let note: string
    if (!daily && !platformLatest[key]) note = '未采到'
    else if (!daily) note = '无逐日读数'
    else if (!c.daysOf[key] && !p.daysOf[key]) note = '无此项'
    else note = `采到 ${c.daysOf[key] ?? 0} 天`
    return { platform: a.platform, label: accountLabel(a.id), key, cur: c.perPlatform[key] ?? null, prev: p.perPlatform[key] ?? null, diff, pct, note }
  })
  return rows.sort((x, y) => (y.cur ?? -1) - (x.cur ?? -1))
}
)

/* ---------------- ④ 作品榜 ---------------- */
const WORK_SORTS: { id: 'views' | 'follows' | 'collects' | 'likes'; label: string }[] = [
  { id: 'views', label: '按阅读' },
  { id: 'follows', label: '按涨粉' },
  { id: 'collects', label: '按收藏' },
  { id: 'likes', label: '按点赞' },
]
const workSort = ref<(typeof WORK_SORTS)[number]['id']>('views')
/** 同平台可能登了两个号，按号分档才认得出这条是谁发的 */
const workAccounts = computed(() => [...new Set(works.map((w) => w.account))])
const workAccount = ref('')
const workAccountItems = computed(() =>
  workAccounts.value.map((a) => ({ id: a, label: `${accountLabel(a)} ${works.filter((w) => w.account === a).length}` })),
)
const shownWorks = computed(() => {
  const acct = workAccount.value || workAccounts.value[0] || ''
  return works
    .filter((w) => w.account === acct)
    .sort((a, b) => ((b[workSort.value] as number | null) ?? -1) - ((a[workSort.value] as number | null) ?? -1))
})

/** 取数情况折成一行：正常那档（采满 N 天）不占版面，只说哪个号缺什么 */
const fetchGaps = computed(() =>
  rankRows.value.filter((r) => !r.note.startsWith('采到')).map((r) => `${r.label} ${r.note}`),
)
const workCols = [
  { key: 'views', label: '阅读' },
  { key: 'likes', label: '点赞' },
  { key: 'collects', label: '收藏' },
  { key: 'comments', label: '评论' },
  { key: 'follows', label: '涨粉' },
  { key: 'ctr', label: '点击率' },
] as const

const publishedCount = (platform: string) =>
  articles.filter((a) => a.account === platform && a.status === 'published').length

function openStudio(article: string | null) {
  if (article) gotoStudio(article)
}

/* ---------------- 复盘队列：T+3 欠账的题排在这里 ----------------
 * 弹窗而不是常驻面板：复盘一天最多做一次，判据（哪些题到期）住在 scripts/lesson-core.mjs，
 * 这里只报那颗数字。 */
const showReview = ref(false)

/* ---------------- 作品榜：「这篇教会了我们什么」输入位 ----------------
 * 学习环本体（评分体系 §五）原来只能改 md，界面上没有入口；这里就地写、写回稿的同名段。
 * 保存后服务端 refresh() 广播 SSE，整页带新数据回来。 */
const { toast } = useToast()
const lessonEdit = ref('')
const lessonDraft = ref('')
const lessonBusy = ref(false)
const workKey = (w: Work) => `${w.account}-${w.title}`
function editLesson(w: Work) {
  lessonEdit.value = workKey(w)
  lessonDraft.value = w.lesson
}
async function saveLesson(w: Work) {
  if (!w.article) return toast('这篇没有匹配到本地稿，回不去', 'fail')
  lessonBusy.value = true
  try {
    const r = await fetch('/__lesson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: `content/${w.article.file}`, text: lessonDraft.value }),
    })
    const o = await r.json()
    if (!o.ok) throw new Error(o.error || '保存失败')
    toast('已写回稿里的「教会了我们什么」段', 'ok')
    lessonEdit.value = ''
  } catch (e) {
    toast(e instanceof Error ? e.message : '保存失败', 'fail')
  } finally {
    lessonBusy.value = false
  }
}

/* ---------------- ⑤ 账号数据 ---------------- */
/** 账号表固定看三档窗口：今天 / 近 7 日 / 近 30 日，都以数据截止日结尾。
 *  顶部那颗「近 N 日」只喂 KPI 与账号卡，不改这张表——三档并排才看得出「这周的事是不是今天干的」。 */
const WINDOWS = ['1d', '7d', '30d'] as const
const WINDOW_DAYS: Record<(typeof WINDOWS)[number], number> = { '1d': 1, '7d': 7, '30d': 30 }
type WinStats = Record<(typeof WINDOWS)[number], PeriodStat>
const ACCOUNT_METRICS: { key: DailyMetric; label: string }[] = [
  { key: 'new_followers', label: '净增粉' },
  { key: 'views', label: '播放' },
  { key: 'likes', label: '点赞' },
  { key: 'collects', label: '收藏' },
  { key: 'comments', label: '评论' },
  { key: 'shares', label: '分享' },
]

const accountRows = computed(() => {
  const winStat = (m: DailyMetric) =>
    Object.fromEntries(WINDOWS.map((w) => [w, periodStat(m, periodPair(WINDOW_DAYS[w]).cur)])) as WinStats
  const stats: Record<string, WinStats> = {}
  for (const m of ACCOUNT_METRICS) stats[m.key] = winStat(m.key)
  return accounts.map((a) => {
    const at = platformLatest[a.key]
    return {
      platform: a.platform,
      nickname: a.nickname || a.platform,
      followers: at?.snap.followers ?? null,
      works: publishedCount(a.platform),
      asOf: stamp(at?.collectedAt ?? null) || null,
      state: hasDaily(a.key) ? (at ? '正常' : '无回流') : at ? '只到存量' : '未采到',
      cells: ACCOUNT_METRICS.map((m) => ({
        metric: m.label,
        vals: WINDOWS.map((w) => stats[m.key][w].perPlatform[a.key] ?? null),
      })),
    }
  })
})
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader title="数据复盘" />

    <ReviewModal v-if="showReview" @close="showReview = false" />

    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <BentoSegmented label="分区" :items="SECTIONS" :model-value="section"
        @update:model-value="section = $event as Section" />
      <!-- 分区右边只挂这一区用得上的那颗：时间窗只喂总览两张卡，作品榜与账号表各有自己的窗口 -->
      <BentoSegmented v-if="section === 'overview'" class="ml-auto" label="时间窗"
        :items="RANGES.map((r) => ({ id: String(r), label: `近 ${r} 日` }))" :model-value="String(range)"
        @update:model-value="range = Number($event)" />
      <button v-else-if="section === 'works'" class="chip ml-auto shrink-0 !py-1"
        :title="reviewTopics.length ? '发布满 3 天还没写复盘' : '没有欠复盘的稿'"
        @click="showReview = true">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="reviewTopics.length ? 'status-failed' : 'status-published'" />
        <IconNotebook :size="13" />
        {{ reviewTopics.length ? `待复盘 ${reviewTopics.length}` : '复盘无欠账' }}
      </button>
      <SyncButton v-else task="collect" :at="lastSyncAt" class="ml-auto" />
    </div>

    <!-- ============ 总览 ============ -->
    <div v-if="section === 'overview'" class="grid grid-cols-12 gap-4">
      <!-- ① 六张读数：一卡并排，环比给不出就退成绝对差，原因在 title 里 -->
      <section class="bento col-span-12 bento-enter" style="--i: 0" aria-label="本周期读数">
        <div class="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 xl:grid-cols-6">
          <div v-for="k in kpis" :key="k.key" class="min-w-0" :title="[k.caveat, k.split].filter(Boolean).join(' · ') || undefined">
            <div class="truncate text-aux text-ink-3">{{ k.label }}</div>
            <div class="mt-1.5 text-hero-sm text-ink">
              <template v-if="k.big">
                <CountUp :value="k.big.v" :digits="k.big.digits" /><span
                  v-if="k.big.unit" class="text-metric-sm text-ink-2">{{ k.big.unit }}</span>
              </template>
              <template v-else>—</template>
              <BentoDelta :pct="k.pct" :diff="k.diff" class="ml-1.5 align-[3px] text-sm" />
            </div>
            <div class="mt-1.5 truncate text-aux text-ink-3 tabular-nums">上周期 {{ fmt(k.prev) }}</div>
          </div>
        </div>
      </section>

      <!-- ② 逐日：一根轴上摆两个周期，虚线左边是上周期 -->
      <section class="bento col-span-12 flex flex-col gap-3 xl:col-span-7 bento-enter" style="--i: 1"
        :aria-label="`${detailLabel}逐日`">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span class="text-section text-ink">{{ detailLabel }} · 逐日</span>
          <BentoSegmented class="ml-auto" label="指标" :items="DETAIL_METRICS" :model-value="detailMetric"
            @update:model-value="detailMetric = $event as DailyMetric" />
        </div>
        <BentoBars v-if="barSeries.length" :dates="detailDates" :series="barSeries" :split-at="splitAt" />
        <div v-else class="bento-inset flex min-h-[220px] items-center px-4 text-aux text-ink-3">
          {{ detailLabel }}无逐日读数
        </div>
        <div v-if="barSeries.length" class="flex flex-wrap gap-x-3.5 gap-y-1.5 text-aux text-ink-3">
          <span v-for="s in barSeries" :key="s.name" class="inline-flex items-center gap-1.5">
            <i class="size-2 rounded-[2px]" :style="{ background: s.color }" />{{ s.name }}
          </span>
        </div>
      </section>

      <!-- ③ 账号环比：选中哪个指标就按哪个指标排 -->
      <section class="bento col-span-12 flex flex-col xl:col-span-5 bento-enter" style="--i: 2" aria-label="账号环比"
        :title="fetchGaps.length ? `未采满：${fetchGaps.join(' · ')}` : undefined">
        <div class="mb-1">
          <span class="text-section text-ink">账号 · {{ detailLabel }}</span>
        </div>
        <div v-for="r in rankRows" :key="r.key" class="flex items-center gap-3 border-t border-line py-2.5">
          <PlatformLogo :platform="r.platform" :size="20" class="shrink-0" />
          <div class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{{ r.label }}</div>
          <div class="shrink-0 text-right">
            <div class="text-metric-sm tabular-nums text-ink">{{ fmt(r.cur) }}</div>
            <div v-if="r.prev != null" class="mt-0.5 flex items-center justify-end gap-1.5 text-aux text-ink-3 tabular-nums">
              <BentoDelta :pct="r.pct" :diff="r.diff" />
              <span>上周期 {{ fmt(r.prev) }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ============ 作品榜 ============ -->
    <div v-if="section === 'works'" class="grid grid-cols-12 gap-4">
      <section class="bento col-span-12 flex flex-col gap-3 bento-enter" style="--i: 0" aria-label="作品榜">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span class="text-section text-ink">作品榜</span>
          <BentoSegmented class="ml-auto" label="排序" :items="WORK_SORTS" :model-value="workSort"
            @update:model-value="workSort = $event as typeof workSort" />
        </div>
        <BentoSegmented v-if="workAccounts.length > 1" class="self-start" label="账号" :items="workAccountItems"
          :model-value="workAccount || workAccounts[0]" @update:model-value="workAccount = $event" />

        <div v-for="w in shownWorks" :key="`${w.account}-${w.title}`" class="flex flex-col rounded-[14px]">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-line px-3 py-2.5 transition-colors"
            :class="[w.article ? 'cursor-pointer hover:bg-surface-2' : '', lessonEdit === workKey(w) ? 'bg-surface-2' : '']"
            @click="lessonEdit !== workKey(w) && openStudio(w.article && versionKeyOf(w.article))">
            <img v-if="w.cover" :src="w.cover" class="h-14 w-14 shrink-0 rounded-[10px] object-cover">
            <div v-else
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-line text-aux text-ink-3">
              无封面
            </div>
            <div class="min-w-[12rem] flex-1 basis-64">
              <div class="flex items-center gap-2">
                <span v-if="w.rejected" class="chip status-failed !px-1.5 !py-0">未通过</span>
                <span class="truncate text-sm font-medium text-ink">{{ w.title }}</span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-aux text-ink-2">
                <PlatformLogo :platform="w.platform" :size="14" />
                <span class="tabular-nums">发布于 {{ w.published?.slice(5, 16) ?? '—' }}</span>
              </div>
              <div class="mt-1 flex items-center gap-2 text-aux">
                <button class="btn-ghost !px-1.5 !py-0 text-xs" title="记录复盘结论" @click.stop="editLesson(w)">
                  <IconNotebook :size="13" class="shrink-0" />
                  {{ w.lesson ? '改心得' : '写心得' }}
                </button>
                <span v-if="w.lesson" class="min-w-0 truncate text-ink-3" :title="w.lesson">{{ w.lesson.replace(/\s+/g, ' ').slice(0, 60) }}</span>
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap items-end gap-x-5">
              <div class="w-12 text-right" :title="w.scoreNote">
                <div class="text-aux text-ink-3">数据分</div>
                <div class="mt-1 text-metric-sm tabular-nums text-ink">
                  <span v-if="w.dataScore != null">{{ w.dataScore }}</span>
                  <span v-else class="text-ink-3">—</span>
                </div>
              </div>
              <div v-for="c in workCols" :key="c.key" class="w-14 text-right">
                <div class="text-aux text-ink-3">{{ c.label }}</div>
                <div class="mt-1 text-metric-sm tabular-nums text-ink">
                  <span v-if="c.key === 'ctr'">{{ w.ctr == null ? '—' : `${w.ctr}%` }}</span>
                  <span v-else>{{ fmt(w[c.key as 'views'] as number | null) }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="lessonEdit === workKey(w)" class="flex flex-col gap-2 px-3 pb-3">
            <textarea v-model="lessonDraft" rows="3" class="input w-full !py-2 leading-6"
              placeholder="记录结论与下次改进方向" />
            <div class="flex items-center gap-2">
              <button class="btn btn-primary !py-1 text-xs" :disabled="lessonBusy" @click="saveLesson(w)">
                {{ lessonBusy ? '保存中…' : '保存' }}
              </button>
              <button class="btn-ghost !py-1 text-xs" @click="lessonEdit = ''">取消</button>
            </div>
          </div>
        </div>
      </section>

      <p v-if="workGaps.length" class="col-span-12 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-aux text-ink-3">
        <IconCircleAlert :size="15" class="shrink-0" />
        <span>无逐篇读数</span>
        <span v-for="g in workGaps" :key="g.account" class="tabular-nums">{{ accountLabel(g.account) }} {{ g.count }}</span>
      </p>
    </div>

    <!-- ============ 账号 ============ -->
    <div v-if="section === 'accounts'" class="grid grid-cols-12 gap-4">
      <section class="bento col-span-12 bento-enter" style="--i: 0" aria-label="账号数据">
        <div class="mb-2 flex items-baseline gap-2">
          <span class="text-section text-ink">账号数据</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[1120px] text-left text-sm">
            <thead>
              <tr>
                <th class="min-w-[160px] whitespace-nowrap px-3 pb-2 text-aux font-medium text-ink-3">账号</th>
                <th class="px-3 pb-2 text-right text-aux font-medium text-ink-3">粉丝</th>
                <th class="w-12 px-2 pb-2"></th>
                <th v-for="m in ACCOUNT_METRICS" :key="m.key" class="px-3 pb-2 text-right text-aux font-medium text-ink-3">{{ m.label }}</th>
                <th class="whitespace-nowrap px-3 pb-2 text-aux font-medium text-ink-3">取数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in accountRows" :key="a.platform" class="border-t border-line">
                <td class="whitespace-nowrap px-3 py-3 align-top">
                  <span class="flex items-center gap-2 font-medium text-ink">
                    <PlatformLogo :platform="a.platform" :size="18" class="shrink-0" />
                    {{ a.nickname }}
                  </span>
                  <span class="mt-1 block text-aux text-ink-3 tabular-nums">已发布 {{ a.works }} 篇</span>
                </td>
                <td class="px-3 py-3 text-right align-top text-metric-sm tabular-nums text-ink">{{ fmt(a.followers) }}</td>
                <td class="px-2 py-3 align-top">
                  <span v-for="w in WINDOWS" :key="w"
                    class="block text-right text-aux leading-7 text-ink-3 tabular-nums">{{ w }}</span>
                </td>
                <td v-for="c in a.cells" :key="c.metric" class="px-3 py-3 align-top">
                  <span v-for="(v, i) in c.vals" :key="i"
                    class="block text-right leading-7 text-metric-sm tabular-nums text-ink">{{ fmt(v) }}</span>
                </td>
                <td class="whitespace-nowrap px-3 py-3 align-top">
                  <span class="flex items-center gap-1.5 text-aux text-ink-2">
                    <span class="h-2 w-2 shrink-0 rounded-full"
                      :class="a.state === '正常' ? 'status-published' : a.state === '无回流' ? 'status-not-start' : 'status-creating'"></span>
                    {{ a.state }}
                  </span>
                  <span class="mt-1 block text-aux text-ink-3 tabular-nums">{{ a.asOf ?? '—' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
