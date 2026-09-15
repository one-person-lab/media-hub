<script setup lang="ts">
import { ref, computed } from 'vue'
import { readings } from '../data/store'
import type { Reading } from '../data/store'
import {
  PhLightbulb, PhTarget, PhSparkle, PhCaretDown, PhHeart, PhBookmarkSimple,
} from '@phosphor-icons/vue'

const filter = ref<string>('all')
const expanded = ref<Set<string>>(new Set())
const selectedId = ref<string | null>(null)
const toast = ref('')

const selected = computed(() => readings.find((r) => r.id === selectedId.value) || null)

function toastMsg(m: string) {
  toast.value = m
  setTimeout(() => (toast.value = ''), 2600)
}

const analyzedCount = computed(() => readings.filter((r) => r.analysis).length)
const pendingCount = computed(() => readings.length - analyzedCount.value)

const filters = [
  { id: 'all', label: `全部 ${readings.length}` },
  { id: 'analyzed', label: `已拆解 ${analyzedCount.value}` },
  { id: 'pending', label: `待拆解 ${pendingCount.value}` },
]

const shown = computed(() => {
  if (filter.value === 'analyzed') return readings.filter((r) => r.analysis)
  if (filter.value === 'pending') return readings.filter((r) => !r.analysis)
  return readings
})

function toggle(id: string) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
}

const ANALYSIS_SECTIONS: { key: keyof NonNullable<Reading['analysis']>; label: string }[] = [
  { key: 'titleStructure', label: '标题结构' },
  { key: 'hook', label: '开头钩子' },
  { key: 'structure', label: '行文结构' },
  { key: 'steal', label: '可偷句式' },
  { key: 'topics', label: '适用选题' },
]

/** 无图占位封面的错落色调与高度（按 id 稳定散列） */
const TONES = [
  { bg: 'var(--color-neo-yellow)', h: 'h-28' },
  { bg: 'var(--color-neo-green)', h: 'h-36' },
  { bg: 'var(--color-neo-pink)', h: 'h-24' },
  { bg: 'var(--color-neo-blue)', h: 'h-32' },
  { bg: 'var(--color-neo-purple)', h: 'h-40' },
]
function toneOf(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return TONES[h % TONES.length]
}

async function createDraft(r: Reading) {
  try {
    const resp = await fetch('/__draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `读《${r.title}》的联想`, fromKind: 'reading', from: r.title }),
    })
    const out = await resp.json()
    if (!out.ok) throw new Error(out.error)
    toastMsg('✓ 已转为选题草稿，去选题库继续')
  } catch (e) {
    toastMsg('转为选题失败：' + (e as Error).message)
  }
}
</script>

<template>
  <!-- ============ 详情页 ============ -->
  <div v-if="selected" class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-4">
      <button class="neo-btn" @click="selectedId = null">
        <PhCaretDown :size="14" weight="bold" class="rotate-90 shrink-0" />
        返回灵感库
      </button>
      <div class="flex gap-2">
        <a v-if="selected.url" :href="selected.url" target="_blank" class="neo-btn">
          打开原帖 ↗
        </a>
        <button class="neo-btn neo-btn-primary" @click="createDraft(selected)">
          <PhTarget :size="15" weight="bold" class="shrink-0" />
          一键转选题
        </button>
      </div>
    </div>

    <Transition>
      <div v-if="toast" class="neo-chip status-published self-start !text-sm">{{ toast }}</div>
    </Transition>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr] items-start">
      <!-- 左列：封面 + 数据三卡 -->
      <div class="flex flex-col gap-3">
        <div class="neo-card !p-0 overflow-hidden">
          <img v-if="selected.coverImage" :src="selected.coverImage" :alt="selected.title" class="w-full" />
          <div v-else class="flex items-center justify-center h-64" :style="{ background: toneOf(selected.id).bg }">
            <div class="px-6 text-center text-xl font-black leading-snug">{{ selected.title }}</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div class="neo-card !p-3 text-center">
            <div class="text-xl font-black text-[#c2410c]">{{ selected.likes ?? '—' }}</div>
            <div class="text-[10px] font-bold text-neutral-500">点赞</div>
          </div>
          <div class="neo-card !p-3 text-center">
            <div class="text-xl font-black text-[#15803d]">{{ selected.collects ?? '—' }}</div>
            <div class="text-[10px] font-bold text-neutral-500">收藏</div>
          </div>
          <div class="neo-card !p-3 text-center">
            <div class="text-xl font-black text-[#1d4ed8]">{{ selected.comments ?? '—' }}</div>
            <div class="text-[10px] font-bold text-neutral-500">评论</div>
          </div>
        </div>
      </div>

      <!-- 右列：信息与拆解 -->
      <div class="flex flex-col gap-4">
        <div>
          <div class="text-xs font-bold text-neutral-400">灵感库 › 详情</div>
          <h2 class="mt-1 text-2xl font-black leading-snug">{{ selected.title }}</h2>
          <div class="mt-1.5 text-xs font-bold text-neutral-500">
            {{ selected.source || '本地资料' }}<span v-if="selected.postedAt"> · {{ selected.postedAt }}</span>
          </div>
          <div v-if="selected.tags" class="mt-2 flex flex-wrap gap-1.5">
            <span v-for="tag in selected.tags.split(/\s+/).filter(Boolean)" :key="tag" class="neo-chip !px-1.5 !py-0 !text-[10px]">{{ tag }}</span>
          </div>
        </div>

        <!-- 先读这一条 -->
        <div class="neo-card">
          <div class="mb-2 flex items-center gap-2 font-black">
            <span class="flex h-5 w-5 items-center justify-center rounded-full border-2 border-black bg-neo-blue text-[10px]">1</span>
            先读这一条
          </div>
          <dl class="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
            <dt class="text-neutral-500">摘要</dt>
            <dd class="leading-6">{{ selected.excerpt }}…</dd>
            <dt class="text-neutral-500">适用选题方向</dt>
            <dd class="font-bold leading-6">{{ selected.analysis?.topics || '—' }}</dd>
            <dt class="text-neutral-500">发布时间</dt>
            <dd>{{ selected.postedAt || '—' }}</dd>
          </dl>
        </div>

        <!-- 拆解怎么成立 -->
        <div v-if="selected.analysis" class="neo-card">
          <div class="mb-2 flex items-center gap-2 font-black">
            <span class="flex h-5 w-5 items-center justify-center rounded-full border-2 border-black bg-neo-yellow text-[10px]">2</span>
            拆解怎么成立
            <span class="ml-auto flex items-center gap-1 text-[10px] font-bold text-neutral-400">
              <PhSparkle :size="12" weight="fill" /> AI 自动生成
            </span>
          </div>
          <dl class="grid grid-cols-[110px_1fr] gap-y-2.5 text-sm">
            <dt class="text-neutral-500">标题类型</dt>
            <dd class="font-bold leading-6">{{ selected.analysis.titleStructure }}</dd>
            <dt class="text-neutral-500">开头钩子</dt>
            <dd class="leading-6">{{ selected.analysis.hook }}</dd>
            <dt class="text-neutral-500">行文结构</dt>
            <dd class="leading-6">{{ selected.analysis.structure }}</dd>
            <dt class="text-neutral-500">可偷句式</dt>
            <dd class="leading-6">{{ selected.analysis.steal }}</dd>
          </dl>
        </div>

        <!-- 笔记原文 -->
        <div class="neo-card">
          <div class="mb-2 font-black">笔记原文</div>
          <pre class="max-h-96 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-7 text-neutral-700">{{ selected.body || selected.excerpt }}</pre>
        </div>
      </div>
    </div>
  </div>

  <!-- ============ 瀑布流列表 ============ -->
  <div v-else class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="flex items-center gap-2 text-2xl font-black">
          <PhLightbulb :size="22" weight="bold" class="shrink-0" />
          灵感库
        </h2>
        <p class="mt-1 text-sm text-neutral-500">从采集的素材中筛选灵感，进入选题和创作流程。</p>
      </div>
      <span class="neo-chip status-published shrink-0 !text-xs">采集用浏览器扩展 · 一键入库</span>
    </div>

    <!-- 筛选 -->
    <div class="flex gap-2">
      <button
        v-for="f in filters"
        :key="f.id"
        class="neo-btn"
        :class="filter === f.id && 'bg-neo-yellow! shadow-neo'"
        @click="filter = f.id"
      >{{ f.label }}</button>
    </div>

    <!-- 瀑布流 -->
    <div class="columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5">
      <div
        v-for="r in shown"
        :key="r.id"
        class="mb-3 break-inside-avoid neo-card !p-0 overflow-hidden transition-transform hover:-translate-y-0.5"
      >
        <!-- 封面：点击进详情 -->
        <button class="block w-full cursor-pointer" @click="selectedId = r.id">
          <img v-if="r.coverImage" :src="r.coverImage" :alt="r.title" class="w-full object-cover" loading="lazy" />
          <div v-else class="flex items-center justify-center" :style="{ background: toneOf(r.id).bg }" :class="toneOf(r.id).h">
            <div class="px-6 text-center">
              <div class="text-3xl font-black leading-snug">{{ r.title }}</div>
            </div>
          </div>
        </button>

        <div class="flex flex-col gap-1.5 p-2.5">
          <!-- 标题：两行截断；已拆解的点击展开 -->
          <component
            :is="r.analysis ? 'button' : 'div'"
            class="flex items-start gap-1.5 text-left"
            @click="r.analysis && toggle(r.id)"
          >
            <span v-if="r.coverImage || !r.analysis" class="min-w-0 flex-1 text-xs font-black leading-snug line-clamp-2">{{ r.title }}</span>
            <span v-else class="min-w-0 flex-1 text-xs font-bold text-neutral-500 leading-snug">AI 拆解 · 点击展开</span>
            <PhCaretDown
              v-if="r.analysis"
              :size="13"
              weight="bold"
              class="mt-0.5 shrink-0 transition-transform"
              :class="expanded.has(r.id) && 'rotate-180'"
            />
            <span v-else-if="r.source" class="neo-chip status-creating shrink-0 !px-1 !py-0 !text-[9px]">待拆解</span>
          </component>

          <!-- AI 拆解展开区 -->
          <div v-if="r.analysis && expanded.has(r.id)" class="flex flex-col gap-1.5 rounded-[4px] border-2 border-dashed border-neutral-300 bg-neo-bg/60 p-2">
            <div v-for="sec in ANALYSIS_SECTIONS" :key="sec.key" class="text-[11px] leading-4">
              <span class="mr-1 inline-block rounded-[3px] border border-black bg-neo-yellow px-1 text-[9px] font-black">{{ sec.label }}</span>
              <span class="font-bold text-neutral-700">{{ r.analysis![sec.key] }}</span>
            </div>
          </div>

          <!-- 底行：作者 · 数据 · 操作（小红书式一行） -->
          <div class="flex items-center justify-between gap-1.5 text-[10px] font-bold text-neutral-500">
            <span class="min-w-0 truncate">{{ (r.source || '本地').replace('小红书 @', '') }}</span>
            <span class="flex shrink-0 items-center gap-2">
              <span v-if="r.likes != null" class="flex items-center gap-0.5">
                <PhHeart :size="11" weight="fill" class="shrink-0" /> {{ r.likes }}
              </span>
              <span v-if="r.collects != null" class="flex items-center gap-0.5">
                <PhBookmarkSimple :size="11" weight="fill" class="shrink-0" /> {{ r.collects }}
              </span>
              <button
                class="neo-btn !gap-1 !border-2 !px-1.5 !py-0.5 !text-[10px] hover:bg-neo-yellow"
                title="生成选题"
                @click="createDraft(r)"
              >
                <PhTarget :size="10" weight="bold" class="shrink-0" />
                选题
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <p class="px-1 text-xs text-neutral-400">
      采集：小红书笔记页点浏览器扩展一键入库（自动拆解）。
      参考资料 md 放 <code>content/参考资料/</code>，拆解规范见其 README。
      历史金句已归档至 <code>content/自媒体运营/创作素材/归档/</code>。
    </p>
  </div>
</template>
