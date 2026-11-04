<script setup lang="ts">
/** 素材库·图文模板：把在架模板摊成一整屏能挑的画廊，第一眼给的是封面小样。
 *  与创作台那个选择器的分工：这一页回答「有什么、这条凭什么算被验证过」，
 *  选择器回答「这一稿换哪条」。所以这页只有三种写：补渲小样、候选转正/删掉、从爆款批量收编；
 *  「用到创作台」把模板带回稿子，改哪几页、重渲几页仍回创作台算。 */
import { computed, ref, watch } from 'vue'
import {
  absorbBroadcasts, cardLayoutByName, cardThemes, candidateCardTemplates, materialTemplatePick, PLATFORM_META,
  selectableCardTemplates, type CardTemplate,
} from '../data/store'
import { renderTemplateThumbs } from '../lib/useTemplateThumbs'
import { settleCloneVisual } from '../lib/cloneVisual'
import { countText } from '../utils/count'
import DetailModal from '../components/DetailModal.vue'
import SearchField from '../components/SearchField.vue'
import HarvestModal from '../components/HarvestModal.vue'
import { useToast } from '../lib/useToast'
import { ArrowUp as IconArrowUp, Flame as IconFlame, Image as IconImage, MousePointerClick as IconCursor, RotateCw as IconRotateCw, Trash2 as IconTrash2 } from 'lucide-vue-next'

const emit = defineEmits<{ go: [id: string] }>()
const { toast } = useToast()

const allTemplates = computed(() => [...selectableCardTemplates(), ...candidateCardTemplates()])
/** 形态词表与 config/card-templates.json 的 shape 同源，界面上只列真出现的，避免出现筛不满的档 */
const shapes = computed(() => {
  const seen: string[] = []
  for (const t of allTemplates.value) for (const s of t.shape || []) if (!seen.includes(s)) seen.push(s)
  return seen
})
const shape = ref('')
const q = ref('')
const sort = ref<'rec' | 'hot'>('rec')
const themeOf = (t: CardTemplate) => cardThemes.themes.find((x) => x.key === t.theme)
const layoutLabel = (name?: string) => (name ? cardLayoutByName(name)?.label || name : '—')
/** 收编来的那条爆款有多热：在架的手调模板没有这个数，不硬凑一个 0 出来 */
const heatOf = (t: CardTemplate) => Number(t.source?.heat || 0)

/** 搜索打的是「名字、皮肤、形态、收自哪条爆款」——画廊里挑东西靠的是这几个词，不是 key */
function matches(t: CardTemplate, kw: string) {
  const hay = `${t.label} ${themeOf(t)?.label || ''} ${(t.shape || []).join(' ')} ${t.source?.title || ''}`.toLowerCase()
  return hay.includes(kw)
}
const filterBy = (arr: CardTemplate[]) => {
  const kw = q.value.trim().toLowerCase()
  const rows = arr.filter(
    (t) => (!shape.value || (t.shape || []).includes(shape.value)) && (!kw || matches(t, kw)),
  )
  return sort.value === 'hot' ? [...rows].sort((a, b) => heatOf(b) - heatOf(a) || (a.order ?? 99) - (b.order ?? 99)) : rows
}
const list = computed(() => filterBy(selectableCardTemplates()))
const cands = computed(() => filterBy(candidateCardTemplates()))
const filtered = computed(() => !!(shape.value || q.value.trim()))
const isCandidate = (t: CardTemplate) => t.status === 'candidate'
/** 推荐按「在架 / 收编来的候选」两栏摊，候选是要人点头的那批，得跟能直接选的分开；
 *  最热是商店排法：跨两栏按互动分从高到低走一屏，库里最狠的那几条第一眼就能看见。 */
const groups = computed(() =>
  sort.value === 'hot'
    ? [{ key: 'hot', title: '', items: filterBy(allTemplates.value) }]
    : [
        { key: 'active', title: '', items: list.value },
        ...(cands.value.length ? [{ key: 'cand', title: '收编来的候选', items: cands.value }] : []),
      ],
)

/* ---- 小样状态：读的是 build-data 算好的 manifest 结论，本地只多记「刚补渲完」那几条 ---- */
const localStatus = ref<Record<string, string>>({})
const bust = ref<Record<string, number>>({})
const statusOf = (t: CardTemplate) => localStatus.value[t.key] || t.thumb?.status || 'missing'
/** 第一眼给封面：素材库这一屏是按封面点开的，只给正文页等于把最能打的那张藏起来 */
const firstThumb = (t: CardTemplate) => t.coverThumb || t.thumb?.url || ''
const srcOf = (url: string, key: string) => (url || '') + (bust.value[key] ? `?v=${bust.value[key]}` : '')

const busy = ref('')
const status = ref('')
const staleKeys = computed(() => allTemplates.value.filter((t) => statusOf(t) !== 'ready').map((t) => t.key))

async function renderStale(keys: string[]) {
  if (!keys.length || busy.value) return
  busy.value = keys.join(',')
  status.value = ''
  try {
    const { rendered, failed } = await renderTemplateThumbs(keys)
    const ts = Date.now()
    for (const k of rendered) {
      localStatus.value = { ...localStatus.value, [k]: 'ready' }
      bust.value = { ...bust.value, [k]: ts }
    }
    busy.value = ''
    if (failed.length) throw new Error(failed.map((f) => `${f.key}：${f.error}`).join('；'))
  } catch (e) {
    busy.value = ''
    status.value = String((e as Error).message || e)
  }
}

/* ---- 批量收编：从采集回来的图文爆款里勾几条，逐条读皮进候选 ---- */
const harvestOpen = ref(false)
function onHarvested(saved: number, dup: number) {
  harvestOpen.value = false
  if (saved && dup) toast(`收进来 ${saved} 条候选，${dup} 条库里已有`, 'ok')
  else if (saved) toast(`收进来 ${saved} 条候选`, 'ok')
  else if (dup) toast(`库里已有 ${dup} 条同皮同排法`, 'ok')
}

/* ---- 详情：一次只摊开一条，图、皮、三个角色的版式、凭什么选它 ----
   存的是 key 不是对象：转正/删掉引出的一次重建就把整张表换掉，攥着旧对象看的是已经不在了的那份 */
const openKey = ref('')
const open = computed(() => allTemplates.value.find((t) => t.key === openKey.value) || null)
const detail = computed(() => {
  const t = open.value
  if (!t) return null
  const th = themeOf(t)
  return {
    key: t.key,
    label: t.label,
    pick: t.pick || '',
    source: t.source ? `${PLATFORM_META[t.source.platform || '']?.label || '克隆'} · ${t.source.title || t.source.noteId || ''}` : '',
    heat: t.source?.likes || t.source?.comments ? [
      t.source.likes ? `${countText(t.source.likes)} 赞` : '',
      t.source.collects ? `${countText(t.source.collects)} 藏` : '',
      t.source.comments ? `${countText(t.source.comments)} 评` : '',
    ].filter(Boolean).join(' · ') : '',
    themeLabel: th?.label || t.theme,
    themeWhy: th?.why || '',
    swatches: ['--page', '--ink', '--accent'].map((k) => th?.tokens?.[k] || 'transparent'),
    layouts: ['cover', 'body', 'closing'].map((r) => layoutLabel(t.layouts?.[r as 'cover'])).join(' · '),
    shapes: (t.shape || []).join(' · '),
    ready: statusOf(t) === 'ready',
    shots: t.coverThumb
      ? [{ cap: '封面', url: srcOf(t.coverThumb, t.key) }, { cap: '正文', url: srcOf(t.thumb?.url || '', t.key) }]
      : [{ cap: '正文', url: srcOf(t.thumb?.url || '', t.key) }],
  }
})

function useInStudio(t: CardTemplate) {
  materialTemplatePick.value = t.key
  openKey.value = ''
  emit('go', 'studio-image')
}

/* ---- 候选的去处只有两个：转正进在架，或连它独占的那层皮一起删掉 ----
   收进来的东西在这页只有看和挑的份，想让它上货架或反悔删掉得在这原地办完，
   否则等于把人往「只能改配置文件」的死路里逼。 */
const acting = ref('')
const isClone = (t: CardTemplate | null) => !!t && (!!t.source || t.status === 'candidate')
async function settle(t: CardTemplate, mode: 'promote' | 'drop') {
  if (acting.value) return
  acting.value = `${mode}:${t.key}`
  status.value = ''
  try {
    await settleCloneVisual(mode, t.key)
    status.value = mode === 'promote' ? `「${t.label}」已转正进在架` : `已删掉「${t.label}」`
    if (mode === 'drop') openKey.value = ''
  } catch (e) {
    status.value = String((e as Error).message || e)
  } finally {
    acting.value = ''
  }
}

/* ---- 补渲和转正/删掉都会引出重建：这一屏摊着详情或小样进度时把广播吸成就地换表，
   否则刚点完转正，迟到的第二条广播把整页刷掉，状态文案和刚开的详情一起没（同 TemplatePicker）。 ---- */
let releaseAbsorb: (() => void) | null = null
watch(
  () => !!(openKey.value || busy.value),
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
        <SearchField v-model="q" placeholder="搜模板" label="搜索图文模板" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <button class="btn-ghost !px-2" aria-label="从爆款收进来" title="从爆款收进来" @click="harvestOpen = true">
            <IconFlame :size="15" />
          </button>
          <button
            v-if="staleKeys.length"
            class="btn-ghost !px-2"
            :class="busy ? 'opacity-60' : ''"
            :disabled="!!busy"
            aria-label="补渲小样"
            title="补渲小样"
            @click="renderStale(staleKeys)"
          >
            <IconRotateCw :size="15" :class="busy ? 'animate-spin' : ''" />
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <button class="seg" :class="!shape && 'is-selected'" @click="shape = ''">全部形态</button>
          <button v-for="s in shapes" :key="s" class="seg" :class="shape === s && 'is-selected'" @click="shape = s">
            {{ s }}
          </button>
        </div>
        <div class="ml-auto flex items-center gap-1.5">
          <button class="seg" :class="sort === 'rec' && 'is-selected'" @click="sort = 'rec'">推荐</button>
          <button class="seg" :class="sort === 'hot' && 'is-selected'" @click="sort = 'hot'">最热</button>
        </div>
      </div>
    </div>

    <p v-if="status" class="chip !h-auto !whitespace-normal !px-3 !py-2 text-sm leading-5">{{ status }}</p>

    <div v-if="!list.length && !cands.length" class="rounded-bento border border-line bg-surface px-6 py-10 text-center">
      <IconImage :size="28" class="mx-auto text-ink-3" />
      <p class="mt-3 text-sm text-ink-2">
        {{ filtered ? '没有对得上的模板' : '模板目录是空的' }}
      </p>
    </div>

    <section v-else class="flex flex-col gap-6">
      <div v-for="g in groups" :key="g.key" class="flex flex-col gap-2">
        <p v-if="g.title" class="text-aux text-ink-3">{{ g.title }}</p>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <div
            v-for="t in g.items"
            :key="t.key"
            class="tcard overflow-hidden rounded-bento border bg-surface shadow-neo"
            :class="isCandidate(t) ? 'border-dashed border-line' : 'border-line'"
          >
            <button class="block w-full text-left" @click="openKey = t.key">
              <span class="thumb block">
                <img v-if="statusOf(t) === 'ready'" :src="srcOf(firstThumb(t), t.key)" :alt="t.label" loading="lazy" />
                <span v-else class="placeholder">
                  <IconImage :size="22" />
                  {{ statusOf(t) === 'stale' ? '小样过期' : '未渲染' }}
                </span>
                <span v-if="t.source?.likes" class="heat">
                  <IconFlame :size="13" />{{ countText(t.source.likes) }}
                </span>
              </span>
              <span class="flex flex-col gap-0.5 px-3 py-2.5">
                <span class="truncate text-sm font-medium text-ink">{{ t.label }}</span>
                <span class="truncate text-aux text-ink-3">
                  <template v-if="isCandidate(t)">收自 {{ t.source?.platform || '参考图' }}</template>
                  <template v-else>
                    {{ (t.shape || []).join(' · ') }}<template v-if="themeOf(t)"> · {{ themeOf(t)!.label }}</template>
                  </template>
                </span>
              </span>
            </button>
            <span v-if="isCandidate(t)" class="flex items-center gap-1 border-t border-line px-2 py-1">
              <button
                class="btn-ghost flex !px-2 !py-0.5 items-center gap-1"
                :disabled="!!acting"
                title="放进在架模板，以后所有稿子都能选它"
                @click="settle(t, 'promote')"
              >
                <IconArrowUp :size="13" class="shrink-0" />转正
              </button>
              <button
                class="btn-ghost flex !px-2 !py-0.5 items-center gap-1"
                :disabled="!!acting"
                title="删掉这条候选，只属于它的那层皮一起清"
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
        <div class="grid grid-cols-2 gap-3">
          <figure v-for="shot in detail.shots" :key="shot.cap" class="m-0">
            <div class="thumb overflow-hidden rounded-inset border border-line">
              <img v-if="detail.ready" :src="shot.url" :alt="shot.cap" />
              <span v-else class="placeholder">
                <IconImage :size="22" />
                <button class="btn !px-2.5 !py-1" :disabled="!!busy" @click="renderStale([detail.key])">
                  <IconRotateCw :size="13" />补渲这条
                </button>
              </span>
            </div>
            <figcaption class="mt-1.5 text-aux text-ink-3">{{ shot.cap }}</figcaption>
          </figure>
        </div>

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="shrink-0 text-ink-3">皮肤</dt>
          <dd class="flex flex-wrap items-center gap-2">
            <span
              v-for="(c, i) in detail.swatches"
              :key="i"
              class="inline-block h-4 w-4 rounded-full border border-line"
              :style="{ background: c }"
            />
            {{ detail.themeLabel }}
          </dd>
          <dt class="shrink-0 text-ink-3">版式</dt>
          <dd class="min-w-0">{{ detail.layouts }}</dd>
          <dt class="shrink-0 text-ink-3">形态</dt>
          <dd class="min-w-0">{{ detail.shapes }}</dd>
          <template v-if="detail.source">
            <dt class="shrink-0 text-ink-3">收自</dt>
            <dd class="min-w-0 truncate">{{ detail.source }}</dd>
          </template>
          <template v-if="detail.heat">
            <dt class="shrink-0 text-ink-3">当时热度</dt>
            <dd class="flex min-w-0 items-center gap-1.5 tabular-nums">
              <IconFlame :size="15" class="shrink-0 text-orange-400" />
              {{ detail.heat }}
            </dd>
          </template>
        </dl>

        <p v-if="detail.pick" class="rounded-inset bg-surface-2 px-3 py-2.5 text-sm leading-5 text-ink-2">
          {{ detail.pick }}
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <button
            class="btn btn-primary !px-3 !py-1.5 flex items-center gap-1.5"
            @click="open && useInStudio(open)"
          >
            <IconCursor :size="13" />
            用到创作台
          </button>
          <template v-if="isClone(open)">
            <button
              class="btn !px-3 !py-1.5 flex items-center gap-1.5"
              :disabled="!!acting"
              @click="open && settle(open, 'promote')"
            >
              <IconArrowUp :size="13" />转正进在架
            </button>
            <button
              class="btn-ghost ml-auto !px-2.5 !py-1 !text-red-600 flex items-center gap-1.5"
              :disabled="!!acting"
              @click="open && settle(open, 'drop')"
            >
              <IconTrash2 :size="13" />删掉这条收编
            </button>
          </template>
        </div>
      </div>
    </DetailModal>

    <HarvestModal v-if="harvestOpen" @close="harvestOpen = false" @done="onHarvested" />
  </div>
</template>

<style scoped>
.tcard:hover {
  transform: translateY(-2px);
  transition: transform 0.14s ease;
}
.thumb {
  position: relative;
  aspect-ratio: 1242 / 1660;
  background: var(--app-surface-2, #f2f2f2);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
  display: block;
}
.placeholder {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: var(--app-ink-3, #999);
}
/* 收编来的模板把源笔记的点赞数钉在封面上：这一屏是按「它爆过」挑的，不点亮等于白收 */
.heat {
  position: absolute;
  bottom: 6px;
  left: 6px;
  display: flex;
  align-items: center;
  gap: 3px;
  border-radius: 999px;
  background: rgba(17, 14, 23, 0.72);
  padding: 1px 7px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #f5fbff;
}
</style>
