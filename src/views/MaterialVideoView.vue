<script setup lang="ts">
/** 素材库·视频模板：库里两条来源分开摊——
 *  自己起工程的那每条都指着真存在的 Remotion composition（有代码、有镜头表、渲得出成片）；
 *  从抖音爆款收编来的只是节奏规格，没有工程也不在线渲，靠「复制开工提示词」交给 Agent 照着拍。
 *  与图文模板的差别必须如实摊开：图文的槽位在 json 里，套一下就换皮；
 *  视频的文案与节奏还在各项目代码里，所以这一页给的是「改哪儿 + 怎么渲」。 */
import { computed, ref, watch } from 'vue'
import {
  absorbBroadcasts, candidateVideoTemplates, PLATFORM_META, selectableVideoTemplates, type VideoTemplate,
} from '../data/store'
import { settleVideoCandidate } from '../lib/harvestVideoTemplates'
import { copyToClipboard } from '../utils/clipboard'
import { countText } from '../utils/count'
import DetailModal from '../components/DetailModal.vue'
import FilmPlayer from '../components/FilmPlayer.vue'
import SearchField from '../components/SearchField.vue'
import HarvestVideoModal from '../components/HarvestVideoModal.vue'
import { useToast } from '../lib/useToast'
import { ArrowUp as IconArrowUp, Clapperboard as IconClapperboard, Clock as IconClock, Copy as IconCopy, Flame as IconFlame, Play as IconPlay, Trash2 as IconTrash2 } from 'lucide-vue-next'

const { toast } = useToast()

const ready = computed(() => selectableVideoTemplates())
const cands = computed(() => candidateVideoTemplates())
const all = computed(() => [...ready.value, ...cands.value])
const kinds = computed(() => {
  const seen: string[] = []
  for (const t of all.value) if (t.kind && !seen.includes(t.kind)) seen.push(t.kind)
  return seen
})
const kind = ref('')
const q = ref('')
const sort = ref<'rec' | 'hot'>('rec')
const heatOf = (t: VideoTemplate) => Number(t.source?.heat || 0)

/** 搜索打的是「名字、类型、收自哪条爆款」——商店里挑片子靠这几个词，不是 key */
function matches(t: VideoTemplate, kw: string) {
  const hay = `${t.label} ${t.kind} ${t.source?.title || ''} ${t.composition}`.toLowerCase()
  return hay.includes(kw)
}
function filterBy(arr: VideoTemplate[]) {
  const kw = q.value.trim().toLowerCase()
  const rows = arr.filter((t) => (!kind.value || t.kind === kind.value) && (!kw || matches(t, kw)))
  return sort.value === 'hot'
    ? [...rows].sort((a, b) => heatOf(b) - heatOf(a) || (a.order ?? 99) - (b.order ?? 99))
    : rows
}
/** 推荐按「在架 / 收编来的候选」两栏摊；最热是商店排法，跨两栏按互动分走一屏 */
const groups = computed(() =>
  sort.value === 'hot'
    ? [{ key: 'hot', title: '', items: filterBy(all.value) }]
    : [
        { key: 'ready', title: '', items: filterBy(ready.value) },
        ...(cands.value.length ? [{ key: 'cand', title: '收编来的候选', items: filterBy(cands.value) }] : []),
      ],
)
const filtered = computed(() => !!(kind.value || q.value.trim()))
const list = computed(() => [...ready.value, ...cands.value])

const isCandidate = (t: VideoTemplate) => t.status === 'candidate'
/** 收编来的那条没有工程、没有 composition，转正前后都只是一份节奏规格：
 *  卡片下面给的是拍长和语速，不是分辨率；开工提示词也走节奏那条分支，不看槽位表。 */
const isRhythm = (t: VideoTemplate) => !t.composition
/** 平台在界面上只写中文名，不许露 douyin / xiaohongshu 这种内部 id */
const platformOf = (t: VideoTemplate) => PLATFORM_META[t.source?.platform || '']?.label || '爆款'
const fmtDur = (sec: number) => {
  if (!sec) return '未渲'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
/** 收编来的那条卡片下面给的是节奏读数，不是分辨率——它没有画面，只有拍长和语速 */
const subOf = (t: VideoTemplate) =>
  isRhythm(t)
    ? `${t.structure?.beats || 0} 拍 · ${t.structure?.charsPerSec || 0} 字/秒 · 收自 ${platformOf(t)}`
    : `${(t.size || '').replace('x', ' × ')} · 每秒 ${t.fps} 帧`

/* ---- 详情：存 key 不存对象，转正/删掉引出的一次重建就把整张表换掉 ---- */
const openKey = ref('')
const open = computed(() => all.value.find((t) => t.key === openKey.value) || null)
const detail = computed(() => {
  const t = open.value
  if (!t) return null
  const st = t.structure
  return {
    key: t.key,
    label: t.label,
    note: t.note || '',
    poster: t.posterReady ? t.poster : '',
    preview: t.previewReady ? t.preview : '',
    candidate: isCandidate(t),
    source: t.source ? `${platformOf(t)} · ${t.source.title || t.source.noteId || ''}` : '',
    heat: [t.source?.likes && `${countText(t.source.likes)} 赞`, t.source?.collects && `${countText(t.source.collects)} 藏`, t.source?.comments && `${countText(t.source.comments)} 评`]
      .filter(Boolean)
      .join(' · '),
    hook: st ? `${st.hookSec} 秒 · ${st.hookLines} 句 · ${st.hookChars} 字` : '',
    hookText: st?.hookText || '',
  }
})

/** 视频不在界面里渲（口径见 content/Knowledge/视频创作.md），所以「选一条视频模板开工」
 *  在这条线的落点就是把这条模板的结构交给 Agent——库里的模板由此真的被用起来。
 *  收编来的候选没有工程、没有槽位，给的是节奏读数与那条爆款笔记，让它照着拍一条新的。 */
function kickoffPrompt(t: VideoTemplate): string {
  if (isRhythm(t)) {
    const st = t.structure
    return [
      `你是这个自媒体仓库的创作助手。当前工作目录 = one-person-hub 仓库根。`,
      ``,
      `任务：照一条已被验证的视频爆款节奏，做一条视频。`,
      `- 节奏（从这条爆款的逐字稿时间码上量的）：${st?.durationSec} 秒 ${st?.chars} 字、${st?.beats} 拍，` +
        `语速 ${st?.charsPerSec} 字/秒，平均一拍 ${st?.beatSec} 秒，最长一次停顿 ${st?.maxGap} 秒`,
      `- 开场钩子：前 ${st?.hookSec} 秒说完（${st?.hookLines} 句 ${st?.hookChars} 字）`,
      `- 参考的那条爆款：${platformOf(t)} ${t.source?.title}（${countText(t.source?.likes) || '?'} 赞）${t.source?.url ? ` ${t.source.url}` : ''}`,
      ``,
      `步骤：`,
      `1. 先读 media-hub/content/Knowledge/视频创作.md（铁律与边界）和 media-hub/videos/brand-kit.json（品牌与署名）。`,
      `2. 按那份文档第二节起新工程：init-video-project.mjs 到 media-hub/videos/promo-video-<slug>/（slug 用你要推的那条选题），换上新产品的 brand-kit。`,
      `3. 口播稿自己写，只照上面那个节奏拍：分镜数与每镜时长贴住拍长与停顿，不许抄参考那条的字。`,
      `4. 数字、出处、结论只认你要推的那条选题的来源采集卡和 media-hub 的产品档案，不许凭空编。`,
      `5. 渲完把成片复制到 media-hub/public/videos/<slug>.mp4，并在选题主稿末尾补一行「- 视频素材：public/videos/<slug>.mp4」。`,
      `6. 字幕时间轴用 ffprobe 量真实音频时长；落版带品牌署名与 AI 标识；首帧、中段、落版帧各抽一张核对。`,
    ].join('\n')
  }
  const slots = (t.slots || []).map((s) => `   - ${s.at} → ${s.what}`).join('\n')
  return [
    `你是这个自媒体仓库的创作助手。当前工作目录 = one-person-hub 仓库根。`,
    ``,
    `任务：照「${t.label}」这条模板的结构，做一条视频。`,
    `- 模板：${t.composition}（工程 media-hub/${t.project}）· ${(t.size || '').replace('x', ' × ')} · 每秒 ${t.fps} 帧`,
    `- 这条模板能改的地方：`,
    slots || `   这条没登记槽位表，去 media-hub/${t.project}/src 里读镜头与文案`,
    `- 渲它：${t.render}`,
    ``,
    `步骤：`,
    `1. 先读 media-hub/content/Knowledge/视频创作.md（铁律与边界）和 media-hub/videos/brand-kit.json（品牌与署名）。`,
    `2. 按那份文档第二节起新工程：init-video-project.mjs 到 media-hub/videos/promo-video-<slug>/（slug 用你要推的那条选题），换上新产品的 brand-kit。`,
    `3. 镜头表与文案照上面这条模板的结构改；数字、出处、结论只认你要推的那条选题的来源采集卡脚本和 media-hub 的产品档案，不许凭空编。`,
    `4. 渲完把成片复制到 media-hub/public/videos/<slug>.mp4，并在选题主稿末尾补一行「- 视频素材：public/videos/<slug>.mp4」。`,
    `5. 字幕时间轴用 ffprobe 量真实音频时长；落版带品牌署名与 AI 标识；首帧、中段、落版帧各抽一张核对。`,
  ].join('\n')
}

const copied = ref('')
async function copy(text: string, tag: string) {
  try {
    await copyToClipboard(text)
    copied.value = tag
    setTimeout(() => {
      if (copied.value === tag) copied.value = ''
    }, 1800)
  } catch {
    copied.value = ''
  }
}

/* ---- 收编与候选的去处 ---- */
const harvestOpen = ref(false)
function onHarvested(saved: number, skipped: { id: string; why: string }[]) {
  harvestOpen.value = false
  if (saved) toast(`收进来 ${saved} 条候选${skipped.length ? `，${skipped.length} 条没收` : ''}`, 'ok')
  else if (skipped.length) toast(skipped[0].why, 'fail')
  else harvestOpen.value = false
}

const acting = ref('')
async function settle(t: VideoTemplate, mode: 'promote' | 'drop') {
  if (acting.value) return
  acting.value = `${mode}:${t.key}`
  try {
    const r = await settleVideoCandidate(mode, t.key)
    toast(mode === 'promote' ? `「${r.label}」已转正进可选` : `已删掉「${r.label}」`, 'ok')
    if (mode === 'drop') openKey.value = ''
  } catch (e) {
    toast(String((e as Error).message || e), 'fail')
  } finally {
    acting.value = ''
  }
}

/* 开着详情或正在办转正/删掉时，把重建广播吸成就地换表：否则刚点完，迟到的第二条广播
   会把整页刷掉，弹层和刚写完的状态一起没（同图文那页）。 */
let releaseAbsorb: (() => void) | null = null
watch(
  () => !!(openKey.value || acting.value),
  (on) => {
    if (on && !releaseAbsorb) releaseAbsorb = absorbBroadcasts()
    else if (!on && releaseAbsorb) {
      releaseAbsorb()
      releaseAbsorb = null
    }
  },
)
</script>

<template>
  <div class="flex flex-col gap-4 pb-10">
    <div class="station-toolbar">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜模板" label="搜索视频模板" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <button class="btn-ghost !px-2" aria-label="从爆款收进来" title="从爆款收进来" @click="harvestOpen = true">
            <IconFlame :size="15" />
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <button class="seg" :class="!kind && 'is-selected'" @click="kind = ''">全部类型</button>
          <button v-for="k in kinds" :key="k" class="seg" :class="kind === k && 'is-selected'" @click="kind = k">
            {{ k }}
          </button>
        </div>
        <div class="ml-auto flex items-center gap-1.5">
          <button class="seg" :class="sort === 'rec' && 'is-selected'" @click="sort = 'rec'">推荐</button>
          <button class="seg" :class="sort === 'hot' && 'is-selected'" @click="sort = 'hot'">最热</button>
        </div>
      </div>
    </div>

    <div v-if="!list.length" class="rounded-bento border border-line bg-surface px-6 py-10 text-center">
      <IconClapperboard :size="28" class="mx-auto text-ink-3" />
      <p class="mt-3 text-sm text-ink-2">{{ filtered ? '没有对得上的模板' : '还没有登记任何视频模板' }}</p>
    </div>

    <section v-else class="flex flex-col gap-6">
      <div v-for="g in groups" :key="g.key" class="flex flex-col gap-2">
        <p v-if="g.title" class="text-aux text-ink-3">{{ g.title }}</p>
        <div v-if="g.items.length" class="grid gap-4 md:grid-cols-2">
          <div
            v-for="t in g.items"
            :key="t.key"
            class="vcard overflow-hidden rounded-bento border bg-surface shadow-neo"
            :class="isCandidate(t) ? 'border-dashed border-line' : 'border-line'"
          >
            <button class="block w-full text-left" @click="openKey = t.key">
              <span class="poster relative block bg-surface-2">
                <img v-if="t.posterReady" :src="t.poster" :alt="t.label" class="h-full w-full object-cover" loading="lazy" />
                <span v-else class="flex h-full w-full items-center justify-center text-aux text-ink-3">
                  <IconClapperboard :size="22" class="mr-1.5" />
                  {{ isRhythm(t) ? '只有节奏，没有画面' : '这条还没渲过' }}
                </span>
                <span
                  v-if="t.source?.likes"
                  class="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-[rgba(17,14,23,0.72)] px-2 py-0.5 font-metric text-[12px] tabular-nums text-[#F5FBFF]"
                >
                  <IconFlame :size="11" />{{ countText(t.source.likes) }}
                </span>
                <span
                  v-else-if="t.posterReady"
                  class="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-[rgba(17,14,23,0.72)] px-2 py-0.5 font-metric text-[12px] tabular-nums text-[#F5FBFF]"
                >
                  <IconPlay :size="11" />{{ fmtDur(t.durationSec) }}
                </span>
              </span>
              <span class="flex flex-col gap-1 px-4 py-3">
                <span class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium text-ink">{{ t.label }}</span>
                  <span v-if="t.kind" class="chip shrink-0">{{ t.kind }}</span>
                </span>
                <span class="truncate text-aux text-ink-3">{{ subOf(t) }}</span>
              </span>
            </button>
            <span v-if="isCandidate(t)" class="flex items-center gap-1 border-t border-line px-3 py-1">
              <button
                class="btn-ghost flex !px-2 !py-0.5 items-center gap-1"
                :disabled="!!acting"
                title="放进在架列表，开视频时从它复制开工提示词"
                @click="settle(t, 'promote')"
              >
                <IconArrowUp :size="13" class="shrink-0" />转正
              </button>
              <button
                class="btn-ghost flex !px-2 !py-0.5 items-center gap-1"
                :disabled="!!acting"
                title="删掉这条收编来的候选"
                @click="settle(t, 'drop')"
              >
                <IconTrash2 :size="13" class="shrink-0" />删掉
              </button>
            </span>
          </div>
        </div>
      </div>
    </section>

    <DetailModal v-if="detail" @close="openKey = ''">
      <template #title>{{ detail.label }}</template>
      <div class="flex flex-col gap-4">
        <FilmPlayer v-if="detail.preview" :src="detail.preview" />
        <img v-else-if="detail.poster" :src="detail.poster" :alt="detail.label" class="w-full rounded-inset border border-line" />

        <dl v-if="detail.candidate" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="shrink-0 text-ink-3">收自</dt>
          <dd class="min-w-0">{{ detail.source }}</dd>
          <dt class="shrink-0 text-ink-3">当时热度</dt>
          <dd class="min-w-0 tabular-nums">{{ detail.heat || '—' }}</dd>
          <dt class="shrink-0 text-ink-3">开场钩子</dt>
          <dd class="min-w-0">
            <span class="tabular-nums">{{ detail.hook }}</span>
            <span v-if="detail.hookText" class="mt-1 block text-sm leading-5 text-ink-2">{{ detail.hookText }}</span>
          </dd>
        </dl>

        <div class="flex flex-wrap items-center gap-2">
          <button
            class="btn btn-primary !px-3 !py-1.5 flex items-center gap-1.5"
            @click="open && copy(kickoffPrompt(open), `kick:${open.key}`)"
          >
            <IconCopy :size="13" />
            {{ copied === `kick:${open?.key}` ? '已复制' : '复制开工提示词' }}
          </button>
          <template v-if="detail.candidate">
            <button class="btn !px-3 !py-1.5 flex items-center gap-1.5" :disabled="!!acting" @click="open && settle(open, 'promote')">
              <IconArrowUp :size="13" />转正进可选
            </button>
            <button class="btn !px-3 !py-1.5 flex items-center gap-1.5" :disabled="!!acting" @click="open && settle(open, 'drop')">
              <IconTrash2 :size="13" />删掉这条收编
            </button>
          </template>
        </div>

        <p v-if="detail.note" class="text-sm leading-5 text-red-600">{{ detail.note }}</p>
      </div>
    </DetailModal>

    <HarvestVideoModal v-if="harvestOpen" @close="harvestOpen = false" @done="onHarvested" />
  </div>
</template>

<style scoped>
.vcard:hover {
  transform: translateY(-2px);
  transition: transform 0.14s ease;
}
.poster {
  aspect-ratio: 16 / 9;
}
</style>
