<script setup lang="ts">
/**
 * 看板顶上那一行：这台机器还没接上时才有，四步齐了整行消失。
 * 一行只报读数，清单在点开的那层里——看板是天天看的页，不能天天被装机清单挤掉首屏。
 * 判据全在服务端 start-guide.mjs，界面只报读数：装没装、登没登、采没采全，都是回头看文件看出来的，
 * 所以这里没有「下一步」按钮，哪一步的产物齐了哪一步自己打勾。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { guide, loadGuide, setGuideDismissed, settingsPanel, stopRunningJob } from '../data/store'
import { Check as IconCheck, ChevronRight as IconChevronRight, LoaderCircle as IconLoaderCircle, Square as IconSquare, X as IconX } from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'go', view: string): void }>()

const steps = computed(() => guide.value?.steps ?? [])
const passed = computed(() => steps.value.filter((s) => s.state === 'ready').length)
const todo = computed(() => steps.value.filter((s) => s.state !== 'ready').map((s) => s.title))

const show = ref(false)

/* 弹层开着才回头看产物：扫码登进来、采集落盘这些不该等人再点一下，但没人看着时不必翻盘 */
let poll: ReturnType<typeof setInterval> | null = null
watch(show, (on) => {
  if (on && !poll) poll = setInterval(loadGuide, 4000)
  else if (!on && poll) { clearInterval(poll); poll = null }
})
onMounted(loadGuide)
onBeforeUnmount(() => { if (poll) clearInterval(poll) })

/* ==================== 第 4 步：粘一条链接采回来（占浏览器，走服务端单飞队列） ==================== */
const url = ref('')
const collecting = ref(false)
/** 按过停但脚本还在收这一段（浏览器那一趟不会掐在半路，走到下一个边界才退） */
const stopping = ref(false)
const failMsg = ref('')
const elapsed = ref(0)
let tick: ReturnType<typeof setInterval> | null = null
let watcher: ReturnType<typeof setInterval> | null = null

const clock = computed(() => `${Math.floor(elapsed.value / 60)}:${String(elapsed.value % 60).padStart(2, '0')}`)

function stopTimers() {
  if (tick) clearInterval(tick)
  if (watcher) clearInterval(watcher)
  tick = watcher = null
}
onBeforeUnmount(stopTimers)

async function stopCollect() {
  if (stopping.value) return
  const r = await stopRunningJob('sync', 'note')
  if (r.ok) stopping.value = true
  else failMsg.value = r.error || '停止请求没送到本地服务'
}

async function collect() {
  const link = url.value.trim()
  if (!link || collecting.value) return
  failMsg.value = ''
  try {
    const r = await (await fetch('/__run-script', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'note', arg: link }),
    })).json()
    if (!r.ok) throw new Error(r.error || '这一条没排上')
    collecting.value = true
    stopping.value = false
    elapsed.value = 0
    tick = setInterval(() => (elapsed.value += 1), 1000)
    const startedAt = r.startedAt as number
    watcher = setInterval(async () => {
      try {
        const { job } = await (await fetch('/__run-script')).json()
        if (!job || job.task !== 'note' || job.startedAt !== startedAt) return
        if (job.running) { stopping.value = !!job.stopping; return }
        stopTimers()
        collecting.value = false
        stopping.value = false
        if (job.exitCode !== 0) failMsg.value = job.action || job.error || '这一条没采回来，换一条再试'
        else { url.value = ''; await loadGuide() }
      } catch { /* 本地服务在重建，下一轮再问 */ }
    }, 2000)
  } catch (e) {
    failMsg.value = (e as Error).message
  }
}

/** 没过的那一步右侧那一个动作：能点的全做成按钮，点了就收掉这一层，不让人在两层里找东西 */
function act(jump: string) {
  show.value = false
  if (jump === 'machine') settingsPanel.value = 'machine'
  else emit('go', 'accounts')
}
</script>

<template>
  <!-- 一条完整的摘要行，不是一句带下划线的文字：左边说这是什么，中间摊开缺的前两项，
       右边给数量徽标和箭头。整行可点，点开仍是这份清单。 -->
  <button
    v-if="todo.length"
    class="flex h-12 w-full items-center gap-3 rounded-lg border border-line bg-surface px-4 text-left transition-colors hover:bg-surface-2"
    title="点开看四步清单"
    @click="show = true"
  >
    <span class="shrink-0 text-aux text-ink-3">这台机器</span>
    <span class="min-w-0 flex-1 truncate text-sm text-ink-2">{{ todo.slice(0, 2).join(' · ') }}</span>
    <span class="shrink-0 rounded-md bg-surface-2 px-2 py-0.5 text-aux tabular-nums text-ink-2">
      还差 {{ todo.length }} 步
    </span>
    <IconChevronRight :size="15" class="shrink-0 text-ink-3" />
  </button>
  <div v-else class="flex items-center gap-2 text-aux text-ink-3">
    <span>环境检查</span>
    <IconLoaderCircle v-if="!steps.length" :size="13" class="animate-spin shrink-0" />
    <span v-else>4 步已就绪</span>
  </div>

  <div v-if="show" v-dialog="'把这台机器接上'" class="modal" @click.self="show = false">
    <div class="card modal-card max-w-3xl">
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <div class="min-w-0 flex-1 text-[15px] font-medium">把这台机器接上</div>
        <span class="chip shrink-0" :class="passed === steps.length ? 'status-published' : 'status-creating'">
          {{ passed }}/{{ steps.length || 4 }}
        </span>
        <button v-if="!guide?.dismissed" class="btn shrink-0 !px-2.5 !py-1 !text-sm" @click="setGuideDismissed(true)">不再出现</button>
        <button class="btn shrink-0 px-2 py-1" title="关闭" aria-label="关闭" @click="show = false">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body space-y-3 p-5">
        <div v-for="s in steps" :key="s.id" class="flex items-start gap-3">
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line text-sm font-medium"
            :class="s.state === 'ready' ? 'status-published' : 'bg-surface-2'"
          >
            <IconCheck v-if="s.state === 'ready'" :size="15" />
            <template v-else>{{ s.n }}</template>
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 class="text-sm font-medium">{{ s.title }}</h3>
              <span class="text-sm font-medium" :class="s.state === 'ready' ? 'text-ink-2' : 'text-red-700'">{{ s.detail }}</span>
            </div>
            <p v-if="s.next" class="mt-1 max-w-prose text-sm font-medium leading-relaxed text-red-700">{{ s.next }}</p>

            <!-- 动作只挂在没过的那一步上；过了的步骤不再留按钮 -->
            <div v-if="s.state !== 'ready'" class="mt-2 flex flex-wrap items-center gap-2">
              <template v-if="s.id === 'bin'">
                <button class="btn btn-primary !px-3 !py-1 !text-sm" @click="loadGuide">重新检查</button>
                <button class="btn !px-3 !py-1 !text-sm" @click="act('machine')">看看还缺什么</button>
              </template>
              <button v-else-if="s.jump" class="btn btn-primary !px-3 !py-1 !text-sm" @click="act(s.jump)">
                {{ s.id === 'accounts' ? '去登记' : '去授权' }}
              </button>

              <!-- 第 4 步：一条链接进来，一张采全的卡出去 -->
              <div v-else-if="s.id === 'collect'" class="flex w-full max-w-[520px] items-center gap-2">
                <input
                  v-model="url"
                  class="input min-w-0 flex-1"
                  placeholder="粘一条小红书笔记链接"
                  @keyup.enter="collect"
                />
                <button class="btn btn-primary shrink-0 !px-3 !py-1 !text-sm" :disabled="collecting || !url.trim()" @click="collect">
                  <IconLoaderCircle v-if="collecting" :size="13" class="animate-spin" />
                  {{ collecting ? (stopping ? `已按停 ${clock}` : `正在采 ${clock}`) : '采' }}
                </button>
                <button
                  v-if="collecting"
                  class="btn shrink-0 !px-2 !py-1 !text-sm"
                  :disabled="stopping"
                  title="停止"
                  aria-label="停止"
                  @click="stopCollect"
                >
                  <IconSquare :size="13" />
                </button>
              </div>
            </div>
            <p v-if="s.id === 'collect' && failMsg" class="mt-1.5 text-sm font-medium text-red-700">{{ failMsg }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
