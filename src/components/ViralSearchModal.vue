<script setup lang="ts">
/** 搜爆款：人点一个平台、现输关键词，浏览器边搜边把达标候选写进候选池，这一屏每两秒读一次池子——
 *  第一条出来就摆出来，不等整趟跑完。勾中的那几条才走第二趟浏览器搬进爆款采集。
 *  搜索与入库分两趟，中间这一次判断归人，所以候选连封面先落在服务端池子里。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PLATFORM_META, absorbBroadcasts, isRemote, stopRunningJob } from '../data/store'
import { countText } from '../utils/count'
import ClientOnly from './ClientOnly.vue'
import PlatformLogo from './PlatformLogo.vue'
import {
  Flame as IconFlame,
  Images as IconImages,
  LoaderCircle as IconLoaderCircle,
  Search as IconSearch,
  Square as IconSquare,
  X as IconX,
} from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'close'): void; (e: 'done', saved: number): void }>()

const labelOf = (p: string) => PLATFORM_META[p]?.label ?? p

interface Candidate {
  platform: string
  id: string
  title: string
  author: string
  likes: string
  format: string
  url: string
  cover: string
  keyword: string
  publishedAt: string
  heat: number
  /** 搜的时候就已经在库里（或进过归档）：不给再勾一遍 */
  already?: boolean
  /** 这一池里已经被挑走过的 */
  captured?: boolean
}

const rows = ref<Candidate[]>([])
const kw = ref('')
const gate = ref({ minLikes: 0, withinDays: 0 })
/** 候选池的时间戳：有它＝这台机器搜过，没它＝一次都没搜过，两种空态说法不一样 */
const poolAt = ref('')
/** 上一轮实际输进去的那几个词：翻回这一屏时接着它改，不从候选的命中词反推 */
const lastKeywords = ref('')
/** 搜哪个平台必须点出来：两个平台各搜一轮等于把等待摊成两倍 */
const PLATS = ['xiaohongshu', 'douyin']
const plat = ref('xiaohongshu')

/* ---------- 实时态：起一趟、盯到它收工 ---------- */
type Current = { platform: string | null; phase: string; done?: number; total?: number; note?: string }
type Job = {
  task?: string
  startedAt?: number
  running?: boolean
  exitCode?: number
  error?: string
  stopped?: boolean
  stopping?: boolean
  progress?: { platforms?: string[]; current?: Current | null } | null
}
const phase = ref<'idle' | 'search' | 'capture'>('idle')
const busy = computed(() => phase.value !== 'idle')
const searching = computed(() => phase.value === 'search')
const capturing = computed(() => phase.value === 'capture')
const current = ref<Current | null>(null)
const elapsed = ref(0)
const err = ref('')
/** 按停后的读数：停是人的动作，不是故障，用灰字报「停在哪」 */
const note = ref('')
/** 按下去了但脚本要在下一条才退：按钮先说「已按停」，不让人再点一次 */
const stopping = ref(false)

const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (sec: number) => `${Math.floor(sec / 60)}:${p2(Math.floor(sec) % 60)}`
/** 运行中那句读数：跑到第几个词、第几条，人据此判断还要等多久 */
const statusLine = computed(() => {
  const head = capturing.value ? '入库中' : '搜索中'
  const c = current.value
  if (!c) return `${head} ${clock(elapsed.value)}`
  const who = c.platform ? labelOf(c.platform) : ''
  const step = Number.isFinite(c.total) ? ` ${c.done ?? 0}/${c.total}` : ''
  return `${head} ${clock(elapsed.value)} · ${who}${c.phase}${step}`
})
/** 入库那一趟按钮自己就叫「入库中」，读数别再重复一遍，只报已等多久、走到第几条 */
const captureLine = computed(() => {
  const c = current.value
  if (!c) return `已 ${clock(elapsed.value)}`
  const step = Number.isFinite(c.total) ? ` ${c.done ?? 0}/${c.total}` : ''
  return `已 ${clock(elapsed.value)} · ${c.phase}${step}`
})

let poll: ReturnType<typeof setInterval> | null = null
let ticker: ReturnType<typeof setInterval> | null = null
/** 搜索那一趟每两秒读一次池子：脚本每搜完一个词就重写，第一条出来就该摆出来 */
let poolTick: ReturnType<typeof setInterval> | null = null
function clearWatch() {
  if (poll) clearInterval(poll)
  if (ticker) clearInterval(ticker)
  if (poolTick) clearInterval(poolTick)
  poll = ticker = poolTick = null
  current.value = null
}

async function startTask(task: string, arg: string) {
  const r = await (
    await fetch('/__run-script', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, arg }) })
  ).json()
  if (!r.ok) throw new Error(r.error || '启动失败')
  return r.startedAt as number
}

/** 盯着自己启动的那一笔：带 startedAt 问，否则服务端内存那一格会被别的任务顶掉 */
function watch(task: string, startedAt: number, onDone: (job: Job) => void) {
  elapsed.value = Math.round((Date.now() - startedAt) / 1000)
  ticker = setInterval(() => (elapsed.value = Math.round((Date.now() - startedAt) / 1000)), 1000)
  poll = setInterval(async () => {
    let job: Job | null = null
    try {
      job = (await (await fetch(`/__run-script?startedAt=${startedAt}`)).json()).job
    } catch {
      return // 本地服务在重建，下一轮再问
    }
    if (!job || job.task !== task || job.startedAt !== startedAt) return
    if (job.running) {
      current.value = job.progress?.current ?? null
      stopping.value = !!job.stopping
      return
    }
    clearWatch()
    onDone(job)
  }, 2000)
}

async function loadPool() {
  try {
    const o = await (await fetch('/__viral-search')).json()
    if (!o?.ok) return
    rows.value = (o.rows ?? []) as Candidate[]
    poolAt.value = o.at || ''
    lastKeywords.value = (o.keywords ?? []).join('，')
    gate.value = { minLikes: o.minLikes ?? 0, withinDays: o.withinDays ?? 0 }
    // 上一轮点的那个平台记在池子里：翻回这一屏接着用它
    const last = (o.platforms ?? [])[0]
    if (PLATS.includes(last)) plat.value = last
  } catch {
    /* 没有端点＝这台机器上没候选池，界面上就是空态 */
  }
}

async function search() {
  if (busy.value) return
  const kws = kw.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  if (!kws.length) return
  err.value = ''
  note.value = ''
  stopping.value = false
  picked.value = []
  rows.value = [] // 旧候选不属于这几个词，留着会把两轮的结果混成一池
  phase.value = 'search'
  poolTick = setInterval(loadPool, 2000)
  try {
    watch('viral-search', await startTask('viral-search', `${plat.value}:${kws.join(',')}`), async (job) => {
      phase.value = 'idle'
      stopping.value = false
      await loadPool()
      if (job.stopped) note.value = `已停止 · 搜到 ${shown.value.length} 条`
      else if (job.exitCode !== 0) err.value = job.error || '这一轮没搜成'
    })
  } catch (e) {
    clearWatch()
    phase.value = 'idle'
    err.value = String((e as Error).message || e)
  }
}

async function stop() {
  if (!busy.value || stopping.value) return
  // 停止走登记处那一条路；停不成要说出来，不许按下去没反应
  const r = await stopRunningJob('sync', capturing.value ? 'viral-capture' : 'viral-search')
  if (r.ok) stopping.value = true
  else err.value = r.error || '停止请求没送到本地服务'
}

/* ---------- 挑与收 ---------- */
const picked = ref<string[]>([])
/** 已在库的从列表里摘掉：同一批摆两遍，人得对着勾第二遍 */
const shown = computed(() => rows.value.filter((r) => !r.already && !r.captured))
const dupCount = computed(() => rows.value.length - shown.value.length)
const chosen = computed(() => shown.value.filter((r) => picked.value.includes(r.id)))
function toggle(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

async function capture() {
  if (busy.value || !chosen.value.length) return
  err.value = ''
  note.value = ''
  stopping.value = false
  const before = new Set(rows.value.filter((r) => r.captured).map((r) => r.id))
  const ids = chosen.value.map((r) => r.id)
  phase.value = 'capture'
  try {
    watch('viral-capture', await startTask('viral-capture', ids.join(',')), async (job) => {
      phase.value = 'idle'
      stopping.value = false
      picked.value = []
      await loadPool()
      const saved = rows.value.filter((r) => r.captured && !before.has(r.id)).length
      if (job.stopped) {
        note.value = `已停止 · 入库 ${saved} 条`
        if (saved) emit('done', saved)
        return
      }
      if (job.exitCode !== 0) {
        err.value = job.error || '没收进来'
        return
      }
      if (!saved) {
        err.value = '这几条库里已经有了'
        return
      }
      emit('done', saved)
    })
  } catch (e) {
    phase.value = 'idle'
    err.value = String((e as Error).message || e)
  }
}

/** 收进来的那几条会引出重建广播：这一屏还开着，吸成就地换表，别让候选列表被整页刷掉 */
let releaseAbsorb: (() => void) | null = null

onMounted(async () => {
  releaseAbsorb = absorbBroadcasts()
  await loadPool()
  kw.value = lastKeywords.value
  // 上一趟还没跑完就翻回这一页：接着盯它，别把运行中的搜索说成没搜过
  try {
    const { job } = await (await fetch('/__run-script')).json()
    if (job?.running && (job.task === 'viral-search' || job.task === 'viral-capture')) {
      phase.value = job.task === 'viral-capture' ? 'capture' : 'search'
      stopping.value = !!job.stopping
      if (phase.value === 'search') poolTick = setInterval(loadPool, 2000)
      watch(job.task, job.startedAt, async (job) => {
        phase.value = 'idle'
        stopping.value = false
        await loadPool()
        if (job.stopped) note.value = job.task === 'viral-capture' ? '已停止' : `已停止 · 搜到 ${shown.value.length} 条`
      })
    }
  } catch {
    /* 问不到实时态就只显盘上的候选池 */
  }
})
onBeforeUnmount(() => {
  clearWatch()
  releaseAbsorb?.()
  releaseAbsorb = null
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !busy.value) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const needAuth = computed(() => /登录|扫码|风控|验证码/.test(err.value))
/** 卡面那一行读数：平台 · 发布日 · 命中词，缺哪项就不出那个点 */
const metaOf = (v: Candidate) => [labelOf(v.platform), v.publishedAt, v.keyword].filter(Boolean).join(' · ')
</script>

<template>
  <div v-dialog="'搜爆款'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="!busy && emit('close')" />
    <div class="card modal-card relative z-10 max-w-2xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div class="flex items-center gap-2 text-sm font-medium">
          <IconFlame :size="15" />
          搜爆款
        </div>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body p-5">
        <div class="flex items-center gap-2">
          <div class="flex shrink-0 items-center gap-1">
            <button
              v-for="p in PLATS"
              :key="p"
              class="seg"
              :class="plat === p && 'is-selected'"
              :disabled="busy"
              @click="plat = p"
            >{{ labelOf(p) }}</button>
          </div>
          <input
            v-model="kw"
            :disabled="busy"
            class="input min-w-0 flex-1 !px-3 !py-1.5"
            placeholder="关键词"
            aria-label="关键词"
            @keyup.enter="search"
          />
          <button
            v-if="!busy"
            class="btn btn-primary shrink-0 !px-2.5 !py-1.5"
            :disabled="!kw.trim()"
            title="搜爆款"
            aria-label="搜爆款"
            @click="search"
          >
            <IconSearch :size="15" />
          </button>
          <button
            v-else
            class="btn shrink-0 !px-2.5 !py-1.5"
            :disabled="stopping"
            :title="stopping ? '已按停' : '停止'"
            :aria-label="stopping ? '已按停' : '停止'"
            @click="stop"
          >
            <IconSquare :size="15" />
          </button>
        </div>

        <ClientOnly v-if="isRemote" :what="'搜爆款'" class="mt-4" />

        <template v-else>
          <!-- 搜索中：读数挂在列表上面，候选每搜完一个词就多一批，不必等整趟跑完 -->
          <p v-if="searching" class="mt-3 flex items-center gap-2 text-aux tabular-nums text-ink-3">
            <IconLoaderCircle :size="13" class="shrink-0 animate-spin" />
            {{ statusLine }}
          </p>
          <p v-else-if="!shown.length" class="mt-4 rounded-bento border border-line bg-surface px-6 py-10 text-center">
            <IconImages :size="28" class="mx-auto text-ink-3" />
            <span v-if="poolAt && dupCount" class="mt-3 block text-sm text-ink-2">库里已有 {{ dupCount }} 条</span>
            <span v-else-if="poolAt" class="mt-3 block text-sm text-ink-2">
              没有过 {{ countText(gate.minLikes) }} 赞、近 {{ gate.withinDays }} 天的
            </span>
            <span v-else class="mt-3 block text-sm text-ink-2">还没搜过</span>
          </p>

          <ul v-if="shown.length" class="mt-3 flex flex-col divide-y divide-line rounded-inset border border-line">
            <li v-for="v in shown" :key="v.id">
              <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left" @click="toggle(v.id)">
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 shrink-0 accent-accent"
                  :checked="picked.includes(v.id)"
                  @click.stop="toggle(v.id)"
                />
                <img
                  v-if="v.cover"
                  :src="v.cover"
                  :alt="v.title"
                  class="h-12 w-9 shrink-0 rounded border border-line object-cover"
                  loading="lazy"
                />
                <span v-else class="grid h-12 w-9 shrink-0 place-items-center rounded border border-line bg-surface-2">
                  <IconImages :size="13" class="text-ink-3" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-sm text-ink">{{ v.title }}</span>
                  <span class="flex min-w-0 items-center gap-1 truncate text-aux text-ink-3">
                    <PlatformLogo :platform="labelOf(v.platform)" :size="12" />
                    {{ metaOf(v) }}
                  </span>
                </span>
                <span class="shrink-0 text-right font-metric text-aux tabular-nums text-ink-2">
                  {{ countText(v.likes) || '—' }} 赞
                </span>
              </button>
            </li>
          </ul>
        </template>
      </div>

      <div v-if="shown.length || err || note" class="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <button
          class="btn btn-primary flex !px-3 !py-1.5 items-center gap-1.5"
          :disabled="busy || !picked.length"
          @click="capture"
        >
          <IconLoaderCircle v-if="capturing" :size="13" class="animate-spin" />
          {{ capturing ? '入库中' : `收进来 ${picked.length} 条` }}
        </button>
        <a v-if="needAuth" class="btn-ghost shrink-0 !px-2.5" href="#/accounts" title="去账号页扫码登录">去授权</a>
        <span v-if="capturing" class="min-w-0 flex-1 truncate text-aux tabular-nums text-ink-3">{{ captureLine }}</span>
        <span v-else-if="err" class="min-w-0 flex-1 truncate text-sm font-medium text-red-600">{{ err }}</span>
        <span v-else-if="note" class="min-w-0 flex-1 truncate text-aux tabular-nums text-ink-3">{{ note }}</span>
        <span v-else-if="dupCount" class="min-w-0 flex-1 truncate text-sm text-ink-3">库里已有 {{ dupCount }} 条</span>
      </div>
    </div>
  </div>
</template>
