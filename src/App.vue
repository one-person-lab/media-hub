<script setup lang="ts">
import { ref, computed, watch, provide } from 'vue'
import { dataError, isGuest, settingsPanel, guide, gotoStudio, isDemoSite, studioViewFromHash } from './data/store'
import SideNav from './components/SideNav.vue'
import AppBackdrop from './components/AppBackdrop.vue'
import SettingsModal from './components/SettingsModal.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import Toast from './components/Toast.vue'
import JobStatusPill from './components/JobStatusPill.vue'
import TopBarActions from './components/TopBarActions.vue'
import AuthModal from './components/AuthModal.vue'
import { confirmState, useConfirm } from './lib/useConfirm'
import { useGenerate } from './lib/useGenerate'
import { useTheme } from './lib/useTheme'
import { authOpen } from './lib/useAuth'
import { tabsOf } from './lib/nav'
import StationTabs from './components/StationTabs.vue'
import ChatView from './views/ChatView.vue'
import BoardView from './views/BoardView.vue'
import InspirationView from './views/InspirationView.vue'
import CollectGuideView from './views/CollectGuideView.vue'
import PluginView from './views/PluginView.vue'
import ViralView from './views/ViralView.vue'
import HistoryView from './views/HistoryView.vue'
import TopicsView from './views/TopicsView.vue'
import StudioView from './views/StudioView.vue'
import CalendarView from './views/CalendarView.vue'
import AccountsView from './views/AccountsView.vue'
import AnalyticsView from './views/AnalyticsView.vue'
import BenchmarksView from './views/BenchmarksView.vue'
import ProductsView from './views/ProductsView.vue'
import MaterialImagesView from './views/MaterialImagesView.vue'
import MaterialVideoView from './views/MaterialVideoView.vue'
import KnowledgeView from './views/KnowledgeView.vue'
import { CircleAlert as IconCircleAlert, Monitor as IconMonitor } from 'lucide-vue-next'

// 默认落地页 = 对话：打开就是一张输入框，一句话直接交给本机 Agent（2026-09-30）
// 五站流程的视图全留着，对话只是多出来的一个入口，不替掉任何一条链
// 视图 id 同时是 URL hash（#/viral）。gen:data 重写 generated.json 会让 Vite 整页 reload，
// 不写进地址栏的话每次刷新都被打回首页。
const views: Record<string, unknown> = {
  chat: ChatView,
  board: BoardView,
  products: ProductsView,
  'material-image': MaterialImagesView,
  'material-video': MaterialVideoView,
  knowledge: KnowledgeView,
  inspiration: InspirationView,
  'collect-guide': CollectGuideView,
  plugin: PluginView,
  viral: ViralView,
  history: HistoryView,
  topics: TopicsView,
  // 创作台按形态分两档页签，同一视图组件吃一个 form 参数（2026-11-04）
  'studio-image': StudioView,
  'studio-video': StudioView,
  benchmarks: BenchmarksView,
  calendar: CalendarView,
  accounts: AccountsView,
  analytics: AnalyticsView,
}

const viewFromHash = () => {
  // 只取第一段：#/studio-image/<选题短码> 的第二段归各视图自己管
  let id = location.hash.replace(/^#\/?/, '').split('/')[0]
  // 发布中心已并入发布日历（2026-09-24）：旧链接照落
  if (id === 'publish') return 'calendar'
  // 「动效」「方案库」不再是独立页（2026-10-28）：导出与套用方案都住进创作台
  // 创作台又分成图文/视频两档（2026-11-04）：带选题短码的链接按这条选题的形态归到对应那一档，地址栏跟着换
  if (id === 'studio' || id === 'studio-image' || id === 'studio-video' || id === 'motion' || id === 'playbooks') {
    const at = studioViewFromHash(id === 'studio-video' ? 'studio-video' : 'studio-image')
    if (id !== at) {
      const seg = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[1] || '')
      history.replaceState(null, '', seg ? `#/${at}/${seg}` : `#/${at}`)
      id = at
    }
  }
  // 「起步」不再是独立一站（2026-10-22）：向导搬进看板顶部那张卡
  if (id === 'start') return 'board'
  // 「设定」不再是独立一站（2026-11-02）：它是 00-定位.md 的残缺投影，正文都在知识库
  if (id === 'identity') return 'knowledge'
  if (!(id in views)) return landingView.value
  return id
}
// 演示站的落地页是看板：那一屏把「接下来做什么」摊得最全，对话在它上面本来就跑不动（要本机 Agent）
const landingView = computed(() => (isDemoSite.value ? 'board' : 'chat'))

const current = ref(viewFromHash())

// 第一次装机那一下：地址栏没指名去哪，就先落在看板——那张「把这台机器接上」的卡在最上面。
// 读数是异步来的，所以只认这一趟的第一次回复
const landed = ref(false)
watch(guide, (g) => {
  if (landed.value || !g) return
  landed.value = true
  if (!g.ok && !g.dismissed && !location.hash.replace(/^#\/?/, '')) current.value = 'board'
})

watch(current, (id) => {
  // 地址栏已停在这个视图（可能带着 #/studio-image/<选题短码>）就别动它，否则第二段被抹掉
  const at = !id || id === 'board' ? /^#?\/?$/ : new RegExp(`^#/${id}(/|$)`)
  if (!at.test(location.hash)) location.hash = `/${id}`
})

// 浏览器前进/后退与手改地址栏，以及右上角任务浮层跳回选题（#/studio-<形态>/<短码>）
window.addEventListener('hashchange', () => {
  current.value = viewFromHash()
})

// 内置生成的进度不只活在弹层里：右上角浮层常驻（状态在 useGenerate 模块级单例）
useGenerate()

// 主题单例（顶栏右侧只切深浅，全套配色在设置里；首屏预上色在 index.html 的内联脚本里）
useTheme()

// 侧边栏底部的「配置」面板（放在 store 里：起步向导也要把用户指到环境/自检那一屏）

const activeView = computed(() => views[current.value])
/** 两档创作页签共用一个视图，靠这个参数决定这一屏筛图文还是视频 */
const activeProps = computed<Record<string, unknown> | null>(() =>
  current.value === 'chat' ? { class: 'min-h-0 flex-1' }
    : current.value === 'studio-video' ? { form: 'video' as const }
      : current.value === 'studio-image' ? { form: 'image' as const }
        : null,
)
// 站内多页才出页签；hash 仍是子页 id，深链与前进后退照旧
const tabs = computed(() => tabsOf(current.value))
// 页头钉不钉：站内有页签时钉住的是页签行（选中那一项就是这一页的名字），页头不再多钉一行
provide('headerSticky', computed(() => !tabs.value))

const { settle: settleConfirm } = useConfirm()

// 数据断了那张卡上的「重试」：改坏的文件修好后点一下就能接着看，不用去敲命令
const reload = () => location.reload()
</script>

<template>
  <!--
    应用外壳（2026-10-23 重做）：灰画布 + 白侧栏 + 限宽内容列。
    整个视口不滚，只有主区滚；侧边栏固定，不跟着内容滑走。
  -->
  <div class="flex h-screen overflow-hidden bg-canvas">
    <!-- 整页背景点阵：鼠标推着走、滚动时窜一下，没人碰也自己慢慢游。
         绝对定位铺满外壳，侧栏与主区都要 relative 才压得住这一层。
         对话页给加强那档：这屏没有白卡压着，背景是唯一的动效。 -->
    <div class="app-bg pointer-events-none absolute inset-0 z-0" aria-hidden="true">
      <AppBackdrop :vivid="current === 'chat'" />
    </div>
    <SideNav :current="current" @select="current = $event" @open="settingsPanel = $event" />
    <main class="relative z-10 flex min-w-0 flex-1 flex-col overflow-y-auto">
      <!-- 对话页要占满整屏（输入框贴底、空态居中），所以这一列在它是「对话」时改成弹性列；
           其余各站保持普通块流，内容多长撑多长。 -->
      <div
        class="mx-auto w-full max-w-[1440px] px-8 pb-6"
        :class="current === 'chat' ? 'flex min-h-full flex-col' : ''"
      >
        <!-- 状态条在流内、页头之上：以前挂右上角 fixed，实测生成中会把看板页头三个按钮的点击全吃掉。
             只剩「数据断了」「生成进度」两条，都空时这层不留间距。
             授权失效不再铺一条横幅（2026-10-23 再收一刀）：侧栏底部「授权」按钮上的红点 + 悬停
             已经说清是哪几个号，授权页也逐号列着；横幅在每个页面顶上重复一遍，只是噪音。 -->
        <div class="flex shrink-0 flex-col gap-2 empty:hidden has-[>div]:mb-3 has-[>div]:pt-4">
          <!-- 演示那一屏要说清看到的是真东西的哪一半：站内这份是混排。
               游客那一屏不铺这条——他还没打算用这站，先告诉他「这是假的」只是噪音，
               真要写东西时按 401 弹登录就够了。回客户端的出口在侧栏底部，这里不再重复 -->
          <div v-if="isDemoSite && !isGuest" class="flex w-full items-center gap-2 text-sm text-ink-2">
            <IconMonitor :size="15" class="shrink-0" />
            <span>演示数据与真实数据混排，带「示例」的是演示</span>
          </div>
          <div v-if="dataError"
            class="flex w-full items-center gap-2 rounded-lg border border-line bg-red-50 px-3 py-1.5">
            <IconCircleAlert :size="15" class="shrink-0 text-red-700" />
            <div class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="text-sm font-medium text-ink">界面数据断了 · {{ dataError.error }}</span>
              <span v-if="dataError.action" class="min-w-0 truncate text-sm text-red-800">{{ dataError.action }}</span>
            </div>
            <button class="btn shrink-0 !px-2.5 !py-1 !text-sm" @click="reload">重试</button>
          </div>
          <JobStatusPill @open-topic="gotoStudio" />
        </div>
        <!-- 深浅切换与账号钉在页头那一行：这一层高度为 0，按钮浮在内容列右上角，
             所以标题不必再为它让出一整行；外层不吃点击，只有按钮本身可点，
             不会再盖住页头右侧的动作按钮（那是以前挂 fixed 时踩过的坑）。 -->
        <div class="pointer-events-none sticky top-0 z-50 h-0 shrink-0">
          <div class="pointer-events-auto absolute right-0 top-4">
            <TopBarActions />
          </div>
        </div>
        <StationTabs v-if="tabs" :items="tabs" :current="current" @select="current = $event" />
        <component
          :is="activeView"
          :key="current"
          v-bind="activeProps"
          @go="current = $event"
        />
      </div>
    </main>
    <SettingsModal v-if="settingsPanel" :panel="settingsPanel" @close="settingsPanel = null" />
    <AuthModal v-if="authOpen" @close="authOpen = false" />
    <ConfirmModal v-if="confirmState" @settle="settleConfirm" />
    <Toast />
  </div>
</template>
