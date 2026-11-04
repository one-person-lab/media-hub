/**
 * 内置生成（拆解 / 图文创作 / 拟判据）的前端驱动器。
 * 模块级单例：任务在后台跑，页面切走再回来仍能看到进度；成功后 SSE 会自动刷新数据。
 * 进度不只活在弹层里——外壳右上角的 JobStatusPill 也读这份状态（见 App.vue）。
 */
import { ref, computed } from 'vue'
import { setHoldAutoRefresh } from '../data/store'

export type GenKind = 'teardown' | 'create' | 'gate'

const GEN_TEXT: Record<GenKind, string> = { teardown: '拆解', create: '图文创作', gate: '拟判据' }

const runningKind = ref<GenKind | ''>('')
const progress = ref('')
const genError = ref('')
/** 当前任务所属选题（创作线才有；拆解为 ''），右上角浮层靠它跳回那条选题 */
const jobKey = ref('')
const jobDetail = ref('')
/** 任务开跑时刻，用于浮层计时；整页刷新后由服务端 startedAt 接上 */
const startedAt = ref(0)
/** 服务端给的硬上限（图文创作 25 分）：界面据此报「已跑 X / 上限 Y」，超时中止前不再是黑箱 */
const limitMs = ref(0)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const elapsed = computed(() =>
  startedAt.value ? Math.max(0, Math.round((now.value - startedAt.value) / 1000)) : 0,
)

let polling: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  if (polling) clearInterval(polling)
  polling = null
  if (clock) clearInterval(clock)
  clock = null
  setHoldAutoRefresh(false)
  runningKind.value = ''
  progress.value = ''
  jobKey.value = ''
  jobDetail.value = ''
  startedAt.value = 0
  limitMs.value = 0
}

function startClock() {
  if (clock) return
  clock = setInterval(() => (now.value = Date.now()), 1000)
}

async function api(url: string, body?: unknown) {
  const r = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json()
}

function pollUntilDone() {
  setHoldAutoRefresh(true)
  polling = setInterval(async () => {
    try {
      const o = await api('/__generate')
      if (!o.job?.running) {
        stopPolling()
        // 人按的停不算失败：服务端把那一笔报成「人在界面上按了停止」，界面只说「已停止」
        if (o.job && o.job.ok === false) {
          const name = GEN_TEXT[o.job.kind as GenKind] || '生成'
          genError.value = o.job.stopped ? `${name}已停止` : `${name}失败：${o.job.error || '未知错误'}`
        } else location.reload()
      } else {
        progress.value = o.job.progress || ''
        jobKey.value = o.job.key || ''
        jobDetail.value = o.job.detail || ''
        limitMs.value = o.job.limitMs || 0
        if (o.job.startedAt) startedAt.value = o.job.startedAt
        startClock()
      }
    } catch { /* 服务瞬断下一轮再问 */ }
  }, 4000)
}

/** 启动一个生成任务；返回 ''=已启动，否则为立即可知的错误（缺脚本/忙等）。任务结果经 genError / 自动刷新呈现 */
async function run(kind: GenKind, body: Record<string, unknown>): Promise<string> {
  if (runningKind.value) return `「${GEN_TEXT[runningKind.value]}」还在跑，一次只能做一件生成`
  genError.value = ''
  const o = await api('/__generate', { kind, ...body }).catch(() => ({ ok: false, error: '服务未就绪' }))
  if (!o.ok) return o.error || '启动失败'
  runningKind.value = kind
  jobKey.value = typeof body.key === 'string' ? body.key : ''
  jobDetail.value = typeof body.detail === 'string' ? body.detail : ''
  startedAt.value = Date.now()
  now.value = startedAt.value
  startClock()
  pollUntilDone()
  return ''
}

// 页面加载/刷新时如果服务端还有任务在跑（比如刚整页刷新过），接上它的进度
// 对话任务不算在这里：它由 useChat 自己轮，进度长在对话流里，不该抢右上角浮层
api('/__generate').then((o) => {
  if (o.job?.running && o.job.kind !== 'chat') {
    runningKind.value = o.job.kind
    progress.value = o.job.progress || ''
    jobKey.value = o.job.key || ''
    jobDetail.value = o.job.detail || ''
    startedAt.value = o.job.startedAt || Date.now()
    limitMs.value = o.job.limitMs || 0
    pollUntilDone()
  }
}).catch(() => {})

export function useGenerate() {
  return {
    runningKind,
    genError,
    busy: computed(() => !!runningKind.value),
    runningText: computed(() => (runningKind.value ? GEN_TEXT[runningKind.value] : '')),
    progress,
    elapsed,
    limitMs,
    jobKey,
    jobDetail,
    run,
    teardown: (file: string) => run('teardown', { file }),
    gate: (file: string) => run('gate', { file }),
    agentTask: (kind: 'create', prompt: string, detail: string, key = '') =>
      run(kind, { prompt, detail, key }),
    dismissError: () => (genError.value = ''),
  }
}
