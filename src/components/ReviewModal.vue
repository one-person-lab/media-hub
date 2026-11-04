<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  articles, works, reviewTopics, lessonEntries, versionKeyOf, gotoStudio,
  type Article,
} from '../data/store'
import { useToast } from '../lib/useToast'
import { ArrowRight as IconArrowRight, CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, LoaderCircle as IconLoaderCircle, Notebook as IconNotebook, Sparkles as IconSparkles, X as IconX } from 'lucide-vue-next'

/** 待复盘弹窗：发布满 3 天、还没写「这篇教会了我们什么」的选题排在这里。
 *  机器先按读数 + 当初判据 + 已有台账答一版三件套，人改完保存才落盘——
 *  结论是要人认账的东西，替人写完再让人改，等于系统自己签了个字。 */
const emit = defineEmits<{ (e: 'close'): void }>()
const { toast } = useToast()

interface Row {
  key: string
  title: string
  date: string | null
  days: number
  files: string[]
  vers: Article[]
  /** 预答证据挂在这一版上：有读数的那版当主稿，摆不出证据的版只跟着写回 */
  primaryFile: string
  noDataVers: Article[]
  dataScore: number | null
  scoreNote: string
}

const num = (v: number | null | undefined) => (v == null ? '—' : v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))

/** 一版的一行读数：缺的项不摆「—」占满一行，全缺就一句话说清（和台账同一口径） */
const readout = (a: Article) => {
  const parts = [
    ['播放', a.metrics.views], ['赞', a.metrics.likes], ['藏', a.metrics.collects],
    ['评', a.metrics.comments], ['享', a.metrics.shares], ['粉', a.metrics.follows],
  ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k} ${num(v as number)}`)
  return parts.length ? parts.join(' · ') : '无回填读数'
}

/** 已复盘但没结论的那几版不在写回清单里，界面要说明它们去哪了：
 *  同题的另一版已经答过，这一题就只补剩下那几版 */
const rows = computed<Row[]>(() => reviewTopics.map((t) => {
  const vers = t.files
    .map((f) => articles.find((a) => a.file === f))
    .filter((a): a is Article => !!a)
  const primary = vers.find((a) => a.file === t.primary) || vers[0]
  const w = primary ? works.find((x) => x.article?.file === primary.file) || null : null
  return {
    key: primary ? primary.file : t.files[0],
    title: t.title,
    date: t.date,
    days: t.days,
    files: t.files,
    vers,
    primaryFile: primary?.file || t.files[0],
    noDataVers: vers.filter((a) => a.dataState !== 'filled'),
    dataScore: w?.dataScore ?? null,
    scoreNote: w?.scoreNote ?? '',
  }
}))

const open = ref('')
const draft = ref('')
const busy = ref<'' | 'draft' | 'save'>('')
const err = ref('')
const written = ref(0)

function toggle(row: Row) {
  if (open.value === row.key) {
    open.value = ''
    return
  }
  open.value = row.key
  // 各版结论本应同源：取第一版已有的正文当草稿，改一次写回全题
  draft.value = row.vers.find((a) => a.lesson)?.lesson || ''
  err.value = ''
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const current = computed(() => rows.value.find((r) => r.key === open.value) || null)
async function prefill() {
  const row = current.value
  if (!row) return
  busy.value = 'draft'
  err.value = ''
  try {
    const r = await fetch('/__review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rel: `content/${row.primaryFile}`,
        dataScore: row.dataScore,
        scoreNote: row.scoreNote,
      }),
    })
    const o = await r.json()
    if (!o.ok) throw new Error(o.error || '模型没答出来')
    draft.value = o.draft
    toast(`已预答，${(o.files || []).length} 份一起写回`, 'ok')
  } catch (e) {
    err.value = e instanceof Error ? e.message : '预答失败'
  } finally {
    busy.value = ''
  }
}

async function save() {
  const row = current.value
  if (!row) return
  busy.value = 'save'
  err.value = ''
  try {
    const r = await fetch('/__lesson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: row.files.map((f) => `content/${f}`), text: draft.value }),
    })
    const o = await r.json()
    if (!o.ok) throw new Error(o.error || '保存失败')
    written.value += o.written ?? 0
    toast('已写回', 'ok')
    open.value = ''
    draft.value = ''
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = ''
  }
}

/** 已写过的结论摆在同一屏：复盘是接着上一轮往下说，不是每轮从零感想。
 *  跳转要用选题聚合键，只能从 articles 里拿到真身；匹配不到稿（例如已挪出排期）就不摆按钮。 */
const ledger = computed(() =>
  lessonEntries.slice(0, 20).map((l) => {
    const a = articles.find((x) => `content/${x.file}` === l.rel)
    return { ...l, key: a ? versionKeyOf(a) : '' }
  }),
)
</script>

<template>
  <div v-dialog="'待复盘'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
    <div class="card modal-card relative z-10 max-w-3xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div class="flex items-center gap-2 text-sm font-medium">
          <IconNotebook :size="15" />
          待复盘
          <span class="text-ink-3">{{ rows.length }} 题</span>
        </div>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body space-y-4 p-5">
        <p class="text-sm leading-6 text-ink-2">
          数据更新：发布后 3 天。
          答的内容落在「这篇教会了我们什么」段，选题预审和创作环节下一轮就会读它。
        </p>

        <p v-if="!rows.length" class="card !p-4 text-sm text-ink-2">
          没有欠复盘的稿{{ written ? `（本轮已写回 ${written} 条）` : '' }}。发布满 3 天的下一批会自动排到这里。
        </p>

        <div v-for="row in rows" :key="row.key" class="card !p-0">
          <button class="flex w-full items-start gap-3 px-4 py-3 text-left" @click="toggle(row)">
            <span class="mt-1 shrink-0 text-xs tabular-nums text-ink-3" :title="`发布至今 ${row.days} 天`">
              逾期 {{ row.days }} 天
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-ink">{{ row.title }}</span>
              <span class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
                <span class="tabular-nums">{{ row.date || '未标日期' }}</span>
                <span>{{ row.vers.map((v) => v.account).join('、') }}</span>
                <span v-if="row.dataScore != null" class="tabular-nums" :title="row.scoreNote">
                  第 A 组：{{ row.dataScore }}/60
                </span>
                <span v-else class="text-ink-3">第 A 组：待评分</span>
                <span v-if="row.noDataVers.length === row.vers.length" class="text-ink-3">本篇无回填读数</span>
              </span>
            </span>
            <IconArrowRight :size="15" class="mt-1 shrink-0 text-ink-3" />
          </button>

          <div v-if="open === row.key" class="space-y-3 border-t border-line px-4 py-3">
            <div class="grid gap-1 text-xs text-ink-2">
              <div v-for="v in row.vers" :key="v.file" class="flex gap-2">
                <span class="w-20 shrink-0 truncate text-ink">{{ v.account }}</span>
                <span class="tabular-nums">{{ readout(v) }}</span>
              </div>
            </div>
            <textarea v-model="draft" rows="6" class="input w-full leading-6"
              placeholder="一句话：这篇换来的新信息｜证据：引得出数字或原句｜下次：下一条直接执行的一个动作" />
            <div class="flex flex-wrap items-center gap-2">
              <button class="btn !px-3 !py-1 text-xs" :disabled="busy !== ''" @click="prefill">
                <IconLoaderCircle v-if="busy === 'draft'" :size="13" class="animate-spin" />
                <IconSparkles v-else :size="13" />
                {{ busy === 'draft' ? '模型在答…' : '机器预答' }}
              </button>
              <button class="btn btn-primary !px-3 !py-1 text-xs" :disabled="busy !== '' || !draft.trim()" @click="save">
                <IconLoaderCircle v-if="busy === 'save'" :size="13" class="animate-spin" />
                {{ busy === 'save' ? '保存中…' : '写回' }}
              </button>
              <button class="btn-ghost !px-2.5 !py-1 text-xs" :disabled="busy !== ''" @click="open = ''">收起</button>
              <span v-if="err" class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-red-600">
                <IconCircleAlert :size="15" class="shrink-0" />
                <span class="min-w-0">{{ err }}</span>
              </span>
            </div>
          </div>
        </div>

        <div v-if="ledger.length" class="border-t border-line pt-4">
          <div class="mb-2 flex items-center gap-2 text-sm font-medium text-ink-2">
            <IconCircleCheck :size="15" class="text-green-700" />
            已有结论 {{ lessonEntries.length }} 条
          </div>
          <div class="space-y-2">
            <div v-for="l in ledger" :key="l.rel" class="text-xs leading-5">
              <button v-if="l.key" class="font-medium text-ink underline-offset-2 hover:underline"
                @click="gotoStudio(l.key)">
                {{ l.title }}
              </button>
              <span v-else class="font-medium text-ink">{{ l.title }}</span>
              <span class="ml-2 text-ink-3">{{ l.account }} · {{ l.date }} · {{ l.metricsText }}</span>
              <p class="mt-0.5 text-ink-2">{{ l.lesson.replace(/\s+/g, ' ').slice(0, 160) }}…</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
