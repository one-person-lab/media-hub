<script setup lang="ts">
import { computed } from 'vue'
import { covers } from '../data/store'
import { PhImage, PhQuestion, PhEye } from '@phosphor-icons/vue'

const items = computed(() => covers)

const STYLE_COLORS: Record<string, string> = {
  大字报: 'var(--color-neo-yellow)',
  白底黑字: 'var(--color-neo-green)',
  对比拼图: 'var(--color-neo-pink)',
  截图标注: 'var(--color-neo-blue)',
}
const toneOf = (s: string) => STYLE_COLORS[s] ?? 'var(--color-neo-purple)'
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-4">
      <h2 class="flex items-center gap-2 text-2xl font-black">
        <PhImage :size="22" weight="bold" class="shrink-0" />
        封面参考
        <span class="text-sm font-bold text-neutral-400">{{ items.length }} 条</span>
      </h2>
      <span v-if="!items.length" class="neo-chip status-creating !text-xs">库已建好 · 等第一条</span>
    </div>

    <p class="px-1 text-sm leading-6 text-neutral-500">
      收集爆款封面的样式与结构——标题靠文案，点击靠封面。
      只收「<b>说得清为什么有点击率</b>」的封面；图片放 <code class="rounded bg-neo-yellow/60 px-1">public/covers/</code>。
    </p>

    <div v-if="items.length" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <div v-for="c in items" :key="c.id" class="flex flex-col gap-3 neo-card">
        <div class="overflow-hidden rounded-[6px] border-2 border-black bg-neo-bg" style="aspect-ratio: 3 / 4">
          <img v-if="c.image" :src="c.image" :alt="c.title" class="h-full w-full object-cover" />
          <div v-else class="flex h-full flex-col items-center justify-center gap-2 text-neutral-400">
            <PhImage :size="36" weight="bold" />
            <span class="text-xs font-bold">未配图</span>
          </div>
        </div>

        <div class="font-black">{{ c.title }}</div>

        <div class="flex flex-wrap gap-1.5">
          <span v-if="c.style" class="neo-chip !px-1.5 !py-0.5 !text-[10px]" :style="{ background: toneOf(c.style) }">{{ c.style }}</span>
          <span v-if="c.scene" class="neo-chip !px-1.5 !py-0.5 !text-[10px]">{{ c.scene }}</span>
          <span v-if="c.source" class="neo-chip !px-1.5 !py-0.5 !text-[10px]">{{ c.source }}</span>
        </div>

        <p v-if="c.why" class="flex items-start gap-1.5 text-xs leading-5 text-neutral-600">
          <PhEye :size="13" weight="bold" class="mt-0.5 shrink-0" />
          {{ c.why }}
        </p>
      </div>
    </div>

    <div v-else class="neo-card flex flex-col items-center gap-2 py-12 text-center">
      <PhQuestion :size="40" weight="bold" class="text-neutral-300" />
      <p class="text-sm font-bold text-neutral-500">还没有封面条目</p>
      <p class="max-w-md text-xs leading-5 text-neutral-400">
        刷到值得记的封面时：截图存进 <code>public/covers/</code>，在
        <code>content/自媒体运营/封面参考/</code> 建一个 md 按模板填好——工作台会自动收进来。
      </p>
    </div>

    <p class="px-1 text-xs text-neutral-400">
      建档规范见 <code>content/自媒体运营/封面参考/README.md</code>。数量预期 10–20 条，宁缺毋滥。
    </p>
  </div>
</template>
