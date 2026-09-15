<script setup lang="ts">
import {
  PhSun,
  PhKanban,
  PhLightbulb,
  PhTarget,
  PhUsersThree,
  PhRocketLaunch,
  PhCalendarDots,
  PhFrameCorners,
  PhChartLineUp,
  PhSparkle,
  PhGearSix,
  PhDatabase,
} from '@phosphor-icons/vue'

defineProps<{ current: string }>()
defineEmits<{ (e: 'select', id: string): void; (e: 'open', panel: 'config' | 'data'): void }>()

// 导航分组即流程阶段：总览 → ①收集 → ②立项 → ③发布 → ④复盘
// tone：图标色块背景。配色循环取自 style.css 的 @theme 令牌
const groups = [
  {
    title: '总览',
    items: [
      { id: 'board', label: '内容看板', icon: PhKanban, tone: 'bg-neo-pink' },
      { id: 'home', label: '今日工作台', icon: PhSun, tone: 'bg-neo-yellow' },
    ],
  },
  {
    title: '① 收集',
    items: [
      { id: 'inspiration', label: '灵感库', icon: PhLightbulb, tone: 'bg-neo-green' },
    ],
  },
  {
    title: '② 立项',
    items: [
      { id: 'topics', label: '选题库', icon: PhTarget, tone: 'bg-neo-yellow' },
      { id: 'benchmarks', label: '对标账号', icon: PhUsersThree, tone: 'bg-neo-blue' },
    ],
  },
  {
    title: '③ 发布',
    items: [
      { id: 'publish', label: '发布中心', icon: PhRocketLaunch, tone: 'bg-neo-blue' },
      { id: 'calendar', label: '发布日历', icon: PhCalendarDots, tone: 'bg-neo-purple' },
      { id: 'covers', label: '封面参考', icon: PhFrameCorners, tone: 'bg-neo-green' },
    ],
  },
  {
    title: '④ 复盘',
    items: [
      { id: 'analytics', label: '数据复盘', icon: PhChartLineUp, tone: 'bg-neo-green' },
    ],
  },
]
</script>

<template>
  <aside class="neo-card flex h-full w-60 shrink-0 flex-col p-4">
    <div class="mb-4 flex items-center gap-2 px-1">
      <span
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border-2 border-black bg-black text-[#ffe89b]"
      >
        <PhSparkle :size="16" weight="fill" />
      </span>
      <div class="text-xl font-black tracking-tight">自媒体工作台</div>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
      <template v-for="group in groups" :key="group.title">
        <div class="mt-3 px-2 text-xs font-bold text-neutral-500">{{ group.title }}</div>
        <button
          v-for="item in group.items"
          :key="item.id"
          class="flex items-center gap-2.5 rounded-[6px] border-2 px-2.5 py-2 text-left text-sm transition-colors"
          :class="
            current === item.id
              ? 'border-black bg-white font-black text-black shadow-neo-sm'
              : 'border-transparent font-bold hover:bg-neo-yellow/60'
          "
          @click="$emit('select', item.id)"
        >
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black text-black"
            :class="item.tone"
          >
            <component :is="item.icon" :size="13" weight="fill" />
          </span>
          <span>{{ item.label }}</span>
        </button>
      </template>
    </nav>

    <div class="mt-6 flex gap-2 border-t-2 border-dashed border-neutral-300 pt-4">
      <button class="neo-btn flex-1 px-2!" @click="$emit('open', 'config')">
        <PhGearSix :size="15" weight="bold" />
        配置
      </button>
      <button class="neo-btn flex-1 px-2!" @click="$emit('open', 'data')">
        <PhDatabase :size="15" weight="bold" />
        数据
      </button>
    </div>
  </aside>
</template>
