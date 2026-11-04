<script lang="ts">
import type { ReadingAnalysis } from '../data/store'

/** 右栏摊开的那一份采集内容：灵感库（Reading）与爆款采集（ViralItem）各映射进来，分块排法只住这一处。
 *  标题在抽屉头部、原片在中间那一栏，这里不重复摆。 */
export interface CaptureSource {
  /** 发布时那篇正文（详情页读回来的原话） */
  desc: string
  /** 原笔记自带话题，空格分隔 */
  tags: string
  /** 完整脚本：图文＝逐页图内文字，视频＝全程口播逐字稿 */
  script: string
  images: string[]
  analysis: ReadingAnalysis | null
  analyzedAt: string | null
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ANALYSIS_SECTIONS } from '../data/store'
import RichText from './RichText.vue'
import { ChevronDown as IconChevronDown, LoaderCircle as IconLoaderCircle, RefreshCw as IconRefreshCw } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    source: CaptureSource
    page?: number
    scriptBusy?: boolean
    teardownBusy?: boolean
  }>(),
  { page: 0, scriptBusy: false, teardownBusy: false },
)
const emit = defineEmits<{
  (e: 'refresh-script'): void
  (e: 'teardown'): void
  (e: 'go-page', i: number): void
}>()

const why = computed(() => props.source.analysis?.why || '')
const tags = computed(() =>
  (props.source.tags || '').split(/[\s,，]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
)
/** 正文里话题写成「#名字[话题]#」，芯片已经列过一遍，这里只留作者自己写的那句话 */
const descText = computed(() => {
  let out = (props.source.desc || '').replace(/#[^#\s]*?\[话题\]#?/g, '')
  for (const t of tags.value) out = out.split(`#${t}`).join('')
  return out.replace(/[ \t]+\n/g, '\n').trim()
})

/** 长文先折一屏：右栏第一屏要给「为什么火」和这段是什么，不是先读完一篇长文 */
const FOLD = 240
const expanded = ref(false)
const foldable = computed(() => props.source.script.length > FOLD)
watch(() => props.source.script, () => (expanded.value = false))

/** 正文比脚本更容易长（抖音一条能写上千字），四行封顶 */
const descOpen = ref(false)
const descFoldable = computed(() => descText.value.length > 120)
watch(descText, () => (descOpen.value = false))
</script>

<template>
  <div class="mt-4">
    <!-- 一句话为什么火 -->
    <p v-if="why" class="rounded-lg border border-line bg-accent-soft px-3.5 py-3 text-[15px] font-medium leading-6 text-ink">
      {{ why }}
    </p>

    <!-- 发布文案：作者在详情页写下的那一段，连自带的话题一起 -->
    <section v-if="descText || tags.length" class="mt-4">
      <h3 class="text-aux font-medium text-ink-3">{{ descText ? '发布文案' : '话题' }}</h3>
      <p
        v-if="descText"
        class="mt-1.5 whitespace-pre-line break-words text-sm leading-6 text-ink-2"
        :class="!descOpen && descFoldable && 'line-clamp-4'"
      >
        {{ descText }}
      </p>
      <button
        v-if="descFoldable"
        class="btn-ghost mt-1 !px-0 text-sm"
        :aria-label="descOpen ? '收起正文' : '展开正文'"
        @click="descOpen = !descOpen"
      >
        {{ descOpen ? '收起' : '展开' }}
        <IconChevronDown :size="15" class="transition-transform" :class="descOpen && 'rotate-180'" />
      </button>
      <div v-if="tags.length" class="mt-2 flex flex-wrap gap-1.5">
        <span v-for="t in tags" :key="t" class="chip">#{{ t }}</span>
      </div>
    </section>

    <!-- 原文脚本：拆解与创作的唯一材料 -->
    <section class="mt-4">
      <div class="flex items-center gap-2">
        <h3 class="text-aux font-medium text-ink-3">原文脚本</h3>
        <span v-if="source.script" class="ml-auto text-aux tabular-nums text-ink-3">{{ source.script.length }} 字</span>
        <button
          class="btn-ghost !px-1.5"
          :class="!source.script && 'ml-auto'"
          :disabled="scriptBusy"
          aria-label="重新生成脚本"
          title="重新生成脚本"
          @click="emit('refresh-script')"
        >
          <IconLoaderCircle v-if="scriptBusy" :size="15" class="animate-spin" />
          <IconRefreshCw v-else :size="15" />
        </button>
      </div>
      <div v-if="source.script" class="relative mt-1.5">
        <div class="overflow-hidden rounded-lg border border-line bg-surface-2 px-3.5 py-3" :class="!expanded && foldable && 'max-h-36'">
          <RichText :text="source.script" class="text-ink-2" />
        </div>
        <div v-if="!expanded && foldable" class="pointer-events-none absolute inset-x-0 bottom-0 h-14 rounded-b-lg bg-gradient-to-t from-surface-2 to-transparent" />
      </div>
      <div v-else class="mt-1.5 h-14 rounded-lg border border-dashed border-line-strong" />
      <button
        v-if="foldable"
        class="btn-ghost mt-1 !px-0 text-sm"
        :aria-label="expanded ? '收起脚本' : '展开全文脚本'"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全文' }}
        <IconChevronDown :size="15" class="transition-transform" :class="expanded && 'rotate-180'" />
      </button>
    </section>

    <!-- 逐页源图：点一张，中间那一栏换过去 -->
    <section v-if="source.images.length > 1" class="mt-4">
      <div class="flex items-baseline gap-2">
        <h3 class="text-aux font-medium text-ink-3">逐页源图</h3>
        <span class="ml-auto text-aux tabular-nums text-ink-3">{{ source.images.length }} 页</span>
      </div>
      <div class="mt-2 flex gap-2 overflow-x-auto pb-1">
        <button
          v-for="(img, i) in source.images"
          :key="img"
          class="h-16 w-12 shrink-0 overflow-hidden rounded-md border transition-colors"
          :class="i === page ? 'border-accent' : 'border-line hover:border-line-strong'"
          :title="`第 ${i + 1} 页`"
          :aria-label="`中间看第 ${i + 1} 页`"
          @click="emit('go-page', i)"
        >
          <img :src="img" :alt="`第 ${i + 1} 页`" loading="lazy" class="h-full w-full object-cover" />
        </button>
      </div>
    </section>

    <!-- 爆款拆解：五层结论 -->
    <section v-if="source.analysis" class="mt-4">
      <div class="flex items-baseline gap-2">
        <h3 class="text-aux font-medium text-ink-3">爆款拆解</h3>
        <span v-if="source.analyzedAt" class="ml-auto text-aux tabular-nums text-ink-3">{{ source.analyzedAt }}</span>
      </div>
      <dl class="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2.5 text-sm">
        <template v-for="sec in ANALYSIS_SECTIONS" :key="sec.key">
          <dt class="text-ink-2">{{ sec.label }}</dt>
          <dd class="leading-6 text-ink">{{ source.analysis![sec.key] }}</dd>
        </template>
      </dl>
    </section>
    <section v-else-if="source.script" class="mt-4">
      <div class="flex items-center gap-2">
        <h3 class="text-aux font-medium text-ink-3">爆款拆解</h3>
        <slot name="tools" />
        <button class="btn ml-auto" :disabled="teardownBusy" title="拆解这条爆款" @click="emit('teardown')">
          <IconLoaderCircle v-if="teardownBusy" :size="15" class="animate-spin" />
          {{ teardownBusy ? '拆解中…' : '拆解' }}
        </button>
      </div>
    </section>
  </div>
</template>
