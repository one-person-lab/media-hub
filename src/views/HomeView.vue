<script setup lang="ts">
import { computed } from 'vue'
import {
  articles, readings, snapshots,
  STATUS_TEXT, STATUS_CLASS, TODAY,
} from '../data/store'
import {
  PhSun, PhLightbulb, PhTarget, PhPencilSimple,
  PhFolderOpen, PhChartLineUp, PhCalendarCheck,
  PhWarningCircle, PhArrowRight,
} from '@phosphor-icons/vue'

const emit = defineEmits<{ (e: 'go', view: string): void }>()

const pendingSchedule = computed(() => articles.filter((a) => a.status === 'creating'))
const draftCount = computed(() => articles.filter((a) => a.status === 'not_start').length)
const scheduled = computed(() => articles.filter((a) => a.status === 'ready'))
const lastPublished = computed(() =>
  articles.filter((a) => a.status === 'published').map((a) => a.date!).sort().at(-1),
)
const daysSince = computed(() => {
  if (!lastPublished.value) return null
  const ms = Date.parse(TODAY) - Date.parse(lastPublished.value)
  return Math.round(ms / 86400000)
})
const noMetrics = computed(() =>
  articles.filter((a) => a.status === 'published' && !a.metricsFilled).length,
)
const recent = computed(() => articles.slice(-5).reverse())
const todayItems = computed(() => articles.filter((a) => a.date === TODAY))

/** 下一步：与内容看板同一套推导规则，取最该做的一件事 */
const nextStep = computed(() => {
  if (scheduled.value.length === 0 && pendingSchedule.value.length > 0) {
    return { text: `有 ${pendingSchedule.value.length} 篇成稿还没排期`, cta: '去排期', view: 'topics' }
  }
  if (daysSince.value !== null && daysSince.value >= 3) {
    return { text: `发布环路停了 ${daysSince.value} 天`, cta: '去发布', view: 'publish' }
  }
  if (noMetrics.value > 0) {
    return { text: `${noMetrics.value} 篇已发布的数据还没回填`, cta: '去复盘', view: 'analytics' }
  }
  if (snapshots.length < 2) {
    return { text: '平台数据快照不足 2 个，趋势图画不出来', cta: '去复盘', view: 'analytics' }
  }
  return { text: '节奏正常，今天按计划发一篇', cta: '去发布', view: 'publish' }
})

const now = new Date()
const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="neo-card flex items-center justify-between">
      <div>
        <h2 class="flex items-center gap-2 text-2xl font-black">
          <PhSun :size="22" weight="bold" class="shrink-0" />
          今日工作台 · {{ weekday }} {{ TODAY }}
        </h2>
        <p class="mt-1 text-sm text-neutral-500">
          库存：{{ readings.length }} 条灵感 · {{ draftCount }} 篇草稿 ·
          {{ pendingSchedule.length }} 篇成稿待排期
        </p>
      </div>
      <div class="flex gap-2">
        <button class="neo-btn" @click="emit('go', 'inspiration')">
          <PhLightbulb :size="15" weight="bold" class="shrink-0" />
          收灵感
        </button>
        <button class="neo-btn neo-btn-primary" @click="emit('go', 'topics')">
          <PhTarget :size="15" weight="bold" class="shrink-0" />
          去选题
        </button>
      </div>
    </div>

    <!-- 下一步：从数据推导，直接回答「从何下手」 -->
    <button
      class="neo-card flex items-center gap-3 !py-3 text-left transition-transform hover:-translate-y-0.5"
      @click="emit('go', nextStep.view)"
    >
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border-2 border-black bg-neo-pink text-black">
        <PhWarningCircle :size="15" weight="bold" />
      </span>
      <span class="text-xs font-bold tracking-widest text-neutral-500 uppercase">下一步</span>
      <span class="min-w-0 flex-1 truncate font-black">{{ nextStep.text }}</span>
      <span class="neo-btn neo-btn-primary !py-1 !text-xs">
        {{ nextStep.cta }}
        <PhArrowRight :size="13" weight="bold" class="shrink-0" />
      </span>
    </button>

    <div class="grid grid-cols-4 gap-4">
      <button class="neo-card text-left transition-transform hover:-translate-y-0.5" @click="emit('go', 'topics')">
        <div class="flex items-center gap-2 text-sm font-bold text-neutral-500">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black bg-neo-yellow text-black">
            <PhPencilSimple :size="14" weight="bold" />
          </span>
          待排期成稿
        </div>
        <div class="mt-1 text-4xl font-black">{{ pendingSchedule.length }}</div>
      </button>
      <button class="neo-card text-left transition-transform hover:-translate-y-0.5" @click="emit('go', 'topics')">
        <div class="flex items-center gap-2 text-sm font-bold text-neutral-500">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black bg-neo-purple text-black">
            <PhFolderOpen :size="14" weight="bold" />
          </span>
          草稿
        </div>
        <div class="mt-1 text-4xl font-black">{{ draftCount }}</div>
      </button>
      <button class="neo-card text-left transition-transform hover:-translate-y-0.5" @click="emit('go', 'analytics')">
        <div class="flex items-center gap-2 text-sm font-bold text-neutral-500">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black bg-neo-blue text-black">
            <PhChartLineUp :size="14" weight="bold" />
          </span>
          数据待补
        </div>
        <div class="mt-1 text-4xl font-black">{{ noMetrics }}</div>
      </button>
      <div class="neo-card">
        <div class="flex items-center gap-2 text-sm font-bold text-neutral-500">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black bg-neo-green text-black">
            <PhCalendarCheck :size="14" weight="bold" />
          </span>
          上次发布
        </div>
        <div class="mt-1 text-2xl font-black">{{ lastPublished || '—' }}</div>
        <div v-if="daysSince !== null" class="mt-1 text-xs font-bold text-neutral-500">
          {{ daysSince === 0 ? '就是今天！' : `已经 ${daysSince} 天了` }}
        </div>
      </div>
    </div>

    <div class="neo-card">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-lg font-black">今天的发布队列</h3>
        <span v-if="scheduled.length" class="neo-chip status-ready">{{ scheduled.length }} 篇已排期在后头</span>
      </div>
      <div class="flex flex-col gap-2">
        <div
          v-for="a in todayItems"
          :key="a.id"
          class="flex items-center gap-3 rounded-lg border-2 border-black bg-white p-3 shadow-neo-sm"
        >
          <span class="flex-1 truncate font-bold">{{ a.title }}</span>
          <span class="neo-chip" :class="STATUS_CLASS[a.status]">{{ STATUS_TEXT[a.status] }}</span>
        </div>
        <div v-if="!todayItems.length" class="py-6 text-center text-sm text-neutral-400">
          今天没有排期。要不让 Claude Code 写一篇，或者去灵感库逛一圈？
        </div>
      </div>
    </div>

    <div class="neo-card">
      <h3 class="mb-3 text-lg font-black">最近的日更</h3>
      <div class="flex flex-col gap-2">
        <div v-for="a in recent" :key="a.id" class="flex items-center gap-3 text-sm">
          <span class="w-20 shrink-0 font-bold text-neutral-500">{{ a.date || '未排' }}</span>
          <span class="min-w-0 flex-1 truncate font-bold">{{ a.title }}</span>
          <span class="neo-chip !px-1.5" :class="a.metricsFilled ? 'status-published' : 'status-creating'">
            {{ a.metricsFilled ? '已复盘' : '待补数据' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
