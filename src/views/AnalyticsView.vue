<script setup lang="ts">
import { computed } from 'vue'
import {
  articles, readings, snapshots, latestSnapshot, PLATFORM_META, snapshotDelta,
} from '../data/store'
import {
  PhChartLineUp, PhEye, PhHeart, PhStar, PhChatCircle, PhSparkle,
  PhTrendUp, PhNote, PhVideoCamera, PhArrowClockwise,
} from '@phosphor-icons/vue'

const published = computed(() => articles.filter((a) => a.status === 'published'))
const filled = computed(() => published.value.filter((a) => a.metricsFilled))
const pending = computed(() => published.value.filter((a) => !a.metricsFilled))

const total = (k: 'views' | 'likes' | 'collects' | 'comments' | 'follows') =>
  filled.value.reduce((s, a) => s + (a.metrics[k] || 0), 0)

const sum = (v: number) => v.toLocaleString()

const stock = computed(() => [
  { label: '已发布', value: published.value.length, color: 'var(--color-neo-green)' },
  { label: '数据已回填', value: filled.value.length, color: 'var(--color-neo-blue)' },
  { label: '数据待补', value: pending.value.length, color: 'var(--color-neo-yellow)' },
  { label: '灵感库存', value: readings.length, color: 'var(--color-neo-pink)' },
])

/* ---------------- 平台快照（自动采集） ---------------- */
const PLATFORM_ICON: Record<string, unknown> = {
  xiaohongshu: PhNote,
  douyin: PhVideoCamera,
}

const platformCards = computed(() => {
  if (!latestSnapshot) return []
  return Object.entries(latestSnapshot.platforms).map(([key, p]) => {
    const meta = PLATFORM_META[key] ?? { label: key, color: 'var(--color-neo-yellow)' }
    const secKey = p.likesCollects != null ? 'likesCollects' : 'likes'
    const secVal = p.likesCollects ?? p.likes
    return {
      key,
      label: meta.label,
      color: meta.color,
      icon: PLATFORM_ICON[key] ?? PhChartLineUp,
      nickname: p.nickname,
      followers: p.followers,
      followersDelta: snapshotDelta(key, 'followers', p.followers),
      following: p.following,
      secondary: secVal,
      secondaryDelta: snapshotDelta(key, secKey, secVal),
      secondaryLabel: p.likesCollects != null ? '获赞与收藏' : '获赞',
      period: p.period,
    }
  })
})

const fmtDelta = (d: number | null) => (d == null ? '' : `${d > 0 ? '+' : ''}${d.toLocaleString()}`)

const collectedLabel = computed(() => {
  const t = latestSnapshot?.collectedAt
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

const trendSeries = computed(() =>
  Object.keys(PLATFORM_META)
    .filter((k) => snapshots.some((s) => s.platforms[k]?.followers != null))
    .map((k) => ({
      key: k,
      label: PLATFORM_META[k].label,
      color: PLATFORM_META[k].color,
      points: snapshots
        .map((s) => ({ date: s.date, value: s.platforms[k]?.followers ?? null }))
        .filter((p): p is { date: string; value: number } => p.value != null),
    })),
)

const trendReady = computed(() => trendSeries.value.some((t) => t.points.length >= 2))

/** 折线坐标（viewBox 600×140） */
const trendLines = computed(() => {
  const W = 600
  const H = 140
  const padX = 16
  const padY = 22
  return trendSeries.value
    .filter((t) => t.points.length >= 2)
    .map((t) => {
      const vals = t.points.map((p) => p.value)
      const min = Math.min(...vals)
      const max = Math.max(...vals)
      const span = max - min || 1
      const coords = t.points.map((p, i) => ({
        x: padX + (i * (W - padX * 2)) / (t.points.length - 1),
        y: H - padY - ((p.value - min) / span) * (H - padY * 2),
        ...p,
      }))
      return {
        ...t,
        coords,
        path: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '),
        min,
        max,
      }
    })
})

const xhsNotes = computed(() => latestSnapshot?.platforms.xiaohongshu?.notes ?? [])

const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-4">
      <h2 class="flex items-center gap-2 text-2xl font-black">
        <PhChartLineUp :size="22" weight="bold" class="shrink-0" />
        数据复盘
      </h2>
      <span v-if="collectedLabel" class="neo-chip status-published !text-xs">
        采集于 {{ collectedLabel }}
      </span>
    </div>

    <!-- ============ 平台数据（自动采集） ============ -->
    <template v-if="platformCards.length">
      <div class="text-xs font-black tracking-wider text-neutral-400">平台数据 · 自动采集</div>

      <div class="grid grid-cols-2 gap-4">
        <div v-for="p in platformCards" :key="p.key" class="neo-card">
          <div class="flex items-center gap-2">
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border-2 border-black text-black"
              :style="{ background: p.color }"
            >
              <component :is="p.icon" :size="14" weight="bold" />
            </span>
            <span class="font-black">{{ p.label }}</span>
            <span class="text-xs font-bold text-neutral-500">{{ p.nickname }}</span>
            <span v-if="p.period" class="ml-auto text-xs font-bold text-neutral-400">{{ p.period }}</span>
          </div>

          <div class="mt-3 flex items-end gap-8">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-3xl font-black">{{ sum(p.followers ?? 0) }}</span>
                <span
                  v-if="p.followersDelta != null"
                  class="neo-chip !px-1.5 !py-0.5 !text-[11px]"
                  :class="p.followersDelta >= 0 ? 'status-published' : 'status-failed'"
                >
                  {{ fmtDelta(p.followersDelta) }} 比上次
                </span>
              </div>
              <div class="text-xs font-bold text-neutral-500">粉丝</div>
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="text-xl font-black">{{ sum(p.secondary ?? 0) }}</span>
                <span
                  v-if="p.secondaryDelta != null"
                  class="neo-chip !px-1.5 !py-0.5 !text-[11px]"
                  :class="p.secondaryDelta >= 0 ? 'status-published' : 'status-failed'"
                >
                  {{ fmtDelta(p.secondaryDelta) }}
                </span>
              </div>
              <div class="text-xs font-bold text-neutral-500">{{ p.secondaryLabel }}</div>
            </div>
            <div>
              <div class="text-xl font-black">{{ sum(p.following ?? 0) }}</div>
              <div class="text-xs font-bold text-neutral-500">关注</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 粉丝趋势 -->
      <div class="neo-card">
        <div class="flex items-center gap-2 text-lg font-black">
          <PhTrendUp :size="18" weight="bold" class="shrink-0" />
          粉丝趋势
          <span class="ml-auto flex items-center gap-3 text-xs font-bold text-neutral-500">
            <span v-for="t in trendSeries" :key="t.key" class="flex items-center gap-1">
              <span
                class="inline-block h-3 w-3 rounded-[2px] border-2 border-black"
                :style="{ background: t.color }"
              ></span>
              {{ t.label }} {{ t.points.length }} 点
            </span>
          </span>
        </div>

        <div v-if="trendReady" class="mt-3">
          <svg viewBox="0 0 600 140" class="w-full" style="height: 140px">
            <line
              v-for="g in 3"
              :key="g"
              x1="16"
              :y1="22 + ((g - 1) * 96) / 2"
              x2="584"
              :y2="22 + ((g - 1) * 96) / 2"
              stroke="#e5e5e5"
              stroke-width="1"
              stroke-dasharray="4 4"
            />
            <g v-for="l in trendLines" :key="l.key">
              <polyline
                :points="l.path"
                fill="none"
                stroke="#000"
                stroke-width="3"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <circle
                v-for="(c, i) in l.coords"
                :key="i"
                :cx="c.x"
                :cy="c.y"
                r="5"
                fill="#fff"
                stroke="#000"
                stroke-width="2.5"
              />
            </g>
          </svg>
        </div>

        <p v-else class="mt-3 flex items-start gap-2 text-sm font-bold text-neutral-500">
          <PhArrowClockwise :size="16" weight="bold" class="mt-0.5 shrink-0" />
          <span>
            目前只有 {{ snapshots.length }} 个快照点，画不出趋势。再跑一次
            <code class="rounded bg-neo-yellow/60 px-1">npm run collect</code>
            攒到 2 个点就会出线——低频快照也够用，2 个点就能看出走向。
          </span>
        </p>
      </div>

      <!-- 小红书笔记明细 -->
      <div v-if="xhsNotes.length" class="neo-card !p-0 overflow-hidden">
        <div class="flex items-center gap-2 border-b-2 border-black bg-neo-pink/40 px-4 py-3">
          <PhNote :size="18" weight="bold" class="shrink-0" />
          <span class="text-lg font-black">小红书笔记明细</span>
          <span class="text-xs font-bold text-neutral-500">{{ xhsNotes.length }} 条 · 近半年</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b-2 border-black bg-neo-yellow/40 font-black">
                <th class="p-3">笔记</th>
                <th class="whitespace-nowrap p-3">发布</th>
                <th class="p-3 text-right">曝光</th>
                <th class="p-3 text-right">观看</th>
                <th class="p-3 text-right">点击率</th>
                <th class="p-3 text-right">赞</th>
                <th class="p-3 text-right">藏</th>
                <th class="p-3 text-right">评</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(n, i) in xhsNotes"
                :key="i"
                class="border-b-2 border-dashed border-neutral-200 last:border-0 hover:bg-neo-bg/60"
              >
                <td class="max-w-72 p-3 font-bold">
                  <div class="flex items-center gap-2">
                    <span v-if="n.rejected" class="neo-chip status-failed shrink-0 !px-1.5 !py-0.5 !text-[10px]">
                      未通过
                    </span>
                    <span class="truncate">{{ n.title }}</span>
                  </div>
                </td>
                <td class="whitespace-nowrap p-3 text-xs font-bold text-neutral-500">
                  {{ n.published?.slice(5) ?? '—' }}
                </td>
                <td class="p-3 text-right font-bold">{{ n.exposure?.toLocaleString() ?? '—' }}</td>
                <td class="p-3 text-right">{{ n.views?.toLocaleString() ?? '—' }}</td>
                <td class="p-3 text-right">{{ fmtPct(n.ctr) }}</td>
                <td class="p-3 text-right">{{ n.likes ?? '—' }}</td>
                <td class="p-3 text-right">{{ n.collects ?? '—' }}</td>
                <td class="p-3 text-right">{{ n.comments ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 排期内容（本地文件） ============ -->
    <div class="text-xs font-black tracking-wider text-neutral-400">排期内容 · 本地文件</div>

    <div class="grid grid-cols-4 gap-4">
      <div v-for="c in stock" :key="c.label" class="neo-card">
        <div class="text-xs font-bold text-neutral-500">{{ c.label }}</div>
        <div class="mt-2 text-3xl font-black">{{ c.value }}</div>
        <div class="mt-3 h-2 rounded-full border-2 border-black" :style="{ background: c.color }"></div>
      </div>
    </div>

    <div class="grid grid-cols-5 gap-4">
      <div class="neo-card !p-4 text-center">
        <div class="text-2xl font-black">{{ sum(total('views')) }}</div>
        <div class="flex items-center justify-center gap-1 text-xs font-bold text-neutral-500">
          <PhEye :size="14" weight="bold" class="shrink-0" />
          总播放
        </div>
      </div>
      <div class="neo-card !p-4 text-center">
        <div class="text-2xl font-black">{{ sum(total('likes')) }}</div>
        <div class="flex items-center justify-center gap-1 text-xs font-bold text-neutral-500">
          <PhHeart :size="14" weight="bold" class="shrink-0" />
          总点赞
        </div>
      </div>
      <div class="neo-card !p-4 text-center">
        <div class="text-2xl font-black">{{ sum(total('collects')) }}</div>
        <div class="flex items-center justify-center gap-1 text-xs font-bold text-neutral-500">
          <PhStar :size="14" weight="bold" class="shrink-0" />
          总收藏
        </div>
      </div>
      <div class="neo-card !p-4 text-center">
        <div class="text-2xl font-black">{{ sum(total('comments')) }}</div>
        <div class="flex items-center justify-center gap-1 text-xs font-bold text-neutral-500">
          <PhChatCircle :size="14" weight="bold" class="shrink-0" />
          总评论
        </div>
      </div>
      <div class="neo-card !p-4 text-center">
        <div class="text-2xl font-black">{{ sum(total('follows')) }}</div>
        <div class="flex items-center justify-center gap-1 text-xs font-bold text-neutral-500">
          <PhSparkle :size="14" weight="bold" class="shrink-0" />
          关注转化
        </div>
      </div>
    </div>

    <div class="neo-card !p-0 overflow-hidden">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b-2 border-black bg-neo-yellow/50 font-black">
            <th class="p-3">日期</th>
            <th class="p-3">内容</th>
            <th class="p-3 text-right">播放</th>
            <th class="p-3 text-right">点赞</th>
            <th class="p-3 text-right">收藏</th>
            <th class="p-3 text-right">评论</th>
            <th class="p-3">转化</th>
            <th class="p-3">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in published"
            :key="a.id"
            class="border-b-2 border-dashed border-neutral-200 last:border-0 hover:bg-neo-bg/60"
          >
            <td class="whitespace-nowrap p-3 text-xs font-bold text-neutral-500">{{ a.date }}</td>
            <td class="max-w-80 truncate p-3 font-bold">{{ a.title }}</td>
            <td class="p-3 text-right font-bold">{{ a.metrics.views?.toLocaleString() ?? '—' }}</td>
            <td class="p-3 text-right">{{ a.metrics.likes ?? '—' }}</td>
            <td class="p-3 text-right">{{ a.metrics.collects ?? '—' }}</td>
            <td class="p-3 text-right">{{ a.metrics.comments ?? '—' }}</td>
            <td class="p-3">
              <div v-if="Object.keys(a.conversion).length" class="flex flex-wrap gap-1">
                <span
                  v-for="(v, k) in a.conversion"
                  :key="k"
                  class="neo-chip status-published !px-1.5 !py-0.5 !text-[10px]"
                >
                  {{ k }} {{ v }}
                </span>
              </div>
              <span v-else class="text-xs text-neutral-400">未记录</span>
            </td>
            <td class="p-3">
              <span v-if="a.metricsFilled" class="neo-chip status-published">✓ 已复盘</span>
              <span v-else class="neo-chip status-creating">待回填</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="neo-card !p-4">
      <h3 class="mb-1 text-sm font-black">内容数据 ≠ 转化数据</h3>
      <p class="text-xs leading-6 text-neutral-600">
        上面的播放 / 点赞 / 收藏是<b>内容数据</b>，只说明传播有多广；
        「转化」列才是<b>转化数据</b>——落地链接带来多少访问、多少下载、多少 star，
        说明这条内容<b>值不值</b>。
        填法：在对应 md 的「## 转化数据」段手写（一行一个「指标：数值」）；
        链接在<b>发布中心 → 落地链接</b>里复制（已自动带 UTM，能按条归因）。
      </p>
    </div>

    <div v-if="pending.length" class="neo-card bg-neo-yellow!">
      <p class="text-sm font-bold">
        有 {{ pending.length }} 篇发布后数据还没填。在对应 md 文件的「发布后数据」段填上数字，
        再跑 <code>npm run gen:data</code>（或重启 dev），这里就会亮起来。
      </p>
    </div>
  </div>
</template>
