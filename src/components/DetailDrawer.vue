<script lang="ts">
/** 抽屉要画的媒体：四页（灵感库/爆款采集/选题/历史）把各自的卡片映射成这一份 */
export interface DrawerItem {
  id: string
  title: string
  /** 原帖链接，有则在右栏标题旁出「打开原帖」 */
  url?: string
  coverImage?: string
  images?: string[]
  /** 视频源片（public 下相对路径）；空 = 图文或没搬回源料 */
  videoUrl?: string
}
</script>

<script setup lang="ts">
/** 整屏详情抽屉（即创素材库同款，2026-11-01 按用户口径改过比例）：
 *  左轨翻卡 + 中间就地播 + 右栏信息列。
 *  中间比即创窄、右栏比即创宽（476 → 680）：我们的右栏要装脚本、五层拆解、原文三段长文，
 *  即创那份只有一段提示词，照抄它的比例会把我们的内容挤成一屏滚不到底。
 *  壳只管媒体与翻卡，右栏的读数、正文与底沿动作由各页用槽自己填。
 *  Teleport 到 body：挂在 main 里时滚轮会顺着祖先链把背后那面卡片墙一起滚走。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toneOf } from '../data/store'
import { ChevronDown as IconChevronDown, ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight, ChevronUp as IconChevronUp, ExternalLink as IconExternalLink, X as IconX } from 'lucide-vue-next'

const props = defineProps<{
  items: DrawerItem[]
  /** 当前打开那条的 id；空串 = 没打开 */
  current: string
  /** 无障碍标签，如「采集卡详情」 */
  label: string
}>()
const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'close'): void
}>()

const idx = computed(() => props.items.findIndex((i) => i.id === props.current))
const selected = computed(() => (idx.value < 0 ? null : props.items[idx.value]))

/** 左轨：上一条/下一条 + 相邻三张缩略（即创详情同款），只在当前筛选结果里走 */
const rail = computed(() => (idx.value < 0 ? [] : props.items.slice(Math.max(0, idx.value - 1), idx.value + 2)))
function step(d: number) {
  const i = idx.value
  if (i < 0 || i + d < 0 || i + d >= props.items.length) return
  emit('select', props.items[i + d].id)
}

/** 源图逐页翻看：一次只展示一页，像小红书/抖音的图集浏览器 */
const page = ref(0)
const panelBody = ref<HTMLElement | null>(null)
const images = computed(() => selected.value?.images ?? [])
const paging = computed(() => !selected.value?.videoUrl && images.value.length > 1)
function goPage(i: number) {
  page.value = Math.min(Math.max(0, i), images.value.length - 1)
}
watch(() => props.current, () => {
  page.value = 0
  // 抽屉背后那张卡片的墙不动：只把自己这栏滚回顶部
  nextTick(() => panelBody.value?.scrollTo(0, 0))
})

function onKey(e: KeyboardEvent) {
  if (!selected.value) return
  if (e.key === 'ArrowLeft') goPage(page.value - 1)
  if (e.key === 'ArrowRight') goPage(page.value + 1)
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="selected" v-dialog="label" class="fixed inset-0 z-[2000] flex bg-[rgba(17,14,23,0.72)] backdrop-blur-md">
      <!-- 左轨：上一条/下一条 + 相邻缩略 -->
      <div class="flex h-full w-[52px] shrink-0 flex-col items-center justify-center gap-2 py-4">
        <button class="btn-ghost !px-1.5 disabled:!opacity-30" :disabled="idx <= 0" aria-label="上一条" title="上一条" @click="step(-1)">
          <IconChevronUp :size="15" />
        </button>
        <button
          v-for="n in rail"
          :key="n.id"
          class="h-9 w-9 shrink-0 overflow-hidden rounded-md border transition-colors"
          :class="n.id === selected.id ? 'border-[rgba(255,255,255,0.85)]' : 'border-[rgba(255,255,255,0.18)] hover:border-[rgba(255,255,255,0.5)]'"
          :title="n.title"
          :aria-label="`看这条：${n.title}`"
          @click="emit('select', n.id)"
        >
          <img v-if="n.coverImage" :src="n.coverImage" :alt="n.title" class="h-full w-full object-cover" />
          <span v-else class="block h-full w-full" :style="{ background: toneOf(n.id) }" />
        </button>
        <button class="btn-ghost !px-1.5 disabled:!opacity-30" :disabled="idx < 0 || idx >= items.length - 1" aria-label="下一条" title="下一条" @click="step(1)">
          <IconChevronDown :size="15" />
        </button>
      </div>

      <!-- 中间媒体：视频就地播，图文逐页翻（← →） -->
      <div class="relative flex h-full min-w-0 flex-1 items-center justify-center border-r border-[rgba(255,255,255,0.12)] px-8 py-10">
        <video
          v-if="selected.videoUrl"
          :src="selected.videoUrl"
          :poster="selected.coverImage"
          controls
          playsinline
          preload="metadata"
          class="max-h-full max-w-full rounded-xl bg-black object-contain"
        />
        <img
          v-else-if="images[page]"
          :src="images[page]"
          :alt="`${selected.title} 第 ${page + 1} 页`"
          class="max-h-full max-w-full rounded-xl object-contain"
        />
        <img
          v-else-if="selected.coverImage"
          :src="selected.coverImage"
          :alt="selected.title"
          class="max-h-full max-w-full rounded-xl object-contain"
        />
        <div v-else class="grid h-[52vh] w-[min(320px,60%)] place-items-center rounded-xl px-6 text-center text-base font-medium leading-snug text-[#F5FBFF]" :style="{ background: toneOf(selected.id) }">
          没有源图与源片：{{ selected.title }}
        </div>

        <span v-if="paging" class="absolute right-8 top-8 rounded bg-[rgba(17,14,23,0.7)] px-1.5 py-0.5 text-sm font-semibold leading-4 tabular-nums text-[#F5FBFF]">
          {{ page + 1 }} / {{ images.length }}
        </span>
        <button
          v-if="paging && page > 0"
          class="absolute left-10 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-[rgba(17,14,23,0.6)] text-[#F5FBFF] transition-colors hover:bg-[rgba(17,14,23,0.8)]"
          aria-label="上一页（←）"
          title="上一页（←）"
          @click="goPage(page - 1)"
        >
          <IconChevronLeft :size="15" />
        </button>
        <button
          v-if="paging && page < images.length - 1"
          class="absolute right-10 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-[rgba(17,14,23,0.6)] text-[#F5FBFF] transition-colors hover:bg-[rgba(17,14,23,0.8)]"
          aria-label="下一页（→）"
          title="下一页（→）"
          @click="goPage(page + 1)"
        >
          <IconChevronRight :size="15" />
        </button>
      </div>

      <!-- 右栏 680px：即创给 476 是因为它只有一段提示词，我们的脚本与拆解都长，栏宽给足才不用来回滚 -->
      <aside class="flex h-full w-[min(680px,55vw)] shrink-0 flex-col bg-surface">
        <div class="flex shrink-0 items-start gap-3 px-5 pb-3 pt-5">
          <h2 class="min-w-0 flex-1 text-[15px] font-medium leading-6">{{ selected.title }}</h2>
          <a
            v-if="selected.url"
            :href="selected.url"
            target="_blank"
            rel="noopener"
            class="btn-ghost shrink-0 !px-2"
            title="打开原帖"
            aria-label="打开原帖"
          >
            <IconExternalLink :size="15" />
          </a>
          <button class="btn-ghost shrink-0 !px-2" aria-label="关闭详情（Esc）" title="关闭（Esc）" @click="emit('close')">
            <IconX :size="15" />
          </button>
        </div>

        <div ref="panelBody" class="modal-body min-h-0 px-5 pb-4">
          <slot name="meta" :page="page" :go-page="goPage" />
          <slot :page="page" :go-page="goPage" />
        </div>

        <div v-if="$slots.footer" class="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <slot name="footer" />
        </div>
      </aside>
    </div>
  </Teleport>
</template>
