<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { lastViralAt, viral, PLATFORM_META, openTopicHome, holdSelfWrite, isRemote } from '../data/store'
import type { ViralItem } from '../data/store'
import SearchField from '../components/SearchField.vue'
import FilterSelect from '../components/FilterSelect.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import NoteCard from '../components/NoteCard.vue'
import CardChip from '../components/CardChip.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import type { DrawerItem } from '../components/DetailDrawer.vue'
import CaptureDetail from '../components/CaptureDetail.vue'
import type { CaptureSource } from '../components/CaptureDetail.vue'
import ClientOnly from '../components/ClientOnly.vue'
import ViralScopeModal from '../components/ViralScopeModal.vue'
import ViralSearchModal from '../components/ViralSearchModal.vue'
import CloneViralModal from '../components/CloneViralModal.vue'
import CloneSkinModal from '../components/CloneSkinModal.vue'
import { useGenerate } from '../lib/useGenerate'
import { useToast } from '../lib/useToast'
import { Check as IconCheck, CircleAlert as IconCircleAlert, CircleX as IconCircleX, Copy as IconCopy, Flame as IconFlame, Images as IconImages, LoaderCircle as IconLoaderCircle, SlidersHorizontal as IconSlidersHorizontal, Star as IconStar, Trash2 as IconTrash2, WandSparkles as IconWandSparkles } from 'lucide-vue-next'

const { toast } = useToast()
const goHistory = () => (location.hash = '#/history')

/** 采集口径弹窗：口径是低频配置，页面只摆一个按钮，不常驻版面 */
const scopeOpen = ref(false)

/** 搜爆款：现输关键词搜一轮，人挑中的那几条直接落进这一页 */
const searchOpen = ref(false)
function onSearchDone(saved: number) {
  searchOpen.value = false
  toast(`已收进 ${saved} 条`, 'ok')
}

/* 内置拆解：chat 模型直接按五层框架拆脚本并写回卡；复制提示词降为备用入口 */
const gen = useGenerate()
function runTeardown(v: ViralItem) {
  gen.teardown(`content/${v.file}`).then((e) => e && toast(e))
}

/** 用过的卡不进工作列表（选题才是它们现在的家），回看走收集站的「历史」 */
const pool = computed(() => viral.filter((v) => !v.convertedTopic))
/** 平台分组：池子里只有一类时不出下拉——一排只有一个选项的筛选是噪声 */
const platforms = computed(() => [...new Set(pool.value.map((v) => v.platform))])
const labelOf = (p: string) => PLATFORM_META[p]?.label ?? p

/* ---------- 筛选与排序：与灵感库同一套读数口径 ---------- */
const q = ref('')
const sort = ref<'rec' | 'new' | 'hot'>('rec')
const sorts = [
  { id: 'rec' as const, label: '推荐' },
  { id: 'new' as const, label: '最新' },
  { id: 'hot' as const, label: '热度' },
]
const plat = ref('')
const platOptions = computed(() => [
  { value: '', label: '全部平台' },
  ...(platforms.value.length > 1 ? platforms.value.map((p) => ({ value: p, label: `${labelOf(p)} ${pool.value.filter((v) => v.platform === p).length}`, logo: labelOf(p) })) : []),
])
const fmt = ref('')
const fmtOptions = [
  { value: '', label: '全部类型' },
  { value: 'image', label: '图文' },
  { value: 'video', label: '视频' },
]
/** 时间比发布日期（笔记 ID 前 8 位推算），采集日只说明我们什么时候看见它 */
const days = ref('')
const dayOptions = [
  { value: '', label: '全部时间' },
  { value: '3', label: '近3天' },
  { value: '7', label: '近7天' },
  { value: '30', label: '近30天' },
]
function publishedWithin(v: ViralItem, n: number) {
  const t = Date.parse(v.publishedAt || '')
  return Number.isFinite(t) && Date.now() - t <= n * 864e5
}

const filterOn = computed(() => !!(plat.value || fmt.value || days.value || q.value))
function clearFilters() {
  plat.value = ''
  fmt.value = ''
  days.value = ''
  q.value = ''
}

/** 互动分（赞1/藏2/评3）由 build-data 算好写在卡上，界面不再自己折字符串——
 *  两处各折一遍，采集线的 Top 和这里的「热度」排序就会对不上。 */
function heatOf(v: ViralItem) {
  return v.heat || 0
}

/** 视频时长读数，跟素材库视频分区同一写法（1:09） */
const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const rows = pool.value.filter((v) => {
    if (plat.value && v.platform !== plat.value) return false
    if (fmt.value && v.format !== fmt.value) return false
    if (days.value && !publishedWithin(v, Number(days.value))) return false
    if (kw && !`${v.title} ${v.author} ${v.keyword}`.toLowerCase().includes(kw)) return false
    return true
  })
  if (sort.value === 'hot') return [...rows].sort((a, b) => heatOf(b) - heatOf(a))
  if (sort.value === 'new') return [...rows].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
  return rows
})

/* ---------- 详情：整屏抽屉（壳见 DetailDrawer） ---------- */
const openId = ref<string | null>(null)
const selected = computed(() => viral.find((v) => v.id === openId.value) || null)
/** 抽屉的右栏只在选中时有内容，槽里直接取这一份，省得每段都判空 */
const cur = computed(() => selected.value as ViralItem)

const drawerItems = computed<DrawerItem[]>(() =>
  shown.value.map((v) => ({
    id: v.id,
    title: v.title,
    url: v.url,
    coverImage: v.coverImage,
    images: v.images,
    videoUrl: v.videoFile,
  })),
)

/** 右栏那一屏怎么分块，全站只在 CaptureDetail 一处说 */
const curSource = computed<CaptureSource>(() => {
  const v = cur.value
  return { desc: v.desc, tags: v.tags, script: v.script, images: v.images, analysis: v.analysis, analyzedAt: v.analyzedAt }
})

/** 一键同款弹层：盖在详情抽屉上，抽屉换到别条才收起 */
const cloneFor = ref<string | null>(null)
const skinFor = ref<string | null>(null)
watch(openId, (id) => {
  if (id !== cloneFor.value) cloneFor.value = null
  if (id !== skinFor.value) skinFor.value = null
})

/** 卡上的「一键同款」：先把这条摊开，再盖上复刻流程 */
function openClone(v: ViralItem) {
  if (!v.script) return
  openId.value = v.id
  cloneFor.value = v.id
}

/** 收皮：把这条爆款的配色和排法收进图文模板候选。跟「一键同款」是两件事——
 *  那条搬内容，这条搬视觉，所以两个按钮各走各的弹层，不合成一个「克隆」。 */
function openSkin(v: ViralItem) {
  if (!v.images.length) return
  openId.value = v.id
  skinFor.value = v.id
}
function onSkinSaved() {
  skinFor.value = null
  toast('已收进图文模板的候选', 'ok')
}

/* ---------- 触底加载：与灵感库同一档，一次铺 24 张 ---------- */
const PAGE = 24
const limit = ref(PAGE)
const loadingMore = ref(false)
const visible = computed(() => shown.value.slice(0, limit.value))
const hasMore = computed(() => shown.value.length > limit.value)
const sentinelEl = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
function loadMore() {
  if (!hasMore.value || loadingMore.value) return
  loadingMore.value = true
  setTimeout(() => {
    limit.value += PAGE
    loadingMore.value = false
  }, 250)
}
watch(sentinelEl, (el) => el && io?.observe(el))
watch(shown, () => (limit.value = PAGE))
onMounted(() => {
  io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '320px' })
  if (sentinelEl.value) io.observe(sentinelEl.value)
})
onBeforeUnmount(() => io?.disconnect())

function createDraft(v: ViralItem) {
  holdSelfWrite()
  fetch('/__topic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: v.title, fromKind: 'viral', from: v.title, sourceRel: v.file }),
  })
    .then((r) => r.json())
    .then((o) => {
      if (!o.ok) return toast(o.error || '失败')
      toast('已加入选题池，这条从采集列表收起（文件保留，可回链溯源）')
      openId.value = null
    })
}

/** 星标＝收下这条：已立项的直接带去它的家，人不在采集页原地打转 */
function starNote(v: ViralItem) {
  if (v.convertedTopic) return openTopicHome(v.convertedTopic)
  createDraft(v)
}

/** 删除＝归档：卡片文件移进 爆款采集/归档/<平台>/，封面与源片留着；采集线认归档，删过的不会再被定时任务采回来 */
function removeViral(v: ViralItem) {
  holdSelfWrite()
  fetch(`/__viral?file=${encodeURIComponent(`content/${v.file}`)}`, { method: 'DELETE' })
    .then((r) => r.json())
    .then((o) => {
      if (!o.ok) return toast(o.error || '失败')
      toast('已删除，不再出现在列表里')
      openId.value = null
    })
}

/** 补采脚本：不经 Agent，直接触发本机采集链路——缺源料先拉 ego 回详情页搬源料，再本机 OCR/转写写回卡 */
const scriptBusy = ref('')
function captureScript(v: ViralItem) {
  if (scriptBusy.value) return
  scriptBusy.value = v.id
  fetch('/__script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: `content/${v.file}` }),
  })
    .then((r) => r.json())
    .then((o) => toast(o.ok ? `已出稿 ${o.chars} 字` : `出稿失败：${o.error || '服务未就绪'}`, o.ok ? 'ok' : 'fail'))
    .catch(() => toast('出稿失败：服务未就绪', 'fail'))
    .finally(() => (scriptBusy.value = ''))
}

/** 拆解提示词：输入是卡里已有的完整脚本，五层结论写回 analysis:（口径在 Knowledge/爆款拆解.md） */
function teardownPrompt(v: ViralItem): string {
  return [
    `你是这个自媒体仓库的创作助手。当前工作目录 = media-hub 仓库根。`,
    ``,
    `任务：拆解这条爆款采集卡，把结论写回卡片本身。`,
    `- 采集卡：content/${v.file}`,
    `- 原笔记：${v.url || '见卡片 frontmatter 的 url'}`,
    ``,
    `步骤：`,
    `1. 先读 content/Knowledge/爆款拆解.md（拆解框架与写回格式）和 content/Knowledge/00-定位.md（判断主题能不能平移到我们）。`,
    `2. 卡里没脚本就不许拆——拆的输入必须是「## 脚本」段的完整脚本，逐条对着脚本拆，不要凭标题推断内容。`,
    `3. 按框架逐层拆：每层一句话、30 字内，只写「下次怎么用」的结论——③结构写页序规律不逐页复述、⑤机制写收藏型还是传播型不抄数字，这条爆款还靠别的成立的（证据链、时效）补在那一层里，不许写"内容不错"这种废话。`,
    `4. 把五层结论写回采集卡 frontmatter 的 analysis: 块（why/subject/hook/structure/emotion/mechanism），加 analyzedAt: 今天日期。写完即可——工作台会自动刷新。`,
  ].join('\n')
}

async function copyTeardown(v: ViralItem) {
  try {
    await navigator.clipboard.writeText(teardownPrompt(v))
    toast('已复制拆解提示词', 'ok')
  } catch {
    toast('复制失败，请手动选择文本', 'fail')
  }
}
</script>

<template>
  <div class="flex flex-col">
    <!-- 吸顶头与灵感库同一条（样式在 style.css 的 .station-toolbar）：第一行搜索与两个动作，第二行左排序右筛选 -->
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜标题、作者、关键词" label="搜索爆款采集卡" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <!-- 这一格是「搜爆款」：现输关键词搜一轮、人挑中哪几条才落卡。定时的爆款采集归「采集条件」 -->
          <ClientOnly v-if="isRemote" :what="'搜爆款'" />
          <button v-else class="btn-ghost !px-2" aria-label="搜爆款" title="搜爆款" @click="searchOpen = true">
            <IconFlame :size="15" />
          </button>
          <!-- 口径是低频配置：一个按钮弹窗改（平台/关键词/门槛），不常驻版面 -->
          <button class="btn-ghost !px-2" aria-label="采集条件" title="采集条件" @click="scopeOpen = true">
            <IconSlidersHorizontal :size="15" />
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex flex-wrap items-center gap-1">
          <button
            v-for="s in sorts"
            :key="s.id"
            class="seg"
            :class="sort === s.id && 'is-selected'"
            @click="sort = s.id"
          >{{ s.label }}</button>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <FilterSelect v-if="platOptions.length > 1" v-model="plat" placeholder="平台" :options="platOptions" />
          <FilterSelect v-model="fmt" placeholder="类型" :options="fmtOptions" />
          <FilterSelect v-model="days" placeholder="时间" :options="dayOptions" />
          <button v-if="filterOn" class="btn-ghost !px-2" aria-label="清除筛选" title="清除筛选" @click="clearFilters">
            <IconCircleX :size="15" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="!shown.length && filterOn" class="py-16 text-center text-sm text-ink-2">
      没有符合筛选的卡片——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="clearFilters">清掉筛选</button>
      看全部。
    </p>
    <p v-else-if="!shown.length && !pool.length && viral.length" class="py-16 text-center text-sm text-ink-2">
      爆款采集都选过了，用过的都在历史里——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="goHistory">去历史看</button>。
    </p>
    <p v-else-if="!shown.length" class="py-16 text-center text-sm text-ink-2">
      还没有爆款卡片，点右上角搜爆款。
    </p>

    <!-- 封面墙：卡面与 hover 动效都在 NoteCard，这一层只管瀑布流排布 -->
    <div v-if="shown.length" class="columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5">
      <NoteCard
        v-for="v in visible"
        :key="v.id"
        :seed="v.id"
        :heading="v.title"
        :cover-image="v.coverImage"
        :format="v.format"
        :page-count="v.images.length"
        :likes="v.likes"
        :video-url="v.videoFile"
        @click="openId = v.id"
      >
        <template #chip>
          <CardChip v-if="v.analysis" label="已拆解"><IconCheck :size="13" /></CardChip>
          <CardChip v-else-if="!v.script" tone="warn" label="这条还没有脚本"><IconCircleAlert :size="13" /></CardChip>
        </template>
        <template #actions>
          <button
            class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[rgba(255,255,255,0.12)] text-[#F5FBFF] transition-colors duration-300 hover:bg-[rgba(255,255,255,0.22)]"
            :title="v.convertedTopic ? '已在选题库' : '星标收进选题库'"
            :aria-label="v.convertedTopic ? '已在选题库' : '收进选题库'"
            @click.stop="starNote(v)"
          >
            <IconStar :size="22" />
          </button>
          <button
            class="btn-ai h-11 min-w-0 flex-1"
            :disabled="!v.script"
            :title="v.script ? '一键同款' : '这条还没有脚本'"
            @click.stop="openClone(v)"
          >
            <IconWandSparkles :size="18" class="shrink-0" />
            一键同款
          </button>
        </template>
      </NoteCard>
    </div>

    <!-- 触底哨兵：常驻不消失，滚到这里就再铺一批 -->
    <div ref="sentinelEl" class="flex h-12 items-center justify-center">
      <span v-if="loadingMore" class="flex items-center gap-2 text-sm text-ink-3">
        <IconLoaderCircle :size="15" class="animate-spin" />
        加载中
      </span>
    </div>
  </div>

  <!-- ============ 详情：整屏抽屉，拆解/补采/入池/克隆都在这一屏原地做 ============ -->
  <DetailDrawer
    :items="drawerItems"
    :current="openId || ''"
    label="爆款采集卡详情"
    @select="(id) => (openId = id)"
    @close="openId = null"
  >
    <template #meta>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
        <span class="flex items-center gap-1 tabular-nums text-ink" :title="`点赞 ${cur.likes || '无'} · 收藏 ${cur.collects || '无'} · 评论 ${cur.comments || '无'}`">
          <IconFlame :size="15" class="shrink-0 text-orange-400" />
          {{ cur.likes || '—' }} 赞<template v-if="cur.collects"> · {{ cur.collects }} 藏</template><template v-if="cur.comments"> · {{ cur.comments }} 评</template>
        </span>
        <span v-if="cur.durationSec" class="tabular-nums">{{ fmtDur(cur.durationSec) }}</span>
        <span>{{ cur.author || '未知作者' }}</span>
        <span class="flex items-center gap-1.5"><PlatformLogo :platform="labelOf(cur.platform)" :size="14" />{{ labelOf(cur.platform) }}</span>
        <span :title="`采集于 ${cur.capturedAt}`">发布 {{ cur.publishedAt }}</span>
        <span v-if="cur.keyword">关键词「{{ cur.keyword }}」</span>
      </div>
    </template>

    <template #default="{ page, goPage }">
      <CaptureDetail
        :source="curSource"
        :page="page"
        :script-busy="scriptBusy === cur.id"
        :teardown-busy="gen.runningKind.value === 'teardown'"
        @refresh-script="captureScript(cur)"
        @teardown="runTeardown(cur)"
        @go-page="goPage"
      >
        <template #tools>
          <button class="btn-ghost !px-1.5" :disabled="gen.busy.value" aria-label="复制拆解提示词" title="复制拆解提示词" @click="copyTeardown(cur)">
            <IconCopy :size="15" />
          </button>
        </template>
      </CaptureDetail>
    </template>

    <template #footer>
      <button class="btn-ghost shrink-0 !h-11 !w-11 !px-0 !text-red-600" title="删除这条采集卡：卡片归档留痕，封面与源片保留" aria-label="删除这条采集卡" @click="removeViral(cur)">
        <IconTrash2 :size="18" />
      </button>
      <button
        class="btn shrink-0 !h-11 !w-11 !px-0"
        :class="cur.convertedTopic && '!border-amber-400 !text-amber-500'"
        :title="cur.convertedTopic ? '已在选题库' : '星标收进选题库'"
        :aria-label="cur.convertedTopic ? '已在选题库' : '收进选题库'"
        @click="starNote(cur)"
      >
        <IconStar :size="18" />
      </button>
      <button class="btn-ai h-11 min-w-0 flex-1" :disabled="!cur.script" :title="cur.script ? '一键同款' : '这条还没有脚本'" @click="openClone(cur)">
        <IconWandSparkles :size="18" class="shrink-0" />
        一键同款
      </button>
      <button
        class="btn shrink-0 !h-11 !px-3"
        :disabled="!cur.images.length"
        :title="cur.images.length ? '收这条的配色和排法' : '这条没图'"
        @click="openSkin(cur)"
      >
        <IconImages :size="15" class="shrink-0" />
        收进模板库
      </button>
    </template>
  </DetailDrawer>

  <!-- ============ 搜爆款：临时关键词搜一轮，挑中的落进这一页 ============ -->
  <ViralSearchModal v-if="searchOpen" @close="searchOpen = false" @done="onSearchDone" />

  <!-- ============ 采集口径弹窗：平台/关键词/门槛在这改，保存写回 config/viral.json ============ -->
  <ViralScopeModal v-if="scopeOpen" scope="viral" :run-at="lastViralAt" @close="scopeOpen = false" />

  <!-- ============ 一键同款：挂产品 → 生成 → 预览 → 进创作台，全程盖在详情抽屉上 ============ -->
  <CloneViralModal
    v-if="selected && cloneFor === selected.id"
    :source="{ file: `content/${selected.file}`, title: selected.title, platform: labelOf(selected.platform) }"
    @close="cloneFor = null"
  />

  <!-- ============ 收皮：读这条爆款的页图取色与排法，存成图文模板候选 ============ -->
  <CloneSkinModal
    v-if="selected && skinFor === selected.id"
    :shots="selected.images"
    :source="{ title: selected.title, platform: labelOf(selected.platform), noteId: selected.id }"
    @close="skinFor = null"
    @saved="onSkinSaved"
  />
</template>
