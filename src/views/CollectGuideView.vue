<script setup lang="ts">
/** 采集插件页：版式照美图设计室「灵感采集」那一屏（左演示右说明），内容全部来自本机真数据。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { readings, isRemote, clientDownloadUrl, ANALYSIS_SECTIONS } from '../data/store'
import PlatformLogo from '../components/PlatformLogo.vue'
import { useToast } from '../lib/useToast'
import { useReducedMotion } from '../lib/useReducedMotion'
import { ArrowRight as IconArrowRight, ArrowUpRight as IconArrowUpRight, Bookmark as IconBookmark, ChartPie as IconChartPie, Check as IconCheck, CircleCheck as IconCircleCheck, Copy as IconCopy, ExternalLink as IconExternalLink, Folder as IconFolder, Layers as IconLayers, ShieldCheck as IconShieldCheck, Type as IconType, Video as IconVideo } from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'go', id: string): void }>()
const { toast } = useToast()
const reduce = useReducedMotion()

/* ==================== 那颗按钮的态：照美图 InspirationGuide-cta 来 ====================
 * 插件在本机页面上留一个 data-mediahub-clipper 版本号（extension/clipper-flag.js，
 * document_start 注入，所以首屏就能读到，不会先闪一下「未安装」）。读不到就是没装。
 * 非 Chrome 浏览器装了也用不了，所以先判浏览器。 */
const isChrome = /Chrome|CriOS/i.test(navigator.userAgent) && !/Edg|OPR/i.test(navigator.userAgent)
const clipper = ref(document.documentElement.dataset.mediahubClipper || '')
/** 本机那份点完按钮只是把目录路径放进剪贴板，按钮要当场报这一步做完了 */
const copied = ref(false)
let flagObserver: MutationObserver | undefined
onMounted(() => {
  if (clipper.value) return
  flagObserver = new MutationObserver(() => {
    const v = document.documentElement.dataset.mediahubClipper
    if (v) { clipper.value = v; flagObserver?.disconnect() }
  })
  flagObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mediahub-clipper'] })
})
onBeforeUnmount(() => flagObserver?.disconnect())

const cta = computed(() => {
  if (!isChrome) return { kind: 'browser' as const, label: '请使用 Chrome 浏览器' }
  if (clipper.value) return { kind: 'installed' as const, label: '插件已安装' }
  if (copied.value) return { kind: 'copied' as const, label: '插件目录路径已复制' }
  if (isRemote.value) {
    return clientDownloadUrl.value
      ? { kind: 'client' as const, label: '下载桌面客户端' }
      : { kind: 'stalled' as const, label: '' }
  }
  return { kind: 'install' as const, label: '安装插件至 Chrome' }
})

let copyTimer: ReturnType<typeof setTimeout> | undefined
async function onCta() {
  const kind = cta.value.kind
  if (kind === 'browser') return window.open('https://www.google.com/chrome/', '_blank', 'noopener')
  if (kind === 'client') return window.open(clientDownloadUrl.value, '_blank', 'noopener')
  if (kind !== 'install') return
  try {
    const o = await (await fetch('/__extension-path')).json()
    await navigator.clipboard.writeText(o.dir)
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), 4000)
    toast('插件目录路径已复制——在 chrome://extensions 点「加载已解压的扩展程序」，选择框里按 ⌘⇧G 粘贴即可直达')
  } catch {
    toast('复制失败，请手动选择工作台目录下的 extension 文件夹', 'fail')
  }
}

/** 轮播只演这条链的四步，画面用的是灵感库里真采回来的卡 */
const slides = [
  { key: 'pin', title: '固定到浏览器工具栏', desc: '装好一次就一直在那儿，不用每次去找' },
  { key: 'popup', title: '在笔记页点一下', desc: '插件只认当前这一条，不会整站乱抓' },
  { key: 'inbox', title: '当场进灵感库', desc: '封面、正文、赞藏评一次落齐' },
  { key: 'teardown', title: '顺手拆好五层', desc: '主题钩子结构情绪机制，脚本也一起补上' },
] as const
const idx = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (reduce.value) return
  timer = setInterval(() => (idx.value = (idx.value + 1) % slides.length), 3500)
})
onBeforeUnmount(() => clearInterval(timer))

const hasCover = computed(() => readings.filter((r) => r.coverImage))
/** 没赞藏评的卡（收藏、手工录入）不进画面，否则卡底一排破折号像坏了 */
const measured = (r: (typeof readings)[number]) => !!(r.likes || r.collects || r.comments)
const sample = computed(() => hasCover.value.find(measured) || hasCover.value[0] || null)
const showcase = computed(() => hasCover.value.filter(measured).slice(0, 3))
const teardown = computed(() => readings.find((r) => r.analysis && r.script) || null)
/** 卡里存的拆解正文自带「①主题：」前缀，页面左侧已有标签列，重复的那截去掉 */
const layerText = (raw: string, label: string) => {
  const word = label.replace(/^[①-⑤]\s*/, '')
  return raw.replace(new RegExp(`^[①-⑤]?\\s*${word}\\s*[：:]\\s*`), '')
}
/** 地址栏只展示到笔记 id：小红书链接后面那串 xsec_token 又长又是凭据 */
const noteUrl = computed(() => (sample.value?.url || 'https://www.xiaohongshu.com/explore/…').split('?')[0])

const platforms = [
  { label: '小红书笔记', logo: '小红书' },
  { label: '抖音作品', logo: '抖音' },
  { label: '抖音图文', logo: '抖音' },
  { label: '小红书收藏', logo: '小红书' },
  { label: '抖音收藏', logo: '抖音' },
]

const steps = [
  'Chrome 地址栏打开 chrome://extensions，把右上角「开发者模式」点亮',
  '点「加载已解压的扩展程序」，选工作台的 extension 目录，再把插件固定到工具栏',
  '在小红书笔记页或抖音作品页点插件按钮，一条就进灵感库',
]

const scenes = [
  { icon: IconLayers, title: '照着复刻一版', desc: '采集收尾按五层框架拆好，封面、钩子、结构直接对着做。' },
  { icon: IconChartPie, title: '选题只认实测', desc: '推荐池只用真赞藏评算，每条都带「据 N」的证据编号。' },
  { icon: IconType, title: '图文逐页扒字', desc: '原笔记整组源图存本机，入库当场逐页 OCR 成「## 脚本」。' },
  { icon: IconVideo, title: '视频扒口播稿', desc: '抓源片抽帧认硬字幕，1-5 分钟把全程逐字稿写回卡。' },
  { icon: IconBookmark, title: '收藏也搬进来', desc: '小红书、抖音的收藏夹整表同步，自己发的笔记自动滤掉。' },
  { icon: IconShieldCheck, title: '出处留档再发布', desc: '采集内容只当创作参考；原作者的个人案例一律换成自己的。' },
]

onBeforeUnmount(() => clearTimeout(copyTimer))
</script>

<template>
  <div class="flex flex-col gap-8">
    <!-- ============ 首屏：左演示右说明（照 designkit InspirationGuide 的 53/47 分栏） ============ -->
    <section class="grid min-h-[450px] overflow-hidden rounded-bento border border-line bg-surface shadow-neo lg:grid-cols-[53fr_47fr]">
      <div class="bento-canvas relative flex flex-col items-center justify-center gap-5 bg-accent-soft px-8 py-10">
        <!-- ① 工具栏：把插件固定出来 -->
        <div v-if="idx === 0 && sample" class="w-full max-w-[520px] overflow-hidden rounded-xl border border-line bg-surface shadow-neo-lg">
          <div class="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span class="flex shrink-0 gap-1.5">
              <i class="h-2.5 w-2.5 rounded-full bg-line-strong" />
              <i class="h-2.5 w-2.5 rounded-full bg-line-strong" />
              <i class="h-2.5 w-2.5 rounded-full bg-line-strong" />
            </span>
            <span class="min-w-0 flex-1 truncate rounded-md bg-surface px-2.5 py-1 font-metric text-aux text-ink-3">{{ noteUrl }}</span>
            <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md ring-2 ring-accent" title="创作者增长平台采集">
              <img :src="'/favicon.svg'" alt="" width="18" height="18" class="h-[18px] w-[18px]" />
            </span>
          </div>
          <div class="flex gap-3 p-4">
            <img :src="sample.coverImage" :alt="sample.title" class="h-32 w-[96px] shrink-0 rounded-lg object-cover" />
            <div class="flex min-w-0 flex-col gap-2 pt-1">
              <p class="line-clamp-2 text-sm font-medium leading-5">{{ sample.title }}</p>
              <p class="line-clamp-3 text-aux leading-5 text-ink-3">{{ sample.excerpt }}</p>
              <p class="mt-auto flex items-center gap-1.5 text-aux text-ink-3">
                <PlatformLogo :platform="sample.platform" :size="12" />{{ sample.likes || '—' }} 赞 · {{ sample.collects || '—' }} 藏
              </p>
            </div>
          </div>
        </div>

        <!-- ② 插件弹层：点「采集当前笔记」——这一屏就是 extension/popup.html 本来的样子 -->
        <div v-else-if="idx === 1 && sample" class="w-[320px] overflow-hidden rounded-xl border border-line bg-surface shadow-neo-lg">
          <div class="flex items-center gap-2.5 px-3.5 pb-3 pt-3.5">
            <img :src="'/favicon.svg'" alt="" width="30" height="30" class="h-[30px] w-[30px] shrink-0 rounded-[7px]" />
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">一键采集 · 小红书 / 抖音</p>
              <p class="mt-0.5 flex items-center gap-[5px] text-aux text-success"><i class="h-[5px] w-[5px] rounded-full bg-current" />{{ sample.platform }}笔记页已识别</p>
            </div>
          </div>
          <div class="flex flex-col gap-2.5 px-3.5 pb-3.5">
            <div class="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-aux text-ink-2">
              <span class="flex items-center gap-1.5 font-medium">
                <IconFolder :size="13" class="shrink-0" />写入 · 采集笔记
              </span>
              <span class="font-metric text-[11px] text-ink-3">localhost:5173</span>
            </div>
            <div class="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-accent text-sm font-medium text-accent-ink">
              <IconArrowUpRight :size="15" />采集当前笔记
            </div>
            <div class="rounded-lg border border-line bg-success-soft px-2.5 py-2 text-aux leading-[1.65] text-success">
              已写入 {{ sample.file.split('/').pop() }}
              <span v-if="sample.script">· 脚本 {{ sample.script.length }} 字</span>
            </div>
          </div>
        </div>

        <!-- ③ 灵感库：采回来的样子 -->
        <div v-else-if="idx === 2 && showcase.length" class="flex w-full max-w-[520px] items-end gap-3">
          <div v-for="r in showcase" :key="r.id" class="card !p-0 min-w-0 flex-1 overflow-hidden !shadow-neo-lg">
            <img :src="r.coverImage" :alt="r.title" class="aspect-[3/4] w-full object-cover" />
            <div class="flex flex-col gap-1 p-2.5">
              <p class="line-clamp-2 text-aux font-medium leading-5">{{ r.title }}</p>
              <p class="text-aux text-ink-3">{{ r.likes || '—' }} · {{ r.collects || '—' }} · {{ r.comments || '—' }}</p>
            </div>
          </div>
        </div>

        <!-- ④ 拆解：五层 + 脚本 -->
        <div v-else-if="idx === 3 && teardown" class="w-full max-w-[520px] rounded-xl border border-line bg-surface p-4 shadow-neo-lg">
          <div class="mb-3 flex items-center gap-2">
            <PlatformLogo :platform="teardown.platform" :size="13" />
            <p class="min-w-0 flex-1 truncate text-sm font-medium">{{ teardown.title }}</p>
            <span class="chip !py-0.5 !text-aux">已拆解</span>
          </div>
          <div class="flex flex-col gap-2.5">
            <div v-for="s in ANALYSIS_SECTIONS.slice(0, 3)" :key="s.key" class="flex gap-2.5">
              <span class="shrink-0 text-aux font-medium text-ink-3">{{ s.label }}</span>
              <p class="line-clamp-2 text-aux leading-5 text-ink-2">{{ layerText(teardown.analysis?.[s.key] || '', s.label) }}</p>
            </div>
          </div>
          <div class="mt-3 rounded-lg bg-surface-2 p-2.5">
            <p class="mb-1 text-aux font-medium text-ink-3">脚本</p>
            <p class="line-clamp-2 font-metric text-aux leading-5 text-ink-2">{{ teardown.script.split('\n').find(Boolean) }}</p>
          </div>
        </div>

        <div v-else class="max-w-[380px] text-center text-sm text-ink-3">
          灵感库还没有带封面的卡——照下面三步装好插件，采一条回来这里就有画面了。
        </div>

        <div class="max-w-[420px] text-center">
          <p class="text-[15px] font-semibold">{{ slides[idx].title }}</p>
          <p class="mt-1 text-aux leading-5 text-ink-3">{{ slides[idx].desc }}</p>
        </div>

        <div class="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
          <button
            v-for="(s, i) in slides"
            :key="s.key"
            class="h-[7px] w-[7px] rounded-full transition-colors"
            :class="i === idx ? 'bg-ink' : 'bg-line-strong hover:bg-ink-3'"
            :aria-label="s.title"
            :title="s.title"
            @click="idx = i"
          />
        </div>
      </div>

      <div class="flex flex-col justify-center gap-10 px-6 py-10 lg:px-8">
        <div class="flex flex-col gap-3">
          <h1 class="text-[2rem] font-semibold leading-tight tracking-tight">创作者增长平台采集</h1>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="p in platforms"
              :key="p.label"
              class="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-2 text-sm text-ink-2"
            >
              <PlatformLogo :platform="p.logo" :size="12" />{{ p.label }}
            </span>
          </div>
        </div>

        <ol class="flex flex-col gap-4">
          <li v-for="(s, i) in steps" :key="i" class="flex items-start gap-4">
            <IconCircleCheck :size="18" class="mt-1 shrink-0 text-accent" />
            <span class="text-base leading-[22px] text-ink-2">{{ s }}</span>
          </li>
        </ol>

        <!-- 一颗胶囊四种态（美图同款）：非 Chrome / 未安装 / 刚复制 / 已安装 -->
        <div class="flex flex-wrap items-center gap-3">
          <button
            v-if="cta.kind !== 'stalled'"
            class="flex h-12 items-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-white transition-opacity"
            :class="cta.kind === 'installed' ? 'cursor-default' : 'hover:opacity-85'"
            :disabled="cta.kind === 'installed'"
            @click="onCta"
          >
            <span v-if="cta.kind === 'installed' || cta.kind === 'copied'" class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-success text-white">
              <IconCheck :size="13" />
            </span>
            <IconExternalLink v-else-if="cta.kind === 'browser' || cta.kind === 'client'" :size="15" class="shrink-0" />
            <IconCopy v-else :size="15" class="shrink-0" />
            {{ cta.label }}
          </button>
          <p v-else class="text-sm text-ink-3">这一版跑在网页上，采集插件要回桌面客户端装。</p>
          <button class="btn-ghost !px-2.5" @click="emit('go', 'inspiration')">
            去灵感库看采回来的
            <IconArrowRight :size="15" />
          </button>
        </div>
      </div>
    </section>

    <!-- ============ 采集完能干什么 ============ -->
    <section class="flex flex-col gap-4">
      <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
        <h2 class="text-base font-medium text-ink-2">采回来接着做什么</h2>
        <p class="flex items-center gap-1.5 text-aux text-ink-3">
          <IconShieldCheck :size="15" class="shrink-0" />
          引用内容仅作创作参考，发布前请遵守来源平台规则与版权要求
        </p>
      </div>
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div v-for="s in scenes" :key="s.title" class="card flex flex-col gap-2">
          <p class="flex items-center gap-2 text-[15px] font-medium">
            <component :is="s.icon" :size="15" class="shrink-0 text-ink-2" />
            {{ s.title }}
          </p>
          <p class="text-sm leading-[22px] text-ink-3">{{ s.desc }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
