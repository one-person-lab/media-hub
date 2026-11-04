<script setup lang="ts">
/** 商业浓度弹窗：这一稿到底卖不卖东西，在这定。
 *  三档不是装饰——渲染前那道品牌词闸门按它决定拦不拦（见 render-cards.mjs checkCard）：
 *  只给价值 = 品牌词一个都不许出现；价值里植入 = 只有标了「可提品牌」的那几页放行；
 *  只推品牌 = 整稿就是品牌，不拦。所以改完必须重渲一次，闸门才会重新跑一遍现有文字。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { cardLayoutByName, products, type CardIntent } from '../data/store'
import { CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, Tag as IconTag, X as IconX } from 'lucide-vue-next'

const props = defineProps<{
  data: Record<string, any>
  /** 渲染器按 product 有无推导的缺省档，界面上要如实显示「这是推出来的」而不是假装用户选的 */
  derived: CardIntent
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', data: Record<string, any>): void
}>()

const MODES: { key: CardIntent; label: string; note: string }[] = [
  { key: 'value', label: '只给价值', note: '品牌词一个都不许出现' },
  { key: 'mixed', label: '价值里植入', note: '只有标了「可提品牌」的那几页放行' },
  { key: 'promo', label: '只推品牌', note: '整稿都是品牌内容' },
]

const intent = ref<CardIntent>((MODES.some((m) => m.key === props.data?.intent) ? props.data.intent : props.derived) as CardIntent)
const product = ref<string>(String(props.data?.product || ''))
const commercial = ref<Set<number>>(
  new Set((props.data?.pages || []).map((p: any, i: number) => (p?.commercial === true ? i : -1)).filter((i: number) => i >= 0)),
)

const pages = computed(() =>
  (props.data?.pages || []).map((p: any, i: number) => ({
    no: i,
    layout: String(p?.layout || ''),
    label: cardLayoutByName(String(p?.layout || ''))?.label || p?.layout || '未登记版式',
  })),
)

/** 只给价值时挂品牌是自相矛盾：归属品牌只是给闸门看的标签，这一档它不参与判定，清空免得下轮又被推成 promo */const showProduct = computed(() => intent.value !== 'value')

function toggleMode(k: CardIntent) {
  intent.value = k
  if (k === 'value') product.value = ''
}
function togglePage(i: number) {
  const next = new Set(commercial.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  commercial.value = next
}

const mixedNoPage = computed(() => intent.value === 'mixed' && commercial.value.size === 0)
const changed = computed(() => {
  const d = props.data
  if (intent.value !== (d?.intent || props.derived)) return true
  if (product.value !== String(d?.product || '')) return true
  const old = new Set((d?.pages || []).map((p: any, i: number) => (p?.commercial === true ? i : -1)).filter((i: number) => i >= 0))
  if (old.size !== commercial.value.size) return true
  return [...commercial.value].some((i) => !old.has(i))
})

function save() {
  if (mixedNoPage.value) return
  const next = JSON.parse(JSON.stringify(props.data))
  next.intent = intent.value
  next.product = product.value
  next.pages = (next.pages || []).map((p: any, i: number) => {
    const { commercial: _drop, ...rest } = p || {}
    return commercial.value.has(i) ? { ...rest, commercial: true } : rest
  })
  emit('save', next)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <!-- 这一列是 xl:sticky，自带 stacking context：弹窗留在原地会被页面底部推送条压住，遮罩也盖不住它 -->
  <Teleport to="body">
  <div v-dialog="'商业浓度'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
    <div class="card modal-card relative z-10 max-w-xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div class="flex items-center gap-2 text-sm font-medium">
          <IconTag :size="15" />
          商业浓度
        </div>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body space-y-5 p-5">
        <div class="grid gap-2 sm:grid-cols-3">
          <button
            v-for="m in MODES"
            :key="m.key"
            class="seg !h-auto flex-col items-start justify-start !whitespace-normal gap-0 !px-3 !py-2 text-left"
            :class="intent === m.key ? 'is-selected' : ''"
            @click="toggleMode(m.key)"
          >
            <span class="block text-sm font-medium">{{ m.label }}</span>
            <span class="mt-0.5 block text-sm leading-5 text-ink-3">{{ m.note }}</span>
          </button>
        </div>

        <p v-if="!data.intent" class="text-sm leading-5 text-ink-3">
          还没存过选择，上面默认按「{{ data.product ? '挂了品牌 = 只推品牌' : '没挂品牌 = 只给价值' }}」。
        </p>

        <div v-if="showProduct">
          <div
            class="mb-2 text-sm font-medium text-ink-2"
            title="这里改的是图卡上的归属标记；md 里的「归属品牌」在创作信息里改"
          >
            归属品牌
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="p in products"
              :key="p"
              class="chip"
              :class="product === p ? '!border-line-strong !bg-surface font-medium' : ''"
              @click="product = product === p ? '' : p"
            >
              {{ p }}
            </button>
            <span v-if="!products.length" class="text-sm text-ink-3">还没登记品牌，去「品牌」页建一个</span>
          </div>
        </div>

        <div v-if="intent === 'mixed'">
          <div class="mb-2 text-sm font-medium text-ink-2">哪几页可以提品牌</div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in pages"
              :key="p.no"
              class="seg"
              :class="commercial.has(p.no) ? 'is-selected' : ''"
              :title="`第 ${p.no + 1} 页 · ${p.label}`"
              @click="togglePage(p.no)"
            >
              {{ p.no + 1 }} {{ p.label }}
            </button>
          </div>
          <p v-if="mixedNoPage" class="mt-1.5 text-sm font-medium text-red-600">
            一页都没标，等于没植入——勾一页，或换成「只给价值」。
          </p>
        </div>

        <div class="flex items-center gap-2 border-t border-line pt-4">
          <button class="btn btn-primary !px-3 !py-1" :disabled="!changed || mixedNoPage" @click="save">
            <IconCircleCheck v-if="changed && !mixedNoPage" :size="13" />
            保存并重新生成
          </button>
          <span class="flex min-w-0 items-center gap-1.5 text-sm leading-5 text-ink-3">
            <IconCircleAlert v-if="intent !== 'promo'" :size="15" class="shrink-0" />
            <span class="min-w-0">
              修改后重新生成全部页面
            </span>
          </span>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>
