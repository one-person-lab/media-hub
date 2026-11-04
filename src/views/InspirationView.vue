<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { readings, openTopicHome, holdSelfWrite } from '../data/store'
import type { Reading } from '../data/store'
import FilterSelect from '../components/FilterSelect.vue'
import SearchField from '../components/SearchField.vue'
import NoteCard from '../components/NoteCard.vue'
import CardChip from '../components/CardChip.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import type { DrawerItem } from '../components/DetailDrawer.vue'
import CaptureDetail from '../components/CaptureDetail.vue'
import type { CaptureSource } from '../components/CaptureDetail.vue'
import FavoritesConfigModal from '../components/FavoritesConfigModal.vue'
import CloneViralModal from '../components/CloneViralModal.vue'
import { useToast } from '../lib/useToast'
import { useGenerate } from '../lib/useGenerate'
import { Check as IconCheck, CircleAlert as IconCircleAlert, CircleX as IconCircleX, Flame as IconFlame, LoaderCircle as IconLoaderCircle, Puzzle as IconPuzzle, SlidersHorizontal as IconSlidersHorizontal, Star as IconStar, Trash2 as IconTrash2, WandSparkles as IconWandSparkles } from 'lucide-vue-next'

const { toast } = useToast()
const goHistory = () => (location.hash = '#/history')
/** 打开的采集卡记在地址栏（#/inspiration/<id>）：重新生成脚本与拆解都会整页刷新，刷新完要回到同一条 */
const idFromHash = () => {
  const seg = location.hash.replace(/^#\/?/, '').split('/')[1] || ''
  return seg ? decodeURIComponent(seg) : ''
}
const openId = ref<string | null>(idFromHash() || null)
// 已在灵感库时从别处跳来（发布日历/选题库的回链）：hash 第一段没变、整页不会刷新，这里就地切过去
window.addEventListener('hashchange', () => {
  const id = idFromHash()
  if (id !== openId.value) openId.value = id || null
})
watch(openId, (id) => {
  const target = id ? `/inspiration/${encodeURIComponent(id)}` : '/inspiration'
  if (location.hash !== `#${target}`) location.hash = target
})

const selected = computed(() => readings.find((r) => r.id === openId.value) || null)
/** 抽屉的右栏只在选中时有内容，槽里直接取这一份，省得每段都判空 */
const cur = computed(() => selected.value as Reading)
/** 右栏那一屏怎么分块，全站只在 CaptureDetail 一处说 */
const curSource = computed<CaptureSource>(() => {
  const r = cur.value
  return { desc: r.desc, tags: r.tags, script: r.script, images: r.images, analysis: r.analysis, analyzedAt: r.analyzedAt }
})

/** 用过的卡不进工作列表（选题才是它们现在的家），回看走收集站的「历史」 */
const pool = computed(() => readings.filter((r) => !r.convertedTopic))

/** 一级只回答一个问题：这批内容是怎么进来的——我用扩展/链接主动采的，还是平台收藏夹整表搬回的 */
const group = ref('')
const isFavorite = (r: Reading) => r.source === 'favorite'

/** 排序三档照即创：推荐=入库原序（收藏档按收进来的先后）、最新=比入库日、热度=比点赞 */
const sort = ref<'rec' | 'new' | 'hot'>('rec')
const sorts = [
  { id: 'rec' as const, label: '推荐' },
  { id: 'new' as const, label: '最新' },
  { id: 'hot' as const, label: '热度' },
]

/** 档位不跟着细筛闪：搬过收藏就一直在，计数为 0 时点进去看空态，比整档消失好懂 */
const groupOptions = computed(() => {
  const favorite = pool.value.filter(isFavorite).length
  const curated = pool.value.length - favorite
  return [
    { value: '', label: '全部来源' },
    { value: 'curated', label: `采集 ${curated}` },
    ...(readings.some(isFavorite) ? [{ value: 'favorite', label: `我的收藏 ${favorite}` }] : []),
  ]
})

const plat = ref('')
const platformOf = (r: Reading) => (r.platform === '小红书' || r.platform === '抖音' ? r.platform : '')
const platOptions = computed(() => {
  const set = new Set<string>()
  for (const r of pool.value) {
    const p = platformOf(r)
    if (p) set.add(p)
  }
  return [{ value: '', label: '全部平台' }, ...[...set].map((p) => ({ value: p, label: p, logo: p }))]
})

const fmt = ref('')
const fmtOptions = [
  { value: '', label: '全部类型' },
  { value: 'image', label: '图文' },
  { value: 'video', label: '视频' },
]

/** 时间只比入库日：postedAt 是采集时抄回的原文（「09-09 河北」「编辑于 07-13」），比不出天数 */
const days = ref('')
const dayOptions = [
  { value: '', label: '全部时间' },
  { value: '3', label: '近3天' },
  { value: '7', label: '近7天' },
  { value: '30', label: '近30天' },
]
function collectedWithin(r: Reading, n: number) {
  const t = Date.parse(r.collectedAt || '')
  return Number.isFinite(t) && Date.now() - t <= n * 864e5
}

const q = ref('')

const filterOn = computed(() => !!(group.value || plat.value || fmt.value || days.value || q.value))
function clearFilters() {
  group.value = ''
  plat.value = ''
  fmt.value = ''
  days.value = ''
  q.value = ''
}

/** 点赞是抄回来的字符串（「4.1万」/「2314」），排序前先折成数值 */
function heatOf(r: Reading) {
  const m = (r.likes || '').match(/^([\d.]+)\s*([万亿])?/)
  if (!m) return 0
  const n = parseFloat(m[1])
  return Number.isFinite(n) ? n * (m[2] === '万' ? 1e4 : m[2] === '亿' ? 1e8 : 1) : 0
}

/** 收藏档按「什么时候收进来的」倒序：先比同步批次（后一批必然比前一批新），再比当轮列表序号（0=当时最新一条）。
 *  老卡还没写 favOrder，退化成按笔记发布日倒序——至少 2022 年的老视频不再压在最新收藏上面。 */
const favNewest = (a: Reading, b: Reading) =>
  (b.collectedAt || '').localeCompare(a.collectedAt || '')
  || (a.favOrder ?? Number.MAX_SAFE_INTEGER) - (b.favOrder ?? Number.MAX_SAFE_INTEGER)
  || (b.postedAt || '').localeCompare(a.postedAt || '')

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const rows = pool.value.filter((r) => {
    if (group.value === 'favorite' && !isFavorite(r)) return false
    if (group.value === 'curated' && isFavorite(r)) return false
    if (plat.value && platformOf(r) !== plat.value) return false
    if (fmt.value && r.format !== fmt.value) return false
    if (days.value && !collectedWithin(r, Number(days.value))) return false
    if (kw && !`${r.title} ${r.author} ${r.tags} ${r.excerpt}`.toLowerCase().includes(kw)) return false
    return true
  })
  if (sort.value === 'hot') return [...rows].sort((a, b) => heatOf(b) - heatOf(a))
  if (sort.value === 'new') return [...rows].sort((a, b) => (b.collectedAt || '').localeCompare(a.collectedAt || ''))
  return group.value === 'favorite' ? [...rows].sort(favNewest) : rows
})

/** 详情抽屉的媒体：左轨与中间那一栏只认这一份映射 */
const drawerItems = computed<DrawerItem[]>(() =>
  shown.value.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    coverImage: r.coverImage,
    images: r.images,
    videoUrl: r.videoUrl,
  })),
)

/** 下拉分页：一次铺 24 张，滚到底前 320px 就取下一批。250ms 是刻意留的——数据全在内存里，
 *  不顿这一下「加载中」根本来不及露脸，只看到列表突然变长。 */
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

/** 卡片底行的作者位：扩展采集带「小红书/抖音 @作者」，链接采集只留得下出处标记 */
function authorOf(r: Reading) {
  const s = r.source || ''
  if (s === 'favorite') return `${r.platform}收藏 @${r.author}`
  if (!s || s === 'link') return '链接采集'
  return s.replace(/^(小红书|抖音)\s*@?/, '')
}

/** 星标＝收下这条：只立项进选题库，人留在原地继续翻卡 */
function starNote(r: Reading) {
  if (r.convertedTopic) return openTopicHome(r.convertedTopic)
  holdSelfWrite()
  fetch('/__topic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: r.title, fromKind: 'reading', from: r.title, sourceRel: r.file }),
  })
    .then((resp) => resp.json())
    .then((o) => {
      if (!o.ok) return toast(o.error || '失败')
      toast('已进选题库')
      openId.value = null
    })
}

/** 一键同款：就地开弹层，复刻的是手里这一条——选题页那套推广结构方案库是另一件事，不在这条路上 */
const cloneFor = ref<string | null>(null)
watch(openId, (id) => { if (id !== cloneFor.value) cloneFor.value = null })

function openClone(r: Reading) {
  openId.value = r.id
  if (!r.script) return toast('这条还没有脚本', 'fail')
  cloneFor.value = r.id
}

/** 没用的采集卡淘汰＝归档：文件移进归档目录不再占列表，源图保留可回溯 */
function archiveNote(r: Reading) {
  holdSelfWrite()
  fetch(`/__note?file=${encodeURIComponent(`content/${r.file}`)}`, { method: 'DELETE' })
    .then((resp) => resp.json())
    .then((o) => {
      if (!o.ok) return toast(o.error || '失败')
      toast('已归档，不再出现在列表里')
      openId.value = null
    })
}

/** 脚本在采集入库时本机自动出；源料缺失或想换一版，就在详情里就地重跑一次 */
const scriptBusy = ref('')
function rerunScript(r: Reading) {
  scriptBusy.value = r.id
  fetch('/__script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: `content/${r.file}` }),
  })
    .then((resp) => resp.json())
    .then((o) => toast(o.ok ? `已出稿 ${o.chars} 字` : `出稿失败：${o.error || '服务未就绪'}`, o.ok ? 'ok' : 'fail'))
    .catch(() => toast('出稿失败：服务未就绪', 'fail'))
    .finally(() => (scriptBusy.value = ''))
}

/** 拆解在采集收尾自动跑；这里只兜两种没拆成的情况：没配 API key、或脚本是后来补扒的 */
const gen = useGenerate()
function runTeardown(r: Reading) {
  gen.teardown(`content/${r.file}`).then((e) => e && toast(e))
}

/** 安装引导搬到收集站的「采集插件」页（2026-11-01，版式照美图设计室灵感采集） */
const goCollectGuide = () => (location.hash = '#/collect-guide')

/** 收藏搬运只认名单内的专辑（小红书叫专辑、抖音叫收藏夹）：低频配置，一个按钮弹窗改（名单 + 同步） */
const configOpen = ref(false)
</script>

<template>
  <div class="flex flex-col">
    <!-- 吸顶头（即创的搜索行 + 排序行合成一条顶栏）：样式在 style.css 的 .station-toolbar -->
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜标题、作者、标签" label="搜索采集到的笔记" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <button class="btn-ghost !px-2" aria-label="采集配置" title="采集配置" @click="configOpen = true">
            <IconSlidersHorizontal :size="15" />
          </button>
          <button class="btn-ghost !px-2" aria-label="采集插件" title="采集插件" @click="goCollectGuide">
            <IconPuzzle :size="15" />
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
          <FilterSelect v-model="group" placeholder="来源" :options="groupOptions" />
          <FilterSelect v-model="days" placeholder="时间" :options="dayOptions" />
          <FilterSelect v-model="plat" placeholder="平台" :options="platOptions" />
          <FilterSelect v-model="fmt" placeholder="类型" :options="fmtOptions" />
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
    <p v-else-if="!shown.length && !pool.length && readings.length" class="py-16 text-center text-sm text-ink-2">
      收集箱清空了，用过的都在历史里——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="goHistory">去历史看</button>。
    </p>
    <p v-else-if="!shown.length" class="py-16 text-center text-sm text-ink-2">
      还没有带封面的采集笔记——
      <button class="font-medium text-ink underline decoration-1 underline-offset-2" @click="goCollectGuide">装浏览器扩展</button>
      后即可入库。
    </p>

    <!-- 封面墙：卡面数值与 hover 动效都在 NoteCard，这一层只管瀑布流排布 -->
    <div v-if="shown.length" class="columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5">
      <NoteCard
        v-for="r in visible"
        :key="r.id"
        :seed="r.id"
        :heading="r.title"
        :cover-image="r.coverImage"
        :format="r.format"
        :page-count="r.images.length"
        :likes="r.likes"
        :video-url="r.videoUrl"
        @click="openId = r.id"
      >
        <template #chip>
          <CardChip v-if="r.analysis" label="已拆解"><IconCheck :size="13" /></CardChip>
          <CardChip v-else-if="!r.script" tone="warn" label="这条还没有脚本"><IconCircleAlert :size="13" /></CardChip>
        </template>
        <template #actions>
          <button
            class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[rgba(255,255,255,0.12)] text-[#F5FBFF] transition-colors duration-300 hover:bg-[rgba(255,255,255,0.22)]"
            title="星标收进选题库"
            aria-label="收进选题库"
            @click.stop="starNote(r)"
          >
            <IconStar :size="22" />
          </button>
          <button
            class="btn-ai h-11 min-w-0 flex-1"
            :class="!r.script && 'opacity-45'"
            :title="r.script ? '一键同款' : '这条还没有脚本'"
            @click.stop="openClone(r)"
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

  <!-- ============ 详情：整屏抽屉（壳见 DetailDrawer，右栏内容这一页自己填） ============ -->
  <DetailDrawer
    :items="drawerItems"
    :current="openId || ''"
    label="采集卡详情"
    @select="(id) => (openId = id)"
    @close="openId = null"
  >
    <template #meta>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
        <span class="flex items-center gap-1 tabular-nums text-ink" :title="`点赞 ${cur.likes || '无'} · 收藏 ${cur.collects || '无'} · 评论 ${cur.comments || '无'}`">
          <IconFlame :size="15" class="shrink-0 text-orange-400" />
          {{ cur.likes || '—' }} 赞<template v-if="cur.collects"> · {{ cur.collects }} 藏</template><template v-if="cur.comments"> · {{ cur.comments }} 评</template>
        </span>
        <span>{{ authorOf(cur) }}</span>
        <span v-if="cur.postedAt">{{ cur.postedAt }}</span>
      </div>
    </template>

    <template #default="{ page, goPage }">
      <CaptureDetail
        :source="curSource"
        :page="page"
        :script-busy="scriptBusy === cur.id"
        :teardown-busy="gen.runningKind.value === 'teardown'"
        @refresh-script="rerunScript(cur)"
        @teardown="runTeardown(cur)"
        @go-page="goPage"
      />
    </template>

    <template #footer>
      <button class="btn-ghost shrink-0 !h-11 !w-11 !px-0 !text-red-600" title="归档这张（文件移进归档目录，源图保留可回溯）" aria-label="归档这张" @click="archiveNote(cur)">
        <IconTrash2 :size="18" />
      </button>
      <button
        class="btn shrink-0 !h-11 !w-11 !px-0"
        :class="cur.convertedTopic && '!border-amber-400 !text-amber-500'"
        :title="cur.convertedTopic ? `已在选题库：「${cur.convertedTopic}」` : '星标收进选题库'"
        :aria-label="cur.convertedTopic ? '已在选题库' : '收进选题库'"
        @click="starNote(cur)"
      >
        <IconStar :size="18" />
      </button>
      <button class="btn-ai h-11 min-w-0 flex-1" :class="!cur.script && 'opacity-45'" :title="cur.script ? '一键同款' : '这条还没有脚本'" @click="openClone(cur)">
        <IconWandSparkles :size="18" class="shrink-0" />
        一键同款
      </button>
    </template>
  </DetailDrawer>

  <!-- ============ 一键同款：拆这一条的结构 → 挂我的号和产品 → 进创作台，全程盖在详情抽屉上 ============ -->
  <CloneViralModal
    v-if="selected && cloneFor === selected.id"
    :source="{ file: `content/${selected.file}`, title: selected.title, platform: selected.platform }"
    @close="cloneFor = null"
  />

  <FavoritesConfigModal v-if="configOpen" @close="configOpen = false" />
</template>
