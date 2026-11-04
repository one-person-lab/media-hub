<script setup lang="ts">
/** 一键克隆爆款视觉：给一张参考图，从它的像素里取「这套皮」和「这结构像哪个现成版式」，
 *  先渲一张真图摆在同一条稿子旁边对着看，人点头才存成候选模板。
 *  只借皮和结构，不搬文案——字永远是本稿自己的。产出的皮走 config/card-themes.json 的 candidate 状态。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { cardThemes, holdSelfWrite } from '../data/store'
import { candidateTheme, nearestExisting, readImage, structureHint, type Reading, type StructureHint } from '../lib/cardClone'
import { bodyLayoutForShape, detectShape, LAYOUT_SHAPE, type CardData } from '../lib/cardDesign'
import { ArrowLeftRight as IconArrowLeftRight, Ban as IconBan, Check as IconCheck, LoaderCircle as IconLoaderCircle, Upload as IconUpload, X as IconX } from 'lucide-vue-next'

/** data：从创作台开的时候带上，用来判这一稿的形态；从爆款采集开的时候没有稿子，可以不传。
 *  shots：采集卡已经收回本机的那几页图，点一页就当参考图，省得人去磁盘里翻文件再粘回来。 */
const props = defineProps<{
  data?: CardData
  shots?: string[]
  source?: { title?: string; platform?: string; noteId?: string }
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', templateKey: string): void }>()

const call = computed(() => detectShape(props.data || {}))
/** 能当正文的版式：吃皮肤的价值版式，封面不算（封面固定是第一页） */
const layoutOpts = computed(() =>
  cardThemes.layouts.filter((l) => l.themeReady && l.family === 'value' && l.layout !== 'cover'),
)

const shot = ref<{ url: string; name: string } | null>(null)
const reading = ref<Reading | null>(null)
const cand = ref<ReturnType<typeof candidateTheme> | null>(null)
const dup = ref<ReturnType<typeof nearestExisting> | null>(null)
const hint = ref<StructureHint | null>(null)
const body = ref('items')
const reuseTheme = ref(false)
const name = ref('')
const busy = ref('')
const err = ref('')
const pages = ref<{ layout: string; url: string }[]>([])

const SWATCHES: [string, string][] = [
  ['--page', '底色'],
  ['--surface', '淡底'],
  ['--ink', '字色'],
  ['--accent', '强调'],
  ['--rule', '线'],
]
const shapeLabel = computed(() => (hint.value?.layout === 'split' ? '图上看到的左右对照' : hint.value?.layout === 'steps' ? '图上看到的步骤线' : '稿子自己的形态'))
const layoutLabel = computed(() => layoutOpts.value.find((l) => l.layout === body.value)?.label || body.value)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !busy.value) emit('close')
}
async function paste(e: ClipboardEvent) {
  const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile()
  if (f) await take(f)
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('paste', paste)
  // 只有一页就别再问一次，进来直接读
  if (notePages.value.length === 1) useShot(notePages.value[0])
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('paste', paste)
  if (shot.value) URL.revokeObjectURL(shot.value.url)
})

/** 读一张参考图：长边压到 1000 再取像素——原图 2 千多像素，格子只有 48×48，压完读数更稳也快得多。
 *  label：采集卡带过来的图文件名是 page-01，那种名字进不了库，给它笔记标题当名字。 */
async function take(file: File, label?: string) {
  const url = URL.createObjectURL(file)
  if (shot.value) URL.revokeObjectURL(shot.value.url)
  shot.value = { url, name: (label || file.name.replace(/\.[^.]+$/, '')).slice(0, 24) }
  reading.value = null
  pages.value = []
  err.value = ''
  busy.value = '读图'
  try {
    const im = new Image()
    im.src = url
    await new Promise((r, j) => { im.onload = r; im.onerror = () => j(new Error('这张图打不开')) })
    const scale = Math.min(1, 1000 / Math.max(im.naturalWidth, im.naturalHeight))
    const w = Math.max(1, Math.round(im.naturalWidth * scale))
    const h = Math.max(1, Math.round(im.naturalHeight * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('这台机器开不了画布，取不了色')
    ctx.drawImage(im, 0, 0, w, h)
    const r = readImage(ctx.getImageData(0, 0, w, h))
    reading.value = r
    if (!name.value) name.value = shot.value.name
    const c = candidateTheme(r, name.value || shot.value.name, cardThemes.fontStack)
    cand.value = c
    const d = nearestExisting(r, c.tokens, cardThemes.themes)
    dup.value = d
    reuseTheme.value = d.duplicate
    hint.value = structureHint(r)
    body.value = hint.value.layout || bodyLayoutForShape(call.value.shape)
  } catch (e) {
    err.value = String((e as Error).message || e)
  } finally {
    busy.value = ''
  }
}

/** 采集卡收回本机的页图：点一页直接当参考图，不用人去磁盘翻文件再粘 */
const notePages = computed(() => props.shots || [])
async function useShot(url: string) {
  if (busy.value) return
  err.value = ''
  busy.value = '取图'
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error('这一页的图没取到')
    const file = new File([await r.blob()], (url.split('/').pop() || 'shot').replace(/\?.*$/, ''))
    await take(file, props.source?.title)
  } catch (e) {
    err.value = String((e as Error).message || e)
  } finally {
    busy.value = ''
  }
}

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) take(f)
}
function onDrop(e: DragEvent) {
  const f = e.dataTransfer?.files?.[0]
  if (f && f.type.startsWith('image/')) take(f)
}

/** 换一张：读完的图不满意得能退回入口，不然只能关掉整个弹层重来 */
function reset() {
  if (shot.value) URL.revokeObjectURL(shot.value.url)
  shot.value = null
  reading.value = null
  cand.value = null
  dup.value = null
  hint.value = null
  pages.value = []
  err.value = ''
  name.value = ''
  reuseTheme.value = false
}

async function renderPreview() {
  if (!cand.value || busy.value) return
  busy.value = '正在按这条皮渲一张给你看（约 15 秒）'
  err.value = ''
  holdSelfWrite()
  try {
    const layouts = ['cover', body.value].filter((v, i, a) => a.indexOf(v) === i)
    const r = await fetch('/__clone-visual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'preview', layouts, tokens: cand.value.tokens }),
    }).then((x) => x.json())
    if (!r.ok) throw new Error(r.error || '预览没渲出来')
    pages.value = r.pages
  } catch (e) {
    err.value = String((e as Error).message || e)
  } finally {
    busy.value = ''
  }
}

/** 存候选：模板 + （判重没命中时）一条新皮。存完顺手把小样渲出来再关，
 *  候选栏里挂一张「未渲染」的灰块等于把活踢回给人。
 *  这两步服务端都会重建数据并广播；选择器开着的时候那些广播由 absorbBroadcasts 就地接走，
 *  这里再开一次 30 秒窗兜住关掉之后的尾巴——放开挂起走整页刷的话，弹层和选择器会一起没掉。 */
async function save() {
  if (!cand.value || busy.value) return
  busy.value = '正在存候选'
  err.value = ''
  holdSelfWrite()
  try {
    const r = await fetch('/__clone-visual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'save',
        name: name.value || shot.value?.name || '克隆',
        tokens: cand.value.tokens,
        baseTheme: reuseTheme.value ? dup.value?.top?.key || '' : '',
        layouts: { cover: 'cover', body: body.value, closing: 'closing' },
        shape: [call.value.shape || LAYOUT_SHAPE[body.value] || '清单'],
        source: props.source || { title: shot.value?.name || '' },
        swatches: { page: reading.value?.page, ink: reading.value?.ink, accent: reading.value?.accent },
      }),
    }).then((x) => x.json())
    if (!r.ok) throw new Error(r.error || '没存进去')
    busy.value = '正在出这条的小样（约 15 秒）'
    holdSelfWrite()
    await fetch('/__template-thumb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templates: [r.templateKey] }),
    }).then((x) => x.json())
    emit('saved', r.templateKey)
    emit('close')
    holdSelfWrite()
  } catch (e) {
    err.value = String((e as Error).message || e)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-dialog="'克隆爆款视觉'" class="modal">
      <div class="absolute inset-0 bg-black/35" @click="!busy && emit('close')" />
      <div class="card modal-card relative z-10 max-w-4xl">
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div class="flex items-center gap-2 text-sm font-medium">
            <IconArrowLeftRight :size="15" />
            克隆爆款视觉
            <span v-if="reading" class="text-ink-3">· 正文按{{ shapeLabel }}排 · {{ layoutLabel }}</span>
          </div>
          <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
            <IconX :size="15" />
          </button>
        </div>

        <div class="modal-body space-y-4 p-5">
          <!-- 还没有图：只给一个入口，别摆三步教程 -->
          <div v-if="!shot && notePages.length > 1" class="space-y-3">
            <p class="text-sm font-medium">这条笔记 {{ notePages.length }} 页，收哪一页的皮</p>
            <div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
              <button
                v-for="(u, i) in notePages"
                :key="u"
                class="page"
                :disabled="!!busy"
                :title="`第 ${i + 1} 页`"
                :aria-label="`收第 ${i + 1} 页`"
                @click="useShot(u)"
              >
                <img :src="u" :alt="`第 ${i + 1} 页`" loading="lazy" />
              </button>
            </div>
            <label class="drop drop-sm grid place-items-center gap-1.5 rounded-lg px-4 py-5 text-center" @dragover.prevent @drop.prevent="onDrop">
              <input type="file" accept="image/*" class="hidden" @change="onPick" />
              <span class="text-sm">用别的图：拖进来或 ⌘V 粘贴</span>
            </label>
          </div>

          <p v-else-if="!shot && busy" class="chip !h-auto !whitespace-normal !px-3 !py-2 text-sm leading-5">
            <IconLoaderCircle :size="13" class="mr-1 inline animate-spin align-[-2px]" />
            {{ busy }}
          </p>

          <label
            v-else-if="!shot"
            class="drop grid place-items-center gap-2 rounded-lg px-6 py-14 text-center"
            @dragover.prevent
            @drop.prevent="onDrop"
          >
            <input type="file" accept="image/*" class="hidden" @change="onPick" />
            <IconUpload :size="22" class="text-ink-3" />
            <span class="text-sm">挑一张参考图，或直接把图拖进来 / ⌘V 粘贴</span>
            <span class="text-sm text-ink-3">取它的配色和排法，不取它的字</span>
          </label>

          <div v-else class="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
            <div class="space-y-3">
              <div class="cmp grid gap-2" :class="pages.length ? 'grid-cols-3' : 'grid-cols-1'">
                <figure class="m-0">
                  <img :src="shot.url" class="frame" alt="参考图" />
                  <figcaption class="cap">参考图</figcaption>
                </figure>
                <figure v-for="p in pages" :key="p.url" class="m-0">
                  <img :src="p.url" class="frame" :alt="p.layout" />
                  <figcaption class="cap">{{ p.layout === 'cover' ? '我们的封面' : `我们的${layoutLabel}` }}</figcaption>
                </figure>
              </div>
              <p v-if="err" class="chip !h-auto !whitespace-normal !px-3 !py-2 text-sm leading-5">{{ err }}</p>
            </div>

            <div class="space-y-3">
              <div class="rounded-lg bg-surface-2 px-3 py-2.5">
                <input v-model="name" class="w-full bg-transparent text-sm font-medium outline-none" placeholder="给这条克隆起个名" maxlength="24" />
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <span v-for="[k, lab] in SWATCHES" :key="k" class="sw">
                    <i :style="{ background: cand?.tokens[k] || '#fff' }" />
                    {{ lab }} {{ cand?.tokens[k] }}
                  </span>
                </div>
              </div>

              <div v-if="reading">
                <p class="mb-1 text-sm font-medium">它读到的</p>
                <ul class="ev space-y-1">
                  <li v-for="(s, i) in reading.evidence" :key="i">{{ s }}</li>
                </ul>
                <ul v-if="reading.warnings.length" class="ev mt-1.5 space-y-1">
                  <li v-for="(s, i) in reading.warnings" :key="i" class="text-red-700"><IconBan :size="13" class="inline align-[-1px]" /> {{ s }}</li>
                </ul>
              </div>

              <div v-if="dup && reading">
                <p v-if="dup.duplicate" class="text-sm leading-5">
                  这条皮跟现有的 <b>{{ dup.top?.label }}</b> 只差 {{ ((dup.top?.distance || 0) * 100).toFixed(1) }}，
                  <label class="mt-1 flex items-start gap-1.5">
                    <input v-model="reuseTheme" type="checkbox" class="mt-0.5" />
                    <span>不新增皮，只借它的版式另存一条模板</span>
                  </label>
                </p>
                <p v-else class="text-sm leading-5 text-ink-2">
                  最近的现有皮是 <b>{{ dup.top?.label }}</b>（差 {{ ((dup.top?.distance || 0) * 100).toFixed(1) }}），算一条新皮。
                </p>
              </div>

              <label class="block">
                <span class="text-sm text-ink-2">正文版式</span>
                <select v-model="body" class="input mt-1 w-full">
                  <option v-for="l in layoutOpts" :key="l.layout" :value="l.layout">
                    {{ l.label }}{{ hint?.layout === l.layout ? '（图上看出来的）' : '' }}
                  </option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div v-if="shot" class="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <button v-if="!pages.length" class="btn !px-3 !py-1.5" :disabled="!!busy || !cand" @click="renderPreview">
            <IconLoaderCircle v-if="busy" :size="13" class="animate-spin" />
            {{ busy || '看效果' }}
          </button>
          <button v-else class="btn !px-3 !py-1.5" :disabled="!!busy" @click="renderPreview">换个版式重渲</button>
          <button v-if="pages.length" class="btn btn-primary !px-3 !py-1.5" :disabled="!!busy" @click="save">
            <IconCheck :size="13" />
            存为候选
          </button>
          <button class="btn btn-ghost !px-3 !py-1.5" :disabled="!!busy" @click="reset">换一张参考图</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.drop {
  border: 1.5px dashed var(--app-line, #ddd);
  cursor: pointer;
  display: flex;
}
.drop:hover {
  border-color: var(--app-ink-3, #999);
}
.drop-sm {
  border-width: 1px;
}
.page {
  display: block;
  overflow: hidden;
  border-radius: 8px;
  border: 1.5px solid var(--app-line, #ddd);
  background: var(--app-surface-2, #f2f2f2);
}
.page:hover:not(:disabled) {
  border-color: var(--app-ink, #111);
}
.page img {
  aspect-ratio: 1242 / 1660;
  width: 100%;
  object-fit: cover;
  object-position: top;
  display: block;
}
.frame {
  width: 100%;
  aspect-ratio: 1242 / 1660;
  object-fit: contain;
  background: var(--app-surface-2, #f2f2f2);
  border-radius: 8px;
  display: block;
}
.cap {
  margin-top: 4px;
  font-size: 12px;
  color: var(--app-ink-3, #999);
  text-align: center;
}
.sw {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px 2px 3px;
  border-radius: 999px;
  background: var(--app-page, #fff);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sw i {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  display: block;
}
.ev {
  font-size: 12px;
  line-height: 18px;
  color: var(--app-ink-2, #666);
  list-style: none;
  margin: 0;
  padding: 0;
}
.ev li::before {
  content: '·';
  margin-right: 5px;
}
</style>
