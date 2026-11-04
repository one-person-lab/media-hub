<script setup lang="ts">
/**
 * 右上角「现在在跑什么」：生成、渲染、采集、推草稿、补扒脚本都是真异步的——关掉弹层、切到别的页，
 * 本机那条还在跑。这里给一个常驻出口：看得见进度，更要紧的是每一行都能按停（规矩见 scripts/run-jobs.mjs）。
 * 读数一律来自服务端登记处 GET /__jobs，界面不自己猜谁在跑。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useGenerate } from '../lib/useGenerate'
import { fetchRunningJobs, stopRunningJob, studioHashFor, SYNC_TASK_LABEL, type RunningJob } from '../data/store'
import { LoaderCircle as IconLoaderCircle, Square as IconSquare, TriangleAlert as IconTriangleAlert, X as IconX } from 'lucide-vue-next'

const emit = defineEmits<{ openTopic: [key: string] }>()
const gen = useGenerate()

const hash = ref(location.hash)
function syncHash() {
  hash.value = location.hash
}
window.addEventListener('hashchange', syncHash)
onBeforeUnmount(() => window.removeEventListener('hashchange', syncHash))

const jobs = ref<RunningJob[]>([])
const now = ref(Date.now())
/** 按停本身砸了才有的那句（信号文件写不进去、停的不是这一个）：哪一行砸了就只在那一行说 */
const stopErr = ref<Record<string, string>>({})
let poll: ReturnType<typeof setInterval> | null = null
let tick: ReturnType<typeof setInterval> | null = null

async function refresh() {
  jobs.value = await fetchRunningJobs()
  for (const k of Object.keys(stopErr.value)) {
    if (!jobs.value.some((j) => idOf(j) === k)) delete stopErr.value[k]
  }
}
onMounted(() => {
  refresh()
  poll = setInterval(refresh, 4000)
  tick = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
  if (tick) clearInterval(tick)
})

const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (sec: number) => `${Math.floor(sec / 60)}:${p2(Math.floor(sec) % 60)}`
/** 60 分以上说「小时」，否则说「分」——「最多 60 分」读起来像在吓人 */
const limitText = (ms: number) => {
  if (!ms) return ''
  const min = Math.round(ms / 60_000)
  return min >= 60 ? `最多 ${Math.round(min / 60)} 小时` : `最多 ${min} 分`
}
const idOf = (j: RunningJob) => `${j.id}:${j.key}`
/** 采集那一行用界面上那套名字（与运行条、弹层里的同一趟要叫同一个名），其余种类用服务端登记的 */
const nameOf = (j: RunningJob) => (j.id === 'sync' ? SYNC_TASK_LABEL[j.key] : undefined) ?? j.label
const secs = (j: RunningJob) => Math.max(0, Math.round((now.value - j.startedAt) / 1000))

async function stop(j: RunningJob) {
  if (j.stopping) return
  const r = await stopRunningJob(j.id, j.key || undefined)
  if (!r.ok) stopErr.value = { ...stopErr.value, [idOf(j)]: r.error || '停止请求没送到本地服务' }
}

const failed = computed(() => !gen.busy.value && !!gen.genError.value)
/** 跑着的任务若正开在它的弹层里就不重复播报（弹层内自有状态条）；失败必须常驻——人不在弹层里时别静默吞掉。
 *  形态还没定的选题两档页签都进得去，所以拿当前这一段地址当「人在哪一档」问它。 */
const atTopic = computed(() =>
  !!gen.jobKey.value && hash.value === studioHashFor(gen.jobKey.value, hash.value.startsWith('#/studio-video') ? 'studio-video' : 'studio-image'),
)
const genRow = computed(() => jobs.value.find((j) => j.id === 'gen') || null)
/** 生成那一路（图文/视频创作、拆解）由下面的富行播报：进度、选题、上限都在；普通行只列其余种类。
 *  对话那一行不在富行里（它自己长在对话流里），所以照样从登记处出来当普通行列着。 */
const others = computed(() => jobs.value.filter((j) => !(j.id === 'gen' && gen.busy.value)))
const showGen = computed(() => (failed.value || gen.busy.value) && !(atTopic.value && !failed.value))
const visible = computed(() => showGen.value || others.value.length > 0)

const time = computed(() => clock(gen.elapsed.value))
const head = computed(() =>
  [failed.value ? '生成失败' : `${gen.runningText.value}中 ${time.value}${limitText(gen.limitMs.value) ? ` / ${limitText(gen.limitMs.value)}` : ''}`, gen.jobDetail.value]
    .filter(Boolean)
    .join(' · '),
)

function click() {
  if (failed.value) return gen.dismissError()
  // 已经在这条选题的弹层里就别 reload
  if (gen.jobKey.value && !atTopic.value) emit('openTopic', gen.jobKey.value)
}
const stopGen = () => {
  const j = genRow.value
  if (j) stop(j)
}
</script>

<template>
  <div v-if="visible" class="flex w-full min-w-0 flex-col gap-1.5">
    <div
      v-if="showGen"
      class="flex w-full min-w-0 items-start gap-2 rounded-lg border border-line px-3.5 py-2 shadow-neo-sm"
      :class="failed ? 'bg-red-50' : 'bg-accent-soft'"
    >
      <IconTriangleAlert v-if="failed" :size="15" class="mt-0.5 shrink-0 text-red-700" />
      <IconLoaderCircle v-else :size="15" class="mt-0.5 shrink-0 animate-spin" />
      <button
        class="min-w-0 flex-1 text-left"
        :class="!failed && !gen.jobKey ? 'cursor-default' : 'cursor-pointer'"
        :title="failed ? '关闭这条提示' : (gen.jobKey ? '回到这条选题' : '生成任务进行中')"
        @click="click"
      >
        <span class="block truncate text-sm font-medium" :class="failed ? 'text-red-800' : 'text-ink'">
          {{ head }}
        </span>
        <span v-if="failed || gen.progress.value" class="block truncate text-sm font-medium leading-4 text-ink-2">
          {{ failed ? gen.genError.value : gen.progress.value }}
        </span>
      </button>
      <IconX v-if="failed" :size="13" class="mt-0.5 shrink-0 text-red-700" />
      <button
        v-else
        class="mt-0.5 shrink-0 text-ink-2 hover:text-ink"
        :class="genRow?.stopping && 'cursor-not-allowed opacity-50'"
        :title="genRow?.stopping ? '已经在收了' : `停止${gen.runningText.value}`"
        :aria-label="`停止${gen.runningText.value}`"
        @click="stopGen"
      >
        <IconSquare :size="13" />
      </button>
    </div>

    <div
      v-for="j in others"
      :key="idOf(j)"
      class="flex w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-accent-soft px-3.5 py-2 shadow-neo-sm"
    >
      <IconLoaderCircle :size="15" class="shrink-0 animate-spin" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium text-ink">
          {{ nameOf(j) }} 中 {{ clock(secs(j)) }}{{ limitText(j.limitMs) ? ` / ${limitText(j.limitMs)}` : '' }}
        </span>
        <span v-if="stopErr[idOf(j)] || j.stopping" class="block truncate text-sm font-medium leading-4" :class="stopErr[idOf(j)] ? 'text-red-700' : 'text-ink-2'">
          {{ stopErr[idOf(j)] || '已按停，等这一段跑完就收' }}
        </span>
      </span>
      <button
        class="shrink-0 text-ink-2 hover:text-ink"
        :class="(j.stopping || !!stopErr[idOf(j)]) && 'cursor-not-allowed opacity-50'"
        :title="j.stopping ? '已经在收了' : `停止${nameOf(j)}`"
        :aria-label="`停止${nameOf(j)}`"
        @click="stop(j)"
      >
        <IconSquare :size="13" />
      </button>
    </div>
  </div>
</template>
