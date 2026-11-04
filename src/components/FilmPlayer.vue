<script setup lang="ts">
/** 成片预览器：拖、逐帧、时间码、静音，多版切到同一秒对照。看片用的，不剪。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  Pause as IconPause,
  Play as IconPlay,
  Volume2 as IconVolume,
  VolumeX as IconVolumeX,
} from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{ src: string; fps?: number; sources?: { label: string; url: string }[] }>(),
  { fps: 30, sources: () => [] },
)

const list = computed(() => {
  if (props.sources.length) return props.sources
  return [{ label: '成片', url: props.src }]
})
const pick = ref(0)
const url = computed(() => list.value[Math.min(pick.value, list.value.length - 1)].url || props.src)

const video = ref<HTMLVideoElement | null>(null)
const track = ref<HTMLElement | null>(null)
const dur = ref(0)
const cur = ref(0)
const playing = ref(false)
const muted = ref(false)
const portrait = ref(false)
const hover = ref<number | null>(null)

const frames = computed(() => (dur.value ? Math.max(1, Math.round(dur.value * props.fps)) : 0))
const frame = computed(() => Math.max(0, Math.min(frames.value - 1, Math.round(cur.value * props.fps))))
const pct = computed(() => (dur.value ? (cur.value / dur.value) * 100 : 0))

const stamp = (s: number) => {
  const t = Math.max(0, s)
  const mm = Math.floor(t / 60)
  const ss = Math.floor(t % 60)
  const d = Math.round((t - Math.floor(t)) * 10)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${d}`
}

let raf = 0
const loop = () => {
  raf = 0
  if (video.value) cur.value = video.value.currentTime
  if (playing.value) raf = requestAnimationFrame(loop)
}
const stop = () => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function onMeta() {
  const v = video.value
  if (!v) return
  dur.value = Number.isFinite(v.duration) ? v.duration : 0
  portrait.value = v.videoHeight > v.videoWidth
  muted.value = v.muted
}
function toggle() {
  const v = video.value
  if (!v) return
  if (v.paused) v.play().catch(() => {}); else v.pause()
}
/** 逐帧只在停着的时候有意义：按一下先停下，再走一帧 */
function step(n: number) {
  const v = video.value
  if (!v || !dur.value) return
  v.pause()
  v.currentTime = Math.max(0, Math.min(dur.value, (frame.value + n) / props.fps))
  cur.value = v.currentTime
}
function onPlay() {
  playing.value = true
  loop()
}
function onPause() {
  playing.value = false
  stop()
  if (video.value) cur.value = video.value.currentTime
}

const ratioAt = (e: PointerEvent) => {
  const box = track.value?.getBoundingClientRect()
  if (!box || !box.width) return 0
  return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width))
}
let dragging = false
function onDown(e: PointerEvent) {
  dragging = true
  track.value?.setPointerCapture(e.pointerId)
  seek(e)
}
function onMove(e: PointerEvent) {
  hover.value = ratioAt(e) * 100
  if (dragging) seek(e)
}
function onUp(e: PointerEvent) {
  dragging = false
  track.value?.releasePointerCapture?.(e.pointerId)
}
function seek(e: PointerEvent) {
  const v = video.value
  if (!v || !dur.value) return
  v.currentTime = ratioAt(e) * dur.value
  cur.value = v.currentTime
}

function onKey(e: KeyboardEvent) {
  if (e.key === ' ') { e.preventDefault(); toggle() }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -props.fps : -1) }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? props.fps : 1) }
}

watch(muted, (m) => { if (video.value) video.value.muted = m })
/** 换版本停在同一秒：横竖两版对不对得上周，拖一下就看出来 */
watch(url, (u, old) => {
  if (!u || u === old) return
  const at = cur.value
  const v = video.value
  const seekTo = () => {
    if (!v) return
    v.currentTime = Math.min(at, dur.value || 0)
    cur.value = v.currentTime
  }
  if (v) v.addEventListener('loadedmetadata', seekTo, { once: true })
})

onBeforeUnmount(stop)
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-lg border border-line bg-surface outline-none" tabindex="0" @keydown="onKey">
    <div v-if="list.length > 1" class="flex items-center gap-1 border-b border-line px-2 py-1.5">
      <button
        v-for="(s, i) in list"
        :key="s.label"
        class="seg !px-3 !py-1 !text-[13px]"
        :class="i === pick && 'is-selected'"
        @click="pick = i"
      >
        {{ s.label }}
      </button>
    </div>

    <div class="flex justify-center bg-surface-2 px-3 py-3">
      <div :class="portrait ? 'relative shrink-0 rounded-[46px] bg-neutral-900 p-[9px] shadow-neo ring-1 ring-neutral-600' : 'w-full'">
        <div :class="portrait ? 'relative overflow-hidden rounded-[38px]' : 'overflow-hidden rounded-md'">
          <video
            ref="video"
            :src="url"
            playsinline
            preload="metadata"
            :class="portrait ? 'block h-auto w-[270px]' : 'block max-h-[440px] w-full'"
            @loadedmetadata="onMeta"
            @play="onPlay"
            @pause="onPause"
            @ended="onPause"
          />
          <span v-if="portrait" class="pointer-events-none absolute left-1/2 top-[8px] h-[20px] w-[78px] -translate-x-1/2 rounded-full bg-[#0e0e12]" />
        </div>
      </div>
    </div>

    <div class="flex items-center gap-1.5 border-t border-line px-2.5 py-2">
      <button class="btn-ghost !px-2 !py-1" :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停（空格）' : '播放（空格）'" @click="toggle">
        <IconPause v-if="playing" :size="15" class="shrink-0" />
        <IconPlay v-else :size="15" class="shrink-0" />
      </button>
      <button class="btn-ghost !px-1.5 !py-1" aria-label="上一帧" title="上一帧（←）" @click="step(-1)">
        <IconChevronLeft :size="13" class="shrink-0" />
      </button>
      <button class="btn-ghost !px-1.5 !py-1" aria-label="下一帧" title="下一帧（→）" @click="step(1)">
        <IconChevronRight :size="13" class="shrink-0" />
      </button>

      <div
        ref="track"
        class="relative h-5 flex-1 cursor-pointer touch-none select-none"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="hover = null"
      >
        <span class="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line-strong" />
        <span v-if="hover !== null && hover > pct" class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-3" :style="{ left: pct + '%', width: hover - pct + '%' }" />
        <span class="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" :style="{ width: pct + '%' }" />
        <span class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-2 ring-surface" :style="{ left: pct + '%' }" />
        <span
          v-if="hover !== null && dur"
          class="pointer-events-none absolute -top-5 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 font-metric text-[11px] tabular-nums text-canvas"
          :style="{ left: hover + '%' }"
        >
          {{ stamp((hover / 100) * dur) }}
        </span>
      </div>

      <span class="font-metric text-[12px] tabular-nums text-ink-3">{{ stamp(cur) }} / {{ stamp(dur) }}</span>
      <span v-if="frames" class="font-metric text-[12px] tabular-nums text-ink-3">#{{ frame + 1 }}/{{ frames }}</span>
      <button class="btn-ghost !px-2 !py-1" :aria-label="muted ? '取消静音' : '静音'" :title="muted ? '取消静音' : '静音'" @click="muted = !muted">
        <IconVolumeX v-if="muted" :size="15" class="shrink-0" />
        <IconVolume v-else :size="15" class="shrink-0" />
      </button>
    </div>
  </div>
</template>
