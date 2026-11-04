<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { navItems, navOf, type NavItem } from '../lib/nav'
import { loginAlerts, clientDownloadUrl } from '../data/store'
import { KeyRound as IconKeyRound, MonitorDown as IconMonitorDown, PanelLeft as IconPanelLeft, Settings as IconSettings } from 'lucide-vue-next'

const props = defineProps<{ current: string }>()
defineEmits<{ (e: 'select', id: string): void; (e: 'open', panel: 'config'): void }>()

// 侧栏只列「站」，站内的页在页顶用页签切（见 lib/nav.ts）
const activeId = computed(() => navOf(props.current)?.id)

/** 授权不在「发布」站里（那一屏只摆接下来发什么），入口在底部这个按钮上；
 *  所以浮层被关掉后的兜底红点也挂这里，号重新登上了自己消失。 */
const authPlatforms = computed(() => loginAlerts.value.flatMap((g) => g.items.map((i) => i.label)))

/** 按分组标签切行：组变了插一行标签，没写 group 的（AI 助手）不插 */
const rows = computed(() => {
  const out: ({ kind: 'label'; text: string } | { kind: 'item'; item: NavItem })[] = []
  let last: string | undefined
  for (const item of navItems) {
    if (item.group && item.group !== last) out.push({ kind: 'label', text: item.group })
    last = item.group
    out.push({ kind: 'item', item })
  }
  return out
})

/* 收成图标栏：宽度让给主区的表格和视频预览；收法记本机，下次打开照旧 */
const collapsed = ref(localStorage.getItem('sidenav-collapsed') === '1')
watch(collapsed, (v) => localStorage.setItem('sidenav-collapsed', v ? '1' : '0'))

/** 图标按钮的名字一律靠悬浮气泡报出来（折叠态整条都是图标）。原生 title 要悬停一秒才出、
 *  样式也不跟主题走；侧栏本身 overflow-hidden，所以气泡必须挂到 body 上才不被裁掉。 */
const tip = ref<{ text: string; x: number; y: number } | null>(null)
const showTip = (e: MouseEvent, text: string) => {
  const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
  tip.value = { text, x: b.right + 8, y: b.top + b.height / 2 }
}
const hideTip = () => (tip.value = null)
// 一滚动按钮就跑了，气泡跟不上，直接收掉
window.addEventListener('scroll', hideTip, true)
onBeforeUnmount(() => window.removeEventListener('scroll', hideTip, true))
</script>

<template>
  <!-- 侧栏（2026-11-01 照即创重做）：与内容之间**一条线都不画**，靠底色深浅和留白分层。
       200px 菜单列 + 16px 内缩、行高 40、圆角 10，图标一律 18px regular 且比文字更淡一档，
       字重、底色与填实图标只给选中项——即创那套「空气感」的来源。
       纯图标的入口（折叠态菜单项、底部三个工具）名字全走悬浮气泡。
       relative 是为了压在整页背景点阵之上——外壳传进来的 class 落不到这层，只能自己写。 -->
  <aside
    class="relative flex h-full shrink-0 flex-col overflow-hidden bg-surface transition-[width] duration-200 ease-out"
    :class="collapsed ? 'w-14' : 'w-[216px]'"
  >
    <!-- 品牌行：logo + 名称 -->
    <div class="flex h-14 shrink-0 items-center gap-2.5" :class="collapsed ? 'justify-center' : 'px-4'">
      <!-- 运行时取图：静态 src 会被 vite 构建期内联，改完 logo 不重启服务就看不到 -->
      <img :src="'/favicon.svg'" alt="" class="h-6 w-6 shrink-0" />
      <span v-if="!collapsed" class="min-w-0 flex-1 truncate text-sm font-medium tracking-wide text-ink">创作者增长平台</span>
    </div>

    <!-- 导航：分组之间靠留白与小号灰标签分开，不插横线，折叠态同理 -->
    <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-4" :class="collapsed && 'items-center px-0'">
      <template v-for="(row, i) in rows" :key="row.kind === 'item' ? row.item.id : `label-${i}`">
        <div v-if="row.kind === 'label'" :class="collapsed ? 'h-3 shrink-0' : 'px-3 pb-1.5 pt-5 text-xs font-normal tracking-[0.12em] text-ink-3/80'">
          <template v-if="!collapsed">{{ row.text }}</template>
        </div>
        <button
          v-else
          class="flex h-10 w-full items-center gap-2.5 rounded-[10px] border border-transparent text-left text-sm transition-colors duration-150"
          :class="[
            collapsed ? 'w-10 justify-center' : 'px-3',
            activeId === row.item.id
              ? 'is-selected'
              : 'font-normal text-ink-2 hover:bg-surface-2/70 hover:text-ink',
          ]"
          :aria-label="row.item.label"
          @mouseenter="collapsed && showTip($event, row.item.label)"
          @mouseleave="hideTip"
          @click="$emit('select', row.item.id)"
        >
          <component
            :is="row.item.icon"
            :size="18"
            :class="activeId === row.item.id ? 'shrink-0' : 'shrink-0 opacity-75'"
          />
          <span v-if="!collapsed" class="truncate">{{ row.item.label }}</span>
        </button>
      </template>
    </nav>

    <!-- 底部工具：伸缩开关守左端，其余靠右端；纯图标，名字走悬浮气泡，无文字、无上边线 -->
    <div
      class="flex shrink-0 pb-3 pt-1.5"
      :class="collapsed ? 'flex-col items-center gap-1 px-0' : 'items-center gap-1 px-2'"
    >
      <button
        class="btn-ghost !h-9 !w-9 !rounded-[10px] !px-0 !py-0"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        @mouseenter="showTip($event, collapsed ? '展开侧栏' : '收起侧栏')"
        @mouseleave="hideTip"
        @click="collapsed = !collapsed"
      >
        <IconPanelLeft :size="18" :class="collapsed && '-scale-x-100'" />
      </button>
      <div :class="collapsed ? 'flex items-center gap-1' : 'ml-auto flex items-center gap-1'">
        <button
          class="btn-ghost !h-9 !w-9 !rounded-[10px] !px-0 !py-0"
          aria-label="配置"
          @mouseenter="showTip($event, '配置')"
          @mouseleave="hideTip"
          @click="$emit('open', 'config')"
        >
          <IconSettings :size="18" />
        </button>
        <a
          v-if="clientDownloadUrl"
          class="btn-ghost !h-9 !w-9 !rounded-[10px] !px-0 !py-0"
          :href="clientDownloadUrl" target="_blank" rel="noopener"
          aria-label="下载客户端"
          @mouseenter="showTip($event, '下载客户端')"
          @mouseleave="hideTip"
        >
          <IconMonitorDown :size="18" />
        </a>
        <button
          class="btn-ghost relative !h-9 !w-9 !rounded-[10px] !px-0 !py-0"
          :class="[
            current === 'accounts' && 'bg-surface-2 text-ink',
            authPlatforms.length ? 'text-red-600 hover:text-red-700' : '',
          ]"
          :aria-label="authPlatforms.length ? '要重新授权' : '授权'"
          @mouseenter="showTip($event, authPlatforms.length ? `${authPlatforms.join('、')} 要重新授权` : '授权')"
          @mouseleave="hideTip"
          @click="$emit('select', 'accounts')"
        >
          <IconKeyRound :size="18" />
          <span
            v-if="authPlatforms.length"
            class="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-red-600 ring-2 ring-surface"
          />
        </button>
      </div>
    </div>
  </aside>

  <Teleport to="body">
    <div v-if="tip" class="nav-tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">{{ tip.text }}</div>
  </Teleport>
</template>
