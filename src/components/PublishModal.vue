<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PlatformLogo from './PlatformLogo.vue'
import { ArrowUp as IconArrowUp, CircleCheck as IconCircleCheck, Clock as IconClock, ExternalLink as IconExternalLink, LoaderCircle as IconLoaderCircle, TriangleAlert as IconTriangleAlert, X as IconX } from 'lucide-vue-next'

/**
 * 就地发布弹层：把「到浏览器里找那条草稿再点发布」收进工作台。
 *
 * 走的是授权弹层那两条已跑通的通道（预览图 + 信号文件），一次脚本跑到底：
 * 开抽屉认那一格 → 进编辑器回读截图 → 停下等这里按下 → 收到 publish 才点平台的「发布」→ 回读取证。
 * 所以「就是这一条，发布」这颗钮不是二次确认，它是脚本动手的唯一许可；关掉弹层＝发 cancel＝脚本收手。
 *
 * how=schedule 时先在弹层里挑时间，脚本进编辑器后把平台的定时开关翻开、填上这个时间、核对读回的值，
 * 那张截图里看到的就是平台上真正挂上的时间；人按下之后点的才是那颗变成「定时发布」的按钮。
 */
const props = defineProps<{
  account: string
  platform: string
  /** 稿子相对路径（脚本按标题+推送时间在草稿箱里认那一格） */
  rel: string
  /** 平台后台地址：认不出那一版时退回人工入口，按钮不能没有去处 */
  backend: string
  /** 发法：publish=直接点发布；schedule=挂平台定时 */
  how: 'publish' | 'schedule'
}>()
const emit = defineEmits<{ close: []; published: [key: string] }>()

type Phase = 'pick' | 'locating' | 'confirm' | 'pressing' | 'done' | 'fallback'
const phase = ref<Phase>(props.how === 'schedule' ? 'pick' : 'locating')
const note = ref('正在打开草稿箱')

/** 平台口径：北京时间，只收未来 1 小时～14 天（2026-11-04 实测小红书发布页那行说明） */
const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const at = ref(stamp(new Date(Date.now() + 3600_000)))
const atMin = stamp(new Date(Date.now() + 3600_000))
const atMax = stamp(new Date(Date.now() + 14 * 86400_000))
const atText = computed(() => at.value.replace('T', ' '))
const waited = ref(0)
/** 回读到的那张截图：脚本每轮重写文件，所以 src 带时间戳换着拉；一旦拉到就钉住不再换（收工会把文件删掉） */
const shot = ref('')
const shotReady = ref(false)
/** 脚本进度里那句「等你确认」：只有它亮了才把弹层翻到核对态——预览图可能是上一轮跑砸留下的 */
const waiting = ref(false)
const evidence = ref('')
const failText = ref('')

let jobTimer: ReturnType<typeof setInterval> | undefined
let shotTimer: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
let startedAt = 0
let acctKey = ''
let pressed = false
let seenJob = false
let misses = 0

async function post(url: string, body: unknown) {
  return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
}

function refreshShot() {
  if (shotReady.value) return // 已经钉住人核对的那一版，后面再刷会被收工时的删除弄成破图
  // 只在脚本开口说「等你确认」之后才取图：那张图是它进循环前刚写的，早一步拿到的可能是上一轮跑砸留下的
  if (!waiting.value) return
  const url = `/__publish-preview?t=${Date.now()}`
  // 先探一次能不能拿到：核对态的图在弹层翻过去之前根本不在 DOM 里，只挂 img 等 load 会永远等不到
  const probe = new Image()
  probe.onload = () => {
    shot.value = url
    shotReady.value = true
  }
  probe.onerror = () => {
    /* 脚本还没回读到那一版（图还没落盘），下一轮再探 */
  }
  probe.src = url
}

async function signal(action: 'publish' | 'cancel' | 'raise') {
  try {
    const o = await post('/__publish-signal', { action })
    if (!o.ok) failClose(o.error || '浏览器没收到')
  } catch (e) {
    failClose(`浏览器没收到：${(e as Error).message}`)
  }
}

/** 脚本没跑起来 / 信号送不到：别把弹层留成一个没有出路的死屏 */
function failClose(msg: string) {
  stopTimers()
  phase.value = 'fallback'
  failText.value = msg
}

function stopTimers() {
  for (const t of [jobTimer, shotTimer, clock]) if (t) clearInterval(t)
  jobTimer = shotTimer = clock = undefined
}

/** 收尾那一行 JSON 是唯一的凭据：outcome 是 published / scheduled 才算成，其它一律退回人工，绝不报平安 */
function readResult(tail: string) {
  const line = (tail || '').split('\n').filter((l) => l.startsWith('[press-publish] ')).pop()
  if (!line) return null
  try {
    return JSON.parse(line.slice('[press-publish] '.length)) as Record<string, unknown> & { outcome?: string; error?: string; at?: string }
  } catch {
    return null
  }
}

const sched = computed(() => props.how === 'schedule')

function settle(tail: string) {
  const out = readResult(tail)
  stopTimers()
  if (!out) {
    phase.value = 'fallback'
    failText.value = `脚本没回话（本地服务可能重启过），到平台确认这一条${sched.value ? '挂上定时没' : '发出去了没'}`
    return
  }
  if (out.outcome === 'cancelled') {
    emit('close')
    return
  }
  if (out.outcome === 'published' || out.outcome === 'scheduled') {
    evidence.value = out.drafts
      ? `草稿箱 ${(out.drafts as { before: number; after: number }).before} → ${(out.drafts as { before: number; after: number }).after}`
      : '后台那条「上次未发布的图文」已经不在了'
    if (out.at) evidence.value = `${out.at} · ${evidence.value}`
    phase.value = 'done'
    emit('published', acctKey)
    return
  }
  if (out.outcome === 'timeout') {
    phase.value = 'fallback'
    failText.value = '等太久，脚本自己收手了（一个按钮都没点）'
    return
  }
  phase.value = 'fallback'
  failText.value = String(out.error || `没成（${out.outcome}）`)
}

async function pollJob() {
  let job: { task?: string; running?: boolean; tail?: string; startedAt?: number; progress?: { current?: { phase?: string; note?: string } | null } } | null = null
  try {
    job = (await (await fetch('/__run-script')).json()).job
  } catch {
    return /* 服务在重建，下一轮再问 */
  }
  if (!job || job.task !== 'press-publish' || job.startedAt !== startedAt) {
    // 脚本跑一半服务重启了（改 server-core.mjs 就会）：任务记录跟着没了。别把弹层留成一扇没有回音的门
    if (seenJob && ++misses >= 3) failClose('本地服务重启了，脚本没回话——它一个按钮都没点过，请到平台确认草稿还在不在')
    return
  }
  seenJob = true
  misses = 0
  if (job.running) {
    const cur = job.progress?.current
    if (cur) {
      note.value = [cur.phase, cur.note].filter(Boolean).join(' · ')
      if (cur.phase === '等你确认' && !waiting.value) {
        waiting.value = true
        refreshShot()
      }
    }
    if (shotReady.value && waiting.value && !pressed) phase.value = 'confirm'
    return
  }
  settle(job.tail || '')
}

async function start() {
  phase.value = 'locating'
  let params: { ok?: boolean; key?: string; error?: string }
  try {
    params = await post('/__press-params', { rel: props.rel, account: props.account, mode: props.how, at: atText.value })
  } catch (e) {
    return failClose(`服务端没接上：${(e as Error).message}`)
  }
  if (!params.ok || !params.key) return failClose(params.error || `这条没法就地${sched.value ? '挂定时' : '发布'}`)
  acctKey = params.key
  let started: { ok?: boolean; error?: string; startedAt?: number }
  try {
    started = await post('/__run-script', { task: 'press-publish', arg: params.key })
  } catch (e) {
    return failClose(`没跑起来：${(e as Error).message}`)
  }
  if (!started.ok) return failClose(started.error || '没跑起来')
  startedAt = started.startedAt || 0
  clock = setInterval(() => (waited.value += 1), 1000)
  shotTimer = setInterval(refreshShot, 3000)
  jobTimer = setInterval(pollJob, 2000)
  refreshShot()
}

onMounted(() => {
  if (props.how !== 'schedule') void start()
})
onBeforeUnmount(() => {
  stopTimers()
  // 人走了就别把这一版晾在平台上：脚本还在等就发 cancel，它一个按钮都不会点直接收工
  if (jobTimer && !pressed) void post('/__publish-signal', { action: 'cancel' }).catch(() => {})
})

function onPress() {
  pressed = true
  phase.value = 'pressing'
  void signal('publish')
}
</script>

<template>
  <div v-dialog="`${account} · ${sched ? '定时发布' : '发布'}`" class="modal modal--center z-[2110]">
    <div class="absolute inset-0 bg-black/35" @click="phase === 'confirm' ? signal('cancel') : (phase === 'pick' && emit('close'))" />
    <div class="card modal-card relative z-10 flex w-full max-w-[720px] flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <PlatformLogo :platform="platform" :size="18" />
        <span class="min-w-0 flex-1 truncate text-[15px] font-medium">{{ account }} · {{ sched ? '定时发布' : '发布' }}</span>
        <span v-if="phase !== 'pick'" class="shrink-0 text-sm font-medium tabular-nums text-ink-2">{{ waited }} 秒</span>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（脚本会收手，一个按钮都不点）" aria-label="关闭（脚本会收手，一个按钮都不点）"
          @click="phase === 'pick' ? emit('close') : signal('cancel')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body flex flex-col gap-4 p-5">
        <!-- 先挑时间：脚本要拿这个串去平台上那格填，挑完才开浏览器 -->
        <div v-if="phase === 'pick'" class="flex flex-col items-center gap-3 py-8">
          <IconClock :size="28" />
          <div class="text-lg font-medium">定在什么时候发</div>
          <input v-model="at" type="datetime-local" :min="atMin" :max="atMax" step="60"
            class="input !w-auto !px-3 !py-1.5 text-center text-[15px] tabular-nums" />
          <div class="text-sm font-medium tabular-nums text-ink-3">北京时间，可选未来 1 小时～14 天</div>
        </div>

        <!-- 找那一格 / 正在点：只有读数，不摆假进度条 -->
        <div v-else-if="phase === 'locating' || phase === 'pressing'" class="flex flex-col items-center gap-3 py-10">
          <IconLoaderCircle :size="28" class="animate-spin" />
          <div class="text-lg font-medium">{{ phase === 'locating' ? '正在草稿箱里找这条' : `正在点平台的「${sched ? '定时发布' : '发布'}」` }}</div>
          <div class="text-sm font-medium tabular-nums text-ink-2">{{ note }}</div>
        </div>

        <!-- 已发出：把凭据摆出来，不写「发布成功」这种空话 -->
        <div v-else-if="phase === 'done'" class="flex flex-col items-center gap-3 py-10">
          <IconCircleCheck :size="28" class="text-green-700" />
          <div class="text-lg font-medium">{{ sched ? '已挂上定时' : '已发出' }}</div>
          <div class="text-sm font-medium tabular-nums text-ink-2">{{ evidence }}</div>
        </div>

        <!-- 认不出 / 出错了：一个按钮都没点过，退回人工入口 -->
        <div v-else-if="phase === 'fallback'" class="flex flex-col items-center gap-3 py-10">
          <IconTriangleAlert :size="28" class="text-red-700" />
          <div class="text-lg font-medium">{{ sched ? '没挂上定时' : '未自动发布' }}</div>
          <div class="max-w-[520px] text-center text-sm leading-6 font-medium text-ink-2">{{ failText }}</div>
        </div>

        <!-- 回读到的那一版：人要核对的是平台上的东西，不是本地稿 -->
        <template v-else>
          <div class="overflow-hidden rounded-md border border-line bg-surface-2">
            <img :src="shot" alt="平台上回读到的内容" class="block max-h-[46vh] w-full object-contain object-top" />
          </div>
          <div class="text-sm font-medium leading-6">上面这张是{{ platform }}后台里读到的{{ sched ? `定时 ${atText}` : '' }}。确认就是它，再按下{{ sched ? '定时发布' : '发布' }}。</div>
        </template>
      </div>

      <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pb-5">
        <template v-if="phase === 'pick'">
          <button class="btn !px-4 !py-1.5" @click="emit('close')">不发了</button>
          <button class="btn btn-primary !px-4 !py-1.5" @click="start">
            <IconClock :size="15" class="shrink-0" />
            挂上定时
          </button>
        </template>
        <template v-else-if="phase === 'confirm'">
          <button class="btn !px-4 !py-1.5" title="把浏览器窗口调到前面看一眼" @click="signal('raise')">
            调出窗口
          </button>
          <button class="btn !px-4 !py-1.5" @click="signal('cancel')">不发了</button>
          <button class="btn btn-primary !px-4 !py-1.5" @click="onPress">
            <IconArrowUp :size="15" class="shrink-0 -rotate-45" />
            就是这一条，{{ sched ? '挂定时' : '发布' }}
          </button>
        </template>
        <template v-else-if="phase === 'fallback'">
          <a
            v-if="backend"
            :href="backend"
            target="_blank"
            rel="noopener"
            class="btn btn-primary !px-4 !py-1.5"
            :title="`打开${account}后台草稿箱人工${sched ? '挂定时' : '发布'}`"
          >
            打开后台自己点
            <IconExternalLink :size="13" class="shrink-0" />
          </a>
          <button class="btn !px-4 !py-1.5" @click="emit('close')">关闭</button>
        </template>
        <button v-else-if="phase === 'done'" class="btn btn-primary !px-4 !py-1.5" @click="emit('close')">知道了</button>
      </div>
    </div>
  </div>
</template>
