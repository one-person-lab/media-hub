<script setup lang="ts">
import { computed } from 'vue'
import {
  articles, readings, snapshots, TODAY,
} from '../data/store'
import {
  PhLightbulb, PhFolderOpen, PhPencilSimple, PhCalendarBlank, PhChartLineUp,
  PhKanban, PhArrowRight, PhWarning, PhCheckCircle, PhArrowUpRight,
  PhFileText, PhQuotes,
} from '@phosphor-icons/vue'

const emit = defineEmits<{ (e: 'go', view: string): void }>()

/* ---------------- 各阶段数据 ---------------- */

const pendingSchedule = computed(() => articles.filter((a) => a.status === 'creating'))
const draftFiles = computed(() => articles.filter((a) => a.status === 'not_start'))
const scheduled = computed(() => articles.filter((a) => a.status === 'ready'))
const published = computed(() => articles.filter((a) => a.status === 'published'))
const needMetrics = computed(() => published.value.filter((a) => !a.metricsFilled))

const inboxCount = computed(() => readings.length)

const lastPublished = computed(
  () => published.value.map((a) => a.date).filter((d): d is string => !!d).sort().at(-1) ?? null,
)
const daysSince = computed(() => {
  if (!lastPublished.value) return null
  return Math.round((Date.parse(TODAY) - Date.parse(lastPublished.value)) / 86400000)
})

/* ---------------- 看板卡片 ---------------- */

interface Card {
  id: string
  title: string
  meta?: string
  badge?: string
  badgeTone?: string
  view: string
}

interface Column {
  id: string
  no: string
  name: string
  hint: string
  tone: string
  view: string
  icon: unknown
  cards: Card[]
  /** 计数之外的补充说明（如「13 待回填」） */
  note?: string
  /** 该列为空是否算异常（流程断档） */
  emptyIsBad: boolean
}

const columns = computed<Column[]>(() => {
  const inbox: Card[] = readings.slice(0, 4).map<Card>((r) => ({
    id: r.id,
    title: r.title,
    meta: r.source || `${r.chars} 字`,
    view: 'inspiration',
  }))

  return [
    {
      id: 'inbox',
      no: '①',
      name: '灵感池',
      hint: '金句 / 参考',
      tone: 'bg-neo-green',
      view: 'inspiration',
      icon: PhLightbulb,
      cards: inbox,
      note: inboxCount.value > inbox.length ? `还有 ${inboxCount.value - inbox.length} 条` : undefined,
      emptyIsBad: true,
    },
    {
      id: 'draft',
      no: '②',
      name: '草稿',
      hint: '待立项',
      tone: 'bg-neo-purple',
      view: 'topics',
      icon: PhFolderOpen,
      cards: draftFiles.value.map<Card>((a) => ({
        id: a.id,
        title: a.title,
        meta: a.source || undefined,
        view: 'topics',
      })),
      emptyIsBad: false,
    },
    {
      id: 'todo',
      no: '③',
      name: '待排期',
      hint: '已成稿等日期',
      tone: 'bg-neo-yellow',
      view: 'topics',
      icon: PhPencilSimple,
      cards: pendingSchedule.value.map<Card>((a) => ({
        id: a.id,
        title: a.title,
        meta: a.identity || undefined,
        view: 'topics',
      })),
      emptyIsBad: false,
    },
    {
      id: 'ready',
      no: '④',
      name: '已排期',
      hint: '在等发布日期',
      tone: 'bg-neo-blue',
      view: 'calendar',
      icon: PhCalendarBlank,
      cards: scheduled.value.map<Card>((a) => ({
        id: a.id,
        title: a.title,
        meta: a.date || undefined,
        view: 'calendar',
      })),
      emptyIsBad: true,
    },
    {
      id: 'done',
      no: '⑤',
      name: '已发布',
      hint: '等数据回流',
      tone: 'bg-neo-pink',
      view: 'analytics',
      icon: PhChartLineUp,
      cards: needMetrics.value.slice(0, 6).map<Card>((a) => ({
        id: a.id,
        title: a.title,
        meta: a.date || undefined,
        badge: '待回填',
        badgeTone: 'status-creating',
        view: 'analytics',
      })),
      note:
        published.value.length > needMetrics.value.length
          ? `已回填 ${published.value.length - needMetrics.value.length} 篇`
          : undefined,
      emptyIsBad: false,
    },
  ]
})

const totalCards = computed(() => columns.value.reduce((n, c) => n + c.cards.length, 0))

/* ---------------- 下一步：从数据推导的动作提示 ---------------- */

interface Hint {
  text: string
  cta: string
  view: string
  level: 'urgent' | 'warn' | 'info'
}

const hints = computed<Hint[]>(() => {
  const out: Hint[] = []

  if (scheduled.value.length === 0 && pendingSchedule.value.length > 0) {
    out.push({
      text: `有 ${pendingSchedule.value.length} 篇成稿卡在「待排期」，队列从这一列开始就断了`,
      cta: '去排期',
      view: 'topics',
      level: 'urgent',
    })
  }

  if (daysSince.value !== null && daysSince.value >= 3) {
    out.push({
      text: `发布环路停了 ${daysSince.value} 天（上次 ${lastPublished.value}）`,
      cta: '去发布',
      view: 'publish',
      level: 'urgent',
    })
  }

  if (needMetrics.value.length > 0) {
    out.push({
      text: `${needMetrics.value.length} 篇已发布的内容还没回填数据，复盘页拿不到结论`,
      cta: '去复盘',
      view: 'analytics',
      level: 'warn',
    })
  }

  if (inboxCount.value < 20) {
    out.push({
      text: `灵感池只剩 ${inboxCount.value} 条，补充素材免得选题断粮`,
      cta: '收灵感',
      view: 'inspiration',
      level: 'info',
    })
  }

  if (snapshots.length < 2) {
    out.push({
      text: `只有 ${snapshots.length} 个平台数据快照，再采一次才能画出粉丝趋势`,
      cta: '去采集',
      view: 'analytics',
      level: 'info',
    })
  }

  if (!out.length) {
    out.push({
      text: '五列都在正常流动，今天按节奏发一篇就行',
      cta: '去发布',
      view: 'publish',
      level: 'info',
    })
  }

  return out
})

const primaryHint = computed(() => hints.value[0])
const moreHints = computed(() => hints.value.slice(1, 3))

const HINT_STYLE: Record<Hint['level'], { chip: string; bar: string }> = {
  urgent: { chip: 'status-failed', bar: 'bg-neo-pink' },
  warn: { chip: 'status-creating', bar: 'bg-neo-yellow' },
  info: { chip: 'status-ready', bar: 'bg-neo-blue' },
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 页头 -->
    <div class="neo-card flex items-end justify-between gap-4">
      <div>
        <h2 class="flex items-center gap-2 text-2xl font-black">
          <PhKanban :size="22" weight="bold" class="shrink-0" />
          内容看板
        </h2>
        <p class="mt-1 text-sm text-neutral-500">
          灵感到复盘的五步，一屏看完瓶颈在哪 · 共 {{ totalCards }} 项在流转
        </p>
      </div>
      <button class="neo-btn" @click="emit('go', 'home')">
        <PhArrowUpRight :size="15" weight="bold" class="shrink-0" />
        今日工作台
      </button>
    </div>

    <!-- 下一步 -->
    <div class="neo-card !p-4">
      <div class="flex items-center gap-3">
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border-2 border-black text-black"
          :class="HINT_STYLE[primaryHint.level].bar"
        >
          <PhWarning v-if="primaryHint.level === 'urgent'" :size="16" weight="bold" />
          <PhKanban v-else-if="primaryHint.level === 'warn'" :size="16" weight="bold" />
          <PhCheckCircle v-else :size="16" weight="bold" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-xs font-bold tracking-widest text-neutral-500 uppercase">下一步</div>
          <div class="truncate text-base font-black">{{ primaryHint.text }}</div>
        </div>
        <button class="neo-btn neo-btn-primary shrink-0" @click="emit('go', primaryHint.view)">
          {{ primaryHint.cta }}
          <PhArrowRight :size="15" weight="bold" class="shrink-0" />
        </button>
      </div>

      <div v-if="moreHints.length" class="mt-3 flex flex-wrap gap-2 border-t-2 border-dashed border-neutral-300 pt-3">
        <button
          v-for="h in moreHints"
          :key="h.text"
          class="neo-chip !text-xs"
          :class="HINT_STYLE[h.level].chip"
          @click="emit('go', h.view)"
        >
          {{ h.text }}
        </button>
      </div>
    </div>

    <!-- 看板：列头即流程 -->
    <div class="grid grid-cols-5 gap-3">
      <div
        v-for="col in columns"
        :key="col.id"
        class="flex flex-col rounded-xl border-2 border-black bg-white/70"
      >
        <!-- 列头 -->
        <div class="flex items-center gap-2 rounded-t-[10px] border-b-2 border-black px-2.5 py-2" :class="col.tone">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black bg-white text-xs font-black text-black">
            {{ col.no }}
          </span>
          <div class="min-w-0 flex-1 leading-tight">
            <div class="truncate text-sm font-black text-black">{{ col.name }}</div>
            <div class="truncate text-[10px] font-bold text-black/60">{{ col.hint }}</div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-xl leading-none font-black text-black">{{ col.cards.length }}</div>
          </div>
        </div>

        <!-- 异常提示 -->
        <div
          v-if="col.cards.length === 0 && col.emptyIsBad"
          class="flex items-center gap-1 border-b-2 border-black bg-white px-2 py-1 text-[10px] font-bold text-black"
        >
          <PhWarning :size="11" weight="bold" class="shrink-0" />
          断档
        </div>

        <!-- 卡片 -->
        <div class="flex flex-1 flex-col gap-1.5 p-2">
          <button
            v-for="c in col.cards"
            :key="c.id"
            class="rounded-[6px] border-2 border-black bg-white p-2 text-left transition-transform hover:-translate-y-0.5 hover:shadow-neo-sm"
            @click="emit('go', c.view)"
          >
            <div class="line-clamp-2 text-xs leading-snug font-bold">{{ c.title }}</div>
            <div class="mt-1 flex items-center gap-1.5">
              <span v-if="c.meta" class="truncate font-mono text-[10px] font-bold text-neutral-500">{{ c.meta }}</span>
              <span v-if="c.badge" class="neo-chip !px-1.5 !py-0 !text-[10px]" :class="c.badgeTone">
                {{ c.badge }}
              </span>
            </div>
          </button>

          <div
            v-if="col.cards.length === 0"
            class="flex flex-1 items-center justify-center py-6 text-center text-[11px] font-bold text-neutral-400"
          >
            空
          </div>

          <button
            v-if="col.note"
            class="mt-auto pt-1 text-left text-[10px] font-bold text-neutral-500 underline decoration-dotted"
            @click="emit('go', col.view)"
          >
            {{ col.note }} →
          </button>
        </div>
      </div>
    </div>

    <!-- 底部：图例与来源 -->
    <div class="neo-card flex items-center gap-4 !py-3 text-xs font-bold text-neutral-500">
      <span class="flex items-center gap-1.5">
        <PhFileText :size="14" weight="bold" class="shrink-0" />
        数据来自 <span class="font-mono">content/</span> 的 markdown，改完文件跑 <span class="font-mono">npm run gen:data</span> 即刷新
      </span>
      <span class="ml-auto flex items-center gap-1.5">
        <PhQuotes :size="14" weight="bold" class="shrink-0" />
        状态由「文件在哪个目录 / 有没有填数据」推导，不是手动拖的
      </span>
    </div>
  </div>
</template>
