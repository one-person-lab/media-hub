<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { knowledge, TODAY, type KnowledgeDoc, type MdBlock } from '../data/store'
import PageHeader from '../components/PageHeader.vue'
import SearchField from '../components/SearchField.vue'
import MdBlockView from '../components/MdBlockView.vue'
import { copyToClipboard } from '../utils/clipboard'
import { useToast } from '../lib/useToast'
import { Copy as IconCopy, Search as IconSearch, Sparkles as IconSparkles, User as IconUser } from 'lucide-vue-next'

/**
 * 知识库（2026-11-02 照 11-01 界面语言重做）：左册目 / 中一张纸 / 右本页小节。
 * 左栏的行一律走侧栏那套（40px 行、10px 圆角、不画线、靠底色分层）；
 * 正文落在白卡上读，不再让背景点阵压在字后面。
 * 搜索命中的是小节，点一条直接翻到那一篇的那一节。
 * 数据是只读投影：要改内容去 content/Knowledge/ 改 md（R1 唯一知识源）。
 */

const active = ref(0)
const doc = computed(() => knowledge[active.value] ?? null)
const query = ref('')
const activeSec = ref(0)

const { toast } = useToast()

/* ---------------- 搜索：册目 / 小节名 / 正文，命中到小节 ---------------- */

interface Hit {
  k: KnowledgeDoc
  index: number
  secs: { name: string; i: number }[]
}

function blockText(blocks: MdBlock[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (b.text) out.push(b.text)
    if (b.items) out.push(...b.items)
    if (b.head) out.push(...b.head)
    if (b.rows) out.push(...b.rows.flat())
  }
  return out
}

const docText = (k: KnowledgeDoc) =>
  [k.title, ...blockText(k.intro), ...k.sections.flatMap((s) => [s.name, ...blockText(s.blocks)])].join('\n')

const hits = computed<Hit[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const out: Hit[] = []
  knowledge.forEach((k, index) => {
    if (!needle) {
      out.push({ k, index, secs: [] })
      return
    }
    const secs = k.sections
      .map((s, i) => ({ name: s.name, i, text: `${s.name}\n${blockText(s.blocks)}`.toLowerCase() }))
      .filter((s) => s.text.includes(needle))
      .map(({ name, i }) => ({ name, i }))
    const atHead = `${k.title}\n${blockText(k.intro)}`.toLowerCase().includes(needle)
    if (atHead || secs.length) out.push({ k, index, secs })
  })
  return out
})

/* ---------------- 文档头读数：更新于 / 读完用时 ---------------- */

const wordCount = computed(() => (doc.value ? docText(doc.value).replace(/\s/g, '').length : 0))
const readMinutes = computed(() => Math.max(1, Math.round(wordCount.value / 400)))
const daysAgo = computed(() => {
  const u = doc.value?.updated
  if (!u) return null
  return Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${u}T00:00:00Z`)) / 86_400_000)
})

async function copyMd() {
  if (!doc.value) return
  try {
    const resp = await fetch(`/__knowledge-md?file=${encodeURIComponent(doc.value.file)}`, { cache: 'no-store' })
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`)
    await copyToClipboard(await resp.text())
    toast('已复制 MD 原文', 'ok')
  } catch (e) {
    toast(`复制失败：${(e as Error).message}`, 'fail')
  }
}

/** 「账号简介」是整段要贴到各平台主页的产物：从引用块里取纯正文，单独给一个复制口（MD 原文带「> 」，贴过去是脏的） */
const bio = computed(() => {
  const sec = doc.value?.sections.find((s) => s.name === '账号简介')
  if (!sec) return ''
  return sec.blocks
    .filter((b) => b.t === 'quote')
    .map((b) => b.text || '')
    .join('\n')
    .trim()
})

async function copyBio() {
  try {
    await copyToClipboard(bio.value)
    toast('已复制账号简介', 'ok')
  } catch (e) {
    toast(`复制失败：${(e as Error).message}`, 'fail')
  }
}

/* ---------------- 右栏小节：scroll-spy + 点击平滑滚动 ---------------- */

function spy() {
  const n = doc.value?.sections.length ?? 0
  let cur = 0
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(`kb-sec-${i}`)
    if (el && el.getBoundingClientRect().top <= 148) cur = i
  }
  activeSec.value = cur
}

function scrollToSec(i: number) {
  const el = document.getElementById(`kb-sec-${i}`)
  if (!el) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  activeSec.value = i
}

/** 从搜索结果翻到某一篇的某一节：先换篇，等正文挂上再滚过去 */
function openSec(index: number, i: number) {
  if (active.value === index) scrollToSec(i)
  else {
    active.value = index
    nextTick(() => scrollToSec(i))
  }
}

// 整个视口不滚，主区（App.vue 的 <main>）是唯一滚动容器——监听它
let main: HTMLElement | null = null
onMounted(() => {
  main = document.querySelector('main')
  main?.addEventListener('scroll', spy, { passive: true })
  spy()
})
onBeforeUnmount(() => main?.removeEventListener('scroll', spy))

// 换文档：回顶上、小节复位（滚动位置是主区共享的，不重置会停在上一篇的深处）
watch(active, () => {
  activeSec.value = 0
  main?.scrollTo({ top: 0 })
  nextTick(spy)
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <PageHeader title="知识库" />

    <div class="flex flex-col items-start gap-5 lg:flex-row lg:gap-6">
      <!-- 左栏：册目。行、分组标签、选中态全照侧栏那一套（SideNav.vue），不画一条线；
           搜索钉在栏顶，只有册目自己滚。 -->
      <nav
        class="flex w-full shrink-0 flex-col gap-2 lg:sticky lg:top-[var(--page-header-h,0px)] lg:max-h-[calc(100vh-var(--page-header-h,0px)-1rem)] lg:w-[240px]"
      >
        <SearchField v-model="query" placeholder="搜标题、小节或正文…" label="搜索知识库" class="!max-w-none" />

        <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2">
          <div class="flex flex-col gap-0.5">
            <template v-for="{ k, index, secs } in hits" :key="k.file">
              <button
                class="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-sm transition-colors duration-150"
                :class="active === index ? 'is-selected' : 'font-normal text-ink-2 hover:bg-surface-2/70 hover:text-ink'"
                @click="active = index"
              >
                <span class="truncate">{{ k.title }}</span>
                <span
                  class="ml-2 shrink-0 text-xs tabular-nums lg:ml-auto"
                  :class="active === index ? 'text-ink-2' : 'text-ink-3'"
                >{{ k.sections.length }} 节</span>
              </button>

              <!-- 搜索命中到小节：点一条直接翻到那一篇的那一节 -->
              <button
                v-for="s in secs"
                :key="`${k.file}-${s.i}`"
                class="flex w-full items-center rounded-[8px] py-1 pl-6 pr-3 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-2/70 hover:text-ink"
                @click="openSec(index, s.i)"
              >
                <span class="truncate">{{ s.name }}</span>
              </button>
            </template>
          </div>

          <div
            v-if="query.trim() && !hits.length"
            class="flex items-center gap-2 rounded-inset border border-dashed border-line px-3 py-2.5"
          >
            <IconSearch :size="15" class="shrink-0 text-ink-3" />
            <span class="min-w-0 truncate text-sm text-ink-2">没有「{{ query.trim() }}」</span>
          </div>
        </div>
      </nav>

      <!-- 中栏：一篇文档一张纸。正文落在白卡上，背景点阵退到卡外面 -->
      <article v-if="doc" class="card !px-7 min-w-0 max-w-[860px] flex-1 sm:!px-11 !py-9">
        <header class="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div class="min-w-0 flex-1">
            <h2 class="text-[21px] leading-8 font-semibold tracking-[-0.015em] text-ink">{{ doc.title }}</h2>
            <div class="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-aux text-ink-3">
              <span
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium"
                :class="doc.ai === false ? 'bg-surface-2 text-ink-2' : 'bg-accent-soft text-accent'"
                :title="doc.ai === false ? '只给自己看' : '创作时会自动参考'"
              >
                <component :is="doc.ai === false ? IconUser : IconSparkles" :size="13" />
                {{ doc.ai === false ? '仅自己看' : 'AI 可读' }}
              </span>
              <span v-if="doc.updated">
                更新于 {{ doc.updated }}<span v-if="daysAgo !== null && daysAgo >= 0 && daysAgo <= 30" class="text-ink-3">
                  （{{ daysAgo === 0 ? '今天' : `${daysAgo} 天前` }}）</span
                >
              </span>
              <span class="text-ink-3">·</span>
              <span>约 {{ readMinutes }} 分钟读完</span>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button v-if="bio" class="btn-ghost !px-2 !py-1 text-ink-2" title="复制账号简介（去掉引用符号的纯正文）" @click="copyBio">
              <IconCopy :size="15" />
              复制简介
            </button>
            <button class="btn-ghost !px-2 !py-1 text-ink-2" title="复制这篇知识的 markdown 原文" @click="copyMd">
              <IconCopy :size="15" />
              复制原文
            </button>
          </div>
        </header>

        <!-- 引言：这篇讲什么 -->
        <div v-if="doc.intro.length" class="mt-7 flex flex-col gap-3.5">
          <MdBlockView v-for="(b, i) in doc.intro" :key="`intro-${i}`" :b="b" />
        </div>

        <!-- 小节：id 供右栏锚定与 scroll-spy；标题与正文的间距大于小节之间留白的一半 -->
        <section
          v-for="(s, i) in doc.sections"
          :id="`kb-sec-${i}`"
          :key="s.name"
          class="scroll-mt-[calc(var(--page-header-h,0px)+1rem)] pt-10"
        >
          <h3 class="text-[17px] leading-6 font-semibold tracking-[-0.005em] text-ink">{{ s.name }}</h3>
          <div class="mt-4 flex min-w-0 flex-col gap-3.5">
            <MdBlockView v-for="(b, j) in s.blocks" :key="`${i}-${j}`" :b="b" />
          </div>
        </section>
      </article>
      <div v-else class="card flex min-w-0 flex-1 items-center gap-2 !px-3.5 !py-2.5 text-sm text-ink-2">
        知识库还是空的
      </div>

      <!-- 右栏：本页小节（宽屏才出；高亮跟滚动走）。选中用底色，不画那条竖线 -->
      <aside
        v-if="doc && doc.sections.length"
        class="sticky top-[var(--page-header-h,0px)] hidden w-[176px] shrink-0 flex-col xl:flex"
      >
        <div class="px-2.5 pb-1.5 text-xs tracking-[0.12em] text-ink-3/80">本页小节</div>
        <nav class="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          <button
            v-for="(s, i) in doc.sections"
            :key="`toc-${i}`"
            class="rounded-[8px] px-2.5 py-1.5 text-left text-[13px] leading-5 transition-colors"
            :class="activeSec === i ? 'is-selected' : 'text-ink-2 hover:bg-surface-2/70 hover:text-ink'"
            @click="scrollToSec(i)"
          >
            <span class="line-clamp-2">{{ s.name }}</span>
          </button>
        </nav>
      </aside>
    </div>
  </div>
</template>
