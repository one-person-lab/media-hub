<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  articles, TODAY,
  dailySeries, DATA_AS_OF, shiftDay,
  ALL_SCOPES, liveBuckets, platformBuckets, platformLabel, scopeBuckets, scopedStat, followersTotal,
  laneState, laneOfArticle, versionKeyOf, accountById, accountLabel,
  holdSelfWrite, startPushQueue, fetchPushJob, gotoStudio, loginVerdict, hasPushBridge, isRemote,
  type Article, type DailyMetric, type LaneState, type PushJob,
} from '../data/store'
import PageHeader from '../components/PageHeader.vue'
import BatchPopover, { type BatchRow } from '../components/BatchPopover.vue'
import ClientOnly from '../components/ClientOnly.vue'
import CountUp from '../components/CountUp.vue'
import BentoDelta from '../components/BentoDelta.vue'
import BentoHeatmap from '../components/BentoHeatmap.vue'
import BentoSegmented from '../components/BentoSegmented.vue'
import BentoSparkline from '../components/BentoSparkline.vue'
import { LoaderCircle as IconLoaderCircle } from 'lucide-vue-next'

/** 看板一屏四件事：粉丝（结果）→ 近 7 日播放（趋势）→ 三个卡口（动作）→ 发布节奏（规律）。
 *  版本清单不在首页摊开：点卡口或点节奏上某一天，只贴着它浮出这几条，整篇回创作台看。
 *  推草稿的队列活在服务端（/__push），本页只起串和渲染进度，切页刷新都不丢。 */

const emit = defineEmits<{ (e: 'go', view: string): void }>()

const DAY = 86_400_000
/** 日期口径全站一个样：MM-DD（复盘页、采集运行条都是这个），不写 10/27 */
const mmdd = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}`
const dayDiff = (d: string) => Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / DAY)
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function prettyDay(d: string) {
  const n = dayDiff(d)
  const alias = n === 0 ? '今天' : n === 1 ? '昨天' : n === -1 ? '明天' : n === -2 ? '后天' : ''
  return {
    label: alias ? `${alias} ${mmdd(d)}` : mmdd(d),
    week: WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()],
  }
}

/* ---------------- 读数：只用逐日真值，缺数的天不补 0 ---------------- */

/** 两张数据卡共用页头这一颗号筛选，默认全部 = 各号加总 */
const scope = ref<string>(ALL_SCOPES)
const scopeItems = computed(() => [
  { id: ALL_SCOPES, label: '全部' },
  ...platformBuckets.map((k) => ({ id: k, label: platformLabel(k), logo: platformLabel(k) })),
])
const buckets = computed(() => scopeBuckets(scope.value))

const DAY_COUNT = 7

/** 取一项指标的本/上周期：筛单个号就只算它，全部则只算这一期真有读数的号，
 *  两个周期用同一批——某个号这一期断采，不能拿它上期那笔把跌幅做大。 */
function statOf(metric: DailyMetric) {
  const keys = scope.value === ALL_SCOPES ? liveBuckets(metric, DAY_COUNT) : buckets.value
  return scopedStat(metric, DAY_COUNT, keys)
}

/** 万位换算成「1.2万」，与复盘页同一个口径 */
function big(n: number | null) {
  if (n == null) return null
  return Math.abs(n) >= 10000 ? { v: n / 10000, digits: 1, unit: '万' } : { v: n, digits: 0, unit: '' }
}

const fansTotal = computed(() => followersTotal(buckets.value))
const fansBig = computed(() => big(fansTotal.value))

const FANS_FROM = shiftDay(DATA_AS_OF, -29)
const fansSeries = computed(() => dailySeries('new_followers', buckets.value))
const fansPoints = computed(() =>
  fansSeries.value
    .filter((r) => r.date >= FANS_FROM && r.date <= DATA_AS_OF && r.total != null)
    .map((r) => ({ label: mmdd(r.date), value: r.total as number })),
)
/** 截止日那一笔净涨粉：数据可能停在两天前，所以只报「较前一日」不报「昨日」 */
const fansLast = computed(
  () => fansSeries.value.find((r) => r.date === DATA_AS_OF)?.total ?? null,
)

const waveLabels = computed(() => {
  const out: string[] = []
  for (let i = DAY_COUNT - 1; i >= 0; i--) {
    out.push(WEEK[new Date(`${shiftDay(DATA_AS_OF, -i)}T00:00:00Z`).getUTCDay()])
  }
  return out
})

const views = computed(() => statOf('views'))
const viewsBig = computed(() => big(views.value.cur))
const viewsPoints = computed(() =>
  views.value.curDays.map((v, i) => ({ label: waveLabels.value[i], value: v })),
)
/** 本周这一条画不出来就整张图换成空态：只有上周那几条影子不算有图 */
const viewsDrawable = computed(() => views.value.curDays.filter((v) => v != null).length > 1)

const SIDE_METRICS: [DailyMetric, string][] = [
  ['likes', '点赞'],
  ['collects', '收藏'],
  ['comments', '评论'],
  ['shares', '分享'],
]
const sideMetrics = computed(() =>
  SIDE_METRICS.map(([key, name]) => {
    const s = statOf(key)
    return { name, value: big(s.cur), pct: s.pct }
  }),
)

/* ---------------- 三个卡口：按「要不要你动手」分 ---------------- */

interface Row {
  key: string
  /** 这一版属于哪个号（账号 id）；platform 只管 logo 与版式 */
  account: string
  platform: string
  label: string
  title: string
  line: string
  state: LaneState
  pushedAt: string
  date: string
  /** 浮层里那两颗图标要不要出现，采集时就知道：有没有后台地址、本机推不推得动 */
  backend: string
  pushable: boolean
  article: Article
}

/** 一版一条记录：卡口和某一天的明细都从这里拼，口径只写一遍 */
function toRow(a: Article): Row {
  const lane = laneOfArticle(a)
  return {
    key: versionKeyOf(a),
    account: a.account,
    platform: lane.platform,
    label: lane.label,
    title: a.title,
    line: (a.copy || '').split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || '',
    state: laneState(lane),
    pushedAt: a.draftPushed[a.account] || '',
    date: a.date || '',
    backend: accountById(a.account)?.backend || '',
    pushable: hasPushBridge(a.account),
    article: a,
  }
}

/** 进场的是发布环节的稿：在箱等人点发布的、已排期还没推的、以及这一轨看得见的日子里已发出去的。
 *  没写完的稿归还在写，未排期的归待排期，不在这里催。 */
const rows = computed<Row[]>(() => {
  const trackFrom = shiftDay(TODAY, -7)
  return articles.filter((a) => {
    if (!a.date) return false
    const state = laneState(laneOfArticle(a))
    return state === 'drafted'
      || (state === 'pending' && a.status === 'ready')
      || (state === 'published' && a.date >= trackFrom)
  }).map(toRow)
})

const pendingRows = computed(() => rows.value.filter((r) => r.state === 'pending'))
const draftedRows = computed(() => rows.value.filter((r) => r.state === 'drafted'))
const upcoming = computed(() =>
  rows.value.filter((r) => r.date > TODAY).sort((a, b) => a.date.localeCompare(b.date)))

/** 卡口只报状态和数量：谁家的稿、等了几天，点它浮出这几条再看 */
const gates = computed(() => [
  {
    id: 'pending', name: '待推送', count: pendingRows.value.length,
    act: pendingRows.value.length ? '推送' : null,
    push: true,
  },
  {
    id: 'drafted', name: '待发布', count: draftedRows.value.length,
    act: draftedRows.value.length ? '去发布' : null,
    push: false,
  },
  {
    id: 'upcoming', name: '已排期', count: upcoming.value.length,
    act: upcoming.value.length ? '去排期' : null,
    push: false,
  },
])

/* 「本轮焦点」= 还有事要做的卡口里数量最大的那个。只有它配得上主按钮，其余降为描边 */
const focusGate = computed(() => {
  const busy = gates.value.filter((g) => g.count > 0)
  return busy.length ? busy.reduce((a, b) => (b.count > a.count ? b : a)).id : null
})

/* ---------------- 看这一批：贴着点的那一格/那一行浮出，不占页面下方 ---------------- */

interface Batch {
  id: string
  title: string
  /** 触发它的那一行/那一格 */
  el: HTMLElement
}

const batch = ref<Batch | null>(null)
const openId = computed(() => batch.value?.id ?? null)

function toggle(id: string, title: string, el: HTMLElement) {
  if (batch.value?.id === id) {
    batch.value = null
    return
  }
  batch.value = { id, title, el }
}
const batchRows = computed<Row[]>(() => {
  const k = openId.value
  if (!k) return []
  if (k === 'pending') return pendingRows.value
  if (k === 'drafted') return draftedRows.value
  if (k === 'upcoming') return upcoming.value
  return articles.filter((a) => a.date === k).map(toRow)
})

/** 浮层里两步：点整行进创作台；右侧那颗图标是这一版当下最该做的一步 */
function openRow(r: BatchRow) {
  batch.value = null
  gotoStudio(r.key)
}
function actRow(r: BatchRow) {
  const row = batchRows.value.find((x) => x.key === r.key && x.account === r.account)
  if (!row) return
  if (row.state === 'pending') return pushVersions([row])
  if (row.state === 'drafted') {
    if (row.backend) window.open(row.backend, '_blank')
    return
  }
  batch.value = null
  emit('go', 'analytics')
}

/* ---------------- 发布节奏：近 12 周，一格一天，深浅 = 当天发了几版 ---------------- */

const HEAT_DAYS = 84
/** 只数真发出去的版：节奏看的是哪天真的交了活，在箱与未推的归左边卡口催。
 *  断档与连发不用另写一句话——图上连着几列空着就是断了。 */
const heatDays = computed(() => {
  const byDate = new Map<string, number>()
  for (const a of articles) {
    if (a.status === 'published' && a.date) byDate.set(a.date, (byDate.get(a.date) ?? 0) + 1)
  }
  return Array.from({ length: HEAT_DAYS }, (_, i) => {
    const date = shiftDay(TODAY, -(HEAT_DAYS - 1 - i))
    return { date, value: byDate.get(date) ?? 0 }
  })
})

/* ---------------- 推草稿：起串 + 盯服务端进度 ---------------- */

const job = ref<PushJob | null>(null)
const pushNote = ref('')
let poll: ReturnType<typeof setInterval> | null = null
let clock = 0
const nowTick = ref(Date.now())

const pushRunning = computed(() => !!job.value?.running)
const runningStep = computed(() => job.value?.steps.find((s) => s.state === 'running') || null)
const pushElapsed = computed(() => {
  const s = runningStep.value
  return s?.startedAt ? Math.round((nowTick.value - s.startedAt) / 1000) : 0
})
const napping = computed(() => {
  const until = job.value?.napUntil || 0
  return until > nowTick.value ? Math.ceil((until - nowTick.value) / 1000) : 0
})

function stopTimers() {
  if (poll) clearInterval(poll)
  poll = null
  if (clock) clearInterval(clock)
  clock = 0
}

/** 服务端队列是唯一事实源：进页面先问一次，别的页签起的推送照接上 */
async function syncJob() {
  const j = await fetchPushJob()
  if (!j) return
  job.value = j
  if (j.running) startWatch()
  else if (j.steps.some((s) => s.state === 'fail' || s.state === 'done')) reportDone(j)
}

function startWatch() {
  holdSelfWrite() // 推完服务端会重建数据，这段窗口内原地换列表，不整页刷
  if (!clock) clock = window.setInterval(() => (nowTick.value = Date.now()), 1000)
  if (poll) return
  poll = setInterval(async () => {
    const j = await fetchPushJob()
    if (!j) return
    job.value = j
    if (!j.running) {
      stopTimers()
      reportDone(j)
    }
  }, 2000)
}

function reportDone(j: PushJob) {
  const ok = j.steps.filter((s) => s.state === 'done')
  const bad = j.steps.filter((s) => s.state === 'fail')
  pushNote.value = bad.length
    ? `推送完成 ${ok.length} 个 · 失败 ${bad.length} 个：${bad.map((s) => `${accountLabel(s.platform)} ${s.error}`).join('；')}`
    : `已推送：${ok.map((s) => `${accountLabel(s.platform)}${s.evidence ? ` ${s.evidence}` : ''}`).join('、')}`
}

async function pushVersions(list: Row[]) {
  if (!list.length || pushRunning.value) return
  pushNote.value = ''
  // 与创作台共用 loginVerdict 这道预检：有明确证据推不动的版不交排，撞一次要两分钟
  const dead = list.filter((r) => loginVerdict(r.account).level === 'blocked')
  const vs = list.filter((r) => !dead.includes(r))
  if (dead.length) {
    pushNote.value = `未推（要授权）：${dead.map((r) => accountLabel(r.account)).join('、')}`
    if (!vs.length) return
  }
  // date 传空：能进这里的稿都已排期，这里只推草稿，不顺手改发布日期
  const o = await startPushQueue(
    vs.map((r) => ({ rel: `content/${r.article.file}`, platform: r.account })),
    '',
  )
  if (o.job) job.value = o.job
  if (!o.ok) {
    pushNote.value = o.error || '推送没起来'
    if (o.job?.running) startWatch()
    return
  }
  startWatch()
}

onMounted(syncJob)
onBeforeUnmount(stopTimers)

const canPushTo = (account: string) => hasPushBridge(account)
/** 灰掉的那一颗要说清为什么灰：本机缺脚本和「这是网页版」是两回事，出口也不同 */
const pushOffTip = computed(() => isRemote.value
  ? '网页版推不了草稿，回桌面客户端做'
  : '本机没有这些平台的推草稿脚本')
const anyPushable = computed(() => pendingRows.value.some((r) => canPushTo(r.account)))

/* ---------------- 浮出某一批：卡口或热力图上一格，同时只开一个 ---------------- */

function toggleDay(date: string, cell: HTMLElement) {
  const d = prettyDay(date)
  toggle(date, `${d.label} ${d.week}`, cell)
}
</script>

<template>
  <!-- 点格背景由外壳那层 AppBackdrop 统一铺，这里再叠一张静态点格就成了两层网格 -->
  <div class="flex flex-col gap-5">
    <PageHeader title="看板">
      <template #actions>
        <BentoSegmented label="号" :items="scopeItems" :model-value="scope" @update:model-value="scope = $event" />
      </template>
    </PageHeader>

    <!-- 服务端队列的进度：一次只推一版，这里只负责如实显示它跑到哪 -->
    <div v-if="pushRunning || napping" class="bento flex flex-wrap items-center gap-3 !py-3">
      <IconLoaderCircle :size="15" class="animate-spin shrink-0" />
      <span class="min-w-0 flex-1 text-sm font-medium text-ink">
        <template v-if="runningStep">{{ runningStep.platform }} 推送中 · {{ pushElapsed }}s</template>
        <template v-else-if="napping">停顿 {{ napping }}s</template>
        <template v-else>排队中…</template>
      </span>
      <span class="shrink-0 text-sm tabular-nums text-ink-2" style="font-family: var(--font-metric)">
        {{ job?.steps.filter((s) => s.state === 'done').length || 0 }}/{{ job?.steps.length || 0 }}
      </span>
    </div>
    <p
      v-else-if="pushNote"
      class="bento !py-2.5 text-sm font-medium"
      :class="pushNote.includes('失败') ? '!bg-tone-failed' : '!bg-tone-published'"
    >{{ pushNote }}</p>

    <div class="grid grid-cols-12 gap-4">
      <!-- A 粉丝：结果 -->
      <section class="bento col-span-12 flex flex-col gap-3 xl:col-span-5 bento-enter" style="--i: 0" aria-label="总粉丝">
        <div class="flex items-baseline gap-3">
          <span class="text-aux text-ink-3">总粉丝</span>
          <span class="ml-auto text-aux text-ink-3">近 30 日净涨粉</span>
        </div>
        <div class="text-hero text-ink">
          <template v-if="fansBig">
            <CountUp :value="fansBig.v" :digits="fansBig.digits" />
            <span v-if="fansBig.unit" class="text-metric-sm text-ink-2">{{ fansBig.unit }}</span>
          </template>
          <span v-else class="text-metric-sm text-ink-3">—</span>
          <BentoDelta v-if="fansLast != null" :diff="fansLast" class="ml-2 align-[10px] text-sm" />
        </div>
        <BentoSparkline v-if="fansPoints.length > 1" :points="fansPoints" series="净涨粉" :min-h="132" />
        <div v-else class="bento-inset flex min-h-[132px] items-center px-4 text-aux text-ink-3">
          近 30 日暂无涨粉读数
        </div>
      </section>

      <!-- B 播放：趋势 -->
      <section class="bento col-span-12 flex flex-col gap-3 xl:col-span-7 bento-enter" style="--i: 1" aria-label="近 7 日播放">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="text-aux text-ink-3">播放（近 7 日）</span>
          <span class="text-hero text-ink">
            <template v-if="viewsBig">
              <CountUp :value="viewsBig.v" :digits="viewsBig.digits" />
              <span v-if="viewsBig.unit" class="text-metric-sm text-ink-2">{{ viewsBig.unit }}</span>
            </template>
            <span v-else class="text-metric-sm text-ink-3">—</span>
            <BentoDelta :pct="views.pct" :diff="views.diff" class="ml-2 align-[10px] text-sm" />
          </span>
          <span v-if="viewsDrawable" class="ml-auto flex items-center gap-3 text-aux text-ink-3">
            <span class="inline-flex items-center gap-1.5">
              <i class="h-0.5 w-3.5 rounded-sm" style="background: var(--app-chart-1)" />本周
            </span>
            <span class="inline-flex items-center gap-1.5">
              <i class="h-0.5 w-3.5 rounded-sm opacity-30" style="background: var(--app-chart-1)" />上周
            </span>
          </span>
        </div>
        <BentoSparkline
          v-if="viewsDrawable"
          :points="viewsPoints"
          :compare="views.prevDays"
          series="播放"
          zero-base
          x-labels
          :min-h="132"
        />
        <div v-else class="bento-inset flex min-h-[132px] items-center px-4 text-aux text-ink-3">
          近 7 日暂无播放读数
        </div>
        <div class="flex flex-wrap gap-x-8 gap-y-2">
          <div v-for="m in sideMetrics" :key="m.name" class="min-w-0">
            <div class="text-aux text-ink-3">{{ m.name }}</div>
            <div class="mt-1 text-metric-sm tabular-nums text-ink">
              <template v-if="m.value">
                <CountUp :value="m.value.v" :digits="m.value.digits" /><span>{{ m.value.unit }}</span>
              </template>
              <span v-else class="text-ink-3">—</span>
              <BentoDelta :pct="m.pct" class="ml-1.5 align-[2px] text-sm" />
            </div>
          </div>
        </div>
      </section>

      <!-- C 三个卡口：现在就差这一步 -->
      <section class="bento col-span-12 flex flex-col gap-3 xl:col-span-5 bento-enter" style="--i: 2" aria-label="待处理">
        <span class="text-section text-ink">待处理</span>
        <div class="bento-inset flex min-h-0 flex-1 flex-col divide-y divide-line">
          <div
            v-for="g in gates"
            :key="g.id"
            class="flex flex-1 items-center gap-3 px-3.5 transition-colors"
            :class="openId === g.id ? 'bg-surface' : ''"
          >
            <button
              class="flex min-w-0 flex-1 items-baseline gap-2 text-left outline-none"
              :title="openId === g.id ? '收起' : '看这一批'"
              @click="toggle(g.id, g.name, $event.currentTarget as HTMLElement)"
            >
              <span class="inline-flex min-w-0 items-center gap-2">
                <i class="size-1.5 shrink-0 rounded-full" :class="g.count ? 'bg-green-700' : 'bg-ink-3'" />
                <span class="truncate text-sm font-medium" :class="g.count ? 'text-ink' : 'text-ink-3'">{{ g.name }}</span>
              </span>
              <span class="ml-auto w-14 text-right text-hero-sm tabular-nums" :class="g.count ? 'text-ink' : 'text-ink-3'">{{ g.count ?? 0 }}</span>
            </button>

            <div class="flex w-20 shrink-0 flex-col items-end gap-1.5">
              <ClientOnly v-if="g.act && g.push && isRemote" what="推草稿" />
              <button
                v-else-if="g.act && g.push"
                class="btn !px-3 !py-1"
                :class="g.id === focusGate ? 'btn-primary' : ''"
                :disabled="pushRunning || !anyPushable"
                :aria-label="anyPushable ? '把这些推进草稿箱' : pushOffTip"
                :title="anyPushable ? '把这些推进草稿箱' : pushOffTip"
                @click="pushVersions(pendingRows)"
              >
                <IconLoaderCircle v-if="pushRunning" :size="15" class="animate-spin shrink-0" />
                {{ g.act }}
              </button>
              <button
                v-else-if="g.act"
                class="btn !px-3 !py-1"
                :class="g.id === focusGate ? 'btn-primary' : ''"
                @click="emit('go', g.id === 'upcoming' ? 'studio-image' : 'calendar')"
              >
                {{ g.act }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- D 发布节奏：规律 -->
      <section class="bento col-span-12 flex flex-col gap-3 xl:col-span-7 bento-enter" style="--i: 3" aria-label="发布节奏">
        <span class="text-section text-ink">发布节奏</span>
        <BentoHeatmap
          class="bento-inset min-h-0 flex-1 p-2.5"
          :days="heatDays"
          :today="TODAY"
          :selected="openId"
          @select="toggleDay"
        />
      </section>
    </div>

    <!-- 看这一批：贴着点的那一格/那一行浮出 -->
    <BatchPopover
      v-if="batch"
      :title="batch.title"
      :rows="batchRows"
      :anchor="batch.el"
      :busy="pushRunning"
      @close="batch = null"
      @open="openRow"
      @act="actRow"
    />
  </div>
</template>
