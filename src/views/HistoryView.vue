<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { topics, originCardOf, openTopicHome } from '../data/store'
import type { Reading, TopicCard, ViralItem } from '../data/store'
import SearchField from '../components/SearchField.vue'
import FilterSelect from '../components/FilterSelect.vue'
import NoteCard from '../components/NoteCard.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import type { DrawerItem } from '../components/DetailDrawer.vue'
import TopicDetail from '../components/TopicDetail.vue'
import { ArrowRight as IconArrowRight, CircleX as IconCircleX, Flame as IconFlame, LoaderCircle as IconLoaderCircle } from 'lucide-vue-next'

/** 历史 = 已经立项的内容现在的下落。灵感库与爆款采集都只留没选题的那部分，
 *  用过的从这里回看；一条选题只出现一次，封面、源图与源片都从它的来源采集卡带出来。 */

/** 来源采集卡归成三档，供筛选与卡面出处用 */
type Origin = 'favorite' | 'inspiration' | 'viral' | 'archived'
const originOf = (t: TopicCard): Reading | ViralItem | null => originCardOf(t.sourceFile)
const originOfCard = (src: Reading | ViralItem | null): Origin =>
  !src ? 'archived' : 'videoFile' in src ? 'viral' : src.source === 'favorite' ? 'favorite' : 'inspiration'
const ORIGIN_LABEL: Record<Origin, string> = {
  favorite: '灵感库 · 收藏',
  inspiration: '灵感库',
  viral: '爆款采集',
  archived: '来源卡已归档',
}
/** 两条采集线的源片字段名不同（灵感卡 videoUrl / 爆款卡 videoFile） */
const originVideo = (src: Reading | ViralItem | null) =>
  !src ? '' : 'videoUrl' in src ? src.videoUrl : src.videoFile

const q = ref('')
const fStage = ref('')
const fOrigin = ref('')
const fFormat = ref('')

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
/** 阶段的展示顺序照选题库；历史是回看，默认不筛，全阶段都在 */
const stageOptions = computed(() => {
  const order = ['待创作', '创作中', '待发布', '已发布']
  const got = uniq(entries.value.map((e) => e.t.status))
  return [...order.filter((s) => got.includes(s)), ...got.filter((s) => !order.includes(s))]
})
const originFilterOptions = computed(() => [
  { value: '', label: '全部来源' },
  ...(Object.keys(ORIGIN_LABEL) as Origin[]).map((k) => ({
    value: k,
    label: `${ORIGIN_LABEL[k]} ${entries.value.filter((e) => e.origin === k).length}`,
  })),
])
const formatOptions = [
  { value: '', label: '全部形式' },
  { value: 'image', label: '图文' },
  { value: 'video', label: '视频' },
]

const filtering = computed(() => !!(q.value || fOrigin.value || fStage.value || fFormat.value))
function clearFilters() {
  q.value = ''
  fOrigin.value = ''
  fStage.value = ''
  fFormat.value = ''
}

/** 一次回认，卡墙与抽屉共用同一份。
 *  采集卡的 converted 存的是选题 id（不是日期，见 build-data 的立项标记收敛），
 *  所以这一屏没有可靠的「立项日」读数，排序只能跟选题库一样按池子原序。 */
const entries = computed(() =>
  topics
    .filter((t) => t.sourceFile)
    .map((t) => {
      const src = originOf(t)
      return {
        t,
        origin: originOfCard(src),
        coverImage: src?.coverImage || '',
        images: src?.images || [],
        videoUrl: originVideo(src),
      }
    }),
)

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return entries.value.filter(
    (e) =>
      (!fOrigin.value || e.origin === fOrigin.value) &&
      (!fStage.value || e.t.status === fStage.value) &&
      (!fFormat.value || e.t.format === fFormat.value) &&
      (!kw || `${e.t.title} ${e.t.source} ${ORIGIN_LABEL[e.origin]}`.toLowerCase().includes(kw)),
  )
})
const countOfStage = (s: string) => entries.value.filter((e) => e.t.status === s).length

const openId = ref<string | null>(null)
const selected = computed(() => entries.value.find((e) => e.t.id === openId.value) || null)
/** 抽屉的右栏只在选中时有内容，槽里直接取这一份，省得每段都判空 */
const cur = computed(() => selected.value!.t)
const curImages = computed(() => selected.value?.images || [])

const drawerItems = computed<DrawerItem[]>(() =>
  shown.value.map((e) => ({
    id: e.t.id,
    title: e.t.title,
    url: e.t.sourceUrl,
    coverImage: e.coverImage,
    images: e.images,
    videoUrl: e.videoUrl,
  })),
)

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

/** 已立项的住在创作台，还挂在选题库的住在那儿——两处跳法不一样，openTopicHome 认这个 */
const jumpLabel = (t: TopicCard) => (t.status === '待创作' ? '去选题库看这条' : '去创作台接着做')
</script>

<template>
  <div class="flex flex-col">
    <!-- 吸顶头与灵感库同一条（样式在 style.css 的 .station-toolbar）：历史只看不改，所以第一行没有动作按钮 -->
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜标题、来源、出处" label="搜索历史" />
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex flex-wrap items-center gap-1">
          <button class="seg" :class="fStage === '' && 'is-selected'" @click="fStage = ''">
            全部 <span class="font-medium tabular-nums">{{ entries.length }}</span>
          </button>
          <button
            v-for="s in stageOptions"
            :key="s"
            class="seg"
            :class="fStage === s && 'is-selected'"
            @click="fStage = s"
          >
            {{ s }} <span class="font-medium tabular-nums">{{ countOfStage(s) }}</span>
          </button>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <FilterSelect v-model="fOrigin" placeholder="来源" :options="originFilterOptions" />
          <FilterSelect v-model="fFormat" placeholder="形式" :options="formatOptions" />
          <button v-if="filtering" class="btn-ghost !px-2" aria-label="清除筛选" title="清除筛选" @click="clearFilters">
            <IconCircleX :size="15" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="!shown.length && filtering" class="py-16 text-center text-sm text-ink-2">
      这个组合下没有记录——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="clearFilters">清掉筛选</button>
      看全部。
    </p>
    <p v-else-if="!shown.length" class="py-16 text-center text-sm text-ink-2">
      还没有选过的内容——在灵感库或爆款采集里「加入选题池」后会留在这里。
    </p>

    <!-- 封面墙：卡面数值与 hover 动效都在 NoteCard；历史卡的脸也是来源采集卡的脸 -->
    <div v-if="shown.length" class="columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5">
      <NoteCard
        v-for="e in visible"
        :key="e.t.id"
        :seed="e.t.id"
        :heading="e.t.title"
        :cover-image="e.coverImage"
        :format="e.t.format"
        :page-count="e.images.length"
        :likes="e.t.likes"
        :video-url="e.videoUrl"
        title="点开看当初的拆解与判据"
        @click="openId = e.t.id"
      >
        <template #chip>
          <span
            class="absolute left-3 top-3 rounded bg-[rgba(17,14,23,0.7)] px-1 py-0.5 text-sm font-semibold leading-4 text-[#F5FBFF]"
            :title="`立项自${ORIGIN_LABEL[e.origin]}`"
          >{{ e.t.status }}</span>
        </template>
        <template #actions>
          <button class="btn-ai h-11 min-w-0 flex-1" :title="jumpLabel(e.t)" @click.stop="openTopicHome(e.t.id)">
            <IconArrowRight :size="18" class="shrink-0" />
            {{ jumpLabel(e.t) }}
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

  <!-- ============ 详情：整屏抽屉，只读回看（正文与选题库同一屏，机器动作收在选题库） ============ -->
  <DetailDrawer
    :items="drawerItems"
    :current="openId || ''"
    label="历史记录详情"
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
      <TopicDetail :topic="cur" :images="curImages" :page="page" :go-page="goPage" :editable="false" />
    </template>

    <template #footer>
      <button class="btn-ai h-11 min-w-0 flex-1" :title="jumpLabel(cur)" @click="openTopicHome(cur.id)">
        <IconArrowRight :size="18" class="shrink-0" />
        {{ jumpLabel(cur) }}
      </button>
    </template>
  </DetailDrawer>
</template>
