<script setup lang="ts">
/** 一格一天、按周排成列，颜色深浅 = 当天发出几版。今天有框，点一格在它旁边浮出那一批。
 *  格子边长按容器宽算：拉窗口时重排，不至于把方块糊成一条。
 *  悬浮读数自己画：原生 title 要按住半秒才冒出来，鼠标在 24px 的格子上根本停不住。 */
import { computed, nextTick, ref } from 'vue'
import { useSize } from '../lib/useSize'

const props = withDefaults(
  defineProps<{
    days: { date: string; value: number }[]
    today?: string
    selected?: string | null
    color?: string
  }>(),
  { today: '', selected: null, color: 'var(--app-chart-2)' },
)
const emit = defineEmits<{ (e: 'select', date: string, cell: HTMLElement): void }>()

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 五档：0 档是「没发」，其余按当天最大数等分 */
const LEVEL = [0, 26, 46, 70, 100]
const GAP = 4
const LABEL_W = 22
const TOP_H = 16

const { setEl, size } = useSize()
const plot = ref<HTMLElement | null>(null)
const active = ref('')
const hover = ref('')

const mmdd = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}`
const rowOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay()

const cells = computed(() => {
  const offset = props.days.length ? rowOf(props.days[0].date) : 0
  return props.days.map((d, i) => ({
    ...d,
    idx: i,
    row: rowOf(d.date),
    col: Math.floor((offset + i) / 7),
    label: `${mmdd(d.date)} ${WEEK[rowOf(d.date)]}`,
  }))
})
const cols = computed(() => (cells.value.at(-1)?.col ?? 0) + 1)
const maxValue = computed(() => Math.max(1, ...props.days.map((d) => d.value)))
const edge = computed(() => {
  const w = size.value.w
  if (!w || !cols.value) return 16
  return Math.max(10, Math.min(24, Math.floor((w - LABEL_W - (cols.value - 1) * GAP) / cols.value)))
})
const plotW = computed(() => LABEL_W + cols.value * edge.value + (cols.value - 1) * GAP)
const height = computed(() => TOP_H + 7 * edge.value + 6 * GAP)

/** 月标只在该月第一次出现的那一列写一次 */
const monthLabels = computed(() => {
  const out: { key: string; text: string; x: number }[] = []
  let last = ''
  for (const c of cells.value) {
    const m = c.date.slice(0, 7)
    if (m === last) continue
    last = m
    out.push({ key: m, text: `${Number(m.slice(5, 7))}月`, x: LABEL_W + c.col * (edge.value + GAP) })
  }
  return out
})
const weekdayLabels = WEEK.map((w, i) => ({ w, i })).filter((x) => x.i % 2 === 1)

const tabDate = computed(
  () => (props.days.some((d) => d.date === active.value) ? active.value : props.today || props.days.at(-1)?.date || ''),
)
const bg = (v: number) => {
  const level = v <= 0 ? 0 : Math.min(4, Math.ceil((v / maxValue.value) * 4))
  return `color-mix(in srgb, ${props.color} ${LEVEL[level]}%, var(--app-surface))`
}
const box = (d: string) =>
  d === props.today ? '0 0 0 2px var(--app-accent)' : d === props.selected ? '0 0 0 2px var(--app-ink)' : undefined

function onKey(e: KeyboardEvent, i: number) {
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[e.key]
  if (step == null) return
  e.preventDefault()
  const next = props.days[i + step]
  if (!next) return
  active.value = next.date
  nextTick(() => plot.value?.querySelector<HTMLElement>(`[data-date="${next.date}"]`)?.focus())
}

/** 悬浮那一格：键盘走到哪一格也照同一只读数箱 */
const tip = computed(() => {
  const c = cells.value.find((x) => x.date === (hover.value || active.value))
  if (!c) return null
  const cellX = LABEL_W + c.col * (edge.value + GAP)
  const top = TOP_H + c.row * (edge.value + GAP)
  // 头两行上方只剩月标那一行，读数箱改挂到格子下面
  const above = c.row > 1
  // 两端不居中：居中会把箱子压到星期标上或被卡片裁掉，靠左/靠右贴那一列的边
  const half = 58
  const cx = cellX + edge.value / 2
  const align = cx - half < 0 ? 'left' : cx + half > plotW.value ? 'right' : 'center'
  const x = align === 'left' ? cellX : align === 'right' ? cellX + edge.value : cx
  return {
    date: c.date,
    label: c.label,
    value: c.value,
    x,
    y: above ? top - 6 : top + edge.value + 6,
    transform: `translate(${align === 'left' ? '0' : align === 'right' ? '-100%' : '-50%'}, ${above ? '-100%' : '0'})`,
  }
})
</script>

<template>
  <div :ref="setEl" class="flex w-full min-w-0 items-center">
    <div
      v-if="cells.length"
      ref="plot"
      class="relative mx-auto"
      :style="{ width: `${plotW}px`, height: `${height}px` }"
      @pointerleave="hover = ''"
    >
      <span
        v-for="m in monthLabels"
        :key="m.key"
        class="pointer-events-none absolute text-aux leading-4 text-ink-3"
        :style="{ left: `${m.x}px`, top: 0 }"
      >{{ m.text }}</span>
      <span
        v-for="w in weekdayLabels"
        :key="w.w"
        class="pointer-events-none absolute left-0 text-aux text-ink-3"
        :style="{ top: `${TOP_H + w.i * (edge + GAP)}px`, height: `${edge}px`, lineHeight: `${edge}px` }"
      >{{ w.w.slice(1) }}</span>
      <button
        v-for="c in cells"
        :key="c.date"
        type="button"
        :data-date="c.date"
        class="absolute left-0 top-0 cursor-pointer rounded-[4px] border-0 p-0 transition-[filter] hover:brightness-[1.12] focus-visible:outline-2 focus-visible:outline-offset-2"
        :style="{
          width: `${edge}px`,
          height: `${edge}px`,
          transform: `translate(${LABEL_W + c.col * (edge + GAP)}px, ${TOP_H + c.row * (edge + GAP)}px)`,
          background: bg(c.value),
          boxShadow: box(c.date),
        }"
        :aria-label="`${c.label}，发布 ${c.value} 条`"
        :tabindex="c.date === tabDate ? 0 : -1"
        @pointerenter="hover = c.date"
        @click="emit('select', c.date, $event.currentTarget as HTMLElement)"
        @keydown="onKey($event, c.idx)"
      />
      <div
        v-if="tip"
        class="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface/95 px-2 py-1 text-xs whitespace-nowrap"
        :style="{ left: `${tip.x}px`, top: `${tip.y}px`, transform: tip.transform }"
      >
        <span class="text-ink-3">{{ tip.label }}</span>
        <b class="ml-1.5 font-medium tabular-nums text-ink" style="font-family: var(--font-metric)">{{ tip.value }}</b>
        <span class="ml-1 text-ink-3">条</span>
      </div>
    </div>
  </div>
</template>
