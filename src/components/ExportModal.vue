<script setup lang="ts">
/** 图卡出口：渲好的 PNG 直接下载。视频不在这里——它是创作台里的一个页签，不是每次导出都要做的事。 */
import { computed } from 'vue'
import { Download as IconDownload, X as IconX } from 'lucide-vue-next'

const props = defineProps<{ slug: string; title: string; images: string[] }>()
const emit = defineEmits<{ close: [] }>()

const pageCount = computed(() => props.images.length)

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
window.addEventListener('keydown', onEsc)
</script>

<template>
  <div v-dialog="'导出'" class="modal modal--center" @click.self="emit('close')">
    <div class="card modal-card max-w-3xl">
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm text-ink-3">导出</div>
          <div class="truncate text-sm text-ink">{{ title || slug }} · {{ pageCount }} 页图卡</div>
        </div>
        <button class="btn shrink-0 !px-2 !py-1" aria-label="关闭（Esc）" title="关闭（Esc）" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body flex flex-col gap-5 overflow-y-auto p-5">
        <section>
          <h3 class="flex items-baseline justify-between text-sm font-medium text-ink">
            图卡 PNG
            <span class="text-sm font-normal text-ink-3">{{ pageCount }} 张 · 1242 × 1660</span>
          </h3>
          <div class="mt-2.5 flex gap-2.5 overflow-x-auto">
            <a
              v-for="(u, i) in images" :key="u" :href="u" :download="`${slug}-${String(i + 1).padStart(2, '0')}.png`"
              class="group relative shrink-0" title="下载这一页"
            >
              <img :src="u" :alt="`第 ${i + 1} 页`" class="h-28 w-20 rounded-md border border-line bg-canvas object-cover object-top" loading="lazy" />
              <span class="absolute inset-0 flex items-center justify-center rounded-md bg-ink/0 text-surface opacity-0 transition group-hover:bg-ink/45 group-hover:opacity-100">
                <IconDownload :size="15" />
              </span>
            </a>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
