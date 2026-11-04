<script setup lang="ts">
/** bento 柱图：一根时间轴，一天一组并排柱，一柱一个平台；上周期与本周期同轴，缺数的天留空不补 0。
 *  尺寸按真实像素量（ResizeObserver）——viewBox 一拉伸，圆角和刻度字都会糊。
 *  负值（掉粉那几天）从 0 轴往下长，所以轴底跟着最小值走，不钉死在 0。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSize } from '../lib/useSize'
import { useReducedMotion } from '../lib/useReducedMotion'
import { compactNumber, easeOut, niceStep } from '../lib/bentoPath'

export interface BarSeries {
  name: string
  color: string
  values: (number | null)[]
}

const props = withDefaults(
  defineProps<{
    dates: string[]
    series: BarSeries[]
    /** 本周期起始日的下标：在那天左边画一根分隔线，两段窗口同轴才读得出来 */
    splitAt?: number | null
    minH?: number
  }>(),
  { splitAt: null, minH: 220 },
)

const { setEl, size } = useSize()
const reduce = useReducedMotion()
const grow = ref(reduce.value ? 1 : 0)
const hover = ref<number | null>(null)
let raf = 0

const PAD = { top: 26, right: 52, bottom: 26, left: 12 }

watch(size, ({ w, h }) => {
  if (!w || !h || reduce.value || grow.value === 1) return
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / 1200)
    grow.value = easeOut(t)
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))

const plot = computed(() => {
  const { w: W, h: H } = size.value
  const n = props.dates.length
  if (W < 120 || H < 90 || !n || !props.series.length) return null
  let lo = 0
  let hi = 0
  for (const s of props.series) {
    for (const v of s.values) {
      if (v == null) continue
      if (v > hi) hi = v
      if (v < lo) lo = v
    }
  }
  const step = niceStep(lo, hi || 1, 4)
  const top = Math.max(step, Math.ceil(hi / step) * step)
  const bottom = Math.min(0, Math.floor(lo / step) * step)
  const band = (W - PAD.left - PAD.right) / n
  const y = (v: number) => PAD.top + (1 - (v - bottom) / (top - bottom || 1)) * (H - PAD.top - PAD.bottom)
  const ticks: { v: number; y: number }[] = []
  for (let t = bottom; t <= top + 1e-9; t += step) ticks.push({ v: Number(t.toFixed(6)), y: y(t) })
  const groupW = Math.min(band * 0.68, props.series.length * 14)
  const gap = props.series.length > 1 ? 1.5 : 0
  const bw = Math.max(1.5, (groupW - gap * (props.series.length - 1)) / props.series.length)
  const bars = props.series.flatMap((s, k) =>
    s.values.flatMap((v, i) => {
      if (v == null) return []
      const scaled = v * grow.value
      const y0 = y(0)
      const yv = y(scaled)
      const h = Math.abs(yv - y0)
      if (h < 0.6) return []
      return [{
        key: `${k}-${i}`,
        color: s.color,
        x: PAD.left + band * i + (band - groupW) / 2 + k * (bw + gap),
        y: Math.min(y0, yv),
        w: bw,
        h,
      }]
    }),
  )
  const labelIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])]
  const labels = labelIdx.map((i) => ({
    i,
    text: props.dates[i].slice(5),
    x: PAD.left + band * i + band / 2,
    anchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
  }))
  return {
    W,
    H,
    band,
    step,
    ticks,
    bars,
    labels,
    zero: y(0),
    splitX: props.splitAt != null && props.splitAt > 0 && props.splitAt < n
      ? PAD.left + band * props.splitAt
      : null,
  }
})

function move(e: PointerEvent) {
  const p = plot.value
  if (!p) return
  const r = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect()
  const i = Math.floor((e.clientX - r.left - PAD.left) / p.band)
  hover.value = i >= 0 && i < props.dates.length ? i : null
}

const tip = computed(() => {
  const i = hover.value
  const p = plot.value
  if (i == null || !p) return null
  const rows = props.series
    .map((s) => ({ name: s.name, color: s.color, value: s.values[i] }))
    .filter((r): r is { name: string; color: string; value: number } => r.value != null)
  return {
    date: props.dates[i],
    rows,
    total: rows.reduce((a, r) => a + r.value, 0),
    flip: PAD.left + p.band * (i + 0.5) > p.W * 0.6,
  }
})
</script>

<template>
  <div :ref="setEl" class="bento-inset relative flex-1" :style="{ minHeight: `${minH}px` }">
    <!-- svg 绝对定位：一旦它参与高度，卡片高度 = 图高、图高 = 卡片高度，ResizeObserver 会自己把自己吹大 -->
    <svg
      v-if="plot"
      :width="plot.W"
      :height="plot.H"
      class="absolute inset-0 block"
      role="img"
      :aria-label="`${series.map((s) => s.name).join(' 与 ')}逐日`"
    >
      <g v-for="t in plot.ticks" :key="t.v">
        <line :x1="0" :x2="plot.W" :y1="t.y" :y2="t.y" style="stroke: var(--app-line)" stroke-width="1" />
        <text
          :x="plot.W - 10"
          :y="t.y - 5"
          text-anchor="end"
          font-size="10"
          stroke-width="3"
          style="fill: var(--app-ink-3); font-family: var(--font-metric); stroke: var(--app-surface-2); paint-order: stroke"
        >{{ compactNumber(t.v, plot.step) }}</text>
      </g>

      <line
        v-if="plot.splitX != null"
        :x1="plot.splitX"
        :x2="plot.splitX"
        :y1="PAD.top - 8"
        :y2="plot.H - PAD.bottom"
        style="stroke: var(--app-line-strong)"
        stroke-width="1"
        stroke-dasharray="4 4"
      />
      <text
        v-if="plot.splitX != null"
        :x="plot.splitX + 6"
        :y="PAD.top - 4"
        font-size="10"
        style="fill: var(--app-ink-3); font-family: var(--font-metric)"
      >本周期</text>

      <line
        v-if="plot.zero > PAD.top && plot.zero < plot.H - PAD.bottom"
        :x1="PAD.left"
        :x2="plot.W - PAD.right"
        :y1="plot.zero"
        :y2="plot.zero"
        style="stroke: var(--app-line-strong)"
        stroke-width="1"
      />

      <rect
        v-if="hover != null"
        :x="PAD.left + plot.band * hover"
        :y="0"
        :width="plot.band"
        :height="plot.H"
        style="fill: var(--app-ink)"
        opacity="0.05"
      />

      <rect
        v-for="b in plot.bars"
        :key="b.key"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        :fill="b.color"
        rx="2"
      />

      <text
        v-for="l in plot.labels"
        :key="l.i"
        :x="l.x"
        :y="plot.H - 8"
        :text-anchor="l.anchor"
        font-size="10"
        style="fill: var(--app-ink-3); font-family: var(--font-metric)"
      >{{ l.text }}</text>

      <rect :width="plot.W" :height="plot.H" fill="transparent" @pointermove="move" @pointerleave="hover = null" />
    </svg>

    <div
      v-if="tip"
      class="pointer-events-none absolute top-2 min-w-36 rounded-lg border border-line bg-surface/95 px-2 py-1 text-xs whitespace-nowrap"
      :class="tip.flip ? 'left-2.5' : 'right-14'"
    >
      <div class="text-ink-3">{{ tip.date }}</div>
      <div v-for="r in tip.rows" :key="r.name" class="flex items-center gap-1.5">
        <i class="size-2 rounded-[2px]" :style="{ background: r.color }" />
        <span class="text-ink-3">{{ r.name }}</span>
        <b class="ml-auto font-medium tabular-nums text-ink" style="font-family: var(--font-metric)">{{ r.value.toLocaleString('en-US') }}</b>
      </div>
      <div v-if="tip.rows.length > 1" class="flex items-center gap-1.5 border-t border-line pt-1">
        <span class="text-ink-3">合计</span>
        <b class="ml-auto font-medium tabular-nums text-ink" style="font-family: var(--font-metric)">{{ tip.total.toLocaleString('en-US') }}</b>
      </div>
    </div>
  </div>
</template>
