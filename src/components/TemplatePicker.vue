<script setup lang="ts">
/** 图文模板选择器：一条模板 = 一层皮 + 三种页面角色各用哪个版式，一次点定。
 *  小样是预渲的（本机一页 10–15 秒，开界面就渲 12 张等于冻住），
 *  所以状态只有三种：ready 直接看图 / stale 改了皮或版式 / missing 没渲过 —— 后两种给「补渲」。
 *  克隆出来的 candidate 单独一栏：能看能套能转正，但不跟在手写模板里冒充在架款。 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { absorbBroadcasts, candidateCardTemplates, cardTemplates, type CardTemplate } from '../data/store'
import { settleCloneVisual } from '../lib/cloneVisual'
import { detectShape, recommendTemplate, applyTemplate, type CardData } from '../lib/cardDesign'
import { renderTemplateThumbs } from '../lib/useTemplateThumbs'
import CloneSkinModal from './CloneSkinModal.vue'
import { ArrowLeftRight as IconArrowLeftRight, ArrowUp as IconArrowUp, Check as IconCheck, Image as IconImage, RotateCw as IconRotateCw, Sparkles as IconSparkles, Trash2 as IconTrash2, X as IconX } from 'lucide-vue-next'

const props = defineProps<{ data: CardData; preset?: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', tpl: CardTemplate, changed: number[]): void
}>()

const list = computed(() => cardTemplates.templates.filter((t) => !t.status || t.status === 'active'))
const cands = computed(() => candidateCardTemplates())
const rec = computed(() => recommendTemplate(props.data))
const call = computed(() => detectShape(props.data))
const pageCount = computed(() => (props.data.pages || []).length)
/** 这一稿当前挂的模板：json 里没写就是老稿子（没选过），界面不许假装它属于某条 */
const current = computed(() => props.data.template || '')

/* 打开时直接停在当前那条上：不预选的话，用户看不出「现在用的是哪条」，
   换模板变成靠回忆自己当初点了什么。从素材库「用到创作台」过来的带 preset，
   那条优先——人是奔着它来的，停在旧模板上等于没接住这个意图。 */
const all = computed(() => [...list.value, ...cands.value])
const presetKey = computed(() =>
  props.preset && all.value.some((t) => t.key === props.preset) ? props.preset : '',
)
const picked = ref(
  presetKey.value || (list.value.some((t) => t.key === current.value) ? current.value : ''),
)
const chosen = computed(() => [...list.value, ...cands.value].find((t) => t.key === picked.value) || null)
/** 套用前先把「会动哪几页、哪几页不动」算给人看——换版式是有破坏性的动作，不能按了才知道 */
const preview = computed(() => (chosen.value ? applyTemplate(props.data, chosen.value) : null))

const status = ref('')
/* 补渲：一次点一批，服务端串行（渲染共用一把闩）。成功后本地改状态 + 破图缓存，不整页刷。
   选择器开着的时候广播由 absorbBroadcasts 就地接走（见下面的挂载钩子），这里只再开一次窗兜尾巴。 */
const busy = ref('')
const bust = ref<Record<string, number>>({})
const localStatus = ref<Record<string, string>>({})
const statusOf = (t: CardTemplate) => localStatus.value[t.key] || t.thumb?.status || 'missing'
const thumbSrc = (t: CardTemplate) => t.thumb?.url + (bust.value[t.key] ? `?v=${bust.value[t.key]}` : '')
const staleKeys = computed(() => [...list.value, ...cands.value].filter((t) => statusOf(t) !== 'ready').map((t) => t.key))

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
    const bad = failed.map((f) => `${f.key}：${f.error}`)
    busy.value = ''
    if (bad.length) throw new Error(bad.join('；'))
  } catch (e) {
    busy.value = ''
    status.value = String((e as Error).message || e)
  }
}

function pick(t: CardTemplate) {
  picked.value = t.key
  status.value = ''
  if (statusOf(t) !== 'ready' && !busy.value) renderStale([t.key])
}

function apply() {
  if (!chosen.value || !preview.value) return
  emit('apply', chosen.value, preview.value.changed)
}

/* 候选模板的去处只有两个：转正进在架，或连它独占的那层皮一起删掉。
   小样是克隆时渲的，转正不用重渲；转正后这条就在架列表里了，选中状态跟着走。 */
const cloneOpen = ref(false)
async function settleClone(t: CardTemplate, mode: 'promote' | 'drop') {
  if (busy.value) return
  busy.value = `${mode}:${t.key}`
  status.value = ''
  try {
    await settleCloneVisual(mode, t.key)
    status.value = mode === 'promote' ? `「${t.label}」已转正进在架` : `已删掉「${t.label}」`
    if (mode === 'drop' && picked.value === t.key) picked.value = ''
  } catch (e) {
    status.value = String((e as Error).message || e)
  } finally {
    busy.value = ''
  }
}

function onCloned(key: string) {
  cloneOpen.value = false
  status.value = ''
  picked.value = key
}

/** 克隆来的模板（有 source 就是它）不管在架还是候选，都得能就地删掉：
   否则转正之后想要反悔只能改配置文件，界面等于把人往死路里逼。 */
const isClone = (t: CardTemplate | null) => !!t && (!!t.source || t.status === 'candidate')

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
/* 选择器开着的整段时间，重建广播一律就地换表：存候选、渲小样、转正各引出一次重建，
   队列排到几十秒后是常事，那一下整页刷会把人正对着的小样连同整个选择器刷没。 */
let releaseAbsorb = () => {}
onMounted(() => {
  releaseAbsorb = absorbBroadcasts()
  window.addEventListener('keydown', onKey)
  // 预选那条要是没小样，开界面就顺手补渲它：停在一张裂图上不叫「选好了」
  const t = all.value.find((x) => x.key === picked.value)
  if (t && statusOf(t) !== 'ready') renderStale([t.key])
})
onBeforeUnmount(() => {
  releaseAbsorb()
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <!-- 预览栏是 xl:sticky，自带一层 stacking context：弹窗留在原地就会被页面底部的推送条压住，
       「套用」点不到。挂到 body 上才真正盖住整页。 -->
  <Teleport to="body">
    <div v-dialog="'图文模板'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
    <div class="card modal-card relative z-10 max-w-3xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div class="flex items-center gap-2 text-sm font-medium">
          <IconImage :size="15" />
          图文模板
          <span class="text-ink-3">· 形态：{{ call.shape || '未定' }}</span>
        </div>
        <span class="flex items-center gap-2">
          <button
            class="btn-ghost shrink-0 !px-2"
            aria-label="克隆这套皮"
            title="照一张参考图的皮和结构，克隆成这条稿子的候选模板"
            @click="cloneOpen = true"
          >
            <IconArrowLeftRight :size="15" />
          </button>
          <button
            v-if="staleKeys.length"
            class="btn-ghost shrink-0 !px-2"
            :class="busy ? 'opacity-60' : ''"
            :disabled="!!busy"
            aria-label="补渲小样"
            :title="`补渲 ${staleKeys.length} 张小样`"
            @click="renderStale(staleKeys)"
          >
            <IconRotateCw :size="15" :class="busy ? 'animate-spin' : ''" />
          </button>
          <button class="btn-ghost shrink-0 !px-2" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
            <IconX :size="15" />
          </button>
        </span>
      </div>

      <div class="modal-body space-y-4 p-5">
        <p v-if="!list.length" class="text-sm leading-5 text-ink-2">
          <code>config/card-templates.json</code> 里没有可选模板。
        </p>

        <template v-else>
          <div class="rec" :class="rec.uncertain ? 'is-uncertain' : ''">
            <IconSparkles :size="15" class="shrink-0" />
            <span v-if="rec.template && rec.template.key === current" class="min-w-0 flex-1">
              在用 <b>{{ rec.template.label }}</b> —— {{ rec.reason }}
            </span>
            <span v-else-if="rec.template" class="min-w-0 flex-1">
              推荐 <b>{{ rec.template.label }}</b> —— {{ rec.reason }}
            </span>
            <span v-else class="min-w-0 flex-1">没把握，手选一次：{{ rec.reason }}</span>
            <button
              v-if="rec.template && rec.template.key !== current"
              class="btn btn-primary shrink-0 !px-3 !py-1"
              @click="pick(rec.template)"
            >
              就这条
            </button>
          </div>

          <p v-if="status" class="chip !h-auto !whitespace-normal !px-3 !py-2 text-sm leading-5">{{ status }}</p>

          <div class="grid grid-cols-4 gap-3">
            <button
              v-for="t in list"
              :key="t.key"
              class="tcard overflow-hidden rounded-lg border text-left"
              :class="t.key === picked ? 'is-selected' : ''"
              @click="pick(t)"
            >
              <span class="thumb block">
                <img v-if="statusOf(t) === 'ready'" :src="thumbSrc(t)" :alt="t.label" loading="lazy" />
                <span v-else class="placeholder">
                  <IconImage :size="18" />
                  {{ statusOf(t) === 'stale' ? '小样过期' : '未渲染' }}
                </span>
                <span v-if="t.key === current" class="now">在用</span>
              </span>
              <span class="block px-2 py-1.5">
                <span class="block truncate text-sm font-medium">{{ t.label }}</span>
                <span class="block truncate text-sm text-ink-3">{{ t.shape.join(' · ') }}</span>
              </span>
            </button>
          </div>

          <div v-if="cands.length" class="border-t border-line pt-3">
            <p class="mb-2 text-sm leading-5 text-ink-3">候选 {{ cands.length }} 条</p>
            <div class="grid grid-cols-4 gap-3">
              <div
                v-for="t in cands"
                :key="t.key"
                class="tcard overflow-hidden rounded-lg border text-left"
                :class="t.key === picked ? 'is-selected' : ''"
              >
                <button class="block w-full text-left" @click="pick(t)">
                  <span class="thumb block">
                    <img v-if="statusOf(t) === 'ready'" :src="thumbSrc(t)" :alt="t.label" loading="lazy" />
                    <span v-else class="placeholder">
                      <IconImage :size="18" />
                      {{ statusOf(t) === 'stale' ? '小样过期' : '未渲染' }}
                    </span>
                    <span v-if="t.key === current" class="now">在用</span>
                  </span>
                  <span class="block px-2 py-1.5">
                    <span class="block truncate text-sm font-medium">{{ t.label }}</span>
                    <span class="block truncate text-sm text-ink-3">{{ t.shape.join(' · ') }}</span>
                  </span>
                </button>
                <span class="flex items-center gap-1 border-t border-line px-2 py-1">
                  <button
                    class="btn-ghost !px-2 !py-0.5"
                    :disabled="!!busy"
                    title="放进在架模板，以后所有稿子都能选它"
                    @click="settleClone(t, 'promote')"
                  >
                    <IconArrowUp :size="13" class="shrink-0" />转正
                  </button>
                  <button
                    class="btn-ghost !px-2 !py-0.5"
                    :disabled="!!busy"
                    title="删掉这条候选，只属于它的那层皮一起清"
                    @click="settleClone(t, 'drop')"
                  >
                    <IconTrash2 :size="13" class="shrink-0" />删掉
                  </button>
                </span>
              </div>
            </div>
          </div>

          <div v-if="chosen && preview" class="rounded-lg bg-surface-2 px-3 py-2.5">
            <p class="text-sm leading-5">{{ chosen.pick }}</p>
            <p class="mt-1 text-sm leading-5 text-ink-2">
              会重排：{{ preview.changed.length ? `第 ${preview.changed.join('、')} 页` : '没有页需要改版式' }}
              <template v-if="preview.skipped.length">
                · 不动：{{ preview.skipped.map((s) => `第 ${s.page} 页（${s.why}）`).join('；') }}
              </template>
            </p>
          </div>
        </template>
      </div>

      <div v-if="chosen" class="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <button class="btn btn-primary !px-3 !py-1.5" :disabled="!!busy" @click="apply">
          <IconCheck :size="13" />
          <template v-if="chosen.key === current">整组按「{{ chosen.label }}」重渲 {{ pageCount }} 页</template>
          <template v-else>套用「{{ chosen.label }}」· 重渲 {{ pageCount }} 页</template>
        </button>
        <span class="text-sm text-ink-3">约 {{ Math.max(1, Math.round(pageCount * 0.25)) }} 分钟</span>
        <button
          v-if="isClone(chosen)"
          class="btn-ghost ml-auto !px-2.5 !py-1 !text-red-600"
          :disabled="!!busy"
          title="删掉这条克隆来的模板，只属于它的那层皮一起清"
          @click="settleClone(chosen, 'drop')"
        >
          <IconTrash2 :size="13" class="shrink-0" />
          删掉这条克隆
        </button>
      </div>
      </div>
    </div>

    <CloneSkinModal v-if="cloneOpen" :data="props.data" @close="cloneOpen = false" @saved="onCloned" />
  </Teleport>
</template>

<style scoped>
.rec {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-accent, #111) 8%, transparent);
  font-size: 13px;
  line-height: 20px;
}
.rec.is-uncertain {
  background: var(--app-surface-2, #f3f3f3);
  color: var(--app-ink-2, #666);
}
.tcard:hover {
  transform: translateY(-2px);
  transition: transform 0.14s ease;
}
.tcard.is-selected {
  outline: 2px solid var(--app-ink);
  outline-offset: 1px;
}
.thumb {
  position: relative;
  aspect-ratio: 1242 / 1660;
  background: var(--app-surface-2, #f2f2f2);
}
/* 「在用」压在缩略图左上角：一屏 12 张，不看名字也得知道哪张是现在这张稿子的皮 */
.now {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--app-ink, #111);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
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
  gap: 6px;
  font-size: 12px;
  color: var(--app-ink-3, #999);
}
</style>
