<script setup lang="ts">
/** 选题详情的右栏正文（选题库与历史共用一屏）：原文脚本 → 逐页源图 → 爆款拆解 → 选题卡判据。
 *  editable=false 时只读：历史那一屏不改动已经立项的内容，机器动作都收在选题库。 */
import { computed, ref, watch } from 'vue'
import { ANALYSIS_SECTIONS } from '../data/store'
import type { TopicCard } from '../data/store'
import RichText from './RichText.vue'
import { useGenerate } from '../lib/useGenerate'
import { useToast } from '../lib/useToast'
import { ChevronDown as IconChevronDown, Copy as IconCopy, LoaderCircle as IconLoaderCircle, RefreshCw as IconRefreshCw, Sparkles as IconSparkles } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  topic: TopicCard
  /** 逐页源图长在来源采集卡上，由调用方带进来 */
  images?: string[]
  page?: number
  goPage?: (i: number) => void
  editable?: boolean
}>(), { images: () => [], page: 0, editable: true })

const gen = useGenerate()
const { toast } = useToast()

/** 脚本超 240 字先折一屏：右栏第一屏要给「为什么火」、拆解与判据，不是先读一篇长文 */
const FOLD = 240
const expanded = ref(false)
const foldable = computed(() => props.topic.script.length > FOLD)
watch(() => props.topic.id, () => (expanded.value = false))

const gateBusy = computed(() => gen.busy.value && gen.runningKind.value === 'gate')
function gateThis() {
  gen.gate(`content/${props.topic.file}`).then((e) => e && toast(e))
}

async function copyScript() {
  try {
    await navigator.clipboard.writeText(props.topic.script)
    toast('已复制原文脚本', 'ok')
  } catch {
    toast('复制失败，请手动选择文本', 'fail')
  }
}

/** 采集时脚本随源料一起本机自动出；缺源料的旧卡，在详情里就地重跑一次 */
const scriptBusy = ref(false)
function captureScript() {
  if (scriptBusy.value || !props.topic.sourceFile) return
  scriptBusy.value = true
  fetch('/__script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: props.topic.sourceFile }),
  })
    .then((r) => r.json())
    .then((o) => toast(o.ok ? `已出稿 ${o.chars} 字` : `出稿失败：${o.error || '服务未就绪'}`, o.ok ? 'ok' : 'fail'))
    .catch(() => toast('出稿失败：服务未就绪', 'fail'))
    .finally(() => (scriptBusy.value = false))
}

function teardownPrompt(): string {
  const card = props.topic
  return [
    `你是这个自媒体仓库的创作助手。当前工作目录 = media-hub 仓库根。`,
    ``,
    `任务：拆解这个选题的来源采集卡，把结论写回卡片本身（选题卡只读不写）。`,
    `- 选题卡：content/${card.file}`,
    `- 来源采集卡：${card.sourceFile}（原文链接看它的 frontmatter url）`,
    ``,
    `步骤：`,
    `1. 先读 content/Knowledge/爆款拆解.md（拆解框架与写回格式）和 content/Knowledge/00-定位.md（判断主题能不能平移到我们）。`,
    `2. 采集卡没有「## 脚本」段就先补采：打开原笔记（小红书/抖音页面用 ego-browser），视频要全程口播逐字稿、图文要把每一页图上的文字全部读出来按页序写回卡里，连逐页源图与高赞评论一起存。拆只认脚本，不许凭标题猜内容。`,
    `3. 按框架逐层拆：每层一句话、30 字内，只写「下次怎么用」的结论——③结构写页序规律不逐页复述、⑤机制写收藏型还是传播型不抄数字，不许写"内容不错"这种废话。`,
    `4. 把五层结论写回采集卡 frontmatter 的 analysis: 块（why/subject/hook/structure/emotion/mechanism），加 analyzedAt: 今天日期。写完即可——工作台会自动刷新，选题详情页自动带上这份拆解。`,
  ].join('\n')
}

async function copyTeardown() {
  try {
    await navigator.clipboard.writeText(teardownPrompt())
    toast('已复制拆解提示词，发给任意 Agent 拆完这里就能看到', 'ok')
  } catch {
    toast('复制失败，请手动选择文本', 'fail')
  }
}
</script>

<template>
  <p v-if="topic.analysis?.why" class="rounded-lg border border-line bg-accent-soft px-3.5 py-3 text-[15px] font-medium leading-6 text-ink">
    {{ topic.analysis.why }}
  </p>

  <section class="mt-4">
    <div class="flex items-center gap-2">
      <h3 class="text-aux font-medium text-ink-3">原文脚本</h3>
      <span v-if="topic.script" class="ml-auto text-aux tabular-nums text-ink-3">{{ topic.script.length }} 字</span>
      <button v-if="topic.script" class="btn-ghost !px-1.5" aria-label="复制完整脚本" title="复制完整脚本" @click="copyScript">
        <IconCopy :size="15" />
      </button>
      <button v-else-if="editable && topic.sourceFile" class="btn-ghost !px-1.5" :disabled="scriptBusy" aria-label="重新生成脚本" title="重新生成脚本" @click="captureScript">
        <IconLoaderCircle v-if="scriptBusy" :size="15" class="animate-spin" />
        <IconRefreshCw v-else :size="15" />
      </button>
    </div>
    <div v-if="topic.script" class="relative mt-1.5">
      <div class="overflow-hidden rounded-lg border border-line bg-surface-2 px-3.5 py-3" :class="!expanded && foldable && 'max-h-36'">
        <RichText :text="topic.script" class="text-ink-2" />
      </div>
      <div v-if="!expanded && foldable" class="pointer-events-none absolute inset-x-0 bottom-0 h-14 rounded-b-lg bg-gradient-to-t from-surface-2 to-transparent" />
    </div>
    <div v-else-if="topic.sourceFile" class="mt-1.5 h-14 rounded-lg border border-dashed border-line-strong" />
    <button
      v-if="foldable"
      class="btn-ghost mt-1 !px-0 text-sm"
      :aria-label="expanded ? '收起脚本' : '展开全文脚本'"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : '展开全文' }}
      <IconChevronDown :size="15" class="transition-transform" :class="expanded && 'rotate-180'" />
    </button>
  </section>

  <section v-if="images.length" class="mt-4">
    <div class="flex items-baseline gap-2">
      <h3 class="text-aux font-medium text-ink-3">逐页源图</h3>
      <span class="ml-auto text-aux tabular-nums text-ink-3">{{ images.length }} 页</span>
    </div>
    <div class="mt-2 flex gap-2 overflow-x-auto pb-1">
      <button
        v-for="(img, i) in images"
        :key="img"
        class="h-16 w-12 shrink-0 overflow-hidden rounded-md border transition-colors"
        :class="i === page ? 'border-accent' : 'border-line hover:border-line-strong'"
        :title="`第 ${i + 1} 页`"
        :aria-label="`中间看第 ${i + 1} 页`"
        @click="goPage?.(i)"
      >
        <img :src="img" :alt="`第 ${i + 1} 页`" loading="lazy" class="h-full w-full object-cover" />
      </button>
    </div>
  </section>

  <section v-if="topic.analysis" class="mt-4">
    <div class="flex items-baseline gap-2">
      <h3 class="text-aux font-medium text-ink-3">爆款拆解</h3>
      <span v-if="topic.analyzedAt" class="ml-auto text-aux tabular-nums text-ink-3">{{ topic.analyzedAt }}</span>
    </div>
    <dl class="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2.5 text-sm">
      <template v-for="sec in ANALYSIS_SECTIONS" :key="sec.key">
        <dt class="text-ink-2">{{ sec.label }}</dt>
        <dd class="leading-6 text-ink">{{ topic.analysis![sec.key] }}</dd>
      </template>
    </dl>
  </section>
  <section v-else-if="topic.sourceFile" class="mt-4">
    <div class="flex items-center gap-2">
      <h3 class="text-aux font-medium text-ink-3">爆款拆解</h3>
      <template v-if="editable">
        <button class="btn-ghost !px-1.5" :disabled="gen.busy.value" aria-label="复制拆解提示词" title="复制拆解提示词" @click="copyTeardown">
          <IconCopy :size="15" />
        </button>
        <button class="btn ml-auto" :disabled="gen.busy.value" title="按五层框架拆这条脚本" @click="gen.teardown(topic.sourceFile!).then((e) => e && toast(e))">
          <IconLoaderCircle v-if="gen.runningKind.value === 'teardown'" :size="15" class="animate-spin" />
          <IconSparkles v-else :size="15" class="shrink-0" />
          {{ gen.runningKind.value === 'teardown' ? '拆解中…' : '拆解' }}
        </button>
      </template>
    </div>
  </section>

  <section class="mt-4">
    <h3 class="text-aux font-medium text-ink-3">选题卡</h3>
    <dl class="mt-2 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-3 text-sm">
      <dt class="text-ink-2">来源</dt>
      <dd class="break-words text-ink-2">{{ topic.source || '原创选题，无来源信号' }}</dd>
      <dt class="text-ink-2">判据自评</dt>
      <dd v-if="topic.judge" class="leading-6 text-ink">
        <RichText :text="topic.judge" />
        <button v-if="editable" class="btn-ghost mt-1 !px-2 !py-0.5 text-xs" :disabled="gateBusy" title="按《00-定位》重新拟一份，覆盖现在这段" @click="gateThis">
          {{ gateBusy ? '拟…' : '重拟' }}
        </button>
      </dd>
      <dd v-else-if="editable" class="text-ink-2">
        待补充账号简介
        <button class="btn mt-1 !px-2 !py-0.5 text-xs" :disabled="gateBusy" title="按《00-定位》预答判据四问，写进这张卡" @click="gateThis">
          <IconLoaderCircle v-if="gateBusy" :size="13" class="animate-spin" />
          <IconSparkles v-else :size="13" class="shrink-0" />
          拟一份
        </button>
      </dd>
      <dd v-else class="text-ink-2">未填</dd>
      <dt class="text-ink-2">依据经验</dt>
      <dd v-if="topic.basis" class="leading-6 text-ink">
        <RichText :text="topic.basis" />
        <button v-if="editable" class="btn-ghost mt-1 !px-2 !py-0.5 text-xs" :disabled="gateBusy" title="重新取一条沉淀结论作默认，覆盖现在这段" @click="gateThis">
          {{ gateBusy ? '拟…' : '重拟' }}
        </button>
      </dd>
      <dd v-else-if="editable" class="text-ink-2">
        <button class="btn mt-1 !px-2 !py-0.5 text-xs" :disabled="gateBusy" title="按来源拆解与沉淀结论拟一条，写进这张卡" @click="gateThis">
          <IconLoaderCircle v-if="gateBusy" :size="13" class="animate-spin" />
          <IconSparkles v-else :size="13" class="shrink-0" />
          拟一份
        </button>
      </dd>
      <dd v-else class="text-ink-2">未填</dd>
    </dl>
  </section>
</template>
