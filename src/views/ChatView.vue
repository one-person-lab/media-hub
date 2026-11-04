<script setup lang="ts">
import { computed, ref } from 'vue'
import ChatComposer from '../components/ChatComposer.vue'
import ClientOnly from '../components/ClientOnly.vue'
import { isDemoSite } from '../data/store'
import { useChat } from '../lib/useChat'
import type { ChatRef } from '../lib/useChat'
import { useToast } from '../lib/useToast'
import { ChartLine as IconChartLine, Copy as IconCopy, Flame as IconFlame, Image as IconImage, Lightbulb as IconLightbulb, MessageCircle as IconMessageCircle, Pen as IconPen, Plus as IconPlus, Send as IconSend, TriangleAlert as IconTriangleAlert, Video as IconVideo, WandSparkles as IconWandSparkles } from 'lucide-vue-next'

const { conversation, log, running, stopping, error, elapsed, send, requestStop, reset } = useChat()
const { toast } = useToast()

const draft = ref('')
const composer = ref<InstanceType<typeof ChatComposer> | null>(null)

const empty = computed(() => !conversation.value?.messages.length)
const messages = computed(() => conversation.value?.messages || [])
/** 最后一条是用户说的 = Agent 正在答这条，进度挂在这儿 */
const answering = computed(() => running.value && messages.value[messages.value.length - 1]?.role === 'user')

/** 一排快捷入口：每张卡对应一条已经跑通的线，点了把这句话填进输入框，改完再发也来得及 */
const quick = [
  { icon: IconFlame, tint: 'bg-neo-pink', title: '爆款拆解', text: '把爆款采集最新那条按五层框架拆一遍，产出带证据编号的选题卡' },
  { icon: IconLightbulb, tint: 'bg-neo-yellow', title: '选题推荐', text: '从最近 7 天爆款采集的实测数据里挑 3 个我能二创的选题，每个都标证据编号' },
  { icon: IconCopy, tint: 'bg-neo-blue', title: '复刻排版', text: '把爆款采集最新那条小红书按原版排版复刻一篇，先开源笔记看排版再动手' },
  { icon: IconPen, tint: 'bg-neo-purple', title: '逆向文案', text: '把创作台最新那篇稿子按逆向思考的句式改一版' },
  { icon: IconImage, tint: 'bg-neo-green', title: '图文渲染', text: '把创作台最新那篇稿子渲成 1242×1660 图卡' },
  { icon: IconVideo, tint: 'bg-accent-soft', title: '视频创作', text: '把创作台最新那篇稿子写成一条 60 秒视频的脚本' },
  { icon: IconSend, tint: 'bg-neo-blue', title: '推草稿箱', text: '把最新那版推到小红书草稿箱' },
  { icon: IconChartLine, tint: 'bg-neo-purple', title: '数据复盘', text: '把最近 7 天的赞藏评和粉丝变化复盘一遍，指出哪条该续做' },
]

async function onSend(payload: { text: string; refs: ChatRef[] }) {
  const err = await send(payload.text, payload.refs)
  if (err) toast(err)
}

async function onStop() {
  const r = await requestStop()
  if (!r.ok) toast(r.error || '停止请求没送到本地服务')
}

function fill(text: string) {
  draft.value = text
  composer.value?.focus()
}
</script>

<template>
  <!-- 整屏高度由外壳的弹性列给（App.vue 在「对话」这一站把内容列撑满），这里只管自己内部的分栏 -->
  <div class="flex flex-col">
    <!-- 空态：打开即落这里，首页就是这张输入框 + 一排入口（2026-11-01 照美图设计台重排）。
         标题一行话说清这屏干什么，剩下的交给输入框的占位文案。 -->
    <div v-if="empty" class="flex flex-1 flex-col items-center justify-center py-6">
      <div class="w-full max-w-[900px]">
        <h1 class="mb-6 text-[30px] leading-[1.25] font-medium tracking-tight text-ink">
          今天想把哪条<span class="rounded-[10px] bg-accent-soft px-2.5 text-ink">发出去</span>？
        </h1>

        <ChatComposer
          ref="composer"
          v-model="draft"
          hero
          :busy="running"
          :elapsed="elapsed"
          :stopping="stopping"
          @submit="onSend"
          @stop="onStop"
        >
          <template #meta>
            <!-- 演示站那份是静态快照：Agent 跑不了，话还是能看，出口提前摆在输入框里 -->
            <ClientOnly v-if="isDemoSite" what="AI 助手" />
          </template>
        </ChatComposer>

        <div class="mt-6 grid grid-cols-4 gap-3 xl:grid-cols-8">
          <button
            v-for="q in quick"
            :key="q.title"
            class="group rounded-2xl bg-surface p-3.5 text-left shadow-neo transition-all hover:-translate-y-px hover:shadow-neo-lg"
            @click="fill(q.text)"
          >
            <span class="grid h-[38px] w-[38px] place-items-center rounded-[11px]" :class="q.tint">
              <component :is="q.icon" :size="22" class="text-ink transition-colors group-hover:text-accent" />
            </span>
            <span class="mt-3.5 block text-[13px] font-medium text-ink-2 transition-colors group-hover:text-ink">
              {{ q.title }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 有会话：标题条 + 消息流 + 底部输入框。用户消息 = 强调浅底右对齐，助手 = 白卡细边 -->
    <template v-else>
      <div class="mb-4 flex shrink-0 items-center justify-between gap-3 pt-4 pr-[76px]">
        <div class="min-w-0 truncate text-lg font-medium text-ink">{{ conversation?.title || '对话' }}</div>
        <button class="btn" @click="reset">
          <IconPlus :size="15" />
          新对话
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pb-5">
        <template v-for="(m, i) in messages" :key="i">
          <div v-if="m.role === 'user'" class="flex flex-col items-end gap-1.5">
            <div v-if="m.refs?.length" class="flex flex-wrap justify-end gap-1.5">
              <span
                v-for="r in m.refs"
                :key="r.file"
                class="inline-flex max-w-[280px] items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[13px] text-ink-2"
              >
                <IconWandSparkles v-if="r.file.startsWith('.agents/skills/')" :size="13" class="shrink-0" />
                <span class="min-w-0 truncate">{{ r.label }}</span>
              </span>
            </div>
            <div class="max-w-[76%] rounded-lg bg-accent-soft px-4 py-2.5 text-[15px] leading-relaxed text-ink">
              {{ m.text }}
            </div>
          </div>
          <div v-else class="card max-w-[86%] !p-4">
            <div v-if="!m.ok" class="flex items-start gap-2 text-sm font-medium text-red-700">
              <IconTriangleAlert :size="15" class="mt-0.5 shrink-0" />
              <span>{{ m.text }}</span>
            </div>
            <div v-else class="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{{ m.text }}</div>
          </div>
        </template>

        <!-- 正在答：进度一行行吐中文 -->
        <div v-if="answering" class="card max-w-[86%] !p-4">
          <div class="flex items-center gap-2 text-sm font-medium text-ink-2">
            <IconMessageCircle :size="15" />
            正在做
          </div>
          <ul class="mt-2.5 space-y-1">
            <li v-for="(l, i) in log" :key="i" class="flex items-start gap-2 font-mono text-sm leading-relaxed text-ink-2">
              <span class="mt-[7px] h-[5px] w-[5px] shrink-0 bg-ink-3" />
              <span>{{ l }}</span>
            </li>
          </ul>
          <div v-if="!log.length" class="mt-2 text-sm text-ink-3">处理中 · {{ elapsed }} 秒</div>
        </div>

        <div v-if="error" class="flex items-start gap-2 rounded-lg border border-line bg-red-50 px-4 py-3 text-sm text-red-800">
          <IconTriangleAlert :size="15" class="mt-0.5 shrink-0" />
          <span>{{ error }}</span>
        </div>
      </div>

      <ChatComposer
        v-model="draft"
        class="shrink-0"
        :busy="running"
        :elapsed="elapsed"
        :stopping="stopping"
        @submit="onSend"
        @stop="onStop"
      />
    </template>
  </div>
</template>
