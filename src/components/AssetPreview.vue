<script setup lang="ts">
/** 创作成果预览：图文把渲染出来的卡片页一次摊成网格（点一格放大，← → 翻页，Esc 关），视频有素材就真播、没素材就直说。
 *  图来自 public/cards/<slug>/（render-cards 的产物）。
 *  「编辑图卡」直接改卡片 json 的文字并原地重渲改动页——改一个字不用回终端。 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import type { Article } from '../data/store'
import { setHoldAutoRefresh, cardLayoutByName, materialTemplatePick, type CardIntent, type CardTemplate } from '../data/store'
import { pageTextFields, applyField } from '../lib/cardFields'
import { designState, applyTemplate } from '../lib/cardDesign'
import TemplatePicker from './TemplatePicker.vue'
import FilmPlayer from './FilmPlayer.vue'
import IntentModal from './IntentModal.vue'
import { Clapperboard as IconClapperboard, Images as IconImages, Layers as IconLayers, Palette as IconPalette, Pencil as IconPencil, SlidersVertical as IconSlidersVertical, Tag as IconTag, X as IconX } from 'lucide-vue-next'

/** bare：外层已经是一张卡了（创作台右栏），自己不再描一圈边。 */
const props = defineProps<{ article: Article; bare?: boolean }>()

const card = computed(() => props.article.card)
const pages = computed(() => card.value?.urls ?? [])

const at = ref(0)
/** 放大看的那一页：-1=没开 */
const zoom = ref(-1)
const picker = ref(false)
/** 从素材库带过来的模板：选择器一开就停在它上面 */
const pickerPreset = ref('')
const settings = ref(false)

/* 图重渲后同名覆盖，浏览器会拿旧缓存——按页号打时间戳破缓存 */
const bust = ref<Record<number, number>>({})
const imgSrc = (i: number) => pages.value[i] + (bust.value[i] ? `?v=${bust.value[i]}` : '')

/** 哪些页的图到货了：没到货的那格按比例亮骨架屏，不许塌成一条灰块 */
const loaded = ref<Record<number, boolean>>({})
function markLoaded(i: number) {
  loaded.value = { ...loaded.value, [i]: true }
}

watch(() => props.article.id, () => { at.value = 0; zoom.value = -1; editing.value = false; picker.value = false; pickerPreset.value = ''; intentOpen.value = false; settings.value = false; loaded.value = {}; resetDraft() })
watch(pages, (p) => { if (at.value >= p.length) at.value = 0 })

/* 素材库「用到创作台」的落点：这一稿一显示就把模板选择器替人打开、停在带来的那条上。
   意图接走即清——留着的话下次进创作台会再弹一次，那比不接更糟。 */
watch(
  [() => card.value?.data, materialTemplatePick],
  ([data, key]) => {
    if (!data || !key) return
    pickerPreset.value = key
    picker.value = true
    materialTemplatePick.value = ''
  },
  { immediate: true },
)

function step(d: number) {
  const from = zoom.value >= 0 ? zoom.value : at.value
  const to = Math.min(Math.max(0, from + d), pages.value.length - 1)
  if (zoom.value >= 0) zoom.value = to
  else at.value = to
}

function onKey(e: KeyboardEvent) {
  if (!pages.value.length) return
  if (zoom.value >= 0) {
    if (e.key === 'Escape') zoom.value = -1
    if (e.key === 'ArrowLeft') step(-1)
    if (e.key === 'ArrowRight') step(1)
    return
  }
  if (editing.value) return
  const tag = (e.target as HTMLElement | null)?.tagName ?? ''
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return
  if (e.key === 'ArrowLeft') step(-1)
  if (e.key === 'ArrowRight') step(1)
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

/* ==================== 编辑文字 ==================== */
const editing = ref(false)
const draft = ref<Record<string, any>[]>([])
const saving = ref(false)
const status = ref('')

function resetDraft() {
  draft.value = JSON.parse(JSON.stringify(card.value?.data?.pages ?? []))
  status.value = ''
}
function toggleEdit() {
  editing.value = !editing.value
  if (editing.value) resetDraft()
}
const fields = computed(() => {
  const page = draft.value[at.value]
  return page ? pageTextFields(page) : []
})
/** 长文案给多行框，短标签给单行框 */
const isLong = (v: string) => v.length > 26 || v.includes('\n')

function setField(path: (string | number)[], value: string) {
  draft.value[at.value] = applyField(draft.value[at.value], path, value)
}

/** 存盘 + 重渲：只渲改动页（约 15 秒/页），期间挂起 SSE 整页刷新免得弹层被冲掉 */
async function save(body: Record<string, any>, busyText: string, doneText: (r: any, rendered: number[]) => string) {
  saving.value = true
  status.value = busyText
  setHoldAutoRefresh(true)
  try {
    const r = await fetch('/__card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json())
    if (!r.ok) throw new Error(r.error || '保存失败')
    const rendered: number[] = r.rendered?.length ? r.rendered : pages.value.map((_, i) => i + 1)
    const ts = Date.now()
    const nextLoaded = { ...loaded.value }
    for (const n of rendered) {
      bust.value = { ...bust.value, [n - 1]: ts }
      delete nextLoaded[n - 1]
    }
    loaded.value = nextLoaded
    status.value = r.renderError ? `文字已保存，图片生成失败：${r.renderError}` : doneText(r, rendered)
  } catch (e) {
    status.value = String((e as Error).message || e)
  } finally {
    saving.value = false
    setHoldAutoRefresh(false)
  }
}

function savePage() {
  save(
    { jsonRel: card.value!.jsonRel, data: { ...card.value!.data, pages: draft.value } },
    `保存中，正在生成第 ${at.value + 1} 页…`,
    (_r, rendered) => `已保存并生成第 ${rendered.join('、')} 页`,
  )
}

/** 首次渲染：json 已在，png 还没跑出来。渲完松手让 SSE 刷新把新图列表带出来 */
function renderAll() {
  save(
    { jsonRel: card.value!.jsonRel, data: card.value!.data, renderAll: true },
    `渲染中，每页约 15 秒…`,
    (r, rendered) => `已渲染 ${r.pageCount ?? rendered.length} 页，页面刷新中…`,
  )
}

/* ==================== 换模板 ==================== */
/* 没写过 template 的老稿子如实显示「未选模板」；手改过皮或任一页版式就显示「已改过」，
   不让模板名继续冒充当前状态——用户看到的必须是这一稿现在到底是什么样。 */
const design = computed(() => designState(card.value?.data))
/** 没选过模板时按钮写「选模板」这个动作，不写「未选模板」这个状态 */
const designLabel = computed(() => (design.value.label === '未选模板' ? '选模板' : design.value.label))
const layoutLabel = (i: number) => {
  const l = String(card.value?.data?.pages?.[i]?.layout ?? '')
  return cardLayoutByName(l)?.label || l || '无版式'
}

/** 套模板 = 写 theme.id + 逐页 layout + template/shape 回 json，然后整组重渲：
 *  皮是全稿生效的，只渲改动页会留下一半旧一半新。 */
function chooseTemplate(tpl: CardTemplate, changed: number[]) {
  picker.value = false
  const { data } = applyTemplate(card.value!.data!, tpl)
  save(
    { jsonRel: card.value!.jsonRel, data, renderAll: true },
    `套用「${tpl.label}」中，每页约 15 秒…`,
    (_r, rendered) =>
      `已套用「${tpl.label}」：重渲 ${rendered.length} 页` +
      (changed.length ? `，第 ${changed.join('、')} 页换了版式` : '，版式没动（内容装不下或本就一致）'),
  )
}

/* ==================== 商业浓度 ==================== */
/* 与渲染器同一套推导：json 没写 intent 时按「挂没挂产品」定档，界面不许自己猜一个，
   否则显示的是「只给价值」而闸门跑的其实是 promo。 */
const intentOpen = ref(false)
const INTENT_LABEL: Record<CardIntent, string> = { value: '只给价值', mixed: '价值里植入', promo: '只推产品' }
const declaredIntent = computed<CardIntent | ''>(() => {
  const v = card.value?.data?.intent
  return v === 'value' || v === 'mixed' || v === 'promo' ? v : ''
})
const intentDerived = computed<CardIntent>(() => (declaredIntent.value || (card.value?.data?.product ? 'promo' : 'value')) as CardIntent)
const intentLabel = computed(() => INTENT_LABEL[intentDerived.value])

/** 改浓度就是改闸门口径：必须全组重渲一遍才知道现有文字拦不拦得住。
 *  闸门打回时 /__card 仍返回 ok，只把违规塞进 renderError，界面照实说 */
function saveIntent(data: Record<string, any>) {
  intentOpen.value = false
  editing.value = false
  save(
    { jsonRel: card.value!.jsonRel, data, renderAll: true },
    '已保存，正在重新生成全部页面…',
    (_r, rendered) => `已按新设置生成 ${rendered.length} 页`,
  )
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 图文：一页一张，翻页看 -->
    <div v-if="pages.length" :class="bare ? 'overflow-hidden' : 'card !p-0 overflow-hidden'">
      <div v-if="card?.data" :class="bare ? 'px-1 py-1' : 'border-b border-line px-3 py-2'">
        <!-- 页数不在这里报第二遍：当前页读数只留在预览图角上，跳页交给下面缩略图（GPT 第 15 轮判 4） -->
        <div class="flex items-center gap-1">
          <button
            class="btn-ghost !px-2 !py-0.5"
            :class="editing ? 'is-selected' : ''"
            @click="toggleEdit"
          >
            <IconX v-if="editing" :size="13" class="shrink-0" />
            <IconPencil v-else :size="13" class="shrink-0" />
            {{ editing ? '退出编辑' : '编辑图卡' }}
          </button>
          <button
            class="btn-ghost !px-2 !py-0.5"
            :class="settings ? 'is-selected' : ''"
            :disabled="saving"
            title="图卡风格与卖货程度"
            @click="settings = !settings"
          >
            <IconSlidersVertical :size="13" class="shrink-0" />
            设置
          </button>
        </div>
      </div>

      <!-- 风格与浓度不是并列动作，是这张图卡的两个设置项：收在这里，点开才改 -->
      <div v-if="settings && card?.data" class="grid grid-cols-2 gap-1.5 border-b border-line bg-surface-2 px-3 py-2">
        <button class="btn-ghost !justify-start !px-2 !py-1" :disabled="saving" title="换一套图卡风格：整体配色 + 每页版式" @click="picker = true">
          <IconPalette :size="13" class="shrink-0" />风格：{{ designLabel }}
        </button>
        <button class="btn-ghost !justify-start !px-2 !py-1" :disabled="saving" :title="`这一稿卖不卖东西：${intentLabel}`" @click="intentOpen = true">
          <IconTag :size="13" class="shrink-0" />{{ intentLabel }}
        </button>
      </div>

      <!-- 全部页一次摊开成网格：单页大图配一条小缩略图带，等于同一批图摆两遍，
           而且中间那圈灰边把版面撑成一片空。点任一格放大看。
           每格按 3:4 先占住高度再等图，图没到货时铺微光骨架，不让版面一格格塌下去 -->
      <div class="grid gap-2 p-2" :class="bare ? 'grid-cols-3' : 'grid-cols-2'">
        <button
          v-for="(u, i) in pages"
          :key="u"
          class="relative aspect-[3/4] overflow-hidden rounded-lg border bg-surface-2 transition-shadow"
          :class="editing && i === at ? 'border-accent ring-2 ring-accent/25' : 'border-line hover:border-line-strong'"
          :title="editing ? `编辑第 ${i + 1} 页` : `放大看第 ${i + 1} 页`"
          @click="editing ? (at = i) : (zoom = i)"
        >
          <div v-if="!loaded[i]" class="cover-skeleton absolute inset-0" />
          <img
            :src="imgSrc(i)"
            :alt="`${article.title} 第 ${i + 1} 页`"
            class="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            @load="markLoaded(i)"
          />
          <span class="absolute bottom-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-sm tabular-nums text-white">
            {{ i + 1 }}{{ i === 0 ? ' · 封面' : '' }}
          </span>
        </button>
      </div>
      <p v-if="status" class="px-3 pb-2 text-sm leading-5 font-medium text-ink-3">{{ status }}</p>
    </div>

    <!-- 有卡片数据但还没渲染：一键补渲染，不摆空图 -->
    <div v-else-if="card?.data" :class="bare ? 'rounded-lg border border-dashed border-line p-4' : 'card !border-dashed !p-4'">
      <div class="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <IconLayers :size="15" class="shrink-0" />
        {{ card.pageCount }} 页图卡还没出
      </div>
      <button class="btn btn-primary" :disabled="saving" @click="renderAll">
        <IconImages :size="13" class="shrink-0" />{{ saving ? '渲染中…' : '渲染全部页' }}
      </button>
      <p v-if="status" class="mt-2 text-sm leading-5 text-ink-2">{{ status }}</p>
    </div>

    <!-- 纯视频稿没有图卡 json：不摆「读不出来」的误报，也不说自己是纯文字稿——下面视频块就是成果 -->
    <div v-else-if="card && !card.video" :class="[bare ? 'rounded-lg border border-dashed border-line p-4' : 'card !border-dashed !p-4', 'text-sm leading-5 text-ink-2']">
      图卡文件读不出来，可能损坏了。
    </div>

    <div v-else-if="!card" :class="[bare ? 'rounded-lg border border-dashed border-line p-4' : 'card !border-dashed !p-4', 'text-sm leading-5 text-ink-2']">
      这一版是纯文字稿，没有图卡：发出去的就是左边那份正文。
    </div>

    <!-- 编辑面板：只改当前这一页的文字，版式（字号/色块/间距）留给模板 -->
    <div v-if="editing" :class="bare ? 'rounded-lg bg-surface-2/70 p-3' : 'card !p-3'">
      <div class="mb-2 flex items-center gap-2.5">
        <img v-if="pages.length" :src="imgSrc(at)" :alt="`第 ${at + 1} 页`" class="h-14 w-14 shrink-0 rounded-md border border-line object-cover" loading="lazy" />
        <div class="min-w-0">
          <div class="text-sm font-medium">第 {{ at + 1 }} 页 · 共 {{ pages.length }} 页</div>
        </div>
      </div>
      <label v-for="f in fields" :key="f.path.join('.')" class="mb-2 block">
        <span class="mb-1 block text-sm font-medium text-ink-2">{{ f.label }}</span>
        <textarea
          v-if="isLong(f.value)"
          :value="f.value"
          rows="3"
          class="input w-full resize-y !px-2 !py-1 !leading-5"
          @input="setField(f.path, ($event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else
          :value="f.value"
          class="input w-full !px-2 !py-1"
          @input="setField(f.path, ($event.target as HTMLInputElement).value)"
        />
      </label>
      <p v-if="!fields.length" class="text-sm text-ink-2">这一页没有可编辑的文字字段。</p>
      <div class="mt-3 flex items-center gap-2">
        <button class="btn btn-primary !px-3" :disabled="saving" @click="savePage">
          {{ saving ? '正在更新预览…' : '保存并更新预览' }}
        </button>
        <button class="btn-ghost" :disabled="saving" @click="resetDraft()">放弃改动</button>
      </div>
      <p v-if="status" class="mt-2 text-sm leading-5 text-ink-2">{{ status }}</p>
    </div>

    <!-- 视频：素材在 public/ 下就能播，否则说清文件在哪 -->
    <div v-if="card?.video" :class="bare ? 'overflow-hidden' : 'card !p-0 overflow-hidden'">
      <div class="flex items-center gap-1.5 border-b border-line px-3 py-2 text-sm font-medium">
        <IconClapperboard :size="15" class="shrink-0" />视频创作
      </div>
      <!-- 竖屏自己套手机壳、横屏平铺，进度与逐帧在这条机器件上 -->
      <FilmPlayer v-if="card.videoUrl" :src="card.videoUrl" class="m-3" />
      <p v-else class="p-3 text-sm leading-5 text-ink-2">
        视频素材不可预览
      </p>
    </div>

    <!-- 放大看：整屏看图，← → 翻页，Esc 或点图外关闭 -->
    <div v-if="zoom >= 0" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" @click="zoom = -1">
      <img
        :src="imgSrc(zoom)"
        :alt="`${article.title} 第 ${zoom + 1} 页`"
        class="max-h-full w-auto rounded-lg object-contain shadow-neo"
        @click.stop
      />
      <span class="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-md bg-black/60 px-2 py-1 text-sm tabular-nums text-white">
        {{ zoom + 1 }} / {{ pages.length }} · {{ layoutLabel(zoom) }}
      </span>
      <button class="btn absolute right-5 top-5 !px-2 !py-1.5" aria-label="关闭" title="关闭（Esc）" @click="zoom = -1">
        <IconX :size="15" />
      </button>
    </div>

    <TemplatePicker
      v-if="picker && card?.data"
      :data="card.data"
      :preset="pickerPreset"
      @close="picker = false"
      @apply="chooseTemplate"
    />

    <IntentModal
      v-if="intentOpen && card?.data"
      :data="card.data"
      :derived="intentDerived"
      @close="intentOpen = false"
      @save="saveIntent"
    />
  </div>
</template>
