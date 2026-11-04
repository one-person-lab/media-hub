<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { benchmarks, isRemote, PLATFORM_META } from '../data/store'
import type { Benchmark } from '../data/store'
import ClientOnly from '../components/ClientOnly.vue'
import PlatformLogo from '../components/PlatformLogo.vue'
import SearchField from '../components/SearchField.vue'
import DetailDrawer from '../components/DetailDrawer.vue'
import type { DrawerItem } from '../components/DetailDrawer.vue'
import RichText from '../components/RichText.vue'
import { useToast } from '../lib/useToast'
import { useConfirm } from '../lib/useConfirm'
import { ChartLine as IconChartLine, ChevronDown as IconChevronDown, ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight, ChevronsUpDown as IconChevronsUpDown, ChevronUp as IconChevronUp, ExternalLink as IconExternalLink, Lightbulb as IconLightbulb, SlidersHorizontal as IconSlidersHorizontal, Target as IconTarget, Trash2 as IconTrash2 } from 'lucide-vue-next'
import ViralScopeModal from '../components/ViralScopeModal.vue'
import BenchmarkSearchModal from '../components/BenchmarkSearchModal.vue'

const { toast } = useToast()
const { confirm } = useConfirm()
const labelOf = (p: string) => PLATFORM_META[p]?.label ?? p

/** 万/千读数；null 是「建档时没读到」，不能拿 0 冒充 */
const wan = (n: number | null) =>
  n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(n)
const ago = (d: number | null) => (d == null ? '—' : d <= 0 ? '今天' : `${d} 天前`)

/* ---------- 筛选：平台 + 搜索 ---------- */
const platforms = computed(() => [...new Set(benchmarks.map((b) => b.platform))])
const platform = ref('all')
const keyword = ref('')
const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return benchmarks.filter((b) => {
    if (platform.value !== 'all' && b.platform !== platform.value) return false
    if (!q) return true
    return [b.nickname, b.desc, b.position, ...b.keywords].join(' ').toLowerCase().includes(q)
  })
})

/* ---------- 排序：点表头切列，同一列再点换向 ----------
   综合分不当列：52 个号全挤在 98~100，「99.8 / 99.8 / 99.6」这种小数点后一位是假精度，
   摆出来只会让人觉得这三家真有差别。分数仍是默认排序（# 那列就是它），只是不再报数。 */
type Col = 'score' | 'followers' | 'likesCollects' | 'works' | 'recentTopLikes' | 'lastPublishDays'
const cols: { key: Col; label: string; title: string }[] = [
  { key: 'followers', label: '粉丝', title: '建档时主页实测粉丝数' },
  { key: 'likesCollects', label: '获赞', title: '建档时主页实测获赞总数' },
  { key: 'works', label: '作品', title: '主页作品条数（小红书主页没这个读数）' },
  { key: 'recentTopLikes', label: '近期最高赞', title: '最近若干条作品里的最高赞——能不能再出爆款看这列' },
  { key: 'lastPublishDays', label: '最近发布', title: '距最近一次发布几天' },
]
const sort = ref<{ key: Col; dir: 1 | -1 }>({ key: 'score', dir: -1 })
/** 换列默认「大的在前」；只有「最近发布」反过来——点它想看的是还在更新的账号 */
function sortBy(key: Col) {
  const dir: 1 | -1 = key === sort.value.key ? (sort.value.dir * -1) as 1 | -1 : key === 'lastPublishDays' ? 1 : -1
  sort.value = { key, dir }
}
/** 缺读数的行永远沉底，不跟着升降序跳来跳去 */
const sorted = computed(() => {
  const { key, dir } = sort.value
  return [...filtered.value].sort((a, b) => {
    const av = a[key], bv = b[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return (av - bv) * dir
  })
})

/* ---------- 分页 ---------- */
const PAGE_SIZE = 20
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)))
const shown = computed(() => sorted.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
watch([platform, keyword, sort], () => (page.value = 1))

/* ---------- 详情：整屏抽屉（壳见 DetailDrawer），左轨在当前筛选结果里翻号 ---------- */
const openId = ref<string | null>(null)
const selected = computed(() => benchmarks.find((b) => b.id === openId.value) ?? null)
const drawerItems = computed<DrawerItem[]>(() =>
  sorted.value.map((b) => ({ id: b.id, title: b.nickname, url: b.url, coverImage: b.avatar })),
)

/* ---------- 采集：自动线的口径在「采集条件」里，运行键也收在那一层 ---------- */
const scopeOpen = ref(false)
/** 收对标：现输关键词搜一轮作者，人挑中的那几个才开主页读实测、建档 */
const searchOpen = ref(false)
function onSearchDone(saved: number) {
  searchOpen.value = false
  toast(`已收进对标 ${saved} 个`)
}

/** 不再对标 = 归档：整份档案移出列表，头像与快照留在归档目录可回溯 */
async function archiveBenchmark(b: Benchmark) {
  const ok = await confirm({
    title: `不再对标「${b.nickname}」`,
    message: '这份档案不再出现在对标列表里。以后想再看它，把主页链接重新添一次就回来。',
    confirmText: '不再对标',
  })
  if (!ok) return
  fetch(`/__benchmark?file=${encodeURIComponent(`content/${b.file}`)}`, { method: 'DELETE' })
    .then((resp) => resp.json())
    .then((o) => {
      if (!o.ok) return toast(o.action || o.error || '没删成')
      toast('已归档，不再出现在对标列表里')
      openId.value = null
    })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 吸顶头与收集站其余四页同一条（样式在 style.css 的 .station-toolbar）：
         这一页的正文是可排序表格，所以只有第一行有动作，第二行是平台分段 -->
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="keyword" placeholder="搜昵称 / 简介 / 关键词" label="搜对标账号" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <ClientOnly v-if="isRemote" :what="'收对标'" />
          <button v-else class="btn-ghost !px-2" aria-label="收对标" title="收对标" @click="searchOpen = true">
            <IconTarget :size="15" />
          </button>
          <button class="btn-ghost !px-2" aria-label="采集条件" title="采集条件" @click="scopeOpen = true">
            <IconSlidersHorizontal :size="15" />
          </button>
        </div>
      </div>

      <div v-if="platforms.length > 1" class="flex flex-wrap items-center gap-1">
        <button class="seg" :class="platform === 'all' && 'is-selected'" @click="platform = 'all'">
          全部 <span class="tabular-nums text-ink-3">{{ benchmarks.length }}</span>
        </button>
        <button
          v-for="p in platforms"
          :key="p"
          class="seg"
          :class="platform === p && 'is-selected'"
          @click="platform = p"
        >
          <PlatformLogo :platform="labelOf(p)" :size="14" />
          {{ labelOf(p) }} <span class="tabular-nums text-ink-3">{{ benchmarks.filter((b) => b.platform === p).length }}</span>
        </button>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[880px] text-left text-sm">
        <thead>
          <tr class="bg-surface-2">
            <th class="w-12 px-4 py-3 text-right font-medium text-ink-2">
              <button
                class="inline-flex items-center gap-1 font-medium hover:text-ink"
                :class="sort.key === 'score' ? 'text-ink' : 'text-ink-2'"
                title="综合排序"
                @click="sortBy('score')"
              >
                #
                <IconChevronDown v-if="sort.key === 'score' && sort.dir === -1" :size="13" />
                <IconChevronUp v-else-if="sort.key === 'score'" :size="13" />
                <IconChevronsUpDown v-else :size="13" class="opacity-40" />
              </button>
            </th>
            <th class="px-4 py-3 font-medium text-ink-2">账号</th>
            <th v-for="c in cols" :key="c.key" class="px-4 py-3 text-right font-medium text-ink-2">
              <button
                class="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-ink"
                :class="sort.key === c.key ? 'text-ink' : 'text-ink-2'"
                :title="c.title"
                @click="sortBy(c.key)"
              >
                {{ c.label }}
                <IconChevronDown v-if="sort.key === c.key && sort.dir === -1" :size="13" />
                <IconChevronUp v-else-if="sort.key === c.key" :size="13" />
                <IconChevronsUpDown v-else :size="13" class="opacity-40" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(b, i) in shown"
            :key="b.id"
            class="cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-surface-2"
            title="查看账号"
            @click="openId = b.id"
          >
            <td class="px-4 py-3 text-right tabular-nums text-ink-3">{{ (page - 1) * PAGE_SIZE + i + 1 }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-3">
                <img
                  v-if="b.avatar"
                  :src="b.avatar"
                  :alt="b.nickname"
                  loading="lazy"
                  class="h-9 w-9 shrink-0 rounded-full object-cover"
                />
                <span
                  v-else
                  class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2"
                >
                  <PlatformLogo :platform="labelOf(b.platform)" :size="16" />
                </span>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-medium text-ink">{{ b.nickname }}</span>
                    <PlatformLogo :platform="labelOf(b.platform)" :size="12" />
                  </div>
                  <div class="truncate text-sm text-ink-2">
                    {{ [b.ipLocation, b.keywords.join('、')].filter(Boolean).join(' · ') || '—' }}
                  </div>
                </div>
              </div>
            </td>
            <td class="px-4 py-3 text-right font-medium tabular-nums text-ink">{{ wan(b.followers) }}</td>
            <td class="px-4 py-3 text-right font-medium tabular-nums text-ink">{{ wan(b.likesCollects) }}</td>
            <td class="px-4 py-3 text-right font-medium tabular-nums text-ink-2">{{ b.works ?? '—' }}</td>
            <td class="px-4 py-3 text-right font-medium tabular-nums text-ink" :title="`近 ${b.recentSample ?? '?'} 条最高`">
              {{ wan(b.recentTopLikes) }}
            </td>
            <td class="px-4 py-3 text-right font-medium tabular-nums" :class="(b.lastPublishDays ?? 99) > 14 ? 'text-ink-3' : 'text-ink-2'">
              {{ ago(b.lastPublishDays) }}
            </td>
          </tr>
          <tr v-if="!shown.length">
            <td colspan="7" class="px-4 py-16 text-center text-sm text-ink-2">
              <template v-if="!benchmarks.length">还没有对标账号</template>
              <template v-else>没有匹配的账号</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pageCount > 1" class="flex items-center justify-center gap-3 text-sm text-ink-2">
      <button class="btn !px-2 !py-1" :disabled="page === 1" aria-label="上一页" title="上一页" @click="page--">
        <IconChevronLeft :size="13" class="shrink-0" />
      </button>
      <span class="tabular-nums">第 {{ page }} / {{ pageCount }} 页 · 共 {{ sorted.length }} 个</span>
      <button class="btn !px-2 !py-1" :disabled="page === pageCount" aria-label="下一页" title="下一页" @click="page++">
        <IconChevronRight :size="13" class="shrink-0" />
      </button>
    </div>
  </div>

  <!-- ============ 收对标：临时关键词搜一轮作者，挑中的建档 ============ -->
  <BenchmarkSearchModal v-if="searchOpen" @close="searchOpen = false" @done="onSearchDone" />

  <!-- ============ 采集条件：与爆款采集共用同一份 config/viral.json；对标采集的运行键也收在这里 ============ -->
  <ViralScopeModal v-if="scopeOpen" scope="benchmark" @close="scopeOpen = false" />

  <!-- ============ 详情：整屏抽屉，左轨在当前筛选结果里翻号，中间是头像，右栏读数 + 快照史 + 模式 ============ -->
  <DetailDrawer
    :items="drawerItems"
    :current="openId || ''"
    label="对标账号详情"
    @select="(id) => (openId = id)"
    @close="openId = null"
  >
    <template #meta>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
        <span class="flex items-center gap-1.5">
          <PlatformLogo :platform="labelOf(selected!.platform)" :size="13" />
          {{ labelOf(selected!.platform) }}
        </span>
        <span v-if="selected!.ipLocation">{{ selected!.ipLocation }}</span>
        <span v-if="selected!.keywords.length">{{ selected!.keywords.join('、') }}</span>
        <span v-if="selected!.capturedAt" class="ml-auto tabular-nums text-ink-3">建档 {{ selected!.capturedAt }}</span>
      </div>
    </template>

    <template #default>
      <p v-if="selected!.desc" class="text-sm leading-6 text-ink-2">
        <RichText :text="selected!.desc" />
      </p>

      <section class="mt-5">
        <h3 class="text-section text-ink">主页实测</h3>
        <div class="mt-2 grid grid-cols-3 gap-x-6 gap-y-4">
          <div v-for="m in ([
            ['粉丝', wan(selected!.followers)],
            ['获赞', wan(selected!.likesCollects)],
            ['作品', selected!.works ?? '—'],
            ['近期最高赞', wan(selected!.recentTopLikes)],
            ['中位赞', wan(selected!.recentMedianLikes)],
            ['最近发布', ago(selected!.lastPublishDays)],
          ] as [string, string][]) " :key="m[0]">
            <div class="text-sm text-ink-2">{{ m[0] }}</div>
            <div class="mt-0.5 text-lg font-medium tabular-nums text-ink">{{ m[1] }}</div>
          </div>
        </div>
      </section>

      <section v-if="selected!.position || selected!.why" class="mt-5">
        <h3 class="text-section text-ink">为什么对标它</h3>
        <div class="mt-2 flex items-start gap-2 text-sm">
          <IconTarget :size="15" class="mt-1 shrink-0 text-ink-3" />
          <RichText class="text-ink-2" :text="selected!.why || selected!.position" />
        </div>
      </section>

      <!-- 只有一条快照时上面那排读数就是它，不必再抄一遍；人工复查过才有第二段 -->
      <section v-if="selected!.snapshots.length > 1" class="mt-5">
        <div class="flex items-center gap-1.5">
          <IconChartLine :size="15" class="shrink-0 text-ink-3" />
          <h3 class="text-section text-ink">快照变化</h3>
        </div>
        <div class="mt-2 flex flex-col gap-1">
          <div v-for="(s, i) in selected!.snapshots" :key="i" class="text-sm leading-6 text-ink-2">
            <RichText :text="s" />
          </div>
        </div>
      </section>

      <section v-if="selected!.patterns.length" class="mt-5">
        <div class="flex items-center gap-1.5">
          <IconLightbulb :size="15" class="shrink-0 text-ink-3" />
          <h3 class="text-section text-ink">值得偷的模式</h3>
        </div>
        <ul class="mt-2 flex flex-col gap-1.5">
          <li v-for="(p, i) in selected!.patterns" :key="i" class="text-sm leading-6 text-ink-2">
            <RichText :text="p" />
          </li>
        </ul>
      </section>
    </template>

    <template #footer>
      <a
        v-if="selected!.url"
        :href="selected!.url"
        target="_blank"
        rel="noopener"
        class="btn shrink-0 !px-3"
        title="打开主页"
      >
        <IconExternalLink :size="15" class="shrink-0" />
        打开主页
      </a>
      <button class="btn-ghost shrink-0 !px-3 !text-red-600" title="不再对标：整份档案移进归档目录，列表里不再出现" @click="archiveBenchmark(selected!)">
        <IconTrash2 :size="15" class="shrink-0" />
        不再对标
      </button>
    </template>
  </DetailDrawer>

</template>
