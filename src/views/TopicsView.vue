<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { topics, accounts, holdSelfWrite, openTopicHome, originCardOf, playbookPick } from '../data/store'
import type { Reading, TopicCard, ViralItem } from '../data/store'
import SearchField from '../components/SearchField.vue'
import FilterSelect from '../components/FilterSelect.vue'
import NoteCard from '../components/NoteCard.vue'
import CardChip from '../components/CardChip.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import type { DrawerItem } from '../components/DetailDrawer.vue'
import TopicDetail from '../components/TopicDetail.vue'
import PlaybookPickerModal from '../components/PlaybookPickerModal.vue'
import { useToast } from '../lib/useToast'
import { ArrowRight as IconArrowRight, Check as IconCheck, CircleAlert as IconCircleAlert, CircleX as IconCircleX, Flame as IconFlame, Layers as IconLayers, LoaderCircle as IconLoaderCircle, Sparkles as IconSparkles, Trash2 as IconTrash2 } from 'lucide-vue-next'

const emit = defineEmits<{ go: [id: string] }>()

/** 选题池：收进来之后判一条、立一单。默认只看「待创作」（还能动的），
 *  已经立项的照得到——它们住在创作台，这里点卡片直接跳过去。 */
const NO_PRODUCT = '__none'
const q = ref('')
const fStage = ref('待创作')
const fProduct = ref('')
const fFormat = ref('')
const fPlatform = ref('')

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
const stageOptions = computed(() => {
  const order = ['待创作', '创作中', '待发布', '已发布']
  const got = uniq(topics.map((t) => t.status))
  return [...order.filter((s) => got.includes(s)), ...got.filter((s) => !order.includes(s))]
})
const productOptions = computed(() => uniq(topics.map((t) => t.product)))
const platformOptions = computed(() => uniq(accounts.map((a) => a.platform)))
const formatOptions = [
  { value: '', label: '全部形式' },
  { value: 'image', label: '图文' },
  { value: 'video', label: '视频' },
]
const productFilterOptions = computed(() => [
  { value: '', label: '全部品牌' },
  ...productOptions.value.map((p) => ({ value: p, label: p })),
  { value: NO_PRODUCT, label: '不挂品牌' },
])
const platformFilterOptions = computed(() => [
  { value: '', label: '全部平台' },
  ...platformOptions.value.map((p) => ({ value: p, label: p })),
])

const filtering = computed(() => !!(q.value || fProduct.value || fFormat.value || fPlatform.value) || fStage.value !== '待创作')
function clearFilters() {
  q.value = ''
  fStage.value = '待创作'
  fProduct.value = ''
  fFormat.value = ''
  fPlatform.value = ''
}

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return topics.filter(
    (t) =>
      (!fStage.value || t.status === fStage.value) &&
      (!fProduct.value || (fProduct.value === NO_PRODUCT ? !t.product : t.product === fProduct.value)) &&
      (!fFormat.value || t.format === fFormat.value) &&
      (!fPlatform.value || t.platforms.includes(fPlatform.value)) &&
      (!kw || `${t.title} ${t.source} ${t.product}`.toLowerCase().includes(kw)),
  )
})
const countOfStage = (s: string) => topics.filter((t) => t.status === s).length

/** 封面、源图与源片都长在来源采集卡上：选题卡自己只有文字，卡墙要有脸就得回认那一张。
 *  两条采集线的源片字段名不同（灵感卡 videoUrl / 爆款卡 videoFile），这里统一成一个。 */
const originOf = (t: TopicCard) => originCardOf(t.sourceFile)
const originVideo = (src: Reading | ViralItem | null) =>
  !src ? '' : 'videoUrl' in src ? src.videoUrl : src.videoFile

/** 回认一次，卡墙与抽屉共用同一份 */
const cards = computed(() =>
  shown.value.map((t) => {
    const src = originOf(t)
    return { t, coverImage: src?.coverImage || '', images: src?.images || [], videoUrl: originVideo(src) }
  }),
)

function openCard(t: TopicCard) {
  if (t.status === '待创作') openId.value = t.id
  else openTopicHome(t.id)
}

/* 方案库住在选题这一屏：先定「按哪条结构讲」，再立项（2026-10-28 从创作台挪过来） */
const pickerOpen = ref(false)
if (playbookPick.value) {
  playbookPick.value = false
  pickerOpen.value = true
}
const reloadPage = () => location.reload()

/* ==================== 详情：整屏抽屉（壳见 DetailDrawer），正文与历史共用 TopicDetail ==================== */

const openId = ref<string | null>(null)
const selected = computed(() => topics.find((t) => t.id === openId.value) || null)
/** 抽屉的右栏只在选中时有内容，槽里直接取这一份，省得每段都判空 */
const cur = computed(() => selected.value as TopicCard)
const curImages = computed(() => cards.value.find((c) => c.t.id === openId.value)?.images || [])

const drawerItems = computed<DrawerItem[]>(() =>
  cards.value.map((c) => ({
    id: c.t.id,
    title: c.t.title,
    url: c.t.sourceUrl,
    coverImage: c.coverImage,
    images: c.images,
    videoUrl: c.videoUrl,
  })),
)

/* ---------- 触底加载：与灵感库同一档，一次铺 24 张 ---------- */
const PAGE = 24
const limit = ref(PAGE)
const loadingMore = ref(false)
const visible = computed(() => cards.value.slice(0, limit.value))
const hasMore = computed(() => cards.value.length > limit.value)
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
watch(cards, () => (limit.value = PAGE))
onMounted(() => {
  io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '320px' })
  if (sentinelEl.value) io.observe(sentinelEl.value)
})
onBeforeUnmount(() => io?.disconnect())

const { toast } = useToast()

/** 已授权平台 = config/accounts.json，送去创作一次给全部平台各出一版 */
const allPlatforms = accounts.map((a) => a.platform)

function promote(card: TopicCard) {
  holdSelfWrite()
  fetch('/__topic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel: `content/${card.file}`, platforms: allPlatforms }),
  })
    .then((r) => r.json())
    .then((o) => {
      if (!o.ok) return toast(o.error || '送去创作失败')
      const made = o.drafts.filter((d: { skipped?: string }) => !d.skipped).length
      toast(`已创建 ${made} 份稿件`)
      openId.value = null
    })
}

function discard(card: TopicCard) {
  fetch(`/__topic?file=${encodeURIComponent(`content/${card.file}`)}`, { method: 'DELETE' })
    .then((r) => r.json())
    .then((o) => {
      toast(o.ok ? '已淘汰归档，判据留痕可复盘' : o.error || '失败')
      if (o.ok) openId.value = null
    })
}
</script>

<template>
  <div class="flex flex-col">
    <!-- 吸顶头与灵感库同一条（样式在 style.css 的 .station-toolbar）：第一行搜索与套用方案，第二行左阶段右细筛 -->
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜标题、来源、品牌" label="搜索选题" />
        <button
          class="btn-ghost ml-auto shrink-0 !px-2"
          aria-label="套用方案"
          title="套用方案"
          @click="pickerOpen = true"
        >
          <IconLayers :size="15" class="shrink-0" />
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex flex-wrap items-center gap-1">
          <button
            v-for="s in stageOptions"
            :key="s"
            class="seg"
            :class="fStage === s ? 'is-selected' : ''"
            :title="s === '待创作' ? '还能立项的' : '已经立过单，点卡片跳创作台'"
            @click="fStage = s"
          >
            {{ s }} <span class="font-medium tabular-nums">{{ countOfStage(s) }}</span>
          </button>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <FilterSelect v-model="fProduct" placeholder="品牌" :options="productFilterOptions" />
          <FilterSelect v-model="fFormat" placeholder="形式" :options="formatOptions" />
          <FilterSelect v-model="fPlatform" placeholder="平台" :options="platformFilterOptions" />
          <button v-if="filtering" class="btn-ghost !px-2" aria-label="清除筛选" title="清除筛选" @click="clearFilters">
            <IconCircleX :size="15" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="!shown.length && filtering" class="py-16 text-center text-sm text-ink-2">
      这个组合下没有选题——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="clearFilters">清掉筛选</button>
      看全部。
    </p>
    <p v-else-if="!shown.length" class="py-16 text-center text-sm text-ink-2">
      还没有选题——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="emit('go', 'inspiration')">去灵感库挑</button>
      或
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="emit('go', 'viral')">去爆款采集挑</button>。
    </p>

    <!-- 封面墙：卡面与 hover 动效都在 NoteCard；选题卡自己的脸是来源采集卡的封面 -->
    <div v-if="shown.length" class="columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5">
      <NoteCard
        v-for="{ t, coverImage, images, videoUrl } in visible"
        :key="t.id"
        :seed="t.id"
        :heading="t.title"
        :cover-image="coverImage"
        :format="t.format"
        :page-count="images.length"
        :likes="t.likes"
        :video-url="videoUrl"
        :title="t.status === '待创作' ? '点开看拆解与操作' : '已立项 · 去创作台'"
        @click="openCard(t)"
      >
        <template #chip>
          <CardChip v-if="t.analysis" label="来源采集卡已按五层框架拆解"><IconCheck :size="13" /></CardChip>
          <CardChip v-else-if="t.sourceFile" tone="warn" label="来源采集卡还没有 analysis 块"><IconCircleAlert :size="13" /></CardChip>
        </template>
        <template #actions>
          <button
            v-if="t.status !== '待创作'"
            class="btn-ai h-11 min-w-0 flex-1"
            :title="`去${t.status === '创作中' ? '创作台' : '发布链路'}接着做这条`"
            @click.stop="openTopicHome(t.id)"
          >
            <IconArrowRight :size="18" class="shrink-0" />
            去{{ t.status === '创作中' ? '创作台' : '发布' }}接着做
          </button>
          <template v-else>
            <button
              class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[rgba(255,255,255,0.12)] text-[#F5FBFF] transition-colors duration-300 hover:bg-[rgba(255,255,255,0.22)]"
              title="淘汰归档：不删文件，卡片留痕可复盘"
              aria-label="淘汰归档"
              @click.stop="discard(t)"
            >
              <IconTrash2 :size="22" />
            </button>
            <button
              class="btn-ai h-11 min-w-0 flex-1"
              :title="`为 ${allPlatforms.join('、')} 各建一份稿，建完这条从选题库收起`"
              @click.stop="promote(t)"
            >
              <IconSparkles :size="18" class="shrink-0" />
              送去创作
            </button>
          </template>
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

  <!-- ============ 详情：整屏抽屉，正文（脚本/源图/拆解/判据）与历史同一屏 ============ -->
  <DetailDrawer
    :items="drawerItems"
    :current="openId || ''"
    label="选题详情"
    @select="(id) => (openId = id)"
    @close="openId = null"
  >
    <template #meta>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
        <span class="flex items-center gap-1 tabular-nums text-ink" :title="`来源爆款：点赞 ${cur.likes || '无'} · 收藏 ${cur.collects || '无'} · 评论 ${cur.comments || '无'}`">
          <IconFlame :size="15" class="shrink-0 text-orange-400" />
          依据热度 {{ cur.likes || '—' }}
        </span>
        <span>{{ cur.status }}</span>
        <span>{{ cur.product || '人格内容 · 不挂品牌' }}</span>
        <span v-if="cur.platforms.length">{{ cur.platforms.join('、') }}</span>
      </div>
    </template>

    <template #default="{ page, goPage }">
      <TopicDetail :topic="cur" :images="curImages" :page="page" :go-page="goPage" />
    </template>

    <template #footer>
      <button class="btn-ghost shrink-0 !h-11 !w-11 !px-0 !text-red-600" title="淘汰归档：不删文件，卡片归档留痕，复盘可查当初为什么淘汰" aria-label="淘汰归档" @click="discard(cur)">
        <IconTrash2 :size="18" />
      </button>
      <button class="btn-ai h-11 min-w-0 flex-1" :title="`为 ${allPlatforms.join('、')} 各建一份稿，建完这条从选题库收起`" @click="promote(cur)">
        <IconArrowRight :size="18" class="shrink-0" />
        送去创作
      </button>
    </template>
  </DetailDrawer>

  <!-- 生成完回选题列表看一眼：整页刷一次才读得到刚落盘的那条（自动刷新被这一单挂住了） -->
  <PlaybookPickerModal v-if="pickerOpen" @close="pickerOpen = false" @go-studio="pickerOpen = false; reloadPage()" />
</template>
