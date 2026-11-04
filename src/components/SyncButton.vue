<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { accounts, runReading, isRemote, capabilitiesReady, stopRunningJob, SYNC_TASK_LABEL, type CollectTask, type RunSurfaceState } from '../data/store'
import { useToast } from '../lib/useToast'
import ClientOnly from './ClientOnly.vue'
import { Check as IconCheck, ChevronDown as IconChevronDown, RefreshCw as IconRefreshCw, Square as IconSquare, X as IconX } from 'lucide-vue-next'

/** 页头运行条：一个采集任务在这屏的全部可见性——数据什么时候落的、隔了几天、哪几个平台没采到、
 *  现在这一点能不能按。八态见 docs/superpowers/specs/2026-10-22-collect-run-surface.md §三。
 *  只报真实落盘读数：不写频率、不报平安。 */
const props = defineProps<{
  task: CollectTask
  /** 没有运行留痕时用的产物落盘读数（lastViralAt / lastFavoriteAt / lastSyncAt / lastPublishSyncAt） */
  at?: string | null
  /** 静置档：一颗动作键，落盘时间退到悬浮名里。点读数不触发任务 */
  quiet?: boolean
  /** 静置键旁带一句读数（采集配置弹层里那颗键：键后面要跟一句「上次同步…」，光秃秃认不出） */
  reading?: boolean
  /** 外部条件没满足（例如名单还没保存），键按下去不做声 */
  disabled?: boolean
  /** 空闲时那颗键叫什么（搜爆款 / 搜热点）；跑起来仍叫「停止」 */
  runLabel?: string
}>()

/** 本任务跑起来了没有：挂在弹层里时要用它挂住整页刷新，否则一轮跑完的广播会把弹层刷掉 */
const emit = defineEmits<{ (e: 'busy', on: boolean): void }>()

const { toast } = useToast()

const PLAT_CN: Record<string, string> = { xiaohongshu: '小红书', douyin: '抖音', mp: '公众号', kuaishou: '快手', sph: '视频号' }
const verb = computed(() =>
  props.task === 'publish-check' ? '检测' : props.task === 'favorites' ? '同步' : '采集',
)

type Surface = RunSurfaceState | 'running' | 'blocked'
interface PlatResult { state: string; count?: number; note?: string }
type Current = { platform: string | null; phase: string; done?: number; total?: number; note?: string }
interface View {
  surface: Surface
  at: string | null
  gapDays: number | null
  platforms: Record<string, PlatResult>
  /** 本轮计划跑哪些平台（运行中才有）：没轮到的也要列出来，人才知道还剩几步 */
  plan?: string[]
  /** 现在正在做的这一段 */
  current?: Current | null
  failed: string[]
  reason: string
}

const p2 = (n: number) => String(n).padStart(2, '0')
/** 只有日期的产物读数退化成 MM-DD，带时刻的显到分 */
const shortAt = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  return iso.length === 10 ? day : `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const clock = (sec: number) => `${Math.floor(sec / 60)}:${p2(Math.floor(sec) % 60)}`

interface Job {
  running: boolean
  task: string
  /** 服务端给的这活儿的名字（撞车时报名字用，界面不再自己拼一张表） */
  label?: string
  startedAt: number
  finishedAt?: number | null
  exitCode?: number | null
  stopped?: boolean
  /** 人已按停、脚本还在收当前这一段（服务端在写信号文件那一刻翻起来） */
  stopping?: boolean
  error?: string
  /** 服务端看门狗上限（scripts/server-core.mjs 的 SYNC_TASKS[task].timeoutMs）：等待要有个边界可读 */
  limitMs?: number
  /** 脚本运行中实时写的进度（ego 把 stdout 攒到进程退出，进度只能走文件） */
  progress?: {
    platforms?: string[]
    current?: { platform: string | null; phase: string; done?: number; total?: number; note?: string } | null
    updatedAt?: number
  } | null
  steps?: (PlatResult & { platform: string })[]
}
interface Plat extends PlatResult {
  key: string
  state: string
}
const job = ref<Job | null>(null)
const elapsed = ref(0)
/** 跑完那一轮的结果先由本组件拿着：留痕要等重建 + 刷新才进 store，这几秒不能空着 */
const justDone = ref<View | null>(null)
let startedAt = 0

const live = computed(() => {
  const j = job.value
  if (!j?.running) return null
  return {
    task: j.task,
    mine: j.task === props.task, other: SYNC_TASK_LABEL[j.task] ?? j.label ?? j.task,
    startedAt: j.startedAt, steps: j.steps ?? [], plan: j.progress?.platforms ?? [],
    current: j.progress?.current ?? null, limitMs: j.limitMs ?? 0, stopping: !!j.stopping,
  }
})

const view = computed<View>(() => {
  const l = live.value
  if (l) {
    const platforms = Object.fromEntries(l.steps.map((s) => [s.platform, s]))
    return {
      surface: l.mine ? 'running' : 'blocked',
      at: justDone.value?.at ?? props.at ?? null,
      gapDays: null,
      platforms,
      plan: l.plan,
      current: l.current,
      failed: l.steps.filter((s) => s.state === 'error').map((s) => s.platform),
      reason: '',
    }
  }
  if (justDone.value) return justDone.value
  const r = runReading(props.task, props.at)
  return { ...r, surface: r.state }
})

watch(() => view.value.surface === 'running', (on) => emit('busy', on))

/** 运行条只报名字，不报内部键：同平台的第二个号（douyin-2 那种）在表里查得到，就报「抖音·晓丸子君」 */
const platLabel = (k: string) => {
  const cn = PLAT_CN[k]
  if (cn) return cn
  const a = accounts.find((x) => x.key === k)
  return a ? `${a.platform}·${a.nickname}` : k
}

const chipText = computed(() => {
  const v = view.value
  const act = verb.value
  switch (v.surface) {
    // 上限是服务端那道看门狗（超时就掐），给等待一个边界；没带读数（cron 跑的那轮）就不写
    case 'running': return live.value?.stopping
      ? `已按停 ${clock(elapsed.value)}`
      : `${act}中 ${clock(elapsed.value)}${limitText.value ? ` / ${limitText.value}` : ''}`
    case 'blocked': return live.value?.stopping
      ? `${live.value?.other ?? ''}已按停 · 收工中 ${clock(elapsed.value)}`
      : `${live.value?.other ?? ''}正在跑 · 已 ${clock(elapsed.value)}`
    case 'never': return `未${act}过`
    // 断档：隔了几天是真读数；到点了今天这轮还没落盘，说「今天这轮没落」，不写「隔了 0 天」
    case 'stale': return `上次${act} ${shortAt(v.at)} · 已隔 ${v.gapDays ?? 0} 天`
    case 'aged': return `上次${act} ${shortAt(v.at)}${(v.gapDays ?? 0) >= 2 ? ` · 已隔 ${v.gapDays} 天` : ' · 今天这轮没落'}`
    case 'failed': return `本轮没${act}到`
    case 'partial': return `${v.failed.length} 个平台没${act}到`
    default: return `上次${act} ${shortAt(v.at)}`
  }
})
const isBad = computed(() => view.value.surface === 'failed' || view.value.surface === 'partial')
/** 悬浮名把「做什么 + 现在什么态 + 砸了为什么」一次说完，版面因此一个字的读数都不用摆 */
const quietTitle = computed(() => {
  const head = isStop.value ? '停止' : (props.runLabel ?? `立即${verb.value}`)
  const why = isBad.value ? reasonLine.value : ''
  return why ? `${head} · ${why}` : `${head} · ${chipText.value}`
})
/** 60 分以上说「小时」，否则说「分」——「最多 60 分」读起来像在吓人 */
const limitText = computed(() => {
  const ms = live.value?.limitMs ?? 0
  if (!ms || !live.value?.mine) return ''
  const min = Math.round(ms / 60_000)
  return min >= 60 ? `最多 ${Math.round(min / 60)} 小时` : `最多 ${min} 分`
})
const chipClass = computed(() => {
  switch (view.value.surface) {
    case 'stale': case 'failed': return 'status-failed'
    case 'partial': case 'aged': return 'status-creating'
    case 'running': return 'status-ready'
    case 'blocked': return 'opacity-60'
    case 'fresh': return 'status-published'
    default: return ''
  }
})

/* 主动作只有一个入口，名字跟着状态走。
 * 「被挡」那一档也给停止：停的是占着浏览器的那一轮，不是本任务（本任务还没起跑，没东西可停）。
 * 界面凡看得见「正在跑」就得能按停——只报名字不给停，等于让人干等。 */
const isStop = computed(() => view.value.surface === 'running' || view.value.surface === 'blocked')
/** 停止要递服务端真正在跑的那个 task key：一次只跑一条，递错了服务端会挡下来 */
const stopTask = computed(() => (view.value.surface === 'blocked' ? live.value?.task ?? '' : props.task))

const actionText = computed(() => {
  if (isStop.value) return '停止'
  if (view.value.surface === 'partial') return `重采这 ${view.value.failed.length} 个`
  if (view.value.surface === 'failed') return '重试'
  return props.runLabel ?? `立即${verb.value}`
})
const actionDisabled = computed(() => !!props.disabled)

/** 逐平台勾叉只在部分成功与运行中出现——正常态不报平安。
 *  运行中按本轮计划列全：已跑完的给勾/叉与条数，正在跑的转圈，还没轮到的灰着——
 *  看得见「还剩几个」才等得住。 */
const platList = computed<Plat[]>(() => {
  const v = view.value
  if (v.surface !== 'partial' && v.surface !== 'running') return []
  if (v.surface !== 'running') return Object.entries(v.platforms).map(([key, s]) => ({ key, ...s }))
  const keys = v.plan?.length ? v.plan : Object.keys(v.platforms)
  return keys.map((key) => {
    const done = v.platforms[key]
    if (done) return { key, ...done }
    return { key, state: v.current?.platform === key ? 'running' : 'pending' }
  })
})

/** 正在做的这一段：平台 + 阶段 + 第几步/共几步。不属于某个平台的阶段（收尾转写）只写阶段名。 */
const phaseLine = computed(() => {
  const c = view.value.current
  if (!c) return ''
  const who = c.platform ? platLabel(c.platform) : ''
  const n = Number.isFinite(c.total) ? ` ${c.done ?? 0}/${c.total}` : ''
  return `${who} ${c.phase}${n}`.trim()
})

/** 部分成功也要说清是哪个平台为什么没采到——「去授权」全靠这句话认出来 */
const reasonLine = computed(() => {
  const v = view.value
  if (v.surface === 'failed' || v.surface === 'stale') return v.reason
  if (v.surface === 'partial') {
    const k = v.failed[0]
    return k ? `${platLabel(k)}：${v.platforms[k]?.note || '没采到'}` : ''
  }
  return ''
})
const needAuth = computed(() => /登录|扫码|风控|验证码/.test(reasonLine.value))

/** 明细只在点开时展开：把逐平台读数与异常原文铺在页头，等于把内部日志摆到产品脸上 */
const open = ref(false)

/* ---------- 实时态：与浏览器单飞队列同一个来源，刷新页面不能把它弄丢 ---------- */
let poll: ReturnType<typeof setInterval> | null = null
let tick: ReturnType<typeof setInterval> | null = null

function startTick(from: number) {
  startedAt = from
  stopTick()
  elapsed.value = Math.round((Date.now() - from) / 1000)
  tick = setInterval(() => { elapsed.value = Math.round((Date.now() - startedAt) / 1000) }, 1000)
}
function stopTick() {
  if (tick) clearInterval(tick)
  tick = null
}

/** 本轮结果当态：0 新鲜、有采到有砸 = 部分成功、3 人工停止、其余失败。
 *  脚本自己只在被挡时退 2，砸一个平台照样退 1，所以部分成功要按逐平台结果判。 */
function captureResult(j: Job) {
  const steps = j.steps ?? []
  const platforms = Object.fromEntries(steps.map((s) => [s.platform, s]))
  const failed = steps.filter((s) => s.state === 'error').map((s) => s.platform)
  const at = new Date(j.finishedAt ?? Date.now()).toISOString()
  const firstFail = steps.find((s) => s.state === 'error')
  const partial = j.exitCode !== 0 && !j.stopped && failed.length > 0 && steps.some((s) => s.state === 'ok')
  justDone.value = j.exitCode === 0
    ? { surface: 'fresh', at, gapDays: 0, platforms, failed: [], reason: '' }
    : partial
      ? { surface: 'partial', at, gapDays: 0, platforms, failed, reason: '' }
      : {
          surface: 'failed', at, gapDays: 0, platforms, failed,
          reason: j.stopped ? '人工停止，这轮没跑完'
            : (firstFail ? `${platLabel(firstFail.platform)}：${firstFail.note || ''}` : j.error) || '这一条没跑成',
        }
}

async function refresh() {
  try {
    const r = await (await fetch('/__run-script')).json()
    const j = (r.job ?? null) as Job | null
    if (!j) return
    if (j.running) {
      justDone.value = null
      job.value = j
      if (!tick) startTick(j.startedAt)
      return
    }
    if (job.value?.running && j.task === props.task) captureResult(j)
    job.value = j.finishedAt && j.task === props.task ? null : j
    stopTick()
  } catch { /* 非 dev 环境没有端点，退化为只显留痕 */ }
}

async function clickAction() {
  if (actionDisabled.value) return
  if (isRemote.value) return // 远程那份没有桥：动作那颗已经换成下载 chip，这里只兜住别处的误点
  if (isStop.value) {
    const r = await stopRunningJob('sync', stopTask.value)
    if (!r.ok) toast(r.error || '停止请求没送到本地服务', 'fail')
    return
  }
  const only = view.value.surface === 'partial' ? view.value.failed : []
  try {
    const r = await (await fetch('/__run-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: props.task, ...(only.length ? { arg: only.join(',') } : {}) }),
    })).json()
    if (!r.ok) {
      justDone.value = { surface: 'failed', at: props.at ?? null, gapDays: null, platforms: {}, failed: [], reason: r.error || '启动失败' }
      setTimeout(() => (justDone.value = null), 6000)
      return
    }
    justDone.value = null
    job.value = { running: true, task: props.task, startedAt: r.startedAt || Date.now(), steps: [] }
    startTick(r.startedAt || Date.now())
  } catch {
    justDone.value = { surface: 'failed', at: props.at ?? null, gapDays: null, platforms: {}, failed: [], reason: 'dev 端点不可达' }
    setTimeout(() => (justDone.value = null), 6000)
  }
}

function goAuth() {
  window.location.hash = '#/accounts'
}

onMounted(async () => {
  await capabilitiesReady
  // 远程那份跑不了采集，读数照旧从 generated.json 里显，只是不再去问实时运行态（否则每 3 秒吃一个 409）
  if (isRemote.value) return
  refresh()
  poll = setInterval(refresh, 3000)
})
onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
  stopTick()
})
</script>

<template>
  <!-- quiet：一颗图标键，功能靠图标认。跑没跑、砸没砸、几点落的都收在悬浮名里，版面不出字；
       reading 是它进弹层时的例外——键旁边要跟一句读数，光一颗键没人知道它认的是哪一轮 -->
  <div v-if="quiet" class="flex shrink-0 items-center gap-2">
    <ClientOnly v-if="isRemote" :what="verb" />
    <button
      v-else
      class="btn-ghost relative !px-2"
      :class="actionDisabled && '!cursor-not-allowed opacity-60'"
      :disabled="actionDisabled"
      :title="quietTitle"
      :aria-label="quietTitle"
      @click="clickAction"
    >
      <IconSquare v-if="isStop" :size="15" class="shrink-0" />
      <IconRefreshCw v-else :size="15" class="shrink-0" />
      <span v-if="isBad" class="status-failed absolute right-1 top-1 size-1.5 rounded-full" />
    </button>
    <span v-if="reading && !isRemote" class="min-w-0 truncate text-aux tabular-nums text-ink-3" :title="reasonLine || undefined">{{ chipText }}</span>
  </div>

  <!-- 页面上只留一颗读数 chip，点开才看逐平台明细。
       以前是把「平台 · 条数」一排和异常原文直接铺在页头，读起来像服务器日志。 -->
  <div v-else class="relative shrink-0">
    <button
      class="chip !cursor-pointer"
      :class="[chipClass, actionDisabled && 'opacity-60']"
      :title="quietTitle"
      @click="open = !open"
    >
      <IconSquare v-if="isStop" :size="13" class="shrink-0" />
      <IconRefreshCw v-else :size="13" class="shrink-0" />
      {{ chipText }}
      <IconChevronDown :size="13" class="shrink-0 opacity-70" />
    </button>

    <template v-if="open">
      <div class="fixed inset-0 z-20" @click="open = false" />
      <div class="absolute right-0 top-full z-30 mt-1.5 w-[19rem] rounded-lg border border-line bg-surface p-3 shadow-neo">
        <p v-if="phaseLine" class="mb-2 text-sm text-ink-2">{{ phaseLine }}</p>

        <ul v-if="platList.length" class="flex flex-col gap-1.5">
          <li
            v-for="x in platList" :key="x.key"
            class="flex items-center gap-1.5 text-sm"
            :class="x.state === 'error' ? 'text-red-700' : x.state === 'skip' || x.state === 'pending' ? 'text-ink-3' : 'text-ink-2'"
          >
            <IconX v-if="x.state === 'error'" :size="13" class="shrink-0" />
            <IconCheck v-else-if="x.state === 'ok'" :size="13" class="shrink-0" />
            <IconRefreshCw v-else-if="x.state === 'running'" :size="13" class="shrink-0 animate-spin" />
            <span v-else class="inline-block size-[3px] shrink-0 rounded-full bg-current" />
            <span class="shrink-0">{{ platLabel(x.key) }}</span>
            <span v-if="typeof x.count === 'number'" class="shrink-0 tabular-nums">{{ x.count }}</span>
            <span v-if="x.note" class="ml-auto min-w-0 truncate text-ink-3" :title="x.note">{{ x.note }}</span>
          </li>
        </ul>

        <p v-if="reasonLine" class="mt-2 line-clamp-2 text-sm leading-5 text-red-700" :title="reasonLine">{{ reasonLine }}</p>

        <div class="mt-3 flex items-center gap-2">
          <button v-if="needAuth && !isRemote" class="btn-ghost !px-2 !py-1" @click="goAuth">去授权</button>
          <ClientOnly v-if="isRemote" :what="verb" class="ml-auto" />
          <button v-else class="btn ml-auto !px-2.5 !py-1" :disabled="actionDisabled" @click="clickAction">
            <IconSquare v-if="isStop" :size="13" class="shrink-0" />
            <IconRefreshCw v-else :size="13" class="shrink-0" />
            {{ actionText }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
