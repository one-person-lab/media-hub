<script setup lang="ts">
/** 套用方案：从爆款里拆出来的推广结构，换我们自己的品牌、真截图和原话。
 *  一条方案存的是「页序 + 每页槽位 + 素材槽位」，不是成品图；出图与草稿全部由
 *  scripts/same-style-core.mjs 按品牌档案组装，界面一个字的事实都不自己写。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { playbooks, productProfiles, playbookProduct, holdSelfWrite, type Playbook } from '../data/store'
import { useToast } from '../lib/useToast'
import { ArrowLeft as IconArrowLeft, ChevronRight as IconChevronRight, CircleCheck as IconCircleCheck, Flame as IconFlame, LoaderCircle as IconLoaderCircle, X as IconX } from 'lucide-vue-next'

const emit = defineEmits<{ close: []; goStudio: [] }>()
const { toast } = useToast()

/** 文案能不能拿样张预填：样张出自哪个品牌就只预填给那个品牌。
 *  同一条规则的服务端版本在 scripts/same-style-core.mjs 的 sameProductAsSample */
const norm = (s: string) => String(s || '').trim().replace(/(小程序|App|app|网站)$/, '')
const wan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n || ''))

/* ==================== 列表：按品牌筛 ==================== */
const shown = computed(() =>
  playbookProduct.value ? playbooks.filter((p) => p.applies.includes(playbookProduct.value)) : playbooks,
)

/* ==================== 向导 ==================== */
const wb = ref<Playbook | null>(null)
const product = ref('')
const shots = ref<string[]>([])
const title = ref('')
const copy = ref<Record<string, string>>({})
/** 服务端的算法结果（生成前检查、拦截的话、即将落盘的路径）：界面只摆它给的读数 */
const plan = ref<{ ok: boolean; errors: string[]; gates: { ok: boolean; text: string }[]; slug: string; cardRel: string; mdRel: string } | null>(null)
const planning = ref(false)
const writing = ref(false)
const writeErr = ref('')
/** 生成成功后的那一屏：摆真出来的图，不放「成功了」三个字就完事 */
const done = ref<{ slug: string; cardRel: string; mdRel: string; pageCount: number; rendered: number[]; renderError: string } | null>(null)

const profile = computed(() => productProfiles.find((p) => p.name === product.value) || null)
/** 这套方案总共要吃几张真截图：版式的硬约束由服务端算，界面用同一个数提醒人 */
const needShots = computed(() => (wb.value?.pages || []).reduce((n, pg) => n + (pg.shots || 0), 0))

function openWizard(p: Playbook) {
  wb.value = p
  done.value = null
  writeErr.value = ''
  const first = p.applies.find((n) => productProfiles.some((x) => x.name === n)) || ''
  product.value = first
  title.value = ''
  copy.value = {}
  shots.value = []
}
function backToList() {
  wb.value = null
  plan.value = null
}
/** 取消 = 整层关掉；只有生成完那一屏才回到列表那一步 */
function dismiss() {
  if (wb.value && !done.value) backToList()
  emit('close')
}

/** 换品牌 = 换一整套素材与文案底稿：旧的勾选和填过的字都作废，不带进另一个品牌 */
watch(product, () => {
  const p = profile.value
  shots.value = (p?.screens || []).slice(0, needShots.value).map((s) => s.path)
  resetCopy()
})
watch(wb, (p) => {
  if (p) resetCopy()
})

/** 预填只给同款品牌：别的品牌的原话抄过来就是编事实 */
function resetCopy() {
  const pb = wb.value
  const prefill = !!pb && !!profile.value && norm(profile.value.name) === norm(pb.sample.product)
  const out: Record<string, string> = {}
  pb?.pages.forEach((pg, i) => {
    // 角标永远带一个值：换产品时带空串，服务端据此把「结果页原文」这类样张说法摘掉
    out[`${i + 1}.tag`] = prefill ? String(pg.preset?.tag ?? '') : ''
    if (!prefill) return
    const t = pb.sample.texts[i] || {}
    for (const slot of pg.edit) if (t[slot]) out[`${i + 1}.${slot}`] = t[slot]
  })
  copy.value = out
  title.value = ''
}

function toggleShot(path: string) {
  const i = shots.value.indexOf(path)
  if (i >= 0) shots.value.splice(i, 1)
  else shots.value.push(path)
}
const picked = (path: string) => shots.value.includes(path)

/** 发给服务端的这一单：界面给选择，事实一律由档案补 */
const body = () => ({
  playbookSlug: wb.value?.slug || '',
  product: product.value,
  shots: shots.value,
  copy: copy.value,
  title: title.value.trim() || undefined,
})

/* 选完就报：生成前检查与拦截的话都由服务端算，界面不自己判 */
let timer: ReturnType<typeof setTimeout> | undefined
watch([product, shots, copy, title], () => {
  if (!wb.value || done.value) return
  clearTimeout(timer)
  timer = setTimeout(askPlan, 400)
}, { deep: true })
onBeforeUnmount(() => clearTimeout(timer))

// 关闭按钮写着「Esc」，就得真按得掉：和点遮罩走同一条
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') dismiss()
}
onMounted(() => window.addEventListener('keydown', onEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))

async function askPlan() {
  if (!product.value || !wb.value) { plan.value = null; return }
  planning.value = true
  try {
    const r = await (await fetch('/__same-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan', ...body() }),
    })).json()
    if (!r.ok) throw new Error(r.error || '没算出来')
    const p = r.plan
    plan.value = { ok: p.ok, errors: p.errors, gates: p.gates, slug: p.slug, cardRel: p.cardRel, mdRel: p.mdRel }
  } catch (e) {
    plan.value = null
    toast(`检查没跑成：${(e as Error).message}`)
  } finally {
    planning.value = false
  }
}

async function generate() {
  const pb = wb.value
  if (!pb || !plan.value?.ok || writing.value) return
  writing.value = true
  writeErr.value = ''
  // 这一单服务端要落盘 + 渲一分多钟：整个请求期间都把自动刷新挂住。
  // 只在响应回来后才开窗的话，落盘那一条广播会先把整页刷掉，结果屏永远见不到（2026-10-26 实测）。
  holdSelfWrite()
  const beat = setInterval(holdSelfWrite, 20_000)
  try {
    const r = await (await fetch('/__same-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'write', ...body() }),
    })).json()
    if (!r.ok) throw new Error(r.error || '没生成')
    done.value = {
      slug: r.written.slug,
      cardRel: r.written.cardRel,
      mdRel: r.written.mdRel,
      pageCount: r.written.pageCount,
      rendered: r.rendered || [],
      renderError: r.renderError || '',
    }
    toast(`已生成 ${r.written.pageCount} 页图卡 + 1 份草稿`)
  } catch (e) {
    writeErr.value = (e as Error).message
  } finally {
    clearInterval(beat)
    writing.value = false
  }
}

function slotLabel(slot: string) {
  return ({ title: '大字', echo: '小字', items: '清单', cells: '格子', names: '类型名', caption: '收尾' } as Record<string, string>)[slot] || slot
}
function slotHint(slot: string) {
  return ({
    title: '一到两行：第一行压色，第二行淡色',
    echo: '大字底下那两三行小字',
    items: '一行一条，最多 5 条',
    cells: '一行一格，「名称 · 说明」',
    names: '最后一屏列的类型名',
    caption: '这一页收尾那一句',
  } as Record<string, string>)[slot] || ''
}
</script>

<template>
  <div v-dialog="wb ? `使用此方案 · ${wb.name}` : '套用方案'" class="modal modal--center" @click.self="dismiss">
    <div class="card modal-card max-w-5xl">
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <button v-if="wb && !done" class="btn-ghost !px-1.5" aria-label="返回方案列表" title="返回方案列表" @click="backToList">
          <IconArrowLeft :size="15" />
        </button>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-ink">{{ wb ? wb.name : '从跑过的爆款里拆出来的推广结构' }}</div>
          <div class="text-sm text-ink-3">{{ wb ? `${wb.pages.length} 页竖版` : `${shown.length} 条方案` }}</div>
        </div>
        <button class="btn shrink-0 !px-2 !py-1" aria-label="关闭（Esc）" title="关闭（Esc）" @click="dismiss">
          <IconX :size="15" />
        </button>
      </div>

      <!-- ---------- 第一步：挑一条方案 ---------- -->
      <div v-if="!wb" class="modal-body overflow-y-auto p-5">
        <div class="flex flex-wrap items-center gap-1.5">
          <button class="seg" :class="!playbookProduct && 'is-selected'" @click="playbookProduct = ''">
            全部 {{ playbooks.length }}
          </button>
          <button
            v-for="p in productProfiles.filter((x) => playbooks.some((b) => b.applies.includes(x.name)))"
            :key="p.name"
            class="seg"
            :class="playbookProduct === p.name && 'is-selected'"
            @click="playbookProduct = p.name"
          >
            {{ p.name }}
          </button>
        </div>

        <div v-if="shown.length" class="mt-4 grid gap-4 sm:grid-cols-2">
          <article
            v-for="b in shown"
            :key="b.slug"
            class="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-surface transition-[border-color,box-shadow] duration-300 hover:border-line-strong hover:shadow-lg"
            @click="openWizard(b)"
          >
            <!-- 预览摆这套方案上次真跑出来的页（最多 3 页），不是来源爆款那张封面 -->
            <div class="relative flex h-52 items-stretch gap-1.5 bg-canvas p-2">
              <img
                v-for="(u, i) in b.sample.urls.slice(0, 3)"
                :key="u"
                :src="`/${u}`"
                :alt="`同款第 ${i + 1} 页`"
                loading="lazy"
                class="h-full min-w-0 flex-1 rounded-md border border-line bg-surface object-cover object-top"
              />
              <div v-if="!b.sample.urls.length" class="flex flex-1 items-center justify-center rounded-md border border-dashed border-line text-sm text-ink-3">
                {{ b.pages.length }} 页竖版 · 还没跑出样张
              </div>
              <div class="pointer-events-none absolute inset-x-0 bottom-0 flex h-24 items-end justify-center bg-gradient-to-t from-[rgba(17,14,23,0.72)] via-[rgba(17,14,23,0.32)] to-transparent pb-4 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                <span class="btn btn-primary !py-1.5 !px-3 text-sm shadow-lg">
                  用这条
                  <IconChevronRight :size="13" class="shrink-0" />
                </span>
              </div>
            </div>

            <div class="flex flex-1 flex-col gap-2 p-4">
              <h2 class="flex items-center gap-2 text-[15px] font-medium text-ink">
                <span class="truncate">{{ b.name }}</span>
                <span class="chip shrink-0" :class="b.sample.urls.length ? 'status-published' : 'status-not-start'">
                  {{ b.sample.urls.length ? `已跑过 ${b.sample.urls.length} 页` : '只有结构' }}
                </span>
              </h2>
              <p class="line-clamp-2 text-sm leading-6 text-ink-2" :title="b.why">{{ b.structure }}</p>
              <p class="mt-auto flex items-center gap-1.5 border-t border-line pt-3 text-sm text-ink-3">
                <IconFlame :size="13" class="shrink-0 text-orange-400" />
                <span class="shrink-0 tabular-nums">{{ wan(b.source.likes) }} 赞</span>
                <span class="shrink-0">·</span>
                <span class="truncate" :title="`拆自：${b.source.title} · 适合：${b.applies.join(' / ')}`">拆自 {{ b.source.title }}</span>
              </p>
            </div>
          </article>
        </div>
        <p v-else class="mt-4 text-sm text-ink-2">这个品牌还没有可用的方案。</p>
      </div>

      <!-- ---------- 生成完的那一屏：摆真出来的图，不给一句「成功」了事 ---------- -->
      <div v-else-if="done" class="modal-body flex flex-col gap-4 overflow-y-auto p-5">
        <p class="text-sm leading-6 text-ink">
          {{ wb.name }} × {{ product }}：图卡 {{ done.pageCount }} 页，成图 {{ done.rendered.length }} 张，草稿已落待发布。
        </p>
        <div v-if="done.rendered.length" class="flex gap-2.5 overflow-x-auto">
          <img
            v-for="n in done.pageCount"
            :key="n"
            :src="`/cards/${done.slug}/${String(n).padStart(2, '0')}.png`"
            :alt="`第 ${n} 页`"
            class="h-56 w-40 shrink-0 rounded-md border border-line bg-canvas object-cover object-top"
            loading="lazy"
          />
        </div>
        <p v-if="done.renderError" class="text-sm leading-6 text-red-600">
          文字与草稿已保存，图片没全渲出来：{{ done.renderError }}
        </p>
        <div class="flex justify-end gap-2">
          <button class="btn-ghost" @click="backToList">再挑一条</button>
          <button class="btn btn-primary" @click="emit('goStudio')">去创作台看这张卡</button>
        </div>
      </div>

      <!-- ---------- 第二步：三步选择 + 服务端读数 ---------- -->
      <div v-else class="modal-body grid min-h-0 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div class="flex flex-col gap-3">
          <section class="rounded-lg border border-line bg-canvas p-3.5">
            <h3 class="text-sm font-medium text-ink">1. 选择品牌</h3>
            <select v-model="product" class="input mt-2 w-full">
              <option value="">选一个品牌</option>
              <option v-for="p in productProfiles" :key="p.name" :value="p.name">
                {{ p.name }}{{ p.status ? `（${p.status}）` : '' }}
              </option>
            </select>
            <p v-if="profile" class="mt-2 text-sm leading-6 text-ink-2">
              入口：{{ profile.entry || '未登记' }}<br>
              事实：{{ (profile.facts || []).join(' · ') || '未登记' }}
            </p>
            <p v-if="profile && !wb.applies.includes(profile.name)" class="mt-1 text-sm text-red-600">
              这条方案没登记适用于「{{ profile.name }}」：事实对不上就自己改写。
            </p>
          </section>

          <section class="rounded-lg border border-line bg-canvas p-3.5">
            <h3 class="flex items-baseline gap-2 text-sm font-medium text-ink">
              2 选素材
              <span class="text-sm font-normal text-ink-3">这套要 {{ needShots }} 张真界面截图，已勾 {{ shots.length }} 张</span>
            </h3>
            <div v-if="profile?.screens?.length" class="mt-2 grid grid-cols-4 gap-2">
              <button
                v-for="s in profile.screens"
                :key="s.path"
                type="button"
                class="relative overflow-hidden rounded-md border-2"
                :class="picked(s.path) ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100'"
                :aria-label="s.label"
                :title="s.path"
                @click="toggleShot(s.path)"
              >
                <img :src="`/${s.path.replace(/^public\//, '')}`" :alt="s.label" class="aspect-[3/4] w-full bg-canvas object-cover object-top" loading="lazy" />
                <span v-if="picked(s.path)" class="absolute bottom-0 left-0 right-0 truncate bg-accent px-1 py-0.5 text-left text-[11px] text-accent-ink">
                  {{ s.label || '未命名' }}
                </span>
              </button>
            </div>
            <p v-else-if="profile" class="mt-2 text-sm text-red-600">这张档案还没登记真素材，先去「品牌」页勾图。</p>
            <p class="mt-2 text-sm leading-6 text-ink-3">请补齐图片</p>
          </section>

          <section class="rounded-lg border border-line bg-canvas p-3.5">
            <h3 class="text-sm font-medium text-ink">3. 编辑文案</h3>
            <label class="mt-2 block text-sm text-ink-2">
              草稿标题
              <input v-model="title" class="input mt-1 w-full" :placeholder="`${product || '品牌'}：${wb.name}`" />
            </label>
            <p v-if="!copy[`${1}.title`]" class="mt-2 text-sm leading-6 text-ink-3">
              样张是「{{ wb.sample.product || '别的品牌' }}」跑出来的：{{ norm(product) === norm(wb.sample.product) ? '已按样张预填，改字即可' : '请核对品牌信息' }}
            </p>
            <div v-for="(pg, i) in wb.pages" :key="i" class="mt-3 border-t border-line pt-2.5">
              <div class="text-sm font-medium text-ink">第 {{ i + 1 }} 页 · {{ pg.role }}</div>
              <label class="mt-1.5 block">
                <span class="text-sm text-ink-3">页角文字</span>
                <input v-model="copy[`${i + 1}.tag`]" class="input mt-0.5 w-full" placeholder="留空 = 这一页不要角标" />
              </label>
              <label v-for="slot in pg.edit" :key="slot" class="mt-1.5 block">
                <span class="text-sm text-ink-3">{{ slotLabel(slot) }} · {{ slotHint(slot) }}</span>
                <textarea v-if="slot !== 'title'" v-model="copy[`${i + 1}.${slot}`]" rows="2" class="input mt-0.5 w-full" />
                <textarea v-else v-model="copy[`${i + 1}.${slot}`]" rows="2" class="input mt-0.5 w-full" placeholder="第一行&#10;第二行（可省）" />
              </label>
            </div>
          </section>
        </div>

        <div class="flex min-h-0 flex-col gap-3">
          <section class="rounded-lg border border-line p-3.5">
            <h3 class="flex items-baseline justify-between text-sm font-medium text-ink">
              产出预览
              <span class="text-sm font-normal text-ink-3">{{ wb.pages.length }} 页 · 1242 × 1660</span>
            </h3>
            <div class="mt-2.5 flex gap-2.5 overflow-x-auto">
              <figure v-for="(pg, i) in wb.pages" :key="i" class="w-24 shrink-0">
                <img
                  v-if="wb.sample.urls[i]"
                  :src="`/${wb.sample.urls[i]}`"
                  :alt="`样张第 ${i + 1} 页`"
                  class="h-32 w-24 rounded-md border border-line bg-canvas object-cover object-top"
                  loading="lazy"
                />
                <div v-else class="flex h-32 w-24 items-center justify-center rounded-md border border-dashed border-line text-sm text-ink-3">
                  没样张
                </div>
                <figcaption class="mt-1 text-center text-sm leading-5 text-ink-2">
                  {{ i + 1 }} {{ pg.role }}
                  <span v-if="pg.shots" class="text-ink-3">· {{ pg.shots }} 图</span>
                </figcaption>
              </figure>
            </div>
            <p class="mt-2 text-sm leading-6 text-ink-3">上面是我们上次用这条方案跑出来的样子；下面这一单会换成勾上的真截图。</p>
          </section>

          <section class="flex-1 rounded-lg border border-line p-3.5">
            <h3 class="flex items-baseline justify-between text-sm font-medium text-ink">
              生成前检查
              <span v-if="planning" class="flex items-center gap-1 text-sm font-normal text-ink-3">
                <IconLoaderCircle :size="13" class="animate-spin" />在算
              </span>
            </h3>
            <p v-if="!product" class="mt-2 text-sm text-ink-2">先选品牌。</p>
            <template v-else-if="plan">
              <ul class="mt-2 flex flex-col gap-1.5">
                <li v-for="(g, i) in plan.gates" :key="i" class="flex gap-2 text-sm leading-6 text-ink-2">
                  <IconCircleCheck :size="15" class="mt-1.5 shrink-0 text-accent" />
                  <span>{{ g.text }}</span>
                </li>
              </ul>
              <ul v-if="plan.errors.length" class="mt-2 flex flex-col gap-1.5">
                <li v-for="(e, i) in plan.errors" :key="i" class="text-sm leading-6 text-red-600">无法生成：{{ e }}</li>
              </ul>
            </template>
            <p v-else class="mt-2 text-sm text-ink-2">这台机器没起本地服务，检查算不出来（生成同理）。</p>

            <p v-if="writeErr" class="mt-2 text-sm leading-6 text-red-600">没生成：{{ writeErr }}</p>

            <div class="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
              <button class="btn-ghost" @click="dismiss">取消</button>
              <button
                class="btn btn-primary flex items-center gap-1.5"
                :disabled="!plan?.ok || writing || !product"
                :title="plan && !plan.ok ? '先把上面拦住的补齐' : ''"
                @click="generate"
              >
                <IconLoaderCircle v-if="writing" :size="15" class="shrink-0 animate-spin" />
                {{ writing ? '生成中…' : `生成 ${wb.pages.length} 页图卡 + 草稿` }}
                <IconChevronRight v-if="!writing" :size="13" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>
