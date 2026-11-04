<script setup lang="ts">
/** 品牌档案页：要推广的东西只在这一处登记——入口、对外口径、能上图卡的真素材。
 *  选题的「归属品牌」、方案库的适用品牌、一键同款的文案与 CTA 全部回这里取数，
 *  所以这一页不许出现编出来的字段：留空就是没登记，没登记的品牌在向导里会被拦住。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  articles, topics, productProfiles, targetTypes, targetTypeOf, playbookProduct, playbookPick, holdSelfWrite,
  type ProductProfile, type TargetType,
} from '../data/store'
import SearchField from '../components/SearchField.vue'
import { useToast } from '../lib/useToast'
import {
  Check as IconCheck, LoaderCircle as IconLoaderCircle, Pencil as IconPencil, Plus as IconPlus, X as IconX,
} from 'lucide-vue-next'

const emit = defineEmits<{ go: [id: string] }>()
const { toast } = useToast()

const src = (path: string) => `/${path.replace(/^public\//, '')}`

/* ---- 卡面：素材条的比例与叫法都来自类型，不许写死竖屏 ---- */
const RATIO_CLASS: Record<string, string> = {
  '9/19': 'aspect-[9/19]',
  '3/4': 'aspect-[3/4]',
  '1/1': 'aspect-square',
  '4/3': 'aspect-[4/3]',
  '16/10': 'aspect-[16/10]',
}
const ratioClass = (ratio: string) => RATIO_CLASS[ratio] ?? 'aspect-[4/3]'

/** 一条档案的素材槽：类型只有一槽时按张数铺开，多槽时按槽位铺开 */
function slotsOf(p: ProductProfile) {
  const t = targetTypeOf(p.type)
  const screens = p.screens ?? []
  if (!t || t.slots.length < 2) {
    const ratio = t?.slots[0]?.ratio ?? '9/19'
    const shown = screens.slice(0, 4)
    return { ratio, cells: shown.map((s) => ({ ...s, slot: '' })), more: Math.max(0, screens.length - shown.length), last: shown.length - 1 }
  }
  const cells = t.slots.map((slot, i) => ({ path: screens[i]?.path ?? '', label: screens[i]?.label ?? '', slot: slot.label }))
  return { ratio: t.slots[0].ratio, cells, more: Math.max(0, screens.length - t.slots.length), last: cells.length - 1 }
}

/* ---- 推广情况：这一格推过的稿按时间倒序，第一行就是「上次推到哪了」 ---- */
function pushedOf(name: string) {
  const pub = articles
    .filter((a) => a.product === name)
    .sort((x, y) => (y.date || '').localeCompare(x.date || ''))
  return { pub, todo: topics.filter((t) => t.product === name).length }
}

const cards = computed(() =>
  productProfiles.map((p) => {
    const { pub, todo } = pushedOf(p.name)
    return { p, slots: slotsOf(p), pushed: pub.length, todo, last: pub[0] }
  }),
)

/** 类型页签：注册表里有几类就摆几页，0 也摆——加一类不动界面代码 */
const typeFilter = ref('')
const tabs = computed(() => [{ key: '', label: '全部' }, ...targetTypes.map((t) => ({ key: t.key, label: t.label }))])
const q = ref('')
const shown = computed(() =>
  cards.value.filter(({ p }) => {
    if (typeFilter.value && (p.type || 'app') !== typeFilter.value) return false
    if (!q.value.trim()) return true
    const hay = `${p.name} ${p.kind || ''} ${p.entry || ''} ${(p.facts || []).join(' ')} ${p.oneLiner || ''}`
    return hay.toLowerCase().includes(q.value.trim().toLowerCase())
  }),
)

/* ---- 看图弹层 ---- */
const viewer = ref<ProductProfile | null>(null)

/* ==================== 编辑弹层 ==================== */
type Draft = {
  name: string
  type: string
  kind: string
  status: string
  oneLiner: string
  entry: string
  facts: string
  screens: { path: string; label: string }[]
}
const empty = (): Draft => ({ name: '', type: 'app', kind: '', status: '', oneLiner: '', entry: '', facts: '', screens: [] })
const draft = ref<Draft>(empty())
const draftType = computed<TargetType | undefined>(() => targetTypeOf(draft.value.type))
/** 换类型时把状态词清掉：应用切门店留着「已上架」会存出一张自相矛盾的档案 */
function pickType(key: string) {
  if (draft.value.type === key) return
  draft.value.type = key
  draft.value.status = ''
}
/** 打开时那份档案的原名：改名要拿它找回旧条目；空串 = 新建 */
const originalName = ref('')
const open = ref(false)
const saving = ref(false)
const err = ref('')
/** 本机真存在的图：能勾的才是有的，不给人留打错路径的机会 */
const images = ref<string[]>([])

const of = (p: ProductProfile): Draft => ({
  name: p.name,
  type: p.type || 'app',
  kind: p.kind || '',
  status: p.status || '',
  oneLiner: p.oneLiner || '',
  entry: p.entry || '',
  facts: (p.facts || []).join('\n'),
  screens: (p.screens || []).map((s) => ({ path: s.path, label: s.label || '' })),
})

async function loadImages() {
  try {
    const o = await (await fetch('/__product')).json()
    if (o?.ok) images.value = (o.images || []) as string[]
  } catch { /* 静态托管没有本地服务：勾图那一格是空的，保存仍可用 */ }
}
onMounted(loadImages)

// 关闭按钮上写着「Esc」，就得真按得掉；和点遮罩一样直接关
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (viewer.value) viewer.value = null
  else if (open.value) open.value = false
}
onMounted(() => window.addEventListener('keydown', onEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))

function openNew() {
  originalName.value = ''
  draft.value = empty()
  err.value = ''
  open.value = true
}
function openEdit(p: ProductProfile) {
  originalName.value = p.name
  draft.value = of(p)
  err.value = ''
  open.value = true
}

const picked = (path: string) => !!draft.value.screens.find((s) => s.path === path)
/** 勾图网格：已选但本机清单里没有的排最前，免得存进去的图看不见又取消不掉 */
const pickList = computed(() => [...draft.value.screens.map((s) => s.path), ...images.value.filter((i) => !picked(i))])
function toggleImage(path: string) {
  const i = draft.value.screens.findIndex((s) => s.path === path)
  if (i >= 0) draft.value.screens.splice(i, 1)
  else draft.value.screens.push({ path, label: '' })
}
const labelOf = (path: string) => path.split('/').pop()!.replace(/\.[a-z]+$/i, '')

async function save() {
  saving.value = true
  err.value = ''
  try {
    const body = {
      originalName: originalName.value || undefined,
      product: {
        name: draft.value.name,
        type: draft.value.type,
        kind: draft.value.kind,
        status: draft.value.status,
        oneLiner: draft.value.oneLiner,
        entry: draft.value.entry,
        facts: draft.value.facts.split('\n').map((s) => s.trim()).filter(Boolean),
        screens: draft.value.screens,
      },
    }
    const r = await (await fetch('/__product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json()
    if (!r.ok) throw new Error(r.error || '没存进去')
    holdSelfWrite()
    open.value = false
    toast(`档案存好了：${r.product.name}`)
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function toPlaybooks(name: string) {
  playbookProduct.value = name
  playbookPick.value = true
  emit('go', 'topics')
}
</script>

<template>
  <div class="flex flex-col gap-4 pb-10">
    <!-- 本站是侧栏叶子项、站内无页签，--station-tabs-h 没人设，.station-toolbar 会退回 68px
         把吸顶钉在半空，卡片从它上面那道空档里滑过去。top-0 走 utilities 层，压得住 components 层。 -->
    <div class="station-toolbar top-0">
      <div class="flex flex-wrap items-center gap-2.5">
        <SearchField v-model="q" placeholder="搜品牌、口径、入口" label="搜品牌档案" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <button class="btn-ghost !px-2" aria-label="新建品牌" title="新建品牌" @click="openNew">
            <IconPlus :size="15" />
          </button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="seg"
          :class="t.key === typeFilter && 'is-selected'"
          @click="typeFilter = t.key"
        >{{ t.label }}</button>
      </div>
    </div>

    <div v-if="shown.length" class="grid gap-4 lg:grid-cols-2">
      <article
        v-for="{ p, slots, pushed, todo, last } in shown"
        :key="p.name"
        class="flex flex-col overflow-hidden rounded-bento border border-line bg-surface shadow-neo"
      >
        <!-- 卡面：类型给几槽就摆几格，比例也听类型的。点任意一张看全部 -->
        <div
          v-if="p.screens?.length"
          class="grid gap-2 border-b border-line bg-surface-2/60 px-4 py-3.5"
          :class="slots.cells.length === 3 ? 'grid-cols-3' : 'grid-cols-4'"
        >
          <button
            v-for="(s, i) in slots.cells"
            :key="s.path || i"
            class="relative overflow-hidden rounded-inset border border-line bg-surface p-0 transition-shadow hover:shadow-neo-lg"
            :class="[ratioClass(slots.ratio), !s.path && 'opacity-45']"
            :aria-label="`看 ${p.name} 的全部素材`"
            @click="viewer = p"
          >
            <img v-if="s.path" :src="src(s.path)" :alt="s.label || p.name" class="h-full w-full object-cover object-top" loading="lazy" />
            <span v-else class="absolute inset-0 grid place-items-center text-aux text-ink-3">{{ s.slot }}</span>
            <!-- 压在图上，所以固定深底浅字，不跟主题（同 NoteCard 的芯片口径） -->
            <span
              v-if="slots.more && i === slots.last"
              class="absolute inset-x-0 bottom-0 flex h-[26px] items-center justify-center bg-[rgba(17,14,23,0.7)] font-metric text-[12px] tabular-nums text-[#F5FBFF]"
            >+{{ slots.more }}</span>
          </button>
        </div>
        <div v-else class="flex items-center justify-center border-b border-line bg-red-50 px-4 py-5">
          <span class="text-[13px] text-red-600">素材未登记</span>
        </div>

        <div class="flex flex-1 flex-col gap-3 p-4">
          <header class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 class="text-[15px] font-semibold text-ink">{{ p.name }}</h2>
            <span v-if="p.status" class="chip status-published">{{ p.status }}</span>
            <span v-if="p.kind" class="chip status-not-start">{{ p.kind }}</span>
            <button class="btn-ghost ml-auto !px-2 !py-0.5" aria-label="编辑这张档案" title="编辑这张档案" @click="openEdit(p)">
              <IconPencil :size="13" />
            </button>
          </header>

          <p v-if="p.oneLiner" class="text-[13px] leading-[21px] text-ink-2">{{ p.oneLiner }}</p>

          <dl class="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-inset border border-line bg-surface-2/50 px-3.5 py-3 text-[13px]">
            <dt class="text-aux pt-[3px] text-ink-3">{{ targetTypeOf(p.type)?.entryLabel || '入口' }}</dt>
            <dd class="min-w-0 text-ink" :class="!p.entry && 'text-red-600'">{{ p.entry || '未登记' }}</dd>
            <dt class="text-aux pt-[3px] text-ink-3">口径</dt>
            <dd v-if="p.facts?.length" class="min-w-0 flex flex-col gap-1 text-ink-2">
              <span v-for="f in p.facts" :key="f">{{ f }}</span>
            </dd>
            <dd v-else class="min-w-0 text-red-600">未登记</dd>
          </dl>

          <footer class="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
            <div class="min-w-0">
              <div class="font-metric text-[13px] tabular-nums text-ink">
                推过 {{ pushed }} 篇<span v-if="todo"> · 选题 {{ todo }} 个</span>
              </div>
              <div v-if="last" class="truncate text-aux text-ink-3">{{ last.date }} {{ last.title }}</div>
              <div v-else class="text-aux text-ink-3">还没推过</div>
            </div>
            <button class="btn shrink-0 !px-2.5 !py-1 text-sm" @click="toPlaybooks(p.name)">看方案</button>
          </footer>
        </div>
      </article>
    </div>

    <div v-else class="flex flex-col items-center gap-3 rounded-bento border border-dashed border-line bg-surface-2/40 px-6 py-14 text-center">
      <p class="text-[13px] text-ink-3">还没有登记品牌。</p>
      <button class="btn btn-primary flex items-center gap-1.5 !px-3 !py-1 text-sm" @click="openNew">
        <IconPlus :size="15" />
        新建品牌
      </button>
    </div>

    <!-- 看图：整条产品线的真界面，卡面上摆不下的都在这儿 -->
    <div v-if="viewer" class="modal modal--center" @click.self="viewer = null">
      <div class="card modal-card max-w-3xl !p-0 overflow-hidden">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <h2 class="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">{{ viewer.name }}</h2>
          <span class="chip status-not-start">{{ viewer.screens?.length }} 张</span>
          <button type="button" class="btn shrink-0 !px-2 !py-1" aria-label="关闭（Esc）" title="关闭（Esc）" @click="viewer = null">
            <IconX :size="15" />
          </button>
        </div>
        <div class="modal-body grid grid-cols-3 gap-3 p-5 sm:grid-cols-4">
          <figure v-for="s in viewer.screens" :key="s.path" class="flex min-w-0 flex-col gap-1.5">
            <img
              :src="src(s.path)" :alt="s.label"
              :class="['w-full rounded-inset border border-line bg-surface-2 object-cover object-top', ratioClass(targetTypeOf(viewer.type)?.slots[0]?.ratio || '9/19')]" loading="lazy"
            />
            <figcaption class="truncate text-aux text-ink-3">{{ s.label || labelOf(s.path) }}</figcaption>
          </figure>
        </div>
      </div>
    </div>

    <!-- 编辑弹层：字段与档案一一对应，勾图只看真有的文件 -->
    <div v-if="open" v-dialog="originalName ? `编辑 ${originalName}` : '新建品牌'" class="modal modal--center" @click.self="open = false">
      <form class="card modal-card max-w-2xl !p-0 overflow-hidden" @submit.prevent="save">
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <h2 class="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">{{ originalName ? `编辑 ${originalName}` : '新建品牌' }}</h2>
          <button type="button" class="btn shrink-0 !px-2 !py-1" aria-label="关闭（Esc）" title="关闭（Esc）" @click="open = false">
            <IconX :size="15" />
          </button>
        </div>

        <div class="modal-body flex flex-col gap-4 p-5">
          <div class="text-sm font-medium text-ink-2">类型</div>
          <div class="mt-2 grid grid-cols-4 gap-2">
            <button
              v-for="t in targetTypes"
              :key="t.key"
              type="button"
              class="rounded-inset border px-3 py-2 text-[13px]"
              :class="draft.type === t.key ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2/50'"
              :aria-pressed="draft.type === t.key"
              @click="pickType(t.key)"
            >{{ t.label }}</button>
          </div>

          <div class="grid gap-4 sm:grid-cols-[1.4fr_1fr_1fr]">
            <label class="text-sm font-medium text-ink-2">
              品牌名
              <input v-model="draft.name" required maxlength="24" class="input mt-1 w-full" placeholder="醒醒老己小程序" />
            </label>
            <label class="text-sm font-medium text-ink-2">
              细分
              <input v-model="draft.kind" maxlength="12" class="input mt-1 w-full" placeholder="微信小程序" />
            </label>
            <label class="text-sm font-medium text-ink-2">
              状态
              <input v-model="draft.status" list="brand-status" maxlength="8" class="input mt-1 w-full" :placeholder="draftType?.statuses?.[0] || ''" />
              <datalist id="brand-status">
                <option v-for="s in draftType?.statuses || []" :key="s" :value="s" />
              </datalist>
            </label>
          </div>

          <label class="text-sm font-medium text-ink-2">
            简介
            <input v-model="draft.oneLiner" maxlength="60" class="input mt-1 w-full" placeholder="生命力测试 + 身份挑战：先看清现在在哪，再给今天能做的一件。" />
          </label>

          <label class="text-sm font-medium text-ink-2">
            {{ draftType?.entryLabel || '入口' }}
            <input v-model="draft.entry" maxlength="40" class="input mt-1 w-full" :placeholder="draftType?.entryHint || '用户怎么找到它'" />
          </label>

          <label class="text-sm font-medium text-ink-2">
            口径
            <textarea v-model="draft.facts" rows="4" class="input mt-1 w-full" placeholder="24 道题&#10;约 5 分钟&#10;8 种生命力状态" />
          </label>

          <div>
            <div class="flex items-baseline gap-2 text-sm font-medium text-ink-2">
              {{ draftType?.slots[0]?.label || '素材' }}
              <span v-if="draft.screens.length" class="font-metric text-aux tabular-nums text-ink-3">{{ draft.screens.length }} 张</span>
            </div>
            <div v-if="images.length || draft.screens.length" class="mt-2 grid max-h-60 grid-cols-5 gap-2 overflow-y-auto sm:grid-cols-7">
              <button
                v-for="img in pickList"
                :key="img"
                type="button"
                class="relative overflow-hidden rounded-inset border-2 bg-surface-2 transition-all"
                :class="[ratioClass(draftType?.slots[0]?.ratio || '9/19'), picked(img) ? 'border-accent' : 'border-transparent opacity-65 hover:opacity-100']"
                :aria-label="labelOf(img)"
                :aria-pressed="picked(img)"
                @click="toggleImage(img)"
              >
                <img :src="src(img)" :alt="labelOf(img)" class="h-full w-full object-cover object-top" loading="lazy" />
                <span
                  v-if="picked(img)"
                  class="absolute right-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-accent text-accent-ink"
                >
                  <IconCheck :size="13" />
                </span>
              </button>
            </div>
            <p v-else class="mt-2 text-[13px] text-ink-3">本机还没有可选素材。</p>

            <div v-if="draft.screens.length" class="mt-3 flex max-h-60 flex-col gap-2 overflow-y-auto">
              <div
                v-for="(s, i) in draft.screens"
                :key="s.path"
                class="flex items-center gap-2.5 rounded-inset border border-line bg-surface-2/50 p-1.5 pr-2"
              >
                <img
                  :src="src(s.path)" :alt="labelOf(s.path)"
                  class="h-11 shrink-0 rounded-[4px] object-cover object-top"
                  :class="draftType?.slots[0]?.ratio === '9/19' ? 'w-8' : 'w-14'" loading="lazy"
                />
                <span class="w-5 shrink-0 font-metric text-aux tabular-nums text-ink-3">{{ i + 1 }}</span>
                <input v-model="s.label" maxlength="12" class="input min-w-0 flex-1 !py-1" :placeholder="labelOf(s.path)" />
                <button type="button" class="btn-ghost shrink-0 !px-1.5 !py-1" aria-label="移除这张" title="移除这张" @click="toggleImage(s.path)">
                  <IconX :size="13" />
                </button>
              </div>
            </div>
          </div>

          <p v-if="err" class="text-sm text-red-600">{{ err }}</p>

          <div class="flex justify-end gap-2 pt-1">
            <button type="button" class="btn-ghost" @click="open = false">取消</button>
            <button type="submit" class="btn btn-primary flex items-center gap-1.5" :disabled="saving || !draft.name.trim()">
              <IconLoaderCircle v-if="saving" :size="15" class="shrink-0 animate-spin" />
              {{ saving ? '存盘中…' : '存档案' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
