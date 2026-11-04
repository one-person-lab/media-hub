<script setup lang="ts">
/** 从爆款收进来：把采集回来的图文爆款按互动分排好，勾几条就逐条读皮存成候选模板。
 *  一条一条串行跑（读图 + 存盘 + 补小样都在本机），进度只报「收到第几条」，不写教程。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PLATFORM_META, absorbBroadcasts, viral, type ViralItem } from '../data/store'
import { countText } from '../utils/count'
import { harvestPool, harvestOne } from '../lib/harvestTemplates'
import { Flame as IconFlame, Images as IconImages, LoaderCircle as IconLoaderCircle, X as IconX } from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'close'): void; (e: 'done', saved: number, dup: number): void }>()

const labelOf = (p: string) => PLATFORM_META[p]?.label ?? p
/** 这一轮里已确认「库里已有同皮同排法」的笔记：先从池子里摘掉，别让人对着同一批勾第二遍 */
const covered = ref<string[]>([])
const pool = computed(() => harvestPool(viral).filter((v) => !covered.value.includes(v.id)))
const picked = ref<string[]>([])

/** 批量收编一条引出两三次重建（存皮 + 渲小样），几十条串下来广播能排一分钟；
 *  开着这一屏时把广播吸成就地换表，否则第一条收完页面就整页刷掉，进度挂不上（2026-11-04 实测）。 */
let releaseAbsorb: (() => void) | null = null

onMounted(() => {
  releaseAbsorb = absorbBroadcasts()
  picked.value = pool.value.slice(0, 6).map((v) => v.id)
})
onBeforeUnmount(() => {
  releaseAbsorb?.()
  releaseAbsorb = null
})

function toggle(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

const rows = computed(() => pool.value.slice(0, 40))
const chosen = computed(() => pool.value.filter((v) => picked.value.includes(v.id)))

const running = ref(false)
const step = ref('')
const err = ref('')
const doneCount = ref(0)
/** 库里已有同皮同排法的条数：收不进来但不是错，得跟「收进来几条」分开报 */
const dupCount = ref(0)

async function run() {
  if (running.value || !chosen.value.length) return
  running.value = true
  err.value = ''
  doneCount.value = 0
  dupCount.value = 0
  const list: ViralItem[] = [...chosen.value]
  for (const [i, v] of list.entries()) {
    step.value = `正在收第 ${i + 1}/${list.length} 条`
    try {
      const r = await harvestOne(v, labelOf)
      if (r.duplicate) {
        dupCount.value++
        covered.value = [...covered.value, v.id]
      } else {
        doneCount.value++
      }
    } catch (e) {
      err.value = `第 ${i + 1} 条没收进来：${String((e as Error).message || e)}`
      break
    }
  }
  step.value = ''
  running.value = false
  emit('done', doneCount.value, dupCount.value)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !running.value) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-dialog="'从爆款收进来'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="!running && emit('close')" />
    <div class="card modal-card relative z-10 max-w-2xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div class="flex items-center gap-2 text-sm font-medium">
          <IconFlame :size="15" />
          从爆款收进来
          <span class="text-ink-3">· 按互动分排</span>
        </div>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body p-5">
        <p v-if="!rows.length" class="rounded-bento border border-line bg-surface px-6 py-10 text-center">
          <IconImages :size="28" class="mx-auto text-ink-3" />
          <span class="mt-3 block text-sm text-ink-2">采集回来的图文爆款都收过了</span>
        </p>

        <ul v-else class="flex flex-col divide-y divide-line rounded-inset border border-line">
          <li v-for="v in rows" :key="v.id">
            <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left" @click="toggle(v.id)">
              <input
                type="checkbox"
                class="h-3.5 w-3.5 shrink-0 accent-accent"
                :checked="picked.includes(v.id)"
                @click.stop="toggle(v.id)"
              />
              <img :src="v.coverImage" :alt="v.title" class="h-12 w-9 shrink-0 rounded border border-line object-cover" loading="lazy" />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="truncate text-sm text-ink">{{ v.title }}</span>
                <span class="truncate text-aux text-ink-3">
                  {{ labelOf(v.platform) }} · {{ v.images.length }} 页 · {{ v.publishedAt }}
                </span>
              </span>
              <span class="shrink-0 text-right font-metric text-aux tabular-nums text-ink-2">
                {{ countText(v.likes) || '—' }} 赞<template v-if="v.comments"> · {{ countText(v.comments) }} 评</template>
              </span>
            </button>
          </li>
        </ul>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <button class="btn btn-primary !px-3 !py-1.5 flex items-center gap-1.5" :disabled="running || !picked.length" @click="run">
          <IconLoaderCircle v-if="running" :size="13" class="animate-spin" />
          {{ running ? step : `收进来 ${picked.length} 条` }}
        </button>
        <span v-if="err" class="min-w-0 flex-1 truncate text-sm font-medium text-red-600">{{ err }}</span>
        <span v-else-if="!running && dupCount" class="min-w-0 flex-1 truncate text-sm text-ink-3">库里已有 {{ dupCount }} 条同皮同排法</span>
      </div>
    </div>
  </div>
</template>
