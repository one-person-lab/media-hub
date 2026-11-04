<script setup lang="ts">
/**
 * 对话输入卡（2026-11-01 照美图设计台重排）：说话的地方在上，动作收在卡片底栏，
 * 发送是右下角一颗圆键。底栏三颗都有真东西接——
 * 添加素材认盘上已有的采集卡/灵感卡/稿子，技能认能力登记表里的 skill 条目，
 * Agent 那颗报的是这台机器实际会执行的命令与模型。
 * `/` 与 `@` 直接在输入框里按，就唤出技能与素材两个菜单。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { articles, PLATFORM_META, readings, settingsPanel, skillItems, STATUS_TEXT, viral } from '../data/store'
import type { ChatRef } from '../lib/useChat'
import { Bot as IconBot, ChevronDown as IconChevronDown, FileText as IconFileText, LoaderCircle as IconLoaderCircle, Plus as IconPlus, Send as IconSend, Settings as IconSettings, SlidersHorizontal as IconSlidersHorizontal, Square as IconSquare, WandSparkles as IconWandSparkles, X as IconX } from 'lucide-vue-next'

const props = defineProps<{
  busy: boolean
  elapsed?: number
  /** 按过停止、服务端还在收尾：这一颗键不再响应第二次 */
  stopping?: boolean
  /** 首页大输入框：3 行起、24px 圆角卡；会话页底部用紧凑版 */
  hero?: boolean
}>()
const emit = defineEmits<{ (e: 'submit', payload: { text: string; refs: ChatRef[] }): void; (e: 'stop'): void }>()

const text = defineModel<string>({ default: '' })
const refs = ref<ChatRef[]>([])
const ta = ref<HTMLTextAreaElement | null>(null)
const menu = ref<'' | 'asset' | 'skill' | 'agent'>('')

const canSend = computed(() => !!text.value.trim() && !props.busy)
const isSkill = (r: ChatRef) => r.file.startsWith('.agents/skills/')
/** 首页那张卡在屏幕中间，菜单朝下开才不被视口上沿切掉；会话页的卡贴底，只能朝上开 */
const panelDir = computed(() => (props.hero ? 'top-full mt-2' : 'bottom-full mb-2'))

/** 卡名只留一眼能读完的长度，全名和互动数在详情里看 */
const short = (s: string) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 26)

/** 能引用的素材 = 这台机器上真有的三类卡，一条一条按最新排 */
const assetGroups = computed(() => [
  {
    label: '爆款采集',
    items: [...viral]
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
      .slice(0, 8)
      .map((v) => ({
        label: short(v.title),
        file: `content/${v.file}`,
        note: `${PLATFORM_META[v.platform]?.label ?? v.platform}${v.likes ? ` · ${v.likes}赞` : ''}`,
      })),
  },
  {
    label: '灵感库',
    items: [...readings]
      .sort((a, b) => String(b.collectedAt || b.postedAt || '').localeCompare(String(a.collectedAt || a.postedAt || '')))
      .slice(0, 8)
      .map((r) => ({ label: short(r.title), file: `content/${r.file}`, note: r.platform || r.source || '' })),
  },
  {
    label: '稿子',
    items: [...articles]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 8)
      .map((a) => ({ label: short(a.title), file: `content/${a.file}`, note: a.account || STATUS_TEXT[a.status] || '' })),
  },
])

/** 技能菜单的唯一来源是能力登记表（config/capabilities.json 里 kind=skill 那几条） */
const skillRows = computed<ChatRef[]>(() =>
  skillItems.map((s) => ({ label: s.label, file: `.agents/skills/${s.ref}/SKILL.md` })),
)

const agent = ref<{ command: string; model: string } | null>(null)
async function toggle(k: typeof menu.value) {
  menu.value = menu.value === k ? '' : k
  if (k !== 'agent' || agent.value) return
  try {
    const o = await (await fetch('/__llm')).json()
    if (o?.agent) agent.value = { command: String(o.agent.command || ''), model: String(o.agent.model || '') }
  } catch { /* 拿不到就不报型号，那颗键只写 Agent */ }
}

function addRef(r: ChatRef) {
  if (!refs.value.some((x) => x.file === r.file)) refs.value = [...refs.value, r].slice(-6)
  menu.value = ''
  void nextTick(() => ta.value?.focus())
}
const removeRef = (file: string) => (refs.value = refs.value.filter((r) => r.file !== file))

const openSettings = () => {
  menu.value = ''
  settingsPanel.value = 'config'
}

/** 行数自己长，首页版最少 3 行，最高 12 行后内部滚 */
function grow() {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(Math.max(el.scrollHeight, props.hero ? 84 : 0), 300)}px`
}

async function submit() {
  const v = text.value.trim()
  if (!v || props.busy) return
  const sent = refs.value
  text.value = ''
  refs.value = []
  await nextTick()
  grow()
  emit('submit', { text: v, refs: sent })
}

function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === '/') return void (e.preventDefault(), toggle('skill'))
  if (e.key === '@') return void (e.preventDefault(), toggle('asset'))
  if (e.key === 'Escape') return void (menu.value = '')
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void submit()
  }
}

defineExpose({ focus: () => nextTick(() => ta.value?.focus()) })
onMounted(() => ta.value?.focus())
</script>

<template>
  <div
    class="composer relative w-full rounded-[24px] border bg-surface transition-colors"
    :class="[hero ? 'p-5' : 'p-4', menu ? 'border-accent' : 'border-line focus-within:border-accent']"
  >
    <div v-if="menu" class="fixed inset-0 z-20" @click="menu = ''" />

    <!-- 说话的地方。占位文案里的 / 与 @ 是真按键，染成强调色就是告诉人可以按 -->
    <div class="relative">
      <textarea
        ref="ta"
        v-model="text"
        :rows="hero ? 3 : 1"
        class="w-full resize-none bg-transparent text-[15px] leading-[1.65] text-ink outline-none"
        @input="grow"
        @keydown="onKey"
      />
      <p
        v-if="!text"
        class="pointer-events-none absolute left-0 top-0 text-[15px] leading-[1.65] text-ink-3"
      >
        说清楚要做什么，按 <span class="font-medium text-accent">/</span> 用技能，按
        <span class="font-medium text-accent">@</span> 添加素材
      </p>
    </div>

    <!-- 带上的东西：只露名字，路径给 Agent 读 -->
    <div v-if="refs.length" class="mt-2.5 flex flex-wrap gap-1.5">
      <span
        v-for="r in refs"
        :key="r.file"
        class="inline-flex max-w-[280px] items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-2.5 pr-1.5 text-[13px] text-ink"
      >
        <component :is="isSkill(r) ? IconWandSparkles : IconFileText" :size="13" class="shrink-0 text-ink-3" />
        <span class="min-w-0 truncate">{{ r.label }}</span>
        <button
          class="grid h-4 w-4 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-line hover:text-ink"
          :aria-label="`去掉 ${r.label}`"
          @click="removeRef(r.file)"
        >
          <IconX :size="13" />
        </button>
      </span>
    </div>

    <div class="mt-3 flex items-center justify-between gap-3">
      <div class="flex min-w-0 flex-wrap items-center gap-1">
        <!-- 底栏三颗键：安静版动作，只有图标 + 名字，hover 才浮底 -->
        <div class="relative">
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors"
            :class="menu === 'asset' ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'"
            @click="toggle('asset')"
          >
            <IconPlus :size="15" />
            添加素材
          </button>
          <div
            v-if="menu === 'asset'"
            :class="panelDir"
            class="absolute left-0 z-30 max-h-[340px] w-[400px] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-neo"
          >
            <template v-for="g in assetGroups" :key="g.label">
              <div class="px-2.5 pb-1 pt-2 text-[13px] font-semibold text-ink-3">{{ g.label }}</div>
              <button
                v-for="r in g.items"
                :key="r.file"
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[14px] text-ink transition-colors hover:bg-surface-2"
                @click="addRef(r)"
              >
                <span class="min-w-0 flex-1 truncate">{{ r.label }}</span>
                <span class="shrink-0 text-[13px] text-ink-3">{{ r.note }}</span>
              </button>
              <div v-if="!g.items.length" class="px-2.5 py-1.5 text-[13px] text-ink-3">这台机器上还没有</div>
            </template>
          </div>
        </div>

        <div class="relative">
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors"
            :class="menu === 'skill' ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'"
            @click="toggle('skill')"
          >
            <IconWandSparkles :size="15" />
            技能
          </button>
          <div
            v-if="menu === 'skill'"
            :class="panelDir"
            class="absolute left-0 z-30 w-[320px] rounded-2xl border border-line bg-surface p-1.5 shadow-neo"
          >
            <button
              v-for="r in skillRows"
              :key="r.file"
              class="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[14px] text-ink transition-colors hover:bg-surface-2"
              @click="addRef(r)"
            >
              {{ r.label }}
            </button>
            <div v-if="!skillRows.length" class="px-2.5 py-1.5 text-[13px] text-ink-3">这台机器上还没装技能</div>
          </div>
        </div>

        <div class="relative">
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors"
            :class="menu === 'agent' ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'"
            @click="toggle('agent')"
          >
            <IconBot :size="15" />
            Agent
            <IconChevronDown :size="13" :class="menu === 'agent' ? 'rotate-180' : ''" />
          </button>
          <div
            v-if="menu === 'agent'"
            :class="panelDir"
            class="absolute left-0 z-30 w-[280px] rounded-2xl border border-line bg-surface p-1.5 shadow-neo"
          >
            <div class="flex items-center gap-2 px-2.5 py-1.5 text-[14px] text-ink">
              <IconSettings :size="15" class="shrink-0 text-ink-3" />
              <span class="min-w-0 flex-1 truncate">{{ agent ? `${agent.command} · ${agent.model}` : '本机 Agent' }}</span>
            </div>
            <button
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[14px] text-ink transition-colors hover:bg-surface-2"
              @click="openSettings"
            >
              <IconSlidersHorizontal :size="15" class="shrink-0 text-ink-3" />
              改配置
            </button>
          </div>
        </div>

        <slot name="meta" />
      </div>

      <div class="flex shrink-0 items-center gap-3">
        <span v-if="busy" class="chip status-creating">
          <IconLoaderCircle :size="13" class="animate-spin" />
          {{ stopping ? '已按停，正在收尾' : `正在跑 · ${elapsed || 0} 秒` }}
        </span>
        <!-- 跑着的时候这一颗换成停止（跟主流对话入口同一位置）；按下去停的是本机那条 Agent -->
        <button
          v-if="busy"
          class="grid h-[42px] w-[42px] place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:bg-red-50 hover:text-red-700"
          :class="stopping && 'cursor-not-allowed opacity-50 hover:bg-surface-2 hover:text-ink-2'"
          :disabled="stopping"
          :title="stopping ? '已经在收了' : '停止这一条'"
          aria-label="停止"
          @click="emit('stop')"
        >
          <IconSquare :size="22" />
        </button>
        <button
          v-else
          class="grid h-[42px] w-[42px] place-items-center rounded-full transition-colors"
          :class="canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'cursor-not-allowed bg-surface-2 text-ink-3'"
          :disabled="!canSend"
          aria-label="发送"
          @click="submit"
        >
          <IconSend :size="22" />
        </button>
      </div>
    </div>
  </div>
</template>
