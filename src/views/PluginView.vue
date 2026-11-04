<script setup lang="ts">
/**
 * Agent 插件页：把本机的两个技能（爆款五层拆解 / 逆向文案）交给用户自己的 Agent 用。
 * 版式四段：Agent 图标叠排 → 安装卡（Plugin/CLI 分段 + 两步）→ 三场景滚动钉住演示 → 收尾 CTA。
 * 屏上每一条命令、每一个数字都从本机真数据与真仓库来，没有的宁可空着（2026-11-01）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { readings, articles, topics, isRemote, clientDownloadUrl, STATUS_TEXT } from '../data/store'
import { useToast } from '../lib/useToast'
import { useReducedMotion } from '../lib/useReducedMotion'
import { CircleCheck as IconCircleCheck, Copy as IconCopy, ExternalLink as IconExternalLink, FolderOpen as IconFolderOpen, Layers as IconLayers, MoreHorizontal as IconMoreHorizontal, Puzzle as IconPuzzle, SquareTerminal as IconSquareTerminal, Target as IconTarget, Type as IconType } from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'go', id: string): void }>()
const { toast } = useToast()
const reduce = useReducedMotion()

const REPO = 'https://github.com/one-person-lab/media-hub'
const LOCAL = 'http://127.0.0.1:5173'

/* ==================== ① 装给谁用 ====================
 * 图标一律用各家官方标（public/agents/），名字靠悬浮说；
 * 目录只填这个产品族真读的本地路径：Qoder 读 ~/.qoder/skills，Claude Code 读 ~/.claude/skills，
 * ChatGPT 那一族（Codex 运行时）读 ~/.codex/skills，WorkBuddy 读 ~/.workbuddy/skills，
 * 剩下的按跨工具约定落项目里的 .agents/skills。 */
const agents = [
  { id: 'qoder', name: 'Qoder', logo: '/agents/qoder.svg', bleed: true, dir: '~/.qoder/skills/' },
  { id: 'claude-code', name: 'Claude Code', logo: '/agents/claude.svg', bleed: false, dir: '~/.claude/skills/' },
  { id: 'chatgpt', name: 'ChatGPT', logo: '/agents/chatgpt.svg', bleed: false, dir: '~/.codex/skills/' },
  { id: 'workbuddy', name: 'WorkBuddy', logo: '/agents/workbuddy.svg', bleed: true, dir: '~/.workbuddy/skills/' },
  { id: 'any', name: '其它 Agent', logo: '', bleed: false, dir: './.agents/skills/' },
]
const agent = ref(agents[0])
/** 首屏那排叠块只摆有官方标的产品，「其它 Agent」没有品牌可认 */
const heroAgents = agents.filter((a) => a.logo)
const mode = ref<'plugin' | 'cli'>('plugin')

const skillNames = 'viral-teardown、reverse-copy'

const modes = [
  { id: 'plugin', label: 'Plugin', icon: IconPuzzle },
  { id: 'cli', label: 'CLI', icon: IconSquareTerminal },
] as const

const promptText = computed(() =>
  `帮我装上创作者增长平台的两个技能，装完在这台机器上直接能用。

1. 拉仓库：git clone ${REPO}.git
2. 装技能：把仓库里 .agents/skills/ 下的 ${skillNames} 复制到 ${agent.value.dir}
3. 起工作台：cd media-hub && npm install && npm run dev，浏览器打开 ${LOCAL}
4. 以后我说「拆这条爆款」或「照这篇逆向写一版」，你按技能里的规矩做，产物写回同一批 markdown。

装好告诉我，我就开始派活。`)

const cliText = computed(() =>
  `git clone ${REPO}.git
cd media-hub && npm install
mkdir -p ${agent.value.dir} && cp -R .agents/skills/* ${agent.value.dir}
npm run dev   # 然后浏览器打开 ${LOCAL}`)

/* ==================== ② 本机真读数 ==================== */
const torn = computed(() => readings.filter((r) => r.analysis))
const scripted = computed(() => readings.filter((r) => r.script))
const carded = computed(() => articles.filter((a) => (a.card?.urls.length ?? 0) > 0))
const readouts = computed(() => [
  { label: '采回本机', value: readings.length, unit: '条' },
  { label: '拆过五层', value: torn.value.length, unit: '条' },
  { label: '扒回脚本', value: scripted.value.length, unit: '条' },
  { label: '出过图卡', value: carded.value.length, unit: '篇' },
])

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what}已复制——贴给 Agent 或终端都能直接用`)
  } catch {
    toast('浏览器拦了剪贴板，手动选中复制一下', 'fail')
  }
}

/* ==================== ③ 三场景演示 ==================== */
/** 卡上的拆解正文自带「①主题：」前缀，左侧已有标签列，重复的那截去掉 */
const layerText = (raw: string, label: string) =>
  raw.replace(new RegExp(`^[①-⑤]?\\s*${label}\\s*[：:]\\s*`), '')

const teardownCard = computed(() => torn.value.find((r) => r.script) || torn.value[0] || null)
const cardSet = computed(() => carded.value.find((a) => (a.card?.urls.length ?? 0) >= 2) || null)
const cardUrls = computed(() => cardSet.value?.card?.urls ?? [])
const pickedTopic = computed(() => topics.find((t) => t.basis && t.analysis) || topics.find((t) => t.basis) || null)

type Scenario = {
  id: string
  label: string
  icon: typeof IconLayers
  skill: string
  ask: string
  steps: string[]
  /** 执行块里那句「做了什么」 */
  did: string
  /** 执行块的标签芯片（全部来自真字段） */
  chips: string[]
  result: { kind: 'layers' | 'images' | 'topic'; title: string }
};

const scenarios = computed<Scenario[]>(() => {
  const out: Scenario[] = [];
  const t = teardownCard.value;
  if (t?.analysis) {
    out.push({
      id: 'teardown',
      label: '爆款拆五层',
      icon: IconLayers,
      skill: 'viral-teardown',
      ask: `拆一下这条：${t.title}`,
      steps: [
        `读灵感库里这张卡：${t.source}`,
        '按主题、钩子、结构、情绪、机制五层拆，逐层引原文',
        '拆完写回这张卡的 analysis 块，不用另存一份',
      ],
      did: t.analysis.subject ? layerText(t.analysis.subject, '主题') : t.excerpt,
      chips: [
        t.platform,
        `${t.likes || '—'} 赞`,
        `${t.collects || '—'} 藏`,
        t.script ? `脚本 ${t.script.split('\n').filter(Boolean).length} 行` : '脚本待补采',
      ],
      result: { kind: 'layers', title: '五层拆解' },
    });
  }
  const c = cardSet.value;
  if (c?.card) {
    out.push({
      id: 'rewrite',
      label: '照着复刻一版',
      icon: IconType,
      skill: 'reverse-copy',
      ask: `照《${c.title}》那篇逆向写一版，出图文卡片`,
      steps: [
        '取这篇的骨架与句式，不搬原句',
        '换成我们自己的案例与口径，英文术语一律带源语言',
        `出 ${c.card.pageCount} 页图卡并渲染，卡片数据落 ${c.card.slug}.json`,
      ],
      did: c.copy || c.body.split('\n').find(Boolean) || '',
      chips: [c.account || '未分账号', STATUS_TEXT[c.status] ?? c.status, `${c.card.urls.length} 页已出图`],
      result: { kind: 'images', title: '图卡成品' },
    });
  }
  const p = pickedTopic.value;
  if (p) {
    out.push({
      id: 'topics',
      label: '选题只认实测',
      icon: IconTarget,
      skill: '选题推荐',
      ask: '今天做什么？只给我有实测数据撑着的选题',
      steps: [
        `从 ${readings.length} 张卡里按真赞藏评选，${torn.value.length} 张拆过的优先`,
        '每条判断都要引证据编号，缺数据的写进缺口不猜',
        `立项后自动生成稿子骨架，接进创作台（本机现有 ${topics.length} 张选题卡）`,
      ],
      did: p.judge || p.basis,
      chips: [p.status, p.platforms?.length ? p.platforms.join(' / ') : '未定平台', p.likes ? `${p.likes} 赞` : '源卡无读数'],
      result: { kind: 'topic', title: '选题卡' },
    });
  }
  return out;
})

/* 滚动钉住：整段撑高，中间那一屏 sticky 不动，滚到哪三分之一就切哪个场景 */
const PANEL_H = 520;
const active = ref(0);
const wrap = ref<HTMLElement | null>(null);
let scroller: HTMLElement | null = null;

/** 钉住这一段是在 main 里滚的，所以自己算「滚动视口的中线落在第几屏」。
 *  先前用 IntersectionObserver 的窄带在这个滚动容器上切不过去（实测滚到头页签还停在第一个），换成确定性的位移除法。 */
const splitLine = () => {
  const r = scroller?.getBoundingClientRect();
  return r ? r.top + r.height * 0.55 : window.innerHeight * 0.55;
};
const syncActive = () => {
  const el = wrap.value;
  if (!el || !pinned.value || !scenarios.value.length) return;
  const passed = splitLine() - el.getBoundingClientRect().top;
  const i = Math.min(scenarios.value.length - 1, Math.max(0, Math.floor(passed / PANEL_H)));
  if (i !== active.value) active.value = i;
};

onMounted(() => {
  scroller = wrap.value?.closest('main') ?? null;
  scroller?.addEventListener('scroll', syncActive, { passive: true });
  window.addEventListener('resize', syncActive);
  syncActive();
});
onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', syncActive);
  window.removeEventListener('resize', syncActive);
});

function jumpTo(i: number) {
  active.value = i;
  const el = wrap.value;
  if (!pinned.value || !scroller || !el) return;
  const top = scroller.scrollTop + el.getBoundingClientRect().top - splitLine() + (i + 0.5) * PANEL_H;
  scroller.scrollTo({ top, behavior: reduce.value ? 'auto' : 'smooth' });
}

/* 窄屏不钉：面板本身比一屏还高，钉住会让它滚出容器留下一段空白（1470 实测 2855 高，390 曾撑到 11110）。
   所以手机与窄窗只留页签点切，桌面才吃滚动这条链。 */
const wide = ref(typeof window === 'undefined' ? true : window.innerWidth >= 1024);
const mq = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
const onWide = () => (wide.value = !!mq?.matches);
mq?.addEventListener('change', onWide);
onBeforeUnmount(() => mq?.removeEventListener('change', onWide));
const pinned = computed(() => wide.value);

const shown = computed(() => scenarios.value[active.value] ?? scenarios.value[0] ?? null);
const shownLayers = computed(() => {
  const a = teardownCard.value?.analysis;
  if (!a) return [];
  return (
    [
      ['主题', a.subject],
      ['钩子', a.hook],
      ['结构', a.structure],
      ['情绪', a.emotion],
      ['机制', a.mechanism],
    ] as [string, string][]
  ).filter(([, v]) => v).map(([label, raw]) => ({ label, text: layerText(raw, label) }));
});
</script>

<template>
  <div class="pb-10">
    <div class="mx-auto flex max-w-[1150px] flex-col gap-12">
      <!-- ==================== ① 首屏 ==================== -->
      <section class="flex flex-col items-center gap-4 pt-10 text-center">
        <div class="group flex h-[72px] items-center justify-center">
          <button
            v-for="(a, i) in heroAgents"
            :key="a.id"
            type="button"
            class="group/tile relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-line bg-surface shadow-neo transition-all duration-300 hover:z-20"
            :class="[
              i > 0 ? '-ml-3.5 group-hover:ml-1' : '',
              agent.id === a.id ? 'z-10 !border-ink ring-2 ring-ink/15' : '',
            ]"
            :style="{ transform: `rotate(${(i - 1.5) * 2.5}deg)` }"
            :aria-label="a.name"
            @click="agent = a"
          >
            <img
              :src="a.logo"
              :alt="a.name"
              width="44"
              height="44"
              class="h-11 w-11 rounded-xl"
              :class="a.bleed ? 'object-cover' : 'object-contain p-2'"
            />
            <span class="pointer-events-none absolute left-1/2 top-[calc(100%+10px)] -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-2 opacity-0 shadow-neo transition-opacity duration-150 group-hover/tile:opacity-100">
              {{ a.name }}
            </span>
          </button>
        </div>
        <div class="flex flex-col items-center gap-2.5">
          <h1 class="text-[28px] font-bold leading-tight text-ink">
            让 Agent 直接在你的工作台里干活
          </h1>
          <p class="max-w-[560px] text-sm leading-[22px] text-ink-3">
            把爆款五层拆解与逆向文案两个技能装进本机 Agent，它读写的是同一批 markdown。
            查看
            <a :href="REPO" target="_blank" rel="noopener" class="text-accent underline-offset-2 hover:underline">仓库 README</a>
          </p>
        </div>
      </section>

      <!-- ==================== ② 安装卡 ==================== -->
      <section class="rounded-bento border border-line bg-surface-2/70 p-1.5 shadow-neo">
        <div class="flex flex-wrap items-center justify-between gap-3 px-2.5 py-2">
          <div class="flex items-center gap-1.5">
            <button
              v-for="a in agents"
              :key="a.id"
              type="button"
              class="group/tile relative grid h-9 w-9 place-items-center rounded-xl border transition-colors hover:z-20"
              :class="agent.id === a.id ? 'border-ink bg-surface' : 'border-line bg-surface/60'"
              :aria-label="a.name"
              @click="agent = a"
            >
              <img
                v-if="a.logo"
                :src="a.logo"
                :alt="a.name"
                width="28"
                height="28"
                class="h-7 w-7 rounded-lg"
                :class="a.bleed ? 'object-cover' : 'object-contain p-1'"
              />
              <IconMoreHorizontal v-else :size="18" class="text-ink-3" />
              <span class="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-30 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-0.5 text-xs font-medium text-ink-2 opacity-0 shadow-neo transition-opacity duration-150 group-hover/tile:opacity-100">
                {{ a.name }}
              </span>
            </button>
            <span class="ml-1.5 text-sm text-ink-2">{{ agent.name }}</span>
          </div>
          <div class="flex items-center gap-1 rounded-xl bg-surface p-1">
            <button
              v-for="m in modes"
              :key="m.id"
              class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors"
              :class="mode === m.id ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink'"
              @click="mode = m.id"
            >
              <component :is="m.icon" :size="15" />
              {{ m.label }}
            </button>
          </div>
        </div>

        <div class="rounded-inset bg-surface p-5 shadow-neo">
          <div class="grid gap-6 lg:grid-cols-[1fr_300px]">
            <!-- 步骤 1 -->
            <div class="min-w-0">
              <div class="flex items-start gap-3">
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-white">1</span>
                <div class="min-w-0">
                  <h2 class="text-[15px] font-semibold text-ink">
                    {{ mode === 'plugin' ? `把下面这段发给你的 ${agent.name}` : '在终端里跑这四行' }}
                  </h2>
                  <p class="mt-0.5 text-sm leading-[21px] text-ink-3">
                    {{ mode === 'plugin' ? '它自己拉仓库、复制技能、起服务，装完回你一句' : '跑完技能就进了 Agent 的技能目录，工作台也起来了' }}
                  </p>
                </div>
              </div>
              <div class="relative mt-3.5 rounded-xl border border-line bg-surface-2/60 p-4 pr-11">
                <button
                  class="absolute right-2.5 top-2.5 grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-ink-3 transition-colors hover:text-ink"
                  :title="mode === 'plugin' ? '复制这段提示词' : '复制这几行命令'"
                  @click="copy(mode === 'plugin' ? promptText : cliText, mode === 'plugin' ? '提示词' : '命令')"
                >
                  <IconCopy :size="15" />
                </button>
                <pre class="m-0 overflow-x-auto whitespace-pre font-metric text-[12.5px] leading-[21px] text-ink-2">{{ mode === 'plugin' ? promptText : cliText }}</pre>
              </div>
            </div>

            <!-- 步骤 2 -->
            <div class="min-w-0 lg:border-l lg:border-line lg:pl-6">
              <div class="flex items-start gap-3">
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-white">2</span>
                <div>
                  <h2 class="text-[15px] font-semibold text-ink">回工作台看它写的东西</h2>
                  <p class="mt-0.5 text-sm leading-[21px] text-ink-3">
                    服务起来后打开本机这一版，Agent 拆的、写的都在这儿，改一行字就落回原文件
                  </p>
                </div>
              </div>
              <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                <div v-for="r in readouts" :key="r.label">
                  <dt class="text-aux text-ink-3">{{ r.label }}</dt>
                  <dd class="font-metric text-[19px] font-semibold leading-6 text-ink">{{ r.value }}<span class="ml-0.5 text-aux font-normal text-ink-3">{{ r.unit }}</span></dd>
                </div>
              </dl>
              <div class="mt-4 flex flex-col gap-2">
                <a
                  v-if="!isRemote" :href="LOCAL" target="_blank" rel="noopener"
                  class="btn-primary flex h-9 items-center justify-center gap-1.5 text-sm"
                >
                  <IconExternalLink :size="15" />
                  打开本机工作台
                </a>
                <a
                  v-else-if="clientDownloadUrl" :href="clientDownloadUrl" target="_blank" rel="noopener"
                  class="btn-primary flex h-9 items-center justify-center gap-1.5 text-sm"
                >
                  <IconExternalLink :size="15" />
                  下载桌面客户端
                </a>
                <p v-else class="text-aux leading-[20px] text-ink-3">这一版跑在网页上，技能要回桌面客户端这台机器装。</p>
                <button class="btn-ghost flex h-9 items-center justify-center gap-1.5 text-sm" @click="emit('go', 'collect-guide')">
                  <IconFolderOpen :size="15" />
                  顺手装浏览器采集插件
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ==================== ③ 三场景（滚动钉住） ==================== -->
      <section v-if="scenarios.length" class="flex flex-col gap-9">
        <h2 class="text-center text-2xl font-medium text-ink">技能装好之后，这三件事它就自己做了</h2>

        <div ref="wrap" class="relative" :style="pinned ? { height: `${scenarios.length * PANEL_H}px` } : undefined">
          <div
            class="flex flex-col gap-9"
            :class="pinned ? 'sticky top-[calc(var(--station-tabs-h,0px)+16px)]' : ''"
          >
            <nav class="flex flex-wrap items-center justify-center gap-1.5 pr-[76px]">
              <button
                v-for="(s, i) in scenarios"
                :key="s.id"
                class="relative isolate flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] transition-colors"
                :class="i === active ? 'font-semibold text-ink' : 'text-ink-3 hover:text-ink-2'"
                @click="jumpTo(i)"
              >
                <span
                  v-if="i === active"
                  class="bg-surface-2 absolute inset-0 -z-10 rounded-full border border-line shadow-neo transition-all"
                />
                <component :is="s.icon" :size="18" class="shrink-0" />
                {{ s.label }}
              </button>
            </nav>

            <div
              v-if="shown"
              class="grid gap-1.5 lg:grid-cols-5"
              :class="pinned ? 'min-h-[460px] lg:h-[calc(100vh-var(--station-tabs-h,0px)-120px)]' : ''"
            >
              <!-- 左：对话流 -->
              <div class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-bento border border-line bg-surface p-5 shadow-neo lg:col-span-3">
                <div class="flex shrink-0 items-center gap-2.5">
                  <img src="/favicon.svg" alt="" width="28" height="28" class="h-7 w-7 shrink-0" />
                  <span class="text-[15px] font-semibold text-ink">创作者增长平台</span>
                  <span class="chip !py-0.5 !text-aux">
                    <IconCircleCheck :size="13" class="text-green-700" />
                    通过 {{ shown.skill }} 执行
                  </span>
                </div>

                <p class="mt-4 rounded-2xl bg-surface-2 px-4 py-3 text-sm leading-[22px] text-ink-2">
                  {{ shown.ask }}
                </p>

                <ol class="mt-4 flex flex-col gap-2.5">
                  <li
                    v-for="(s, i) in shown.steps"
                    :key="i"
                    class="reveal flex items-start gap-2 text-sm leading-[22px] text-ink-2"
                    :style="{ animationDelay: `${reduce ? 0 : 120 + i * 160}ms` }"
                  >
                    <IconCircleCheck :size="15" class="mt-[3px] shrink-0 text-accent" />
                    {{ s }}
                  </li>
                </ol>

                <div
                  class="reveal mt-4 rounded-xl border border-line bg-surface-2/60 p-4"
                  :style="{ animationDelay: `${reduce ? 0 : 120 + shown.steps.length * 160}ms` }"
                >
                  <p class="line-clamp-3 text-sm leading-[22px] text-ink-2">{{ shown.did }}</p>
                  <div class="mt-3 flex flex-wrap gap-1.5">
                    <span v-for="c in shown.chips" :key="c" class="chip !py-0.5 !text-aux">{{ c }}</span>
                  </div>
                </div>
              </div>

              <!-- 右：本机真产物 -->
              <div class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-bento border border-line bg-surface-2/50 p-5 shadow-neo lg:col-span-2">
                <p class="flex shrink-0 items-center justify-center gap-1.5 text-sm font-medium text-ink-2">
                  <IconCircleCheck :size="15" class="text-green-700" />
                  {{ shown.result.title }}
                </p>

                <!-- 五层拆解 -->
                <div v-if="shown.result.kind === 'layers'" class="mt-5 flex min-h-0 flex-col gap-3 overflow-hidden">
                  <div v-for="(l, i) in shownLayers" :key="l.label" class="reveal flex gap-2.5" :style="{ animationDelay: `${reduce ? 0 : 200 + i * 140}ms` }">
                    <span class="w-[52px] shrink-0 pt-[3px] text-aux font-medium text-ink-3">{{ l.label }}</span>
                    <p class="line-clamp-3 text-aux leading-[21px] text-ink-2">{{ l.text }}</p>
                  </div>
                  <p v-if="!shownLayers.length" class="mt-8 text-center text-sm text-ink-3">这张卡还没拆过——装好技能让它拆一条，这里就有东西了。</p>
                </div>

                <!-- 图卡成品 -->
                <div v-else-if="shown.result.kind === 'images'" class="mt-5 flex min-h-0 flex-1 flex-col items-center gap-2.5 overflow-hidden">
                  <img
                    v-if="cardUrls[0]"
                    :src="cardUrls[0]"
                    alt="第 1 页图卡"
                    class="reveal h-[min(50vh,470px)] max-w-full shrink-0 rounded-lg border border-line object-contain shadow-neo"
                  />
                  <div class="reveal flex shrink-0 items-center gap-2" :style="{ animationDelay: `${reduce ? 0 : 260}ms` }">
                    <img
                      v-for="(u, i) in cardUrls.slice(1, 4)"
                      :key="u"
                      :src="u"
                      :alt="`第 ${i + 2} 页图卡`"
                      class="h-[68px] w-auto shrink-0 rounded border border-line object-cover"
                    />
                    <span v-if="cardUrls.length > 4" class="chip !py-0.5 !text-aux">共 {{ cardUrls.length }} 页</span>
                  </div>
                  <p v-if="!cardUrls.length" class="mt-8 text-center text-sm text-ink-3">这篇还没出过图卡——装好技能让它复刻一版，这里就有东西了。</p>
                </div>

                <!-- 选题卡 -->
                <div v-else class="mt-5 flex min-h-0 flex-col gap-3 overflow-hidden">
                  <div class="reveal rounded-xl border border-line bg-surface p-4">
                    <p class="line-clamp-2 text-sm font-medium leading-5 text-ink">{{ pickedTopic?.title }}</p>
                    <p class="mt-2 text-aux leading-[21px] text-ink-2">立项依据</p>
                    <p class="line-clamp-5 text-aux leading-[21px] text-ink-2">{{ pickedTopic?.basis }}</p>
                  </div>
                  <div class="reveal" :style="{ animationDelay: `${reduce ? 0 : 260}ms` }">
                    <p class="text-aux leading-[21px] text-ink-3">
                      这条的判断与验收标准都在选题卡上，创作台里点开就是原文——推荐池只从真赞藏评里算，缺数据的写进缺口不猜。
                    </p>
                    <button class="btn-ghost mt-3 flex h-8 items-center gap-1.5 text-sm" @click="emit('go', 'topics')">
                      <IconTarget :size="15" />
                      去看本机选题池
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section v-else class="flex flex-col items-center gap-3 rounded-bento border border-dashed border-line-strong bg-surface-2/40 px-6 py-12 text-center">
        <h2 class="text-2xl font-medium text-ink">还没有可演示的真产物</h2>
        <p class="max-w-[460px] text-sm leading-[22px] text-ink-3">
          这一段只摆本机真拆过、真出过图的东西。先去灵感库采几条并跑一轮拆解，回来这里自动有画面。
        </p>
        <button class="btn mt-1" @click="emit('go', 'inspiration')">去灵感库采一条</button>
      </section>

      <!-- ==================== ④ 收尾 ==================== -->
      <section class="dots relative flex flex-col items-center gap-5 overflow-hidden pb-24 pt-20 text-center">
        <h2 class="text-2xl font-semibold leading-snug text-ink">把你手上的 Agent 接进来</h2>
        <p class="max-w-[520px] text-sm leading-[23px] text-ink-3">
          仓库、技能目录、本机工作台三样对上就算装好。整套东西跑在你自己这台机器上，
          数据不出本地，换 Agent 也不用重来一遍。
        </p>
        <a
          :href="REPO" target="_blank" rel="noopener"
          class="flex h-12 items-center gap-1.5 rounded-full bg-ink px-6 text-base font-medium text-white transition-opacity hover:opacity-85"
        >
          去 GitHub 看仓库
          <IconExternalLink :size="18" />
        </a>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 演示面板按滚动进度逐条露出来；关掉动效时直接全显（全局 reduce 规则会把时长压掉） */
.reveal {
  animation: rise 0.5s ease both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* 收尾那段点阵：CSS 画的，不引第三方粒子库 */
.dots::before {
  content: '';
  position: absolute;
  inset: -20% -10%;
  background-image: radial-gradient(currentColor 1px, transparent 1.4px);
  background-size: 22px 22px;
  color: var(--app-line-strong);
  opacity: 0.5;
  animation: drift 26s linear infinite;
}
@keyframes drift {
  to {
    transform: translate3d(22px, 22px, 0);
  }
}
</style>
