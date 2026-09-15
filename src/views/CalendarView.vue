<script setup lang="ts">
import { ref, computed } from 'vue'
import { articles, STATUS_CLASS, TODAY } from '../data/store'
import { PhCalendarBlank } from '@phosphor-icons/vue'

const now = new Date()
const cursor = ref({ y: now.getFullYear(), m: now.getMonth() }) // m: 0-11

const monthLabel = computed(() => `${cursor.value.y} 年 ${cursor.value.m + 1} 月`)

const byDate = computed(() => {
  const map: Record<string, typeof articles> = {}
  for (const a of articles) {
    if (!a.date) continue
    ;(map[a.date] ||= []).push(a)
  }
  return map
})

interface Cell {
  iso: string
  day: number
  inMonth: boolean
  items: typeof articles
}

const cells = computed<Cell[]>(() => {
  const { y, m } = cursor.value
  const first = new Date(y, m, 1)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7)) // 周一为一周开始
  const out: Cell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ iso, day: d.getDate(), inMonth: d.getMonth() === m, items: byDate.value[iso] || [] })
  }
  return out
})

function shift(n: number) {
  const d = new Date(cursor.value.y, cursor.value.m + n, 1)
  cursor.value = { y: d.getFullYear(), m: d.getMonth() }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-black">
        <PhCalendarBlank :size="22" weight="bold" class="shrink-0" />
        发布日历
      </h2>
      <div class="flex items-center gap-2">
        <button class="neo-btn" @click="shift(-1)">‹</button>
        <span class="neo-chip min-w-32! justify-center !text-sm">{{ monthLabel }}</span>
        <button class="neo-btn" @click="shift(1)">›</button>
        <button class="neo-btn" @click="cursor = { y: now.getFullYear(), m: now.getMonth() }">回到今天</button>
      </div>
    </div>

    <div class="neo-card !p-3">
      <div class="grid grid-cols-7">
        <div v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="pb-2 text-center text-xs font-black text-neutral-500">
          周{{ w }}
        </div>
      </div>

      <div class="grid grid-cols-7 gap-1.5">
        <div
          v-for="c in cells"
          :key="c.iso"
          class="min-h-24 rounded-lg border-2 p-1.5"
          :class="[
            c.inMonth ? 'border-black/70 bg-white' : 'border-transparent bg-transparent opacity-40',
            c.iso === TODAY && 'bg-neo-yellow! shadow-neo-sm',
          ]"
        >
          <div class="mb-1 flex items-center justify-between">
            <span class="text-xs font-black" :class="c.iso === TODAY && 'rounded-full border-2 border-black bg-white px-1.5'">{{ c.day }}</span>
            <span v-if="c.items.length" class="neo-chip !px-1.5 !text-[10px]">{{ c.items.length }}</span>
          </div>
          <div
            v-for="a in c.items"
            :key="a.id"
            class="mb-1 truncate rounded-md border border-black px-1 py-0.5 text-[10px] font-bold"
            :class="STATUS_CLASS[a.status]"
            :title="a.title"
          >{{ a.title }}</div>
        </div>
      </div>
    </div>

    <p class="px-1 text-xs text-neutral-400">
      格子来自 <code>content/自媒体运营/发布排期/</code> 的日期文件名；黄色 = 今天。
    </p>
  </div>
</template>
