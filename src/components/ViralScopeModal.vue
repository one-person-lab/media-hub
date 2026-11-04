<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { PLATFORM_META, holdSelfWrite } from '../data/store'
import { CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, LoaderCircle as IconLoaderCircle, Plus as IconPlus, X as IconX } from 'lucide-vue-next'
import PlatformLogo from './PlatformLogo.vue'
import SyncButton from './SyncButton.vue'

/** 采集条件弹窗：平台、关键词、门槛都在这，按 scope 写回各自那份 config——
 *  爆款线是 config/viral.json，对标线是 config/benchmarks.json（两条线的门槛判据不同，不能共用一份）。
 *  工具栏那一格给了「搜爆款 / 收对标」，定时采集的运行键收在这一屏。 */
const emit = defineEmits<{ (e: 'close'): void }>()
const props = defineProps<{ scope?: 'viral' | 'benchmark'; runAt?: string | null }>()
const isBench = computed(() => props.scope === 'benchmark')
const cfgUrl = computed(() => (isBench.value ? '/__benchmark-config' : '/__viral-config'))
const runCn = computed(() => (isBench.value ? '对标采集' : '爆款采集'))

interface Loaded {
  keywords: string[]
  platforms: string[]
  minLikes: number
  minComments: number
  withinDays: number
  minFollowers: number
  maxInactiveDays: number
  dailyLimitPerPlatform: number
}

const loading = ref(true)
const saving = ref(false)
const msg = ref('')
const msgOk = ref(true)
const supported = ref<string[]>([])
const form = ref<Loaded>({
  keywords: [], platforms: [], minLikes: 0, minComments: 0, withinDays: 0,
  minFollowers: 0, maxInactiveDays: 0, dailyLimitPerPlatform: 0,
})
const kwInput = ref('')

onMounted(async () => {
  try {
    const o = await (await fetch(cfgUrl.value)).json()
    if (!o.ok) throw new Error(o.error || '读取失败')
    supported.value = o.supportedPlatforms || []
    form.value = { ...form.value, ...o.config }
  } catch (e) {
    msg.value = `读取失败：${(e as Error).message}`
    msgOk.value = false
  } finally {
    loading.value = false
  }
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const platLabel = (p: string) => PLATFORM_META[p]?.label ?? p

/** 平台是开关不是单选：两个平台可以同时采，也可以只采一个 */
function togglePlatform(p: string) {
  form.value.platforms = form.value.platforms.includes(p)
    ? form.value.platforms.filter((x) => x !== p)
    : [...form.value.platforms, p]
}

/** 关键词 chips：× 删、输入框加。去重在服务端做，这里只管别塞空串 */
function addKeyword() {
  const t = kwInput.value.trim()
  if (!t) return
  if (!form.value.keywords.includes(t)) form.value.keywords.push(t)
  kwInput.value = ''
}
function removeKeyword(kw: string) {
  form.value.keywords = form.value.keywords.filter((k) => k !== kw)
}

const numOf = (v: string | number) => (v === '' ? NaN : Number(v))

/** 门槛数字的即时校验：输入框被清空时 v-model.number 给的是空串，
 *  不拦就会静默变成 0（粉丝下限 0 = 不要门槛），这种错不能等服务端拒了才发现 */
const numBad = computed(() => {
  const { dailyLimitPerPlatform } = form.value
  if (!Number.isInteger(dailyLimitPerPlatform) || dailyLimitPerPlatform < 1) return '每平台每天条数要 ≥ 1 的整数'
  if (isBench.value) {
    const { minFollowers, maxInactiveDays } = form.value
    if (!Number.isInteger(minFollowers) || minFollowers < 0) return '粉丝下限要 ≥ 0 的整数'
    if (!Number.isInteger(maxInactiveDays) || maxInactiveDays < 1) return '停更上限要 ≥ 1 的整数'
    return ''
  }
  const { minLikes, minComments, withinDays } = form.value
  if (!Number.isInteger(minLikes) || minLikes < 0) return '点赞下限要 ≥ 0 的整数'
  if (!Number.isInteger(minComments) || minComments < 0) return '评论下限要 ≥ 0 的整数'
  if (!Number.isInteger(withinDays) || withinDays < 1) return '发布窗口要 ≥ 1 的整数'
  return ''
})

const canSave = computed(() =>
  !saving.value &&
  !loading.value &&
  !numBad.value &&
  form.value.keywords.length > 0 &&
  form.value.platforms.length > 0,
)

async function save() {
  saving.value = true
  msg.value = ''
  const base = { keywords: form.value.keywords, platforms: form.value.platforms, dailyLimitPerPlatform: numOf(form.value.dailyLimitPerPlatform) }
  const gate = isBench.value
    ? { minFollowers: numOf(form.value.minFollowers), maxInactiveDays: numOf(form.value.maxInactiveDays) }
    : {
        minLikes: numOf(form.value.minLikes),
        minComments: numOf(form.value.minComments),
        withinDays: numOf(form.value.withinDays),
      }
  try {
    const o = await (await fetch(cfgUrl.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, ...gate }),
    })).json()
    if (!o.ok) throw new Error(o.error || '保存失败')
    msg.value = '已保存，下轮采集生效'
    msgOk.value = true
    // 服务端写完会重建广播：不开窗，弹层会被整页刷掉；hold 住让页面就地换口径
    holdSelfWrite()
    setTimeout(() => emit('close'), 600)
  } catch (e) {
    msg.value = `保存失败：${(e as Error).message}`
    msgOk.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-dialog="'采集条件'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
    <div class="card modal-card relative z-10 max-w-xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 class="text-[17px] font-semibold text-ink">采集条件</h2>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body flex flex-col gap-6 px-5 py-5">
        <p v-if="loading" class="text-sm text-ink-2">读取中…</p>

        <template v-else>
          <!-- 搜索平台：白名单内的开关，至少留一个 -->
          <section class="flex flex-col gap-2.5">
            <h3 class="text-section text-ink">平台</h3>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="p in supported"
                :key="p"
                class="seg"
                :class="form.platforms.includes(p) && 'is-selected'"
                @click="togglePlatform(p)"
              >
                <PlatformLogo :platform="platLabel(p)" :size="14" />
                {{ platLabel(p) }}
              </button>
            </div>
          </section>

          <!-- 关键词：定位词，两平台共用同一批 -->
          <section class="flex flex-col gap-2.5">
            <div class="flex items-baseline gap-2">
              <h3 class="text-section text-ink">关键词</h3>
              <span class="ml-auto font-metric text-aux tabular-nums text-ink-3">{{ form.keywords.length }}</span>
            </div>
            <div class="rounded-inset border border-line bg-surface-2/50 p-3">
              <div class="flex flex-wrap gap-1.5">
                <span v-for="kw in form.keywords" :key="kw" class="chip !pr-1.5">
                  {{ kw }}
                  <button class="ml-0.5 font-medium text-ink-3 hover:text-red-600" title="删掉这个词" @click="removeKeyword(kw)">×</button>
                </span>
                <span v-if="!form.keywords.length" class="text-sm text-ink-3">还没有关键词</span>
              </div>
              <div class="mt-3 flex gap-2">
                <input
                  v-model="kwInput"
                  class="input min-w-0 flex-1 !px-3 !py-1.5"
                  placeholder="回车添加"
                  @keyup.enter="addKeyword"
                />
                <button class="btn btn-ghost shrink-0 !px-2.5" :disabled="!kwInput.trim()" @click="addKeyword">
                  <IconPlus :size="13" />
                  添加
                </button>
              </div>
            </div>
          </section>

          <!-- 门槛：什么算爆款 / 什么值得长期对标。口径归你拍板，这里只挡非法值 -->
          <section class="flex flex-col gap-2.5">
            <h3 class="text-section text-ink">{{ isBench ? '对标门槛' : '爆款门槛' }}</h3>
            <div class="grid gap-x-3 gap-y-3.5 rounded-inset border border-line bg-surface-2/50 p-3.5 sm:grid-cols-2">
              <template v-if="isBench">
                <label class="block text-aux text-ink-3">
                  粉丝下限
                  <input v-model.number="form.minFollowers" type="number" min="0" step="1000" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
                <label class="block text-aux text-ink-3">
                  停更上限（天）
                  <input v-model.number="form.maxInactiveDays" type="number" min="1" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
                <label class="block text-aux text-ink-3">
                  每平台每天建档数
                  <input v-model.number="form.dailyLimitPerPlatform" type="number" min="1" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
              </template>
              <template v-else>
                <label class="block text-aux text-ink-3">
                  点赞下限
                  <input v-model.number="form.minLikes" type="number" min="0" step="1000" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
                <label class="block text-aux text-ink-3">
                  评论下限
                  <input v-model.number="form.minComments" type="number" min="0" step="50" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
                <label class="block text-aux text-ink-3">
                  发布窗口（天）
                  <input v-model.number="form.withinDays" type="number" min="1" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
                <label class="block text-aux text-ink-3">
                  每平台每天条数
                  <input v-model.number="form.dailyLimitPerPlatform" type="number" min="1" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux tabular-nums" />
                </label>
              </template>
            </div>
            <p v-if="numBad" class="text-aux font-medium text-red-600">{{ numBad }}</p>
          </section>

          <!-- 定时那一趟的运行键收在条件里：工具栏那一格让给搜爆款 / 收对标 -->
          <section class="flex flex-col gap-2.5">
            <h3 class="text-section text-ink">{{ runCn }}</h3>
            <div class="flex w-fit items-center gap-1 rounded-inset border border-line bg-surface-2/50 px-1.5 py-1">
              <SyncButton quiet reading :disabled="saving" :task="props.scope ?? 'viral'" :at="runAt" />
            </div>
          </section>
        </template>
      </div>

      <div v-if="!loading" class="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-5 py-3">
        <span v-if="msg" class="flex min-w-0 items-center gap-1.5 text-aux font-medium" :class="msgOk ? 'text-success' : 'text-red-600'">
          <component :is="msgOk ? IconCircleCheck : IconCircleAlert" :size="13" class="shrink-0" />
          <span class="min-w-0 truncate">{{ msg }}</span>
        </span>
        <button class="btn btn-primary ml-auto shrink-0 !px-3.5 !py-1.5" :disabled="!canSave" @click="save">
          <IconLoaderCircle v-if="saving" :size="13" class="animate-spin" />
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
