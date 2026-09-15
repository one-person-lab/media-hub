<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  topicItems, TODAY,
  STATUS_TEXT, STATUS_CLASS, PLATFORM_COLORS,
} from '../data/store'
import type { TopicItem } from '../data/store'
import LandingLinks from '../components/LandingLinks.vue'
import {
  PhTarget, PhArrowLeft, PhTrash, PhCalendarBlank, PhPencilSimple, PhCalendarPlus,
} from '@phosphor-icons/vue'

const filter = ref<string>('all')
const selectedId = ref<string | null>(null)
const newTitle = ref('')
const creating = ref(false)

const filters = [
  { id: 'all', label: '全部进行中' },
  { id: 'not_start', label: '草稿' },
  { id: 'creating', label: '待排期' },
  { id: 'ready', label: '已排期' },
]

/** 选题库 = 工作队列，只放进行中；已发布的历史去「发布日历」按时间看 */
const shown = computed(() => {
  const items = topicItems().filter((i) => i.status !== 'published')
  if (filter.value === 'all') return items
  return items.filter((i) => i.status === filter.value)
})

const selected = computed(() => topicItems().find((t) => t.id === selectedId.value) || null)

function createManual() {
  const t = newTitle.value.trim()
  if (!t) return
  creating.value = false
  fetch('/__draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: t, fromKind: 'manual', from: '手动新建' }),
  })
    .then((r) => r.json())
    .then((out) => {
      if (!out.ok) toastMsg.value = out.error || '创建失败'
      else { newTitle.value = ''; toastMsg.value = '已创建草稿文件' }
      setTimeout(() => (toastMsg.value = ''), 2500)
    })
}

async function deleteDraftFile(item: TopicItem) {
  const rel = `content/自媒体运营/发布排期/待发布/${item.article!.id}.md`
  const resp = await fetch(`/__draft?file=${encodeURIComponent(rel)}`, { method: 'DELETE' })
  const out = await resp.json()
  if (!out.ok) {
    toastMsg.value = out.error || '删除失败'
    setTimeout(() => (toastMsg.value = ''), 2500)
    return false
  }
  selectedId.value = null
  return true
}

const toastMsg = ref('')
const writing = ref(false)
const writeError = ref('')

async function aiWrite(item: TopicItem) {
  writing.value = true
  writeError.value = ''
  try {
    const resp = await fetch('/__write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: `content/自媒体运营/发布排期/待发布/${item.article!.id}.md` }),
    })
    const out = await resp.json()
    if (!out.ok) throw new Error(out.error || `HTTP ${resp.status}`)
    // 成功：等 gen:data 自动刷新（1.2s debounce + 执行），然后清空选中让列表重载
    setTimeout(() => {
      writing.value = false
      selectedId.value = null
    }, 2500)
  } catch (e) {
    writing.value = false
    writeError.value = `创作失败：${(e as Error).message}`
  }
}

function copyFile(item: TopicItem) {
  if (item.article) navigator.clipboard?.writeText(`content/${item.article.file}`)
}

const scheduleDate = ref('')
const scheduling = ref(false)

/** 排期：待排期 → 已排期（文件 mv + 日期命名，状态自动 ready，到期自动进发布中心） */
async function scheduleItem(item: TopicItem) {
  if (!scheduleDate.value) return
  scheduling.value = true
  try {
    const resp = await fetch('/__schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rel: `content/自媒体运营/发布排期/待发布/${item.article!.id}.md`,
        date: scheduleDate.value,
      }),
    })
    const out = await resp.json()
    if (!out.ok) throw new Error(out.error || `HTTP ${resp.status}`)
    toastMsg.value = `已排期到 ${scheduleDate.value}，到期会自动进发布中心`
    scheduleDate.value = ''
    setTimeout(() => {
      scheduling.value = false
      selectedId.value = null
    }, 2200)
  } catch (e) {
    scheduling.value = false
    toastMsg.value = `排期失败：${(e as Error).message}`
    setTimeout(() => (toastMsg.value = ''), 3000)
  }
}

const minDate = TODAY

const metricLabels: [string, keyof NonNullable<TopicItem['article']>['metrics']][] = [
  ['发布链接', 'link'],
  ['播放量', 'views'],
  ['点赞', 'likes'],
  ['收藏', 'collects'],
  ['评论数', 'comments'],
  ['关注转化', 'follows'],
  ['划走率', 'bounce'],
]
</script>

<template>
  <!-- 详情态 -->
  <div v-if="selected" class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-4">
      <button class="neo-btn" @click="selectedId = null">
        <PhArrowLeft :size="15" weight="bold" class="shrink-0" />
        返回选题库
      </button>
      <div class="flex gap-2">
        <template v-if="selected.kind === 'draft'">
          <button class="neo-btn neo-btn-danger" @click="deleteDraftFile(selected)">
            <PhTrash :size="15" weight="bold" class="shrink-0" />
            删除草稿
          </button>
        </template>
        <template v-else>
          <!-- 排期（仅待排期：文件在 待发布/ 目录） -->
          <div v-if="selected.status === 'creating'" class="flex items-center gap-1.5">
            <input v-model="scheduleDate" type="date" :min="minDate" class="neo-input !px-2 !py-1 !text-xs" />
            <button class="neo-btn neo-btn-primary !px-2.5" :disabled="scheduling || !scheduleDate" @click="scheduleItem(selected)">
              <PhCalendarPlus :size="14" weight="bold" class="shrink-0" />
              {{ scheduling ? '排期中…' : '排期' }}
            </button>
          </div>
          <button class="neo-btn" title="复制文件路径，可用编辑器打开精修" @click="copyFile(selected)">
            <PhPencilSimple :size="15" weight="bold" class="shrink-0" />
            编辑
          </button>
          <button
            v-if="selected.status === 'not_start'"
            class="neo-btn neo-btn-danger"
            @click="deleteDraftFile(selected)"
          >
            <PhTrash :size="15" weight="bold" class="shrink-0" />
            删除
          </button>
        </template>
      </div>
    </div>

    <h2 class="px-1 text-2xl font-black">{{ selected.title }}</h2>

    <!-- 草稿（正文为空的文件）：一键 AI 创作 -->
    <div v-if="selected.kind === 'draft'" class="flex flex-col gap-4">
      <div class="neo-card">
        <div class="mb-2 flex gap-2">
          <span class="neo-chip status-not-start">草稿</span>
          <span v-if="selected.article.source" class="neo-chip">来自 {{ selected.article.source }}</span>
          <span class="neo-chip">文件已入库，不会丢</span>
        </div>
        <p class="text-sm leading-6 text-neutral-600">
          灵感来源：<b>{{ selected.article.source || '待填' }}</b>。
          点下面的按钮，AI 会读取灵感原文和运营手册规范，直接写成日更——正文、配文、话题、首评一次到位，状态自动跳「待排期」。
        </p>
      </div>

      <button
        class="neo-btn neo-btn-primary self-start !px-6 !py-3 !text-base"
        :disabled="writing"
        @click="aiWrite(selected)"
      >
        <PhPencilSimple :size="18" weight="bold" class="shrink-0" />
        {{ writing ? 'AI 创作中，约 20-40 秒…' : '✍ 让 AI 写成日更' }}
      </button>
      <div v-if="writeError" class="neo-chip status-failed self-start">{{ writeError }}</div>
    </div>

    <!-- 文章：完整创作内容 -->
    <div v-else class="grid grid-cols-3 gap-4 items-start">
      <div class="col-span-2 flex flex-col gap-4">
        <div class="neo-card">
          <div class="mb-3 flex items-center justify-between">
            <h3 class="font-black">备忘录正文</h3>
            <span class="neo-chip" :class="STATUS_CLASS[selected.status]">{{ STATUS_TEXT[selected.status] }}</span>
          </div>
          <pre class="whitespace-pre-wrap font-sans text-sm leading-7">{{ selected.article!.body }}</pre>
        </div>

        <div v-if="selected.article!.caption" class="neo-card">
          <h3 class="mb-2 font-black">发布配文</h3>
          <p class="text-sm leading-6">{{ selected.article!.caption }}</p>
          <p v-if="selected.article!.tags" class="mt-3 text-xs text-neutral-500">{{ selected.article!.tags }}</p>
          <template v-if="selected.article!.firstComment">
            <h4 class="mb-1 mt-4 text-sm font-black">首评引导</h4>
            <pre class="whitespace-pre-wrap font-sans text-sm leading-6 text-neutral-600">{{ selected.article!.firstComment }}</pre>
          </template>
        </div>
      </div>

      <div class="flex flex-col gap-4">
        <div class="neo-card">
          <h3 class="mb-3 font-black">创作信息</h3>
          <dl class="grid grid-cols-[76px_1fr] gap-y-3 text-sm">
            <dt class="font-bold text-neutral-500">日期</dt>
            <dd class="font-bold">{{ selected.article!.date || '未排期' }}</dd>
            <dt class="font-bold text-neutral-500">身份主题</dt>
            <dd>{{ selected.article!.identity || '—' }}</dd>
            <dt class="font-bold text-neutral-500">创作意图</dt>
            <dd class="leading-6">{{ selected.article!.intent || '—' }}</dd>
            <dt class="font-bold text-neutral-500">灵感来源</dt>
            <dd class="leading-6">{{ selected.article!.source || '—' }}</dd>
            <dt class="font-bold text-neutral-500">开头类型</dt>
            <dd>{{ selected.article!.openingType || '—' }}</dd>
            <dt class="font-bold text-neutral-500">平台</dt>
            <dd class="flex flex-wrap gap-1">
              <span v-for="p in selected.platforms" :key="p" class="neo-chip text-[10px]!" :style="{ background: PLATFORM_COLORS[p] }">{{ p }}</span>
            </dd>
            <dt class="font-bold text-neutral-500">活动标识</dt>
            <dd>
              <code class="text-xs text-neutral-600">{{ selected.article!.campaign || selected.article!.id }}</code>
              <span class="ml-1 text-xs text-neutral-400">（转化归因用，想短一点就在 md 里填「活动标识」）</span>
            </dd>
          </dl>

          <!-- 转化落点：内容最终把人送到哪（带 UTM，能按条归因） -->
          <LandingLinks :landing="selected.article!.landing" />
        </div>

        <div v-if="selected.status === 'published'" class="neo-card">
          <div class="mb-3 flex items-center justify-between">
            <h3 class="font-black">发布后数据</h3>
            <span v-if="selected.article!.metricsFilled" class="neo-chip status-published">已回填</span>
            <span v-else class="neo-chip status-creating">待回填</span>
          </div>
          <dl class="grid grid-cols-[76px_1fr] gap-y-2 text-sm">
            <template v-for="[label, key] in metricLabels" :key="key">
              <dt class="text-neutral-500">{{ label }}</dt>
              <dd class="font-bold">{{ ((selected.article!.metrics as any)[key] ?? '') || '—' }}</dd>
            </template>
          </dl>
        </div>

        <div v-if="selected.status !== 'published'" class="neo-card bg-neo-bg/60 !p-3">
          <p class="text-xs leading-5 text-neutral-500">
            发布后的链接与数据表现属于「发布 → 复盘」环节：发布完成后在「发布中心」标记，数据回填去「数据复盘」。这里只管把内容写好、排好期。
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- 列表态 -->
  <div v-else class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-black">
        <PhTarget :size="22" weight="bold" class="shrink-0" />
        选题库
        <span class="text-sm font-bold text-neutral-400">{{ shown.length }} 条</span>
      </h2>
      <button class="neo-btn neo-btn-primary" @click="creating = !creating">＋ 新建选题</button>
    </div>

    <Transition>
      <div v-if="toastMsg" class="neo-chip status-published self-start !text-sm">✓ {{ toastMsg }}</div>
    </Transition>

    <form v-if="creating" class="neo-card flex gap-2 !py-3" @submit.prevent="createManual">
      <input v-model="newTitle" class="neo-input flex-1" placeholder="写个标题，回车存为草稿…" autofocus />
      <button class="neo-btn neo-btn-success" type="submit">保存</button>
    </form>

    <div class="flex gap-2 flex-wrap">
      <button
        v-for="f in filters"
        :key="f.id"
        class="neo-btn"
        :class="filter === f.id && 'bg-neo-yellow! shadow-neo'"
        @click="filter = f.id"
      >{{ f.label }}</button>
    </div>

    <div class="flex flex-col gap-3">
      <div
        v-for="t in shown"
        :key="t.id"
        class="neo-card flex cursor-pointer items-center gap-4 transition-transform hover:-translate-y-0.5"
        @click="selectedId = t.id"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate font-black">{{ t.title }}</div>
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span class="neo-chip" :class="STATUS_CLASS[t.status]">{{ STATUS_TEXT[t.status] }}</span>
            <span
              v-if="t.kind === 'article' && t.status === 'published' && !t.article!.metricsFilled"
              class="neo-chip status-creating"
            >数据待补</span>
            <span
              v-for="p in t.platforms"
              :key="p"
              class="neo-chip"
              :style="{ background: PLATFORM_COLORS[p] }"
            >{{ p }}</span>
            <span v-if="t.date" class="flex items-center gap-1">
              <PhCalendarBlank :size="14" weight="bold" class="shrink-0" />
              {{ t.date }}
            </span>
            <span v-if="t.article?.identity">{{ t.article.identity }}</span>
          </div>
        </div>
        <div class="text-xl text-neutral-300">›</div>
      </div>
      <div v-if="!shown.length" class="neo-card py-10 text-center text-sm text-neutral-400">
        这个状态下还没有内容
      </div>
    </div>

    <p class="px-1 text-xs text-neutral-400">
      文章状态由 <code>content/自媒体运营/发布排期/</code> 的文件位置与日期决定；草稿存在本机。
    </p>
  </div>
</template>
