<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { accounts, products, holdSelfWrite, gotoStudio } from '../data/store'
import { CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, LoaderCircle as IconLoaderCircle, PenLine as IconPenLine, RotateCw as IconRotateCw, WandSparkles as IconWandSparkles, X as IconX } from 'lucide-vue-next'

/** 一键同款：把选中的这一条拆成结构，换成我的号和我的产品，出一版稿直接进创作台。 */
const props = defineProps<{ source: { file: string; title: string; platform: string } }>()
const emit = defineEmits<{ (e: 'close'): void }>()

type Step = 'config' | 'running' | 'ready' | 'failed'
const step = ref<Step>('config')
const progress = ref('')
const errText = ref('')
const saving = ref(false)

interface Plan {
  source: { title: string; platform: string }
  structure: { hook: string; audience: string; pain: string; turn: string; evidence: string; cta: string; beats: { role: string; move: string; why: string }[] }
  mapping: { angle: string; avoid: string; beats: { role: string; mine: string }[] }
  versions: {
    image: { title: string; coverText: string; shortCopy: string; body: string[]; tags: string[]; firstComment: string; cta: string } | null
    video: { title: string; shots: { sec: number; visual: string; voice: string; subtitle: string }[]; voiceover: string; outro: string } | null
  }
  gates: { unverifiedClaims: string[]; needFacts: string[] }
  errors?: string[]
}
const plan = ref<Plan | null>(null)

/** 同平台的号排前面：这条爆款本来就是从这个平台采的（两边都用中文平台名比） */
const accountOptions = computed(() => {
  const same = accounts.filter((a) => a.platform === props.source.platform)
  return [...same, ...accounts.filter((a) => a.platform !== props.source.platform)]
})
const pick = ref({
  account: accountOptions.value[0]?.id || '',
  product: '',
  form: 'image' as 'image' | 'video' | 'both',
  goal: 'lead' as 'lead' | 'sale' | 'trust',
  fidelity: 'align' as 'align' | 'loose',
})

const FORMS = [['image', '图文内容'], ['video', '竖屏视频脚本'], ['both', '图文 + 视频脚本']] as const
const GOALS = [['lead', '获取咨询'], ['sale', '卖课程或服务'], ['trust', '建立专业影响力']] as const
const FIDELITY = [['align', '沿用它的顺序，内容全换成我的'], ['loose', '只学它为什么有效，段落我重排']] as const

let timer: ReturnType<typeof setInterval> | null = null
function stop() { if (timer) clearInterval(timer); timer = null }
onBeforeUnmount(stop)

async function start() {
  stop()
  errText.value = ''
  plan.value = null
  const o = await fetch('/__clone', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: props.source.file, ...pick.value }),
  }).then((r) => r.json()).catch(() => ({ ok: false, error: '服务未就绪' }))
  if (!o.ok) { step.value = 'failed'; errText.value = o.error || '启动失败'; return }
  step.value = 'running'
  progress.value = '排队中…'
  timer = setInterval(async () => {
    try {
      const s = await (await fetch('/__clone')).json()
      const job = s.job
      if (!job) return
      if (job.running) { progress.value = job.progress || '生成中…'; return }
      stop()
      if (!job.ok) { step.value = 'failed'; errText.value = job.error || '生成失败'; return }
      plan.value = job.plan as Plan
      step.value = 'ready'
    } catch { /* 服务瞬断下一轮再问 */ }
  }, 3000)
}

async function save() {
  if (!plan.value || saving.value) return
  saving.value = true
  holdSelfWrite()
  const o = await fetch('/__clone', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ write: true }),
  }).then((r) => r.json()).catch(() => ({ ok: false, error: '服务未就绪' }))
  saving.value = false
  if (!o.ok) { errText.value = o.error || '保存失败'; step.value = 'failed'; return }
  // 稿组和选题卡是这次刚落盘的，客户端手上还是刷新前的数据；整页重载才认得到这条的短码。
  // 不动详情抽屉的 openId：它会改写 hash，把刚指过去的创作台深链顶掉。
  const topicKey = String(o.topicRel || '').split('/').pop()?.replace(/\.md$/, '') || ''
  if (topicKey) gotoStudio(topicKey)
  location.reload()
}

const image = computed(() => plan.value?.versions.image || null)
const video = computed(() => plan.value?.versions.video || null)
const draftTitle = computed(() => image.value?.title || video.value?.title || props.source.title)
</script>

<template>
  <Teleport to="body">
    <div v-dialog="'一键同款'" class="modal">
      <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
      <div class="card modal-card relative z-10 max-w-4xl">
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <IconWandSparkles :size="15" />
            <span class="truncate">一键同款 · {{ source.title }}</span>
          </div>
          <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
            <IconX :size="15" />
          </button>
        </div>

        <div class="modal-body space-y-5 p-5">
          <!-- ① 配置：只留会影响结果的四个选择 -->
          <template v-if="step === 'config'">
            <div class="grid gap-4 sm:grid-cols-2">
              <label class="text-sm font-medium text-ink-2">
                挂哪个产品
                <select v-model="pick.product" class="input mt-1 w-full">
                  <option value="">按这个号平时的产品</option>
                  <option v-for="p in products" :key="p" :value="p">{{ p }}</option>
                </select>
              </label>
              <label class="text-sm font-medium text-ink-2">
                发到哪个号
                <select v-model="pick.account" class="input mt-1 w-full">
                  <option v-for="a in accountOptions" :key="a.id" :value="a.id">{{ a.platform }} · {{ a.nickname || a.id }}</option>
                </select>
              </label>
            </div>

            <div>
              <div class="mb-2 text-sm font-medium text-ink-2">出什么</div>
              <div class="flex flex-wrap gap-2">
                <button v-for="[v, t] in FORMS" :key="v" class="seg" :class="pick.form === v && 'is-selected'" @click="pick.form = v">{{ t }}</button>
              </div>
            </div>
            <div>
              <div class="mb-2 text-sm font-medium text-ink-2">这篇为了什么</div>
              <div class="flex flex-wrap gap-2">
                <button v-for="[v, t] in GOALS" :key="v" class="seg" :class="pick.goal === v && 'is-selected'" @click="pick.goal = v">{{ t }}</button>
              </div>
            </div>
            <div>
              <div class="mb-2 text-sm font-medium text-ink-2">学到哪一步</div>
              <div class="flex flex-wrap gap-2">
                <button v-for="[v, t] in FIDELITY" :key="v" class="seg" :class="pick.fidelity === v && 'is-selected'" @click="pick.fidelity = v">{{ t }}</button>
              </div>
            </div>

            <div class="flex items-center gap-2 border-t border-line pt-4">
              <button class="btn btn-primary !px-3 !py-1" :disabled="!pick.account" @click="start">
                <IconWandSparkles :size="13" />
                开始生成
              </button>
              <span class="text-sm text-ink-3">大约一两分钟。</span>
            </div>
          </template>

          <!-- ② 生成中 -->
          <div v-else-if="step === 'running'" class="space-y-3 py-6 text-center">
            <IconLoaderCircle :size="28" class="mx-auto animate-spin text-ink-3" />
            <div class="text-sm font-medium text-ink-2">{{ progress }}</div>
          </div>

          <!-- ③ 失败 -->
          <div v-else-if="step === 'failed'" class="space-y-4">
            <p class="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-700">
              <IconCircleAlert :size="15" class="mt-0.5 shrink-0" />
              <span class="min-w-0 whitespace-pre-wrap">{{ errText || '生成失败' }}</span>
            </p>
            <div class="flex gap-2">
              <button class="btn !px-3 !py-1" @click="step = 'config'"><IconRotateCw :size="13" />回去改一下</button>
              <button class="btn !px-3 !py-1" @click="start"><IconLoaderCircle :size="13" />原样重试</button>
            </div>
          </div>

          <!-- ④ 预览：左边它为什么火，右边我这一版 -->
          <template v-else-if="plan">
            <div class="grid gap-5 lg:grid-cols-[1fr_1.35fr]">
              <section class="space-y-3">
                <h3 class="text-sm font-medium text-ink">它为什么火</h3>
                <dl class="grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-2 text-sm">
                  <dt class="text-ink-2">留人</dt><dd class="leading-6">{{ plan.structure.hook || '—' }}</dd>
                  <dt class="text-ink-2">说给谁</dt><dd class="leading-6">{{ plan.structure.audience || '—' }}</dd>
                  <dt class="text-ink-2">痛点</dt><dd class="leading-6">{{ plan.structure.pain || '—' }}</dd>
                  <dt class="text-ink-2">收口</dt><dd class="leading-6">{{ plan.structure.cta || '—' }}</dd>
                </dl>
                <ol class="space-y-2 text-sm">
                  <li v-for="(b, i) in plan.structure.beats" :key="i" class="rounded-lg bg-surface-2 p-3 leading-6">
                    <span class="font-medium text-ink">{{ i + 1 }}. {{ b.role }}</span>
                    <div class="text-ink-2">{{ b.move }}</div>
                    <div class="text-ink-3">{{ b.why }}</div>
                  </li>
                </ol>
                <p v-if="plan.mapping.avoid" class="rounded-lg border border-line p-3 text-sm leading-6 text-ink-3">
                  这次不搬：{{ plan.mapping.avoid }}
                </p>
              </section>

              <section class="space-y-3">
                <h3 class="text-sm font-medium text-ink">我的这一版</h3>
                <p class="text-sm text-ink-3">切入：{{ plan.mapping.angle }}</p>
                <div class="rounded-lg border border-line p-4">
                  <div class="text-base font-medium text-ink">{{ draftTitle }}</div>
                  <div v-if="image?.coverText" class="mt-1 whitespace-pre-line text-sm leading-6 text-ink-2">{{ image.coverText }}</div>
                </div>
                <div v-if="image" class="space-y-2">
                  <p v-for="(para, i) in image.body" :key="i" class="whitespace-pre-wrap text-sm leading-7 text-ink-2">{{ para }}</p>
                  <p v-if="image.cta" class="rounded-lg bg-surface-2 p-3 text-sm leading-6 text-ink-2">{{ image.cta }}</p>
                  <p v-if="image.tags?.length" class="text-sm text-ink-3">{{ image.tags.join(' ') }}</p>
                </div>
                <ol v-if="video" class="space-y-1.5">
                  <li v-for="(s, i) in video.shots" :key="i" class="flex gap-2 text-sm leading-6">
                    <span class="w-10 shrink-0 tabular-nums text-ink-3">{{ s.sec }}s</span>
                    <span class="min-w-0 text-ink-2">{{ s.voice || s.visual }}</span>
                  </li>
                </ol>
                <p v-if="video?.outro" class="rounded-lg bg-surface-2 p-3 text-sm leading-6 text-ink-2">{{ video.outro }}</p>

                <p v-if="plan.gates.needFacts.length" class="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-800">
                  <IconCircleAlert :size="15" class="mt-0.5 shrink-0" />
                  <span class="min-w-0">这几处没给事实，进创作台后要自己补：{{ plan.gates.needFacts.join('；') }}</span>
                </p>
              </section>
            </div>

            <div class="flex items-center gap-2 border-t border-line pt-4">
              <button class="btn btn-primary !px-3 !py-1" :disabled="saving" @click="save">
                <IconPenLine :size="13" />
                {{ saving ? '进创作台…' : '进创作台' }}
              </button>
              <button class="btn !px-3 !py-1" :disabled="saving" @click="start">
                <IconRotateCw :size="13" />换一版
              </button>
              <span class="flex items-center gap-1.5 text-sm text-ink-3">
                <IconCircleCheck :size="15" class="text-green-700" />
                「{{ pick.account }}」的待发布稿
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
