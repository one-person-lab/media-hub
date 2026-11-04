/**
 * 对话入口：一句话交给本机 Agent，进度逐行吐回，问答落 metrics/chats/<id>.json。
 * 模块级单例——跑着的时候切去别的视图再回来，进度还在。
 * 与创作台共用服务端的同一个任务位：本机同时只跑一个 Agent。
 * 收尾整页刷一次（跟图文/视频创作一致），新落的稿子才会出现在选题库；
 * 会话在盘上、地址栏带 #/chat/<id>，刷完回到原话原答案。
 */
import { ref, computed } from 'vue'
import { setHoldAutoRefresh, stopRunningJob } from '../data/store'

export interface ChatMsg { role: 'user' | 'assistant'; text: string; at: string; ok?: boolean; refs?: ChatRef[] }
/** 一句话带上的引用：技能（.agents/skills/…）或仓库里的素材卡，路径给 Agent 读，界面只露名字 */
export interface ChatRef { label: string; file: string }
export interface ChatConv { id: string; title: string; at: string; sessionId?: string; messages: ChatMsg[] }
export interface ChatBrief { id: string; title: string; at: string; turns: number }

const conversation = ref<ChatConv | null>(null)
const briefs = ref<ChatBrief[]>([])
/** Agent 每次工具调用翻译成的一行中文，跑动时逐行累加 */
const log = ref<string[]>([])
const running = ref(false)
/** 按过停止、服务端那条 Agent 还在收尾 */
const stopping = ref(false)
const error = ref('')
const startedAt = ref(0)
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
let poll: ReturnType<typeof setInterval> | null = null

const elapsed = computed(() =>
  startedAt.value ? Math.max(0, Math.round((now.value - startedAt.value) / 1000)) : 0,
)

async function api(url: string, body?: unknown) {
  const r = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json()
}

function stop() {
  if (poll) clearInterval(poll)
  poll = null
  if (tick) clearInterval(tick)
  tick = null
  setHoldAutoRefresh(false)
  running.value = false
}

function startTick() {
  if (tick) return
  tick = setInterval(() => (now.value = Date.now()), 1000)
}

/** 拉服务端：会话 + 任务。任务从「在跑」翻到「结束」的那一轮负责收尾 */
async function sync() {
  const q = conversation.value?.id ? `?id=${encodeURIComponent(conversation.value.id)}` : ''
  const o = await api(`/__chat${q}`).catch(() => null)
  if (!o) return
  if (Array.isArray(o.conversations)) briefs.value = o.conversations
  if (o.conversation) conversation.value = o.conversation
  const j = o.job
  if (j?.running) {
    running.value = true
    log.value = Array.isArray(j.log) ? j.log : []
    startedAt.value = j.startedAt || Date.now()
    error.value = ''
    startTick()
    setHoldAutoRefresh(true)
    if (!poll) poll = setInterval(sync, 2500)
  } else if (running.value) {
    stop()
    stopping.value = false
    if (j && j.ok === false) {
      error.value = j.error || '没跑出来'
    } else {
      location.reload()
    }
  }
}

/** 界面上按停：服务端掐那条 Agent 子进程，收尾的话（「人在界面上按了停止」）由 sync 那一轮报出来。
 *  返回给调用方决定要不要 toast 那句失败原因——停止没送到本机服务不能变成静默失败。 */
async function requestStop(): Promise<{ ok: boolean; error?: string }> {
  const r = await stopRunningJob('gen')
  if (r.ok) stopping.value = true
  return r
}

/** 发一句（可带引用）；返回 ''=已启动，否则为立即可知的错误（忙/缺配置） */
async function send(text: string, refs: ChatRef[] = []): Promise<string> {
  const prompt = text.trim()
  if (!prompt) return '没说话呢'
  if (running.value) return '上一条还在跑，一次只能做一件'
  error.value = ''
  stopping.value = false
  const o = await api('/__chat', { prompt, id: conversation.value?.id, refs })
    .catch(() => ({ ok: false, error: '服务未就绪' }))
  if (!o.ok) return o.error || '启动失败'
  const msg = { role: 'user' as const, text: prompt, at: '', refs }
  if (conversation.value?.id !== o.id) {
    conversation.value = { id: o.id, title: prompt.slice(0, 24), at: '', messages: [msg] }
    location.hash = `#/chat/${encodeURIComponent(o.id)}`
  } else {
    conversation.value!.messages.push(msg)
  }
  log.value = []
  running.value = true
  startedAt.value = now.value = Date.now()
  startTick()
  setHoldAutoRefresh(true)
  if (!poll) poll = setInterval(sync, 2500)
  return ''
}

function open(id: string) {
  if (!id) return reset()
  conversation.value = { id, title: '', at: '', messages: [] }
  location.hash = `#/chat/${encodeURIComponent(id)}`
  sync()
}

function reset() {
  conversation.value = null
  log.value = []
  error.value = ''
  location.hash = '#/chat'
}

// 深链或整页刷新回来：先认地址栏里的会话号，再接上可能还在跑的任务
const deep = location.hash.match(/^#\/chat\/([^/]+)/)
if (deep) conversation.value = { id: decodeURIComponent(deep[1]), title: '', at: '', messages: [] }
sync()

export function useChat() {
  return { conversation, briefs, log, running, stopping, error, elapsed, send, requestStop, open, reset, sync }
}
