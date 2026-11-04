<script setup lang="ts">
/** 看板「看这一批」：点卡口那一行或热力图某一格，贴着它浮出这几条，不再占页面下方。
 *  一屏只摊几条，整条稿子回平台看——点行进创作台，行右侧那颗图标是这一版当下最该做的一步。
 *  浮层挂 body：bento 卡自己 overflow-hidden 还带入场 transform，留在卡里会被裁掉。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChartLine as IconChartLine, ExternalLink as IconExternalLink, Send as IconSend, X as IconX } from 'lucide-vue-next'
import PlatformLogo from './PlatformLogo.vue'
import { sharedPlatforms, type LaneState } from '../data/store'

export interface BatchRow {
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
  /** 该号后台草稿箱地址，没有就不给外链那颗图标 */
  backend: string
  /** 本机推得动这颗草稿才给「推草稿」；推不动就不摆一颗点不动的图标 */
  pushable: boolean
}

const props = withDefaults(defineProps<{
  title: string
  rows: BatchRow[]
  /** 触发它的那一行/那一格，浮层贴着它摆；滚动时跟着走 */
  anchor: HTMLElement
  /** 服务端推草稿的队列在跑：这一版还没进箱前不许再点一次 */
  busy?: boolean
}>(), { busy: false })

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open', row: BatchRow): void
  (e: 'act', row: BatchRow): void
}>()

const W = 420
const panel = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })

/** 优先挂在触发元素下方，放不下就翻到上方；左右收进视口内 */
async function place() {
  await nextTick()
  const a = props.anchor.getBoundingClientRect()
  const ph = panel.value?.getBoundingClientRect().height ?? 240
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(12, Math.min(a.x, vw - W - 12))
  const below = a.y + a.height + 8 + ph <= vh - 12
  pos.value = { left, top: below ? a.y + a.height + 8 : Math.max(12, a.y - 8 - ph) }
}

/** 一屏 6 条上下，再多就滚——日期同一个就不在每行重复一遍 */
const oneDay = computed(() => new Set(props.rows.map((r) => r.date)).size === 1)

const chipText = (r: BatchRow) =>
  r.state === 'published' ? '已发布'
    : r.state === 'drafted' ? `草稿箱 ${r.pushedAt.slice(11, 16) || r.pushedAt.slice(5, 10)}`
      : '未推送'
const chipTone = (r: BatchRow) =>
  r.state === 'published' ? '!bg-tone-published' : r.state === 'drafted' ? '!bg-tone-ready' : '!bg-tone-idle'

/** 这一版当下最该做的一步：没推的推一把，在箱的带去后台，发完的去看数据 */
function rowAct(r: BatchRow) {
  if (r.state === 'pending')
    return r.pushable ? { icon: IconSend, off: props.busy, tip: props.busy ? '队列在跑，等这批推完' : '只进草稿箱，发布日期不动' } : null
  if (r.state === 'drafted') return r.backend ? { icon: IconExternalLink, off: false, tip: `打开${r.account}后台草稿箱` } : null
  return r.state === 'published' ? { icon: IconChartLine, off: false, tip: '看数据' } : null
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  place()
  window.addEventListener('resize', place)
  window.addEventListener('scroll', place, true)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', place)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('keydown', onKey)
})
watch(() => props.rows.length, place)
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[2040]" @click="emit('close')" />
    <div
      ref="panel"
      role="dialog"
      :aria-label="title"
      class="fixed z-[2050] flex flex-col overflow-hidden rounded-[var(--app-radius-lg)] border border-line bg-surface shadow-neo-lg"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${W}px` }"
    >
      <div class="flex shrink-0 items-baseline gap-2 border-b border-line px-3.5 py-2.5">
        <span class="text-sm font-medium text-ink">{{ title }}</span>
        <span class="text-sm text-ink-2 tabular-nums">{{ rows.length }} 条</span>
        <button
          class="btn-ghost ml-auto !px-2 self-center"
          title="收起"
          aria-label="收起"
          @click="emit('close')"
        >
          <IconX :size="15" class="shrink-0" />
        </button>
      </div>

      <div v-if="!rows.length" class="flex items-center gap-2 px-3.5 py-4">
        <span class="text-sm text-ink-3">暂无</span>
      </div>
      <div v-else class="max-h-[19rem] overflow-y-auto p-1.5">
        <div
          v-for="r in rows"
          :key="`${r.key}-${r.account}`"
          class="group flex items-center gap-2.5 rounded-[10px] px-2 py-2 transition-colors hover:bg-surface-2"
        >
          <PlatformLogo :platform="r.platform" :size="18" />
          <button class="min-w-0 flex-1 text-left outline-none" @click="emit('open', r)">
            <span class="block truncate text-sm leading-snug font-medium text-ink">{{ r.title }}</span>
            <span v-if="sharedPlatforms.has(r.platform) || r.line || !oneDay" class="mt-0.5 flex items-center gap-1.5">
              <span v-if="!oneDay" class="shrink-0 text-xs tabular-nums text-ink-2">{{ r.date.slice(5) }}</span>
              <span v-if="sharedPlatforms.has(r.platform)" class="shrink-0 text-xs text-ink-2">{{ r.label }}</span>
              <span v-if="r.line" class="truncate text-xs text-ink-2">{{ r.line }}</span>
            </span>
          </button>
          <span class="chip shrink-0 !px-2.5 !py-0" :class="chipTone(r)">{{ chipText(r) }}</span>
          <button
            v-if="rowAct(r)"
            class="btn shrink-0 !px-2 !py-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            :disabled="rowAct(r)!.off"
            :title="rowAct(r)!.tip"
            :aria-label="rowAct(r)!.tip"
            @click="emit('act', r)"
          >
            <component :is="rowAct(r)!.icon" :size="13" class="shrink-0" />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
