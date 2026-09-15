<script setup lang="ts">
import { computed } from 'vue'
import { benchmarks } from '../data/store'
import {
  PhUsersThree, PhNote, PhVideoCamera, PhArrowSquareOut, PhLightbulb, PhChartLineUp,
} from '@phosphor-icons/vue'

const PLATFORM_ICON: Record<string, unknown> = {
  小红书: PhNote,
  抖音: PhVideoCamera,
}

const items = computed(() => benchmarks)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-4">
      <h2 class="flex items-center gap-2 text-2xl font-black">
        <PhUsersThree :size="22" weight="bold" class="shrink-0" />
        对标账号
        <span class="text-sm font-bold text-neutral-400">{{ items.length }} 个</span>
      </h2>
      <span class="neo-chip status-creating !text-xs">骨架已立 · 数据待采集</span>
    </div>

    <p class="px-1 text-sm leading-6 text-neutral-500">
      同赛道创作者的数据与打法，给选题和复盘一个外部参照系。数据只记实测值——
      用 <code class="rounded bg-neo-yellow/60 px-1">npm run collect</code> 的同款方式（ego-browser）采集后追加进「数据快照」。
    </p>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div v-for="b in items" :key="b.id" class="flex flex-col gap-3 neo-card">
        <div class="flex items-center gap-2">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black text-black"
            :style="{ background: b.platform === '抖音' ? 'var(--color-neo-blue)' : 'var(--color-neo-pink)' }"
          >
            <component :is="PLATFORM_ICON[b.platform] ?? PhUsersThree" :size="14" weight="bold" />
          </span>
          <span class="font-black">{{ b.nickname }}</span>
          <span class="neo-chip !px-1.5 !py-0.5 !text-[10px]">{{ b.platform }}</span>
          <a
            v-if="b.url"
            :href="b.url"
            target="_blank"
            class="ml-auto flex items-center gap-1 text-xs font-bold text-neutral-400 hover:text-black"
          >
            <PhArrowSquareOut :size="13" weight="bold" class="shrink-0" />
            主页
          </a>
        </div>

        <div class="text-sm font-bold">{{ b.position }}</div>
        <p class="text-xs leading-5 text-neutral-500">{{ b.why }}</p>

        <div class="rounded-[4px] border-2 border-dashed border-neutral-300 bg-neo-bg/60 p-3">
          <div class="mb-1.5 flex items-center gap-1.5 text-xs font-black text-neutral-500">
            <PhChartLineUp :size="13" weight="bold" class="shrink-0" />
            数据快照
          </div>
          <div v-if="b.snapshots.length" class="flex flex-col gap-1">
            <div v-for="(s, i) in b.snapshots" :key="i" class="text-xs font-bold text-neutral-600">{{ s }}</div>
          </div>
          <div v-else class="text-xs font-bold text-neutral-400">还没有快照——采集一次加一行</div>
        </div>

        <div v-if="b.patterns.length">
          <div class="mb-1.5 flex items-center gap-1.5 text-xs font-black text-neutral-500">
            <PhLightbulb :size="13" weight="bold" class="shrink-0" />
            值得偷的模式
          </div>
          <ul class="flex flex-col gap-1.5">
            <li v-for="(p, i) in b.patterns" :key="i" class="text-xs leading-5 text-neutral-600">· {{ p }}</li>
          </ul>
        </div>
      </div>
    </div>

    <p class="px-1 text-xs text-neutral-400">
      建档规范见 <code>content/自媒体运营/对标账号/README.md</code>：一个博主一个文件，frontmatter 存元数据，快照只记实测值。
    </p>
  </div>
</template>
