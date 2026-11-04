<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Landing } from '../data/store'
import { Check as IconCheck, ChevronDown as IconChevronDown, Link as IconLink } from 'lucide-vue-next'

const props = defineProps<{ landing?: Landing }>()

const open = ref(false)
const copied = ref('')
/** 点开才列的那几行：主链接在最前，平台按各自口径排后面 */
const rows = computed(() => {
  const l = props.landing
  if (!l) return []
  const out: { key: string; label: string; note: string; url: string }[] = []
  if (l.primary) out.push({ key: 'primary', label: '主链接', note: '不带平台参数', url: l.primary })
  for (const [pf, v] of Object.entries(l.byPlatform || {})) {
    out.push({ key: pf, label: pf, note: v.placement || '', url: v.url || '' })
  }
  return out
})
const count = computed(() => rows.value.length)
/** 收起时给一眼最有用的信息：有几个平台的链接可拿 */
const summary = computed(() => {
  const plats = rows.value.filter((r) => r.key !== 'primary').length
  return plats ? `${plats} 个平台` : '通用'
})

async function copy(text: string, key: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
    setTimeout(() => { if (copied.value === key) copied.value = '' }, 1500)
  } catch {}
}
</script>

<template>
  <!-- 一排 5 颗平台名 + 主链接，等于把「拿哪条链接」这道题摊在版面上让人数着点。
       收进一颗「推广链接」：点开才列平台，每行一句口径 + 一键复制（GPT 第 11 轮判 2）。 -->
  <div v-if="count" class="relative flex flex-wrap items-center gap-x-1 text-sm">
    <button class="btn-ghost !px-2 !py-0.5" :title="`这条稿子的推广链接：${summary}`" @click="open = !open">
      <IconLink :size="13" class="-mt-px inline-block shrink-0" />
      推广链接
      <span class="text-ink-3">{{ summary }}</span>
      <IconChevronDown :size="13" class="shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <template v-if="open">
      <div class="fixed inset-0 z-20" @click="open = false" />
      <div class="absolute bottom-full left-0 z-30 mb-1 w-72 rounded-lg border border-line bg-surface p-1.5 shadow-neo">
        <button v-for="r in rows" :key="r.key" class="btn-ghost !justify-start !px-2 !py-1 text-sm"
          :title="r.url ? '复制这一条' : '这条没有链接'" :disabled="!r.url" @click="copy(r.url, r.key)">
          <IconCheck v-if="copied === r.key" :size="13" class="shrink-0" />
          <span class="w-16 shrink-0 text-left">{{ r.label }}</span>
          <span class="min-w-0 flex-1 truncate text-left text-ink-3">{{ r.note || r.url }}</span>
        </button>
      </div>
    </template>
  </div>
</template>
