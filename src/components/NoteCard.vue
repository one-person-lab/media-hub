<script setup lang="ts">
/** 收集站五页 + 创作台共用的封面卡（即创素材库数值）：封面铺满整卡、底沿渐变压标题与点赞、
 *  hover 从底沿滑出操作条。卡面常驻只有左上状态芯片（chip 槽）与右上形态芯片，动作都在操作条里。
 *  #foot 是标题行上面那一行小读数（创作台拿它报排期与进度），没有它渐变就是原来的 88px。
 *  排布是瀑布流：封面按原图比例出，不裁成定比，所以卡片高度天然不齐。 */
import { computed, ref, watch } from 'vue'
import { toneOf } from '../data/store'
import CardChip from './CardChip.vue'
import { Flame as IconFlame, Image as IconImage, Images as IconImages, Play as IconPlay } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** 无实图时色块封面的稳定种子（用卡片 id） */
  seed: string
  heading: string
  coverImage?: string
  /** video / image；空 = 形态未知，不出角标 */
  format?: string
  /** 图文的页数：多页用叠图图标，页数进悬浮文字 */
  pageCount?: number
  likes?: string | number | null
  /** 视频源片：hover 就静音循环播，移开回到封面帧 */
  videoUrl?: string
}>(), { coverImage: '', format: '', pageCount: 0, likes: null, videoUrl: '' })

defineEmits<{ click: [] }>()

/** 封面挂了（采集目录被挪走、图卡重渲换了文件名）退回色块：
 *  不修的话 <img> 塌成 0 高，整卡只剩底部那条渐变 */
const broken = ref(false)
/** 卡面到货没有：没到货时 <img> 高 0，卡片会塌成一条 2px 灰线——首屏那一批看着就像坏了 */
const loaded = ref(false)
watch(() => props.coverImage, () => {
  broken.value = false
  loaded.value = false
})
const cover = computed(() => (props.coverImage && !broken.value ? props.coverImage : ''))

const multiPage = computed(() => props.pageCount > 1)
const formatLabel = computed(() =>
  props.format === 'video' ? '视频' : props.format === 'image' ? (multiPage.value ? `图文 · ${props.pageCount} 页` : '图文') : '',
)

function hoverPlayIn(e: Event) {
  ;(e.target as HTMLVideoElement).play().catch(() => {})
}
function hoverPlayOut(e: Event) {
  const v = e.target as HTMLVideoElement
  v.pause()
  v.currentTime = 0
}
</script>

<template>
  <article
    class="group relative mb-3 block w-full cursor-pointer break-inside-avoid overflow-hidden rounded-xl border border-line bg-surface-2 transition-[border-color,box-shadow] duration-300 hover:border-line-strong"
    :style="!cover && { background: toneOf(seed) }"
    title="点开看详情"
    @click="$emit('click')"
  >
    <div v-if="cover && !loaded" class="cover-skeleton aspect-[3/4] w-full" />
    <img
      v-if="cover"
      :src="cover"
      :alt="heading"
      loading="lazy"
      class="block w-full object-cover"
      @load="loaded = true"
      @error="broken = true"
    />
    <!-- 色块大字走主题墨色：浅色主题那五档 tint 都是近白的淡色，钉死白字等于把标题抹掉 -->
    <div v-else class="flex aspect-[3/4] w-full items-center justify-center px-5 pb-14 pt-5 text-center text-base font-medium leading-snug text-ink">
      {{ heading }}
    </div>

    <video
      v-if="videoUrl"
      :src="videoUrl"
      muted
      loop
      playsinline
      preload="none"
      class="absolute inset-0 h-full w-full bg-black object-cover opacity-0 transition-opacity duration-150 group-hover:opacity-100"
      @mouseenter="hoverPlayIn"
      @mouseleave="hoverPlayOut"
    />
    <IconPlay
      v-if="format === 'video'"
      :size="28"
      class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[rgba(245,251,255,0.95)] drop-shadow-[0_1px_8px_rgba(0,0,0,0.6)] transition-opacity duration-150 group-hover:opacity-0"
    />

    <!-- 左上状态芯片 / 右上形态芯片：压在图上所以固定深底浅字，不跟主题
         （bg-black/xx 会被主题映射成 ink，暗色下翻成浅底；text-white 同理映射成 surface） -->
    <slot name="chip" />
    <CardChip v-if="formatLabel" at="right" :label="formatLabel">
      <IconPlay v-if="format === 'video'" :size="13" />
      <IconImages v-else-if="multiPage" :size="13" />
      <IconImage v-else :size="13" />
    </CardChip>

    <!-- 底沿渐变 + 32px 标题行（即创数值）：hover 一起淡出，把位置让给操作条。
         带 #foot（创作台的进度行）时渐变加高到 112px，标题行仍钉在最下沿，跨页对齐。 -->
    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-[1] mb-[-1px] h-[88px] bg-gradient-to-b from-[rgba(0,0,0,0)] to-[rgba(0,0,0,0.55)] opacity-100 transition-opacity delay-150 duration-150 group-hover:delay-0 group-hover:opacity-0" :class="$slots.foot && 'h-[112px]'" />
    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 mb-[-1px] flex flex-col gap-1 px-3 pb-3 opacity-100 transition-opacity delay-150 duration-150 group-hover:delay-0 group-hover:opacity-0">
      <div v-if="$slots.foot" class="flex items-center gap-2 text-[12px] leading-4 text-[rgba(245,251,255,0.82)] [text-shadow:0_0.5px_0.5px_rgba(0,0,0,0.35)]">
        <slot name="foot" />
      </div>
      <div class="flex items-center justify-end gap-3">
        <h3 class="min-w-0 flex-1 truncate text-[14px] font-normal leading-5 text-[#F5FBFF] [text-shadow:0_1.2px_2px_rgba(0,0,0,0.1)]" :title="heading">{{ heading }}</h3>
        <span v-if="likes" class="flex shrink-0 items-center gap-1 text-[14px] leading-[14px] tabular-nums text-[#F5FBFF] [text-shadow:0_0.5px_0.5px_rgba(0,0,0,0.2)]" title="点赞">
          <IconFlame :size="18" class="shrink-0 text-orange-400" />
          {{ likes }}
        </span>
      </div>
    </div>

    <!-- 即创 hover 是把卡片撑高露出操作条；瀑布流撑高会让整列重排抖一下，
         所以这里让操作条从底沿滑进来，盖住刚淡出的标题行——同样 300ms，列不动。
         没传 #actions 的卡（创作台整卡就是一个入口）不出这条，否则 hover 出一块空黑。 -->
    <div v-if="$slots.actions" class="absolute inset-x-0 bottom-0 z-20 flex h-24 translate-y-full items-end gap-2 bg-gradient-to-t from-[rgba(17,14,23,0.82)] via-[rgba(17,14,23,0.55)] to-transparent px-3 pb-3 transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] group-hover:translate-y-0">
      <slot name="actions" />
    </div>
  </article>
</template>
