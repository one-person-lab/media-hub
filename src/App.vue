<script setup lang="ts">
import { ref, computed } from 'vue'
import SideNav from './components/SideNav.vue'
import SettingsModal from './components/SettingsModal.vue'
import BoardView from './views/BoardView.vue'
import HomeView from './views/HomeView.vue'
import InspirationView from './views/InspirationView.vue'
import TopicsView from './views/TopicsView.vue'
import PublishView from './views/PublishView.vue'
import CalendarView from './views/CalendarView.vue'
import AnalyticsView from './views/AnalyticsView.vue'
import BenchmarksView from './views/BenchmarksView.vue'
import CoversView from './views/CoversView.vue'

// 默认落地页 = 内容看板：一屏看到内容卡在哪个阶段
const current = ref('board')
// 侧边栏底部的「配置 / 数据」面板
const panel = ref<'config' | 'data' | null>(null)

const views: Record<string, unknown> = {
  board: BoardView,
  home: HomeView,
  inspiration: InspirationView,
  topics: TopicsView,
  benchmarks: BenchmarksView,
  publish: PublishView,
  calendar: CalendarView,
  covers: CoversView,
  analytics: AnalyticsView,
}

const activeView = computed(() => views[current.value])
</script>

<template>
  <!--
    应用外壳：整个视口不滚，只有主区滚。
    以前用 min-h-screen，整页一起滚 → 侧边栏跟着内容滑走，像个网页 poc。
    h-screen + overflow-hidden 把滚动锁在 main 里，侧边栏就固定住了。
  -->
  <div class="flex h-screen gap-6 overflow-hidden p-6">
    <SideNav :current="current" @select="current = $event" @open="panel = $event" />
    <main class="min-w-0 flex-1 overflow-y-auto">
      <component :is="activeView" @go="current = $event" />
    </main>
    <SettingsModal v-if="panel" :panel="panel" @close="panel = null" />
  </div>
</template>
