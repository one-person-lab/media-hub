<script setup lang="ts">
import { computed, ref } from 'vue'
import { articles, TODAY } from '../data/store'
import LandingLinks from '../components/LandingLinks.vue'
import {
  PhRocketLaunch, PhMegaphone, PhCalendarDots,
  PhClipboardText, PhLinkSimple, PhCheckCircle,
} from '@phosphor-icons/vue'

const copied = ref('')
const autoId = ref<string | null>(null)
const autoStatus = ref('')

/** 一键发布（小红书图文）：自动打开发布页+传图+填内容，停在发布按钮前 */
async function autoPublish(a: (typeof articles)[number]) {
  autoId.value = a.id
  autoStatus.value = '正在打开发布页、上传封面、填写内容…（若弹出验证码，去 Ego Lite 转一下）'
  try {
    const resp = await fetch('/__autopublish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: `content/${a.file}`, platform: '小红书' }),
    })
    const out = await resp.json()
    if (out.ok && out.filled) {
      copied.value = '✓ 已填好！去 Ego Lite 检查，点「发布」；发完回来点「标记已发布」'
    } else {
      copied.value = `一键发布中断：${out.error || '未知原因'}（发布页已打开，可手动完成）`
    }
  } catch (e) {
    copied.value = `一键发布失败：${(e as Error).message}`
  } finally {
    autoId.value = null
    autoStatus.value = ''
    setTimeout(() => (copied.value = ''), 8000)
  }
}
const markingId = ref<string | null>(null)
const markLink = ref('')
const markPlatform = ref('小红书')

/** 今天该发：已排期且日期已到——真正的到期队列 */
const dueList = computed(() =>
  articles
    .filter((a) => a.status === 'ready' && a.date && a.date <= TODAY)
    .sort((x, y) => y.date!.localeCompare(x.date!)),
)

/** 即将发布：未来的已排期 */
const upcoming = computed(() =>
  articles
    .filter((a) => a.status === 'ready' && a.date && a.date > TODAY)
    .sort((x, y) => x.date!.localeCompare(y.date!)),
)

/** 发布历史：已发布，倒序 */
const history = computed(() =>
  articles
    .filter((a) => a.status === 'published')
    .sort((x, y) => (y.date || '').localeCompare(x.date || '')),
)

function publishPack(a: (typeof articles)[number]) {
  return [a.body, '', '—— 发布配文 ——', a.caption, '', a.tags, a.firstComment && ['—— 首评引导 ——', a.firstComment].join('\n')].filter(Boolean).join('\n')
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = label
  } catch {
    copied.value = '复制失败，请手动选择'
  }
  setTimeout(() => (copied.value = ''), 2000)
}

function startMark(a: (typeof articles)[number]) {
  markingId.value = markingId.value === a.id ? null : a.id
  markLink.value = ''
}

async function confirmMark(a: (typeof articles)[number]) {
  const resp = await fetch('/__publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rel: `content/${a.file}`,
      link: markLink.value.trim(),
      platform: markPlatform.value,
    }),
  })
  const out = await resp.json()
  if (!out.ok) {
    copied.value = `标记失败：${out.error}`
  } else {
    markingId.value = null
    copied.value = `✓ 已标记发布：${a.title}`
  }
  setTimeout(() => (copied.value = ''), 2600)
}

const emit = defineEmits<{ (e: 'go', view: string): void }>()
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-black">
        <PhRocketLaunch :size="22" weight="bold" class="shrink-0" />
        发布中心
      </h2>
      <div class="flex gap-2 text-xs">
        <span class="neo-chip status-creating">今天该发 {{ dueList.length }}</span>
        <span class="neo-chip status-ready">即将发布 {{ upcoming.length }}</span>
        <span class="neo-chip status-published">发布历史 {{ history.length }}</span>
      </div>
    </div>

    <Transition>
      <div v-if="copied" class="neo-chip status-published self-start !text-sm">{{ copied }}</div>
    </Transition>

    <!-- ============ 今天该发 ============ -->
    <section class="neo-card">
      <h3 class="mb-1 flex items-center gap-2 text-lg font-black">
        <PhMegaphone :size="18" weight="bold" class="shrink-0" />
        今天该发
      </h3>
      <p class="mb-3 text-xs text-neutral-500">
        到期的已排期内容。点「一键发布」→ 自动打开发布页、传封面、填好标题正文话题（弹出验证码时去 Ego Lite 转一下）→
        你检查后点平台上的「发布」→ 回来点「标记已发布」。
      </p>
      <div class="flex flex-col gap-3">
        <div v-for="a in dueList" :key="a.id" class="rounded-lg border-2 border-black bg-white p-3 shadow-neo-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="w-20 shrink-0 text-xs font-black text-neutral-500">{{ a.date }}</span>
            <span class="min-w-0 flex-1 truncate font-bold">{{ a.title }}</span>
            <button
              class="neo-btn neo-btn-primary !px-2.5 !py-1 !text-xs"
              :disabled="autoId === a.id"
              @click="autoPublish(a)"
            >
              <PhRocketLaunch :size="14" weight="bold" class="shrink-0" :class="autoId === a.id && 'animate-pulse'" />
              {{ autoId === a.id ? '自动发布中…' : '一键发布' }}
            </button>
            <button class="neo-btn !px-2 !py-1 !text-xs" @click="startMark(a)">
              <PhCheckCircle :size="14" weight="bold" class="shrink-0" />
              标记已发布
            </button>
            <button class="neo-btn !px-2 !py-1 !text-xs" title="备用：复制发布包手动粘贴" @click="copy(publishPack(a), a.title)">
              <PhClipboardText :size="13" weight="bold" class="shrink-0" />
            </button>
          </div>
          <div v-if="autoId === a.id && autoStatus" class="mt-2 text-xs font-bold text-neutral-500">{{ autoStatus }}</div>

          <!-- 转化落点：发的时候顺手把带 UTM 的链接复制走 -->
          <LandingLinks :landing="a.landing" />

          <!-- 标记已发布表单 -->
          <div v-if="markingId === a.id" class="mt-2.5 flex flex-wrap items-center gap-1.5 rounded-[6px] border-2 border-dashed border-neutral-300 bg-neo-bg/60 p-2">
            <select v-model="markPlatform" class="neo-input !w-auto !px-2 !py-1 !text-xs">
              <option>小红书</option>
              <option>公众号</option>
              <option>抖音</option>
              <option>B站</option>
              <option>视频号</option>
            </select>
            <input
              v-model="markLink"
              class="neo-input min-w-0 flex-1 !px-2 !py-1 !text-xs"
              placeholder="发布链接（可先留空，之后在复盘补）"
            />
            <button class="neo-btn neo-btn-success !px-2.5 !py-1 !text-xs" @click="confirmMark(a)">
              <PhLinkSimple :size="13" weight="bold" class="shrink-0" />
              确认
            </button>
          </div>
        </div>
        <div v-if="!dueList.length" class="py-6 text-center text-sm text-neutral-400">
          今天没有到期的发布——队列干净 ✓
        </div>
      </div>
    </section>

    <!-- ============ 即将发布 ============ -->
    <section v-if="upcoming.length" class="neo-card">
      <h3 class="mb-3 flex items-center gap-2 text-lg font-black">
        <PhCalendarDots :size="18" weight="bold" class="shrink-0" />
        即将发布
      </h3>
      <div class="flex flex-col gap-2">
        <div v-for="a in upcoming" :key="a.id" class="flex items-center gap-3 text-sm">
          <span class="neo-chip status-ready">{{ a.date }}</span>
          <span class="min-w-0 flex-1 truncate font-bold">{{ a.title }}</span>
          <span class="text-xs text-neutral-400">到日期自动进入「今天该发」</span>
        </div>
      </div>
    </section>

    <!-- ============ 发布历史 ============ -->
    <section class="neo-card !p-0 overflow-hidden">
      <div class="flex items-center gap-2 border-b-2 border-black bg-neo-yellow/50 px-4 py-3">
        <PhCheckCircle :size="18" weight="bold" class="shrink-0" />
        <span class="text-lg font-black">发布历史</span>
        <span class="text-xs font-bold text-neutral-500">{{ history.length }} 篇 · 数据表现去「数据复盘」看</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b-2 border-black bg-neo-yellow/30 font-black">
              <th class="p-3">日期</th>
              <th class="p-3">内容</th>
              <th class="p-3">发布链接</th>
              <th class="p-3">数据</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in history"
              :key="a.id"
              class="border-b-2 border-dashed border-neutral-200 last:border-0 hover:bg-neo-bg/60"
            >
              <td class="whitespace-nowrap p-3 text-xs font-bold text-neutral-500">{{ a.date }}</td>
              <td class="max-w-72 truncate p-3 font-bold">{{ a.title }}</td>
              <td class="max-w-52 truncate p-3 text-xs">
                <a v-if="a.metrics.link" :href="a.metrics.link" target="_blank" class="text-blue-700 underline">{{ a.metrics.link }}</a>
                <span v-else class="text-neutral-400">未记录</span>
              </td>
              <td class="p-3">
                <span v-if="a.metricsFilled" class="neo-chip status-published !px-1.5 !py-0.5 !text-[10px]">✓ 已回填</span>
                <span v-else class="neo-chip status-creating !px-1.5 !py-0.5 !text-[10px]">待回填</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <p class="px-1 text-xs text-neutral-400">
      发布环节只管「发出去」；发布后的数据表现统一在「数据复盘」里看。
      草稿和排期在「选题库」。完整流程见 <code>docs/WORKFLOW.md</code>。
    </p>
  </div>
</template>
