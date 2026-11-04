<script setup lang="ts">
/** bento 折线：一条序列 + 渐变面积，右端留一刻度槽，悬浮出十字线与读数。
 *  传 compare 就多一条上周期淡虚线，与主线同下标对齐、共用一把尺——两条线的高低差就是数的高低差。
 *  尺寸按真实像素量（ResizeObserver），拉伸手柄会把 2.5px 描边糊成一片。 */
import { computed, ref, useId, watch } from 'vue'
import { useSize } from '../lib/useSize'
import { useReducedMotion } from '../lib/useReducedMotion'
import { compactNumber, niceStep, smooth, type Pt } from '../lib/bentoPath'

const props = withDefaults(
  defineProps<{
    points: { label: string; value: number | null }[]
    /** 对比序列（通常是上一周期），与 points 同下标；null 的天不画点 */
    compare?: (number | null)[]
    /** 序列名：只进悬浮读数，不占版面 */
    series?: string
    color?: string
    minH?: number
    /** 从 0 起画：面积的高度即数值，两条线才可比 */
    zeroBase?: boolean
    /** 底部标出每天的短名 */
    xLabels?: boolean
  }>(),
  { series: '', color: 'var(--app-chart-1)', minH: 120, compare: undefined, zeroBase: false, xLabels: false },
)

const uid = `sp${useId().replace(/:/g, '')}`
const { setEl, size } = useSize()
const reduce = useReducedMotion()
const drawn = ref(false)
const hover = ref<number | null>(null)

const PAD = { top: 14, bottom: 12, left: 12, right: 52 }

const plot = computed(() => {
  const { w: W, h: H } = size.value
  const v = props.points.map((p) => p.value)
  if (W < 60 || H < 40 || v.length < 2) return null
  const solid = v.filter((n): n is number => n != null)
  const ghost = (props.compare ?? []).filter((n): n is number => n != null)
  const all = [...solid, ...ghost]
  if (all.length < 2) return null
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const span = hi - lo || 1
  const step = niceStep(lo, hi)
  // 零基线留给「两条线放一起比」的图；单看一条走势时下方留四成五余量，折线浮在上半格，面积才有呼吸
  const mn = props.zeroBase ? Math.min(0, lo) : lo - span * 0.45
  const mx = hi + span * 0.08
  const padB = props.xLabels ? PAD.bottom + 14 : PAD.bottom
  const x = (i: number) => PAD.left + (i / (v.length - 1)) * (W - PAD.left - PAD.right)
  const y = (n: number) => PAD.top + (1 - (n - mn) / (mx - mn)) * (H - PAD.top - padB)
  const ticks: number[] = []
  for (let t = Math.ceil((props.zeroBase ? 0 : lo) / step) * step; t <= hi + 1e-9; t += step) ticks.push(t)
  const P: Pt[] = []
  v.forEach((n, i) => {
    if (n != null) P.push([Number(x(i).toFixed(2)), Number(y(n).toFixed(2))])
  })
  if (P.length < 2) return null
  const d = smooth(P)
  const G: Pt[] = []
  props.compare?.forEach((n, i) => {
    if (n != null && i < v.length) G.push([Number(x(i).toFixed(2)), Number(y(n).toFixed(2))])
  })
  const base = props.zeroBase ? y(0) : H
  return {
    W,
    H,
    step,
    x,
    y,
    ticks,
    P,
    line: d,
    ghost: G.length > 1 ? smooth(G) : '',
    area: `${d}L${P.at(-1)![0]},${base}L${P[0][0]},${base}Z`,
    zero: mn < 0 && mx > 0 ? y(0) : null,
    labels: props.xLabels ? props.points.map((p, i) => ({ x: x(i), text: p.label })) : [],
  }
})

watch(size, ({ w }) => {
  if (!w || drawn.value) return
  if (reduce.value) {
    drawn.value = true
    return
  }
  requestAnimationFrame(() => requestAnimationFrame(() => (drawn.value = true)))
})

function move(e: PointerEvent) {
  const p = plot.value
  if (!p) return
  const r = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect()
  const n = props.points.length
  hover.value = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - PAD.left) / (p.W - PAD.left - PAD.right)) * (n - 1))))
}

/** 悬浮那一笔：缺读数的天没有点，十字线和读数箱都不出现 */
const hoverPt = computed(() => {
  const i = hover.value
  const p = plot.value
  const v = i == null ? null : props.points[i]?.value
  if (i == null || !p || v == null) return null
  return { x: p.x(i), y: p.y(v), day: i }
})

const tip = computed(() => {
  const h = hoverPt.value
  const p = plot.value
  if (!h || !p) return null
  return {
    label: props.points[h.day].label,
    value: props.points[h.day].value!.toLocaleString('en-US'),
    // 读数箱压到左半，悬浮点跑到右边时换成靠左上
    flip: h.x > p.W * 0.6,
  }
})
</script>

<template>
  <div :ref="setEl" class="bento-inset relative flex-1" :style="{ minHeight: `${minH}px` }">
    <!-- svg 绝对定位：一旦它参与高度，卡片高度 = 图高、图高 = 卡片高度，ResizeObserver 会自己把自己吹大 -->
    <svg v-if="plot" :width="plot.W" :height="plot.H" class="absolute inset-0 block" role="img" :aria-label="series">
      <defs>
        <linearGradient :id="`${uid}a`" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" :style="{ stopColor: color, stopOpacity: 0.2 }" />
          <stop offset="1" :style="{ stopColor: color, stopOpacity: 0 }" />
        </linearGradient>
        <linearGradient :id="`${uid}f`" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0.25" />
          <stop offset="1" stop-color="#fff" stop-opacity="1" />
        </linearGradient>
        <mask :id="`${uid}k`"><rect :width="plot.W" :height="plot.H" :fill="`url(#${uid}f)`" /></mask>
      </defs>

      <g v-for="(t, i) in plot.ticks" :key="i">
        <line :x1="0" :x2="plot.W" :y1="plot.y(t)" :y2="plot.y(t)" style="stroke: var(--app-line)" stroke-width="1" />
        <text
          :x="plot.W - 10"
          :y="plot.y(t) - 5"
          text-anchor="end"
          font-size="10"
          stroke-width="3"
          style="fill: var(--app-ink-3); font-family: var(--font-metric); stroke: var(--app-surface-2); paint-order: stroke"
        >{{ compactNumber(t, plot.step) }}</text>
      </g>
      <line
        v-if="plot.zero != null"
        :x1="PAD.left"
        :x2="plot.W - PAD.right"
        :y1="plot.zero"
        :y2="plot.zero"
        style="stroke: var(--app-line-strong)"
        stroke-width="1"
      />

      <path v-if="plot.ghost" :d="plot.ghost" fill="none" :style="{ stroke: color, strokeWidth: 1.5, strokeOpacity: 0.32, strokeDasharray: '4 3' }" />
      <path :d="plot.area" :fill="`url(#${uid}a)`" :mask="`url(#${uid}k)`" />
      <path
        :d="plot.line"
        pathLength="1"
        fill="none"
        :style="{
          stroke: color,
          strokeWidth: 2.5,
          strokeLinecap: 'round',
          strokeDasharray: 1,
          strokeDashoffset: drawn ? 0 : 1,
          transition: 'stroke-dashoffset 1.4s cubic-bezier(.3,.8,.2,1) .2s',
        }"
      />
      <circle
        :cx="plot.P.at(-1)![0]"
        :cy="plot.P.at(-1)![1]"
        r="4.5"
        :style="{ fill: color, stroke: 'var(--app-surface)', strokeWidth: 2 }"
      />

      <text
        v-for="(l, i) in plot.labels"
        :key="`d${i}`"
        :x="l.x"
        :y="plot.H - 6"
        text-anchor="middle"
        font-size="10"
        style="fill: var(--app-ink-3)"
      >{{ l.text }}</text>

      <template v-if="hoverPt">
        <line :x1="hoverPt.x" :x2="hoverPt.x" y1="0" :y2="plot.H" style="stroke: var(--app-ink-3)" stroke-width="1" />
        <circle
          :cx="hoverPt.x"
          :cy="hoverPt.y"
          r="4.5"
          :style="{ fill: color, stroke: 'var(--app-surface)', strokeWidth: 2 }"
        />
      </template>

      <rect :width="plot.W" :height="plot.H" fill="transparent" @pointermove="move" @pointerleave="hover = null" />
    </svg>

    <div
      v-if="tip"
      class="pointer-events-none absolute top-2 rounded-lg border border-line bg-surface/95 px-2 py-1 text-xs whitespace-nowrap"
      :class="tip.flip ? 'left-2.5' : 'right-14'"
    >
      <span class="text-ink-3">{{ tip.label }}</span>
      <b class="ml-1.5 font-medium tabular-nums text-ink" style="font-family: var(--font-metric)">{{ tip.value }}</b>
      <span v-if="series" class="ml-1.5 text-ink-3">{{ series }}</span>
    </div>
  </div>
</template>
