<script setup lang="ts">
import { ref } from 'vue'
import { PhLinkSimple, PhCheck, PhCopy } from '@phosphor-icons/vue'
import type { Landing } from '../data/store'

defineProps<{ landing?: Landing }>()

const copied = ref('')
async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
    setTimeout(() => { if (copied.value === key) copied.value = '' }, 1500)
  } catch {}
}
</script>

<template>
  <div
    v-if="landing && (landing.primary || Object.keys(landing.byPlatform).length)"
    class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[6px] border-2 border-dashed border-neutral-300 bg-neo-bg/60 px-2 py-1.5 text-xs"
  >
    <span class="flex shrink-0 items-center gap-1 font-bold text-neutral-500">
      <PhLinkSimple :size="12" weight="bold" class="shrink-0" />
      落地链接
    </span>
    <span v-if="landing.campaign" class="shrink-0 text-neutral-400">归因 {{ landing.campaign }}</span>

    <button
      v-for="(v, pf) in landing.byPlatform"
      :key="pf"
      class="neo-btn !px-2 !py-0.5 !text-[11px]"
      :title="v.url"
      @click="copy(v.url, pf)"
    >
      <PhCheck v-if="copied === pf" :size="11" weight="bold" class="shrink-0" />
      <PhCopy v-else :size="11" weight="bold" class="shrink-0" />
      {{ pf }}{{ v.placement ? ' · ' + v.placement : '' }}
    </button>

    <button
      v-if="landing.primary"
      class="neo-btn !px-2 !py-0.5 !text-[11px]"
      title="主落地链接（不带平台参数）"
      @click="copy(landing.primary, 'primary')"
    >
      <PhCheck v-if="copied === 'primary'" :size="11" weight="bold" class="shrink-0" />
      <PhCopy v-else :size="11" weight="bold" class="shrink-0" />
      主链接
    </button>
  </div>
</template>
