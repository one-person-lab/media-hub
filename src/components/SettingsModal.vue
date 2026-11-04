<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { target, holdSelfWrite, isRemote, stopRunningJob, SYNC_TASK_LABEL } from '../data/store'
import { useTheme } from '../lib/useTheme'
import { Bot as IconBot, ChevronDown as IconChevronDown, CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, LoaderCircle as IconLoaderCircle, RefreshCw as IconRefreshCw, Sparkles as IconSparkles, Square as IconSquare, X as IconX } from 'lucide-vue-next'

const props = defineProps<{ panel?: 'config' | 'machine' }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const { current: themeId, themes, set: setTheme } = useTheme()

/* ==================== AI 引擎配置：GET/POST /__llm（Key 只存本机文件，不进仓库） ==================== */
const llm = ref({ baseUrl: '', model: '', agentBaseUrl: '', agentModel: '', agentCommand: '', agentArgs: [] as string[] })
const keyConfigured = ref(false)
const llmSaving = ref(false)
const saveMsg = ref('')
const saveOk = ref(true)
const llmTesting = ref<'' | 'chat' | 'agent'>('')
/** 两条通道各留各的结果：以前共用一句，测完 Agent 把拆解模型那次的回复顶掉了 */
type TestResult = { ok: boolean; msg: string } | null
const results = ref<{ chat: TestResult; agent: TestResult }>({ chat: null, agent: null })

const fillLlm = (o: any) => ({
  baseUrl: o.baseUrl, model: o.model,
  agentBaseUrl: o.agent.baseUrl, agentModel: o.agent.model,
  agentCommand: o.agent.command, agentArgs: o.agent.args,
})

onMounted(() => {
  fetch('/__llm').then((r) => r.json()).then((o) => {
    if (!o.ok) return
    llm.value = fillLlm(o)
    keyConfigured.value = o.keyConfigured
  }).catch(() => {})
})

async function saveLlm() {
  llmSaving.value = true
  saveMsg.value = ''
  try {
    const body: Record<string, unknown> = { ...llm.value }
    const k = apiKeyInput.value.trim()
    if (k) body.apiKey = k
    const o = await (await fetch('/__llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
    if (!o.ok) throw new Error(o.error || '保存失败')
    keyConfigured.value = o.keyConfigured
    llm.value = fillLlm(o)
    apiKeyInput.value = ''
    saveMsg.value = '已保存'
    saveOk.value = true
  } catch (e) {
    saveMsg.value = `保存失败：${(e as Error).message}`
    saveOk.value = false
  } finally {
    llmSaving.value = false
  }
}

const apiKeyInput = ref('')

async function testLlm(which: 'chat' | 'agent') {
  llmTesting.value = which
  results.value[which] = null
  try {
    const o = await (await fetch('/__llm-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: which }),
    })).json()
    results.value[which] = { ok: !!o.ok, msg: o.ok ? `通了 · 回了「${o.reply}」` : `不通：${o.error}` }
  } catch (e) {
    results.value[which] = { ok: false, msg: `不通：${(e as Error).message}` }
  } finally {
    llmTesting.value = ''
  }
}

/* ==================== 环境：这台机器缺什么，一次列全。判据全在服务端，界面只报读数 ==================== */
type EnvItem = { id: string; label: string; use: string; state: 'ready' | 'missing'; note?: string; fix?: 'accounts' | 'config' }
type EnvGroup = { id: string; title: string; on?: string; off?: string; task?: string; items: EnvItem[] }

const groups = ref<EnvGroup[]>([])
const installing = ref(false)
/** 按过停、脚本还在收这一段：取料按候选逐个认停，不会掐在半个文件上 */
const envStopping = ref(false)
const envElapsed = ref(0)
const envStep = ref('')
const envBusy = ref('')
const envMsg = ref('')
let envPoll: ReturnType<typeof setInterval> | null = null

const taskName = (j: { task?: string; label?: string }) => SYNC_TASK_LABEL[j.task ?? ''] ?? j.label ?? j.task ?? ''
const envTotal = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
const envReady = computed(() => groups.value.reduce((n, g) => n + g.items.filter((i) => i.state === 'ready').length, 0))
const envClock = computed(() => `${Math.floor(envElapsed.value / 60)}:${String(envElapsed.value % 60).padStart(2, '0')}`)

/** 拍平成一张网格：分组各自起网格会让两项的组留个大空洞，15 项排下来全是参差不齐的右边 */
const cards = computed(() =>
  groups.value.flatMap((g) => g.items.map((i) => ({
    ...i, on: g.on || '已装', off: g.off || '未装', task: g.task,
  }))),
)
const onlyPendingEnv = ref(true)
const shownEnv = computed(() => {
  const miss = cards.value.filter((c) => c.state !== 'ready')
  return onlyPendingEnv.value && miss.length ? miss : cards.value
})

/** 取料日志的最后一行，去掉「… darwin-arm64/」这种前缀 —— 界面上不露路径 */
function lastStep(tail: unknown): string {
  const line = String(tail ?? '').split(/\r?\n/).filter(Boolean).pop() ?? ''
  return line.replace(/^[…✓]\s*/, '').replace(/^darwin-\w+\//, '')
}

async function loadEnv() {
  try {
    const o = await (await fetch('/__env')).json()
    if (o.ok) groups.value = o.groups
  } catch {
    /* 静态站形态没有本地端点，退化为纯展示 */
  }
}

function stopEnvPoll() {
  if (envPoll) clearInterval(envPoll)
  envPoll = null
}

/** 装料和采集共用同一条任务队列，所以这里既要看自己的进度，也要认出"别人在跑" */
async function pollEnv() {
  const o = await (await fetch('/__run-script')).json().catch(() => null)
  const j = o?.job
  if (!j) return
  if (j.running) {
    if (j.task === 'fetch-bin') {
      installing.value = true
      envStopping.value = !!j.stopping
      envElapsed.value = Math.round((Date.now() - j.startedAt) / 1000)
      envStep.value = lastStep(j.tail)
    } else {
      envBusy.value = `已有任务在跑：${taskName(j)}`
    }
    return
  }
  envBusy.value = ''
  if (j.task === 'fetch-bin' && installing.value) {
    installing.value = false
    envStopping.value = false
    envStep.value = ''
    stopEnvPoll()
    if (j.exitCode === 0) loadEnv()
    else envMsg.value = `装不上：${lastStep(j.tail) || `退出码 ${j.exitCode}`}`
  }
}

async function installTask(task?: string) {
  if (!task) return
  envMsg.value = ''
  envBusy.value = ''
  envStep.value = ''
  const o = await (await fetch('/__run-script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  })).json().catch(() => null)
  if (!o?.ok) {
    envMsg.value = o?.error || '起不了任务'
    return
  }
  installing.value = true
  envStopping.value = false
  envElapsed.value = 0
  stopEnvPoll()
  envPoll = setInterval(pollEnv, 2000)
}

async function stopInstall() {
  if (envStopping.value) return
  const r = await stopRunningJob('sync', 'fetch-bin')
  if (r.ok) envStopping.value = true
  else envMsg.value = r.error || '停止请求没送到本地服务'
}

/** 未登录这类"非人不可"的一步，界面上要给一条走得通的路，而不是留一句话 */
function fixAs(fix?: string) {
  if (fix === 'config') goto('engine')
  if (fix === 'accounts') {
    location.hash = '/accounts'
    emit('close')
  }
}

const FIX_LABEL: Record<string, string> = { accounts: '去授权', config: '去填写' }

/* ==================== 自检：判据只看盘上产物，界面只列读数 ==================== */
type CheckItem = { id: string; title: string; state: 'ready' | 'missing' | 'stale' | 'manual'; detail: string; next: string }
const CHECK_TEXT: Record<CheckItem['state'], string> = { ready: '过了', missing: '没过', stale: '半过', manual: '只能人工' }
const CHECK_CLS: Record<CheckItem['state'], string> = {
  ready: 'status-published', missing: 'status-failed', stale: 'status-creating', manual: 'status-not-start',
}

const check = ref<{ ok: boolean; at: string; items: CheckItem[]; never?: boolean } | null>(null)
const checking = ref(false)
const checkMsg = ref('')
/** 全过的十几行平铺着没人看，默认只列要处理的；跑通了这一段就只剩一句结论 */
const checkBad = computed(() => (check.value?.items || []).filter((i) => i.state === 'missing' || i.state === 'stale').length)
const onlyPendingCheck = ref(true)
const shownChecks = computed(() => {
  const items = check.value?.items || []
  return onlyPendingCheck.value ? items.filter((i) => i.state !== 'ready') : items
})
const checkAt = computed(() => {
  const iso = check.value?.at
  if (!iso) return ''
  return new Date(iso).toLocaleString('sv-SE', { hour12: false }).slice(5, 16)
})

async function loadCheck() {
  check.value = await (await fetch('/__selfcheck')).json().catch(() => null)
}

/** 数据层重建 + 十几项产物读数，实测不到一秒，所以不给进度条只给一句结果 */
async function runCheck() {
  // 自检头一项就是重建数据层，服务端跟着会广播一次；不开这个窗，弹层会被整页刷掉
  holdSelfWrite()
  checking.value = true
  checkMsg.value = ''
  try {
    const o = await (await fetch('/__selfcheck', { method: 'POST' })).json()
    if (o.error) throw new Error(o.error)
    check.value = o
    // 跑成什么样左栏那格和每行的状态牌已经说了，这里只在真跑砸了才留一句话
    checkMsg.value = ''
  } catch (e) {
    checkMsg.value = `自检没跑成：${(e as Error).message}`
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  // 「本机」那两段读的是这台机器的桥与盘上产物，网页版一律 409：读数不去取，段也不摆出来
  if (isRemote.value) return
  loadEnv()
  loadCheck()
  fetch('/__run-script').then((r) => r.json()).then((o) => {
    const j = o?.job
    if (!j?.running) return
    if (j.task === 'fetch-bin') {
      installing.value = true
      envStopping.value = !!j.stopping
      envPoll = setInterval(pollEnv, 2000)
    } else {
      envBusy.value = `已有任务在跑：${taskName(j)}`
    }
  }).catch(() => {})
  if (props.panel === 'machine') nextTick(() => goto('env'))
})
onBeforeUnmount(stopEnvPoll)

/* ==================== 一屏到底 + 左栏目录 ====================
   「配置 / 本机」两个页签，各自内部还要再滚，五段东西被切成两屏（2026-11-01）。
   合成一屏之后，左栏这五行就是这一屏的目录，读数直接挂在行尾。 */
type SecId = 'target' | 'engine' | 'theme' | 'env' | 'check'
const active = ref<SecId>(props.panel === 'machine' ? 'env' : 'target')
const pane = ref<HTMLElement | null>(null)

const rail = computed(() => {
  const rows: { kind: string; text?: string; id?: string; label?: string; reading?: string; dot?: string }[] = [
    { kind: 'label', text: '配置' },
    { kind: 'item', id: 'target', label: '推广对象', reading: '', dot: '' },
    { kind: 'item', id: 'engine', label: 'AI 引擎', reading: '', dot: keyConfigured.value ? 'bg-success' : 'bg-red-600' },
    { kind: 'item', id: 'theme', label: '配色', reading: '', dot: '' },
    { kind: 'label', text: '本机' },
    { kind: 'item', id: 'env', label: '工具', reading: envTotal.value ? `${envReady.value}/${envTotal.value}` : '', dot: '' },
    {
      kind: 'item', id: 'check', label: '自检', dot: '',
      reading: check.value?.never ? '' : checkBad.value ? `${checkBad.value}` : check.value?.ok ? '通过' : '没过',
    },
  ]
  return isRemote.value ? rows.filter((r) => r.id !== 'env' && r.id !== 'check' && r.text !== '本机') : rows
})

/** 段顶压过视口上沿那条线，左栏就换亮哪一段（跟插件页同一套算法，不用 IO） */
const onPaneScroll = () => {
  const p = pane.value
  if (!p) return
  const base = p.getBoundingClientRect().top
  let cur = active.value
  for (const el of Array.from(p.querySelectorAll<HTMLElement>('[data-sec]'))) {
    if (el.getBoundingClientRect().top - base <= 24) cur = el.dataset.sec as SecId
  }
  active.value = cur
}
function goto(id: SecId) {
  const p = pane.value
  const el = p?.querySelector<HTMLElement>(`[data-sec="${id}"]`)
  if (!p || !el) return
  active.value = id
  p.scrollTo({ top: p.scrollTop + el.getBoundingClientRect().top - p.getBoundingClientRect().top - 16 })
}

/** 推广对象那几段文案（定位 / 视角）默认收着：设置面板是拿来改东西的，
 *  不是拿来读产品说明书的；想知道现在挂的是哪个产品，看标题那一行就够。 */
const detailOpen = ref(false)

const TYPE_LABEL: Record<string, string> = {
  app: 'APP',
  website: '网站',
  shop: '店铺',
  course: '课程',
  service: '服务',
}

const positioningBrief = computed(() => {
  // 先剥离蒸馏来源等 HTML 注释块，否则注释行会被当成定位首段显示（同 collect-note-core loadAiContext 做法）
  const md = (target?.positioning || '').replace(/<!--[\s\S]*?-->/g, '')
  const para = md.split(/\n\s*\n/).find((s) => {
    const t = s.trim()
    return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('-')
  })
  return (para || '').replace(/\s+/g, ' ').trim()
})
</script>

<template>
  <div v-dialog="'设置'" class="modal" @click.self="emit('close')">
    <div class="card modal-card max-w-5xl">
      <!-- 页眉只放标题和关闭：动作一律长在各自那一段的段头里，不在这里攒一排 -->
      <div class="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
        <h2 class="text-[17px] font-semibold text-ink">设置</h2>
        <button class="btn px-2 py-1" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- 左栏：五段一处一项，读数走行尾，主区滚到哪一段就亮哪一段 -->
        <nav class="hidden w-[172px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-3 lg:flex">
          <template v-for="(row, i) in rail" :key="i">
            <div v-if="row.kind === 'label'" class="px-2.5 pb-1 pt-4 text-xs tracking-[0.12em] text-ink-3/80">
              {{ row.text }}
            </div>
            <button
              v-else
              class="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-sm transition-colors"
              :class="active === row.id ? 'is-selected' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'"
              @click="goto(row.id as SecId)"
            >
              <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
              <span v-if="row.reading" class="shrink-0 font-metric text-aux tabular-nums text-ink-3">{{ row.reading }}</span>
              <span v-else-if="row.dot" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="row.dot" />
            </button>
          </template>
        </nav>

        <div ref="pane" class="modal-body min-w-0 flex-1" @scroll="onPaneScroll">
          <div class="flex flex-col gap-8 px-6 py-5">
            <!-- ==================== ① 推广对象 ==================== -->
            <section data-sec="target" class="flex flex-col gap-2.5">
              <h3 class="text-section text-ink">推广对象</h3>
              <div v-if="!target" class="bento-inset px-4 py-3 text-sm text-ink-2">没有读到推广对象配置。</div>
              <div v-else class="overflow-hidden rounded-bento border border-line bg-surface shadow-neo">
                <button class="flex w-full items-center gap-3 px-4 py-3.5 text-left" @click="detailOpen = !detailOpen">
                  <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-[15px] font-semibold text-ink-2">
                    {{ target.brandName.slice(0, 1) }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2">
                      <span class="truncate text-[15px] font-semibold text-ink">{{ target.brandName }}</span>
                      <span class="chip shrink-0 !py-0 !text-aux">{{ TYPE_LABEL[target.type] || target.type }}</span>
                    </span>
                    <span class="mt-0.5 block truncate text-aux text-ink-3">{{ target.signature }} · {{ target.brandTag }}</span>
                  </span>
                  <IconChevronDown :size="15" class="shrink-0 text-ink-3 transition-transform" :class="detailOpen && '-rotate-180'" />
                </button>
                <dl v-if="detailOpen" class="grid gap-x-6 gap-y-3 border-t border-line px-4 py-4 sm:grid-cols-[88px_minmax(0,1fr)]">
                  <dt class="text-aux text-ink-3">定位</dt>
                  <dd class="min-w-0 text-sm leading-[22px] text-ink-2">{{ positioningBrief }}</dd>
                  <dt class="text-aux text-ink-3">产品视角</dt>
                  <dd class="min-w-0">
                    <ul class="list-inside list-disc space-y-0.5 text-sm leading-[22px] text-ink-2">
                      <li v-for="p in target.productPerspective" :key="p">{{ p }}</li>
                    </ul>
                  </dd>
                </dl>
              </div>
            </section>

            <!-- ==================== ② AI 引擎 ====================
                 两条通道各一行，端点占满剩余宽度（并排两栏会把 URL 截成半条）；
                 测连通的结果回到自己那一行；Key 两条共用一把，所以单列一行不塞进任何一行里。 -->
            <section data-sec="engine" class="flex flex-col gap-2.5">
              <div class="flex items-center gap-2">
                <h3 class="text-section text-ink">AI 引擎</h3>
                <span class="chip ml-auto shrink-0" :class="keyConfigured ? 'status-published' : 'status-failed'">
                  {{ keyConfigured ? 'Key 已配置' : 'Key 未配置' }}
                </span>
              </div>

              <div class="flex flex-col gap-2.5">
                <!-- 拆解模型 -->
                <div class="rounded-inset border border-line bg-surface-2/50 p-3.5">
                  <div class="flex items-center gap-2">
                    <IconSparkles :size="15" class="shrink-0 text-ink-2" />
                    <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">拆解模型</span>
                    <span v-if="results.chat" class="flex min-w-0 items-center gap-1.5 text-aux font-medium" :class="results.chat.ok ? 'text-success' : 'text-red-600'">
                      <component :is="results.chat.ok ? IconCircleCheck : IconCircleAlert" :size="13" class="shrink-0" />
                      <span class="min-w-0 truncate">{{ results.chat.msg }}</span>
                    </span>
                    <button class="btn shrink-0 !px-2.5 !py-1 !text-aux" :disabled="!!llmTesting || !keyConfigured" @click="testLlm('chat')">
                      <IconLoaderCircle v-if="llmTesting === 'chat'" :size="13" class="animate-spin" />
                      {{ llmTesting === 'chat' ? '在测' : '测连通' }}
                    </button>
                  </div>
                  <div class="mt-2.5 flex flex-wrap gap-2.5">
                    <label class="block min-w-[280px] flex-1 text-aux text-ink-3">
                      端点
                      <input v-model="llm.baseUrl" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux" placeholder="https://…/compatible-mode/v1" />
                    </label>
                    <label class="block w-[180px] shrink-0 text-aux text-ink-3">
                      模型名
                      <input v-model="llm.model" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux" placeholder="qwen3.8-flash" />
                    </label>
                  </div>
                </div>

                <!-- 创作 Agent -->
                <div class="rounded-inset border border-line bg-surface-2/50 p-3.5">
                  <div class="flex items-center gap-2">
                    <IconBot :size="15" class="shrink-0 text-ink-2" />
                    <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">创作 Agent</span>
                    <span v-if="results.agent" class="flex min-w-0 items-center gap-1.5 text-aux font-medium" :class="results.agent.ok ? 'text-success' : 'text-red-600'">
                      <component :is="results.agent.ok ? IconCircleCheck : IconCircleAlert" :size="13" class="shrink-0" />
                      <span class="min-w-0 truncate">{{ results.agent.msg }}</span>
                    </span>
                    <button class="btn shrink-0 !px-2.5 !py-1 !text-aux" :disabled="!!llmTesting || !keyConfigured" @click="testLlm('agent')">
                      <IconLoaderCircle v-if="llmTesting === 'agent'" :size="13" class="animate-spin" />
                      {{ llmTesting === 'agent' ? '在测' : '测连通' }}
                    </button>
                  </div>
                  <div class="mt-2.5 flex flex-wrap gap-2.5">
                    <label class="block min-w-[280px] flex-1 text-aux text-ink-3">
                      端点
                      <input v-model="llm.agentBaseUrl" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux" placeholder="https://…/apps/anthropic" />
                    </label>
                    <label class="block w-[160px] shrink-0 text-aux text-ink-3">
                      模型名
                      <input v-model="llm.agentModel" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux" placeholder="qwen3.8-flash" />
                    </label>
                    <label class="block w-[120px] shrink-0 text-aux text-ink-3">
                      命令
                      <input v-model="llm.agentCommand" class="input mt-1 w-full !px-2.5 !py-1.5 font-metric !text-aux" placeholder="claude" />
                    </label>
                  </div>
                </div>

                <!-- Key：两条通道共用一把 -->
                <div class="flex items-center gap-3 rounded-inset border border-line bg-surface-2/50 px-3.5 py-2.5">
                  <span class="shrink-0 text-aux text-ink-3">API Key</span>
                  <input
                    v-model="apiKeyInput" type="password" autocomplete="off"
                    class="input min-w-0 flex-1 !px-2.5 !py-1.5 font-metric !text-aux"
                    :placeholder="keyConfigured ? '••••••••　留空则不改动' : '粘贴 Key'"
                  />
                </div>

                <div class="flex items-center gap-2">
                  <button class="btn btn-primary shrink-0 !px-3 !py-1" :disabled="llmSaving" @click="saveLlm">
                    <IconLoaderCircle v-if="llmSaving" :size="13" class="animate-spin" />
                    {{ llmSaving ? '保存中…' : '保存' }}
                  </button>
                  <span v-if="saveMsg" class="flex min-w-0 items-center gap-1.5 text-aux font-medium" :class="saveOk ? 'text-success' : 'text-red-600'">
                    <component :is="saveOk ? IconCircleCheck : IconCircleAlert" :size="13" class="shrink-0" />
                    <span class="min-w-0 truncate">{{ saveMsg }}</span>
                  </span>
                </div>
              </div>
            </section>

            <!-- ==================== ③ 配色 ====================
                 每张卡用那一套皮肤自己的令牌画一个迷你窗口，选之前先看一眼长什么样。
                 这里一律走 --app-* 原令牌，不能用 bg-surface 那套工具类：
                 工具类吃的是 :root 上的 --color-surface，值在根上就替换完了，嵌一层 data-theme 换不掉。 -->
            <section data-sec="theme" class="flex flex-col gap-2.5">
              <h3 class="text-section text-ink">配色</h3>
              <div class="grid gap-3 sm:grid-cols-3">
                <button
                  v-for="t in themes" :key="t.id"
                  class="overflow-hidden rounded-bento border p-2 text-left transition-shadow"
                  :class="themeId === t.id ? 'border-accent shadow-neo ring-2 ring-accent/25' : 'border-line hover:shadow-neo'"
                  @click="setTheme(t.id)"
                >
                  <div :data-theme="t.id" class="tp flex flex-col gap-1.5 overflow-hidden rounded-inset border p-2.5">
                    <div class="flex shrink-0 items-center gap-1.5">
                      <span class="tp-dot h-2.5 w-2.5 shrink-0 rounded-full" />
                      <span class="tp-sunk h-2 w-10 shrink-0 rounded-full" />
                      <span class="tp-rule ml-auto h-2 w-2 shrink-0 rounded-full" />
                    </div>
                    <div class="flex min-h-0 flex-1 gap-1.5">
                      <span class="tp-face w-5 shrink-0 rounded-[5px]" />
                      <span class="tp-face tp-bordered flex min-w-0 flex-1 flex-col gap-1 rounded-[5px] p-1.5">
                        <span class="tp-ink h-1.5 w-1/2 rounded-full" />
                        <span class="tp-rule h-1.5 w-3/4 rounded-full" />
                        <span class="tp-rule h-1.5 w-2/3 rounded-full" />
                      </span>
                    </div>
                  </div>
                  <div class="mt-2 flex items-baseline gap-1.5 px-1 pb-0.5">
                    <span class="text-sm font-medium text-ink">{{ t.label }}</span>
                    <span class="min-w-0 flex-1 truncate text-aux text-ink-3">{{ t.hint }}</span>
                    <IconCircleCheck v-if="themeId === t.id" :size="15" class="shrink-0 text-accent" />
                  </div>
                </button>
              </div>
            </section>

            <!-- ==================== ④ 工具 ==================== -->
            <section v-if="!isRemote" data-sec="env" class="flex flex-col gap-2.5">
              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                <h3 class="text-section text-ink">工具</h3>
                <span class="chip shrink-0" :class="envTotal && envReady === envTotal ? 'status-published' : 'status-failed'">
                  {{ envTotal ? `${envReady}/${envTotal} 就绪` : '未读到' }}
                </span>
                <span class="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-2">
                  <span class="block h-full bg-accent transition-all" :style="{ width: `${envTotal ? (envReady / envTotal) * 100 : 0}%` }" />
                </span>
                <div class="ml-auto flex shrink-0 items-center gap-1.5">
                  <button
                    v-if="envTotal - envReady"
                    class="seg !px-2.5 !py-1 !text-aux" :class="onlyPendingEnv ? 'is-selected' : ''"
                    @click="onlyPendingEnv = !onlyPendingEnv"
                  >
                    {{ onlyPendingEnv ? `全部 ${envTotal}` : `只看待处理 ${envTotal - envReady}` }}
                  </button>
                  <button
                    v-if="installing"
                    class="btn shrink-0 !px-2 !py-1 !text-aux"
                    :disabled="envStopping"
                    title="停止"
                    aria-label="停止"
                    @click="stopInstall"
                  >
                    <IconSquare :size="13" />
                  </button>
                  <button class="btn shrink-0 !px-2.5 !py-1 !text-aux" :disabled="installing" @click="loadEnv">
                    <IconRefreshCw :size="13" />
                    重新检测
                  </button>
                </div>
              </div>
              <div v-if="installing" class="truncate text-aux text-ink-2">
                {{ envStopping ? '已按停，等这一段跑完就收' : `装料中${envStep ? ` · ${envStep}` : ''}` }}
              </div>
              <div v-if="envBusy" class="truncate text-aux text-ink-2">{{ envBusy }}</div>
              <div v-if="envMsg" class="truncate text-aux font-medium text-red-600">{{ envMsg }}</div>

              <div v-if="!cards.length" class="bento-inset px-4 py-3 text-sm text-ink-2">读不到环境读数。</div>
              <div v-else class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                <div
                  v-for="c in shownEnv"
                  :key="c.id"
                  class="flex flex-col rounded-inset border border-line px-3 py-2.5"
                  :class="c.state === 'ready' ? 'bg-surface' : 'bg-red-50'"
                >
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{{ c.label }}</span>
                    <span class="chip shrink-0 !py-0 !text-aux" :class="c.state === 'ready' ? 'status-published' : 'status-failed'">
                      {{ c.state === 'ready' ? c.on : c.off }}
                    </span>
                  </div>
                  <div class="mt-0.5 truncate text-aux text-ink-3">{{ c.use }}</div>
                  <div
                    v-if="c.note || c.task || (c.state !== 'ready' && FIX_LABEL[c.fix || ''])"
                    class="mt-2 flex items-center gap-2"
                  >
                    <span
                      v-if="c.note"
                      class="min-w-0 flex-1 truncate text-aux"
                      :class="c.state === 'ready' ? 'text-ink-2' : 'text-red-700'"
                      :title="c.note"
                    >{{ c.note }}</span>
                    <span v-else class="min-w-0 flex-1" />
                    <button
                      v-if="c.task"
                      class="btn shrink-0 !px-2 !py-0.5 !text-aux"
                      :class="installing && 'is-on'"
                      :disabled="installing || !!envBusy"
                      @click="installTask(c.task)"
                    >
                      <IconLoaderCircle v-if="installing" :size="13" class="animate-spin" />
                      {{ installing ? `${envClock}` : c.state === 'ready' ? '重装' : '安装' }}
                    </button>
                    <button
                      v-else-if="c.state !== 'ready' && FIX_LABEL[c.fix || '']"
                      class="btn shrink-0 !px-2 !py-0.5 !text-aux"
                      @click="fixAs(c.fix)"
                    >
                      {{ FIX_LABEL[c.fix || ''] }}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <!-- ==================== ⑤ 自检 ====================
                 判据只看盘上产物：脚本自报成功、退出码 0 都不算过。 -->
            <section v-if="!isRemote" data-sec="check" class="flex flex-col gap-2.5">
              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                <h3 class="text-section text-ink">自检</h3>
                <span class="chip shrink-0" :class="check?.never ? 'status-not-start' : checkBad || !check?.ok ? 'status-failed' : 'status-published'">
                  {{ check?.never ? '还没跑过' : checkBad ? `${checkBad} 项要处理` : check?.ok ? '全过了' : '没过' }}
                </span>
                <span v-if="checkAt" class="text-aux text-ink-3">上次 {{ checkAt }}</span>
                <div class="ml-auto flex shrink-0 items-center gap-1.5">
                  <button
                    v-if="check?.items?.length && checkBad"
                    class="seg !px-2.5 !py-1 !text-aux" :class="onlyPendingCheck ? 'is-selected' : ''"
                    @click="onlyPendingCheck = !onlyPendingCheck"
                  >
                    {{ onlyPendingCheck ? `全部 ${check.items.length}` : `只看待处理 ${checkBad}` }}
                  </button>
                  <button class="btn btn-primary shrink-0 !px-2.5 !py-1 !text-aux" :disabled="checking" @click="runCheck">
                    <IconLoaderCircle v-if="checking" :size="13" class="animate-spin" />
                    {{ checking ? '在跑' : check?.never ? '跑一遍' : '再跑一遍' }}
                  </button>
                </div>
              </div>
              <div v-if="checkMsg" class="truncate text-aux font-medium text-red-600">{{ checkMsg }}</div>

              <div v-if="!shownChecks.length" class="bento-inset px-4 py-3 text-sm text-ink-2">
                {{ check?.never ? '自检还没跑过。' : '没有要处理的。' }}
              </div>
              <div v-else class="divide-y divide-line overflow-hidden rounded-bento border border-line bg-surface shadow-neo">
                <div v-for="i in shownChecks" :key="i.id" class="flex items-start gap-3 px-4 py-3">
                  <span class="chip mt-0.5 shrink-0 !py-0 !text-aux" :class="CHECK_CLS[i.state]">{{ CHECK_TEXT[i.state] }}</span>
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-ink">{{ i.title }}</div>
                    <div class="text-aux leading-[21px] text-ink-2">{{ i.detail }}</div>
                    <div v-if="i.next" class="text-aux leading-[21px] font-medium" :class="i.state === 'manual' ? 'text-ink-2' : 'text-red-700'">{{ i.next }}</div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 配色预览：迷你窗口吃自己那一套皮肤的令牌（--app-* 原变量，理由见模板注释）。
   边框宽度与阴影也走令牌，所以经典那套的 2px 硬边、硬位移阴影会照出来。 */
.tp {
  height: 76px;
  background: var(--app-canvas);
  border-color: var(--app-line);
}
.tp-face { background: var(--app-surface); }
.tp-bordered {
  border-style: solid;
  border-width: var(--app-border-w);
  border-color: var(--app-line);
  box-shadow: var(--app-shadow-sm);
}
.tp-dot { background: var(--app-accent); }
.tp-sunk { background: var(--app-surface-2); }
.tp-rule { background: var(--app-line-strong); }
.tp-ink { background: var(--app-ink-3); }
</style>
