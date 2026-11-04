<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DetailModal from './DetailModal.vue'
import PlatformLogo from './PlatformLogo.vue'
import type { TopicVersion } from '../data/store'
import { Check as IconCheck, Image as IconImage, LoaderCircle as IconLoaderCircle } from 'lucide-vue-next'

/** 发布预览：逐个账号看「草稿箱里会出现的成稿」。
 *  数据来自 /__preview——和 /__push 共用 buildPublishPayload，预览与真推不会各说各话。 */
const props = defineProps<{ versions: TopicVersion[]; initial: string }>()
const emit = defineEmits<{ close: [] }>()

interface Preview {
  platform: string
  account: string
  title: string
  titleChars: number
  titleLimit: number
  titlePushed: boolean
  body: string
  bodyChars: number
  tags: string[]
  tagsPushed: boolean
  images: { url: string; exists: boolean }[]
  music: { title: string; author: string } | null
  weapp: string
  warnings: string[]
}
interface Failure { error: string }

const current = ref(props.initial)
const shots = ref<Record<string, Preview | Failure>>({})
const busy = ref(false)

const versionOf = (account: string) => props.versions.find((v) => v.account === account) || null
const data = computed(() => shots.value[current.value] || null)
const preview = computed(() => (data.value && !('error' in data.value) ? data.value : null))
const failure = computed(() => (data.value && 'error' in data.value ? data.value.error : ''))

async function load(account: string) {
  if (shots.value[account]) return
  const v = versionOf(account)
  if (!v?.item) {
    shots.value[account] = { error: '还没有稿' }
    return
  }
  busy.value = true
  try {
    const r = await fetch('/__preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel: `content/${v.item.article.file}`, account }),
    })
    const o = await r.json()
    shots.value[account] = o.ok ? o.preview : { error: o.error || '预览生成失败' }
  } catch {
    shots.value[account] = { error: '服务未就绪' }
  } finally {
    busy.value = false
  }
}

function pick(account: string) {
  current.value = account
  load(account)
}

/* 推广链接属于发布配置，跟着这一版要发出去的平台一起核对，不再挂在右栏画面区（GPT 第 16 轮判 3） */
const landingRow = computed(() => {
  const p = preview.value
  const l = versionOf(current.value)?.item?.article.landing
  if (!p || !l) return null
  const v = l.byPlatform?.[p.platform]
  return { url: v?.url || l.primary || '', note: v?.placement || '', utm: !!v?.url }
})
const copied = ref(false)
async function copyLanding() {
  const url = landingRow.value?.url
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* 剪贴板拿不到不拦人：链接本来就整条摆在屏幕上，选中就能复制 */
  }
}

onMounted(() => load(current.value))
</script>

<template>
  <DetailModal @close="emit('close')">
    <template #title>发布预览</template>

    <div class="grid min-h-[62vh] grid-cols-1 gap-4 md:grid-cols-[176px_minmax(0,1fr)]">
      <!-- 账号清单：同平台多号各一行，和创作台左栏同序 -->
      <ul class="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        <li v-for="v in versions" :key="v.account" class="shrink-0 md:shrink">
          <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors md:py-2"
            :class="v.account === current ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.05)]' : 'text-ink-2 hover:bg-surface/70 hover:text-ink'"
            :disabled="!v.item" :title="v.item ? `看「${v.account}」要发出去的内容` : '还没有稿'"
            @click="pick(v.account)">
            <PlatformLogo :platform="v.platform" :size="18" />
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ v.account }}</span>
            <span v-if="!v.item" class="shrink-0 text-sm text-ink-3">无稿</span>
          </button>
        </li>
      </ul>

      <div class="min-w-0">
        <div v-if="busy && !data" class="flex items-center gap-2 py-8 text-sm font-medium text-ink-2">
          <IconLoaderCircle :size="15" class="animate-spin shrink-0" /> 正在读…
        </div>
        <div v-else-if="failure" class="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm leading-6 text-red-700">
          {{ failure }}
        </div>

        <div v-else-if="preview" class="mx-auto w-full max-w-[380px]">
          <!-- 成稿卡：只画草稿箱里真会出现的东西，不套平台界面 -->
          <article class="overflow-hidden rounded-xl border-2 border-ink bg-surface shadow-neo">
            <div class="flex items-center gap-2 border-b-2 border-ink/10 px-3 py-2">
              <PlatformLogo :platform="preview.platform" :size="16" />
              <span class="text-sm font-semibold">{{ preview.account }}</span>
              <span class="ml-auto text-sm tabular-nums text-ink-3">{{ preview.platform }}</span>
            </div>

            <div class="px-3 pb-3 pt-2.5">
              <!-- 标题 -->
              <div v-if="preview.titlePushed" class="mb-1.5">
                <div class="flex items-start gap-2">
                  <h3 class="min-w-0 flex-1 text-[17px] font-semibold leading-6">{{ preview.title || '（稿里没有 H1 标题）' }}</h3>
                  <span class="shrink-0 pt-0.5 text-sm tabular-nums"
                    :class="preview.titleChars > preview.titleLimit ? 'text-red-600' : 'text-ink-3'">
                    {{ preview.titleChars }}/{{ preview.titleLimit }}
                  </span>
                </div>
              </div>
              <div v-else class="mb-1.5 flex items-center gap-2">
                <h3 class="min-w-0 flex-1 truncate text-[17px] font-semibold leading-6 text-ink-3">{{ preview.title }}</h3>
                <span class="chip shrink-0 !px-1.5 !py-0">不推送</span>
              </div>

              <!-- 正文：脚本逐行回车写进去的那段 -->
              <p v-if="preview.body" class="whitespace-pre-wrap break-words text-[15px] leading-7">{{ preview.body }}</p>
              <p v-else class="text-sm leading-6 text-ink-3">正文是空的，推草稿会被拦下。</p>

              <!-- 话题 -->
              <p v-if="preview.tags.length" class="mt-1.5 text-sm font-medium leading-6"
                :class="preview.tagsPushed ? 'text-accent' : 'text-ink-3 line-through'">
                {{ preview.tags.join(' ') }}
              </p>
              <span v-if="preview.tags.length && !preview.tagsPushed" class="chip mt-1 !px-1.5 !py-0">不推送</span>

              <!-- 图：按推送顺序，封面是第 1 张 -->
              <div v-if="preview.images.length" class="mt-2.5 grid grid-cols-2 gap-1.5">
                <div v-for="(img, i) in preview.images" :key="i"
                  class="relative overflow-hidden rounded-md border border-line bg-surface-2" :class="i === 0 && 'col-span-1'">
                  <img v-if="img.exists && img.url" :src="img.url" :alt="`第 ${i + 1} 张`"
                    class="aspect-[3/4] w-full object-cover" />
                  <div v-else class="flex aspect-[3/4] flex-col items-center justify-center gap-1 text-red-600">
                    <IconImage :size="18" />
                    <span class="text-sm">缺图</span>
                  </div>
                  <span class="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">{{ i + 1 }}</span>
                  <span v-if="i === 0" class="absolute right-1 top-1 rounded bg-white/85 px-1 text-[10px] leading-4 text-ink">封面</span>
                </div>
              </div>

              <!-- 平台额外字段：公众号口令、配乐 -->
              <div v-if="preview.weapp || preview.music" class="mt-2.5 flex flex-col gap-1 border-t border-line pt-2">
                <p v-if="preview.weapp" class="text-sm leading-5">
                  <span class="text-ink-3">链接 </span>
                  <span class="break-all font-medium">{{ preview.weapp }}</span>
                </p>
                <p v-if="preview.music" class="text-sm leading-5">
                  <span class="text-ink-3">配乐 </span>
                  <span class="font-medium">{{ preview.music.title }}</span>
                  <span v-if="preview.music.author" class="text-ink-2"> · {{ preview.music.author }}</span>
                </p>
              </div>

              <!-- 异常：缺段回退这类会是空的话，提前看见 -->
              <div v-if="preview.warnings.length" class="mt-2.5 flex flex-wrap gap-1 border-t border-line pt-2">
                <span v-for="(w, i) in preview.warnings" :key="i" class="chip !bg-tone-creating/20 !px-1.5 !py-0">{{ w }}</span>
              </div>
            </div>
          </article>

          <!-- 这一版要挂的推广链接：核对成稿时顺手拿走，右栏不再另挂一颗入口 -->
          <div v-if="landingRow" class="mt-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <div class="flex items-center gap-2">
              <span class="shrink-0 text-ink-3">推广链接</span>
              <span class="min-w-0 flex-1 break-all font-medium">{{ landingRow.url || '没填链接' }}</span>
              <button class="btn-ghost shrink-0 !px-2 !py-0.5" :disabled="!landingRow.url" title="复制这一条链接" @click="copyLanding">
                <IconCheck v-if="copied" :size="13" class="shrink-0" />
                {{ copied ? '已复制' : '复制' }}
              </button>
            </div>
            <p class="mt-0.5 leading-5 text-ink-3">
              {{ landingRow.note ? `放哪：${landingRow.note}` : '没写放在哪' }}<template v-if="landingRow.utm"> · 带平台参数</template><template v-else> · 通用主链接</template>
            </p>
          </div>

          <p v-if="preview.platform === '小红书'" class="mt-2 text-center text-sm tabular-nums"
            :class="preview.bodyChars > 1000 ? 'text-red-600' : 'text-ink-3'">
            正文 {{ preview.bodyChars }} / 1000 字
          </p>
        </div>
      </div>
    </div>
  </DetailModal>
</template>
