<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhX, PhCopy, PhCheck } from '@phosphor-icons/vue'
import { target, site, generatedAt } from '../data/store'

const props = defineProps<{ panel: 'config' | 'data' }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tab = ref<'config' | 'data'>(props.panel)
const copied = ref('')

async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
    setTimeout(() => { if (copied.value === key) copied.value = '' }, 1500)
  } catch {}
}

const TYPE_LABEL: Record<string, string> = {
  app: 'APP',
  website: '网站',
  shop: '店铺',
  course: '课程',
  service: '服务',
}

const generatedText = computed(() => {
  try {
    return new Date(generatedAt).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return generatedAt
  }
})

const FILE_LABEL: Record<string, string> = {
  articles: '排期文章',
  readings: '参考资料',
  quotes: '金句',
  snapshots: '平台快照',
  benchmarks: '对标账号',
  covers: '封面参考',
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/35 p-6 pt-[8vh]" @click.self="emit('close')">
    <div class="neo-card w-full max-w-2xl">
      <!-- 头部：标题 + 关闭 -->
      <div class="flex items-center justify-between border-b-2 border-black px-5 py-3">
        <div class="flex items-center gap-2">
          <button
            class="rounded-[6px] border-2 px-3 py-1 text-sm font-black transition-colors"
            :class="tab === 'config' ? 'border-black bg-neo-yellow' : 'border-transparent hover:bg-neutral-100'"
            @click="tab = 'config'"
          >
            配置
          </button>
          <button
            class="rounded-[6px] border-2 px-3 py-1 text-sm font-black transition-colors"
            :class="tab === 'data' ? 'border-black bg-neo-blue' : 'border-transparent hover:bg-neutral-100'"
            @click="tab = 'data'"
          >
            数据
          </button>
        </div>
        <button class="neo-btn px-2 py-1" title="关闭" @click="emit('close')">
          <PhX :size="15" weight="bold" />
        </button>
      </div>

      <!-- ========== 配置 ========== -->
      <div v-if="tab === 'config'" class="space-y-4 p-5">
        <div v-if="!target" class="text-sm text-neutral-500">
          没有读到推广对象配置。检查 <code>config/active-target.mjs</code> 是否指向了一个实例文件。
        </div>

        <template v-else>
          <div class="flex items-center gap-2">
            <span class="neo-chip status-ready">{{ TYPE_LABEL[target.type] || target.type }}</span>
            <span class="text-lg font-black">{{ target.brandName }}</span>
          </div>

          <div class="space-y-3 text-sm">
            <div>
              <div class="mb-1 text-xs font-bold text-neutral-500">账号定位</div>
              <div>{{ target.accountPositioning }}</div>
            </div>

            <div>
              <div class="mb-1 text-xs font-bold text-neutral-500">产品视角</div>
              <ul class="list-inside list-disc space-y-0.5">
                <li v-for="p in target.productPerspective" :key="p">{{ p }}</li>
              </ul>
            </div>

            <div class="flex flex-wrap gap-4">
              <div>
                <div class="mb-1 text-xs font-bold text-neutral-500">语气</div>
                <div>{{ target.tone }}</div>
              </div>
              <div>
                <div class="mb-1 text-xs font-bold text-neutral-500">署名</div>
                <div>{{ target.signature }}</div>
              </div>
              <div>
                <div class="mb-1 text-xs font-bold text-neutral-500">品牌标签</div>
                <div>{{ target.brandTag }}</div>
              </div>
            </div>

            <div>
              <div class="mb-1 text-xs font-bold text-neutral-500">内容主题</div>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="t in target.topics" :key="t" class="neo-chip status-creating">{{ t }}</span>
              </div>
            </div>

            <div>
              <div class="mb-1 text-xs font-bold text-neutral-500">运营手册</div>
              <div class="flex items-center gap-2">
                <code class="flex-1 truncate rounded bg-neutral-100 px-2 py-1 text-xs">{{ target.handbookPath }}</code>
                <button class="neo-btn px-2 py-1" :title="'复制路径'" @click="copy(target.handbookPath, 'hb')">
                  <PhCheck v-if="copied === 'hb'" :size="13" weight="bold" />
                  <PhCopy v-else :size="13" weight="bold" />
                </button>
              </div>
            </div>
          </div>

          <div class="rounded-[6px] border-2 border-dashed border-neutral-300 p-3 text-xs leading-6 text-neutral-600">
            换推广对象：复制 <code>config/targets/example.mjs</code> 改成你的产品，
            再改 <code>config/active-target.mjs</code> 里那一行 import。引擎代码不用动。
          </div>
        </template>
      </div>

      <!-- ========== 数据 ========== -->
      <div v-else class="space-y-4 p-5">
        <div v-if="!site" class="text-sm text-neutral-500">没有读到站点信息。</div>
        <template v-else>
          <div>
            <div class="mb-1 text-xs font-bold text-neutral-500">内容库位置</div>
            <div class="flex items-center gap-2">
              <code class="flex-1 truncate rounded bg-neutral-100 px-2 py-1 text-xs">{{ site.contentDir }}</code>
              <button class="neo-btn px-2 py-1" title="复制路径" @click="copy(site.contentDir, 'dir')">
                <PhCheck v-if="copied === 'dir'" :size="13" weight="bold" />
                <PhCopy v-else :size="13" weight="bold" />
              </button>
            </div>
            <div class="mt-1 text-xs text-neutral-500">
              工作台不连数据库——这些 markdown 就是全部数据。改完跑 <code>npm run gen:data</code>。
            </div>
          </div>

          <div>
            <div class="mb-2 text-xs font-bold text-neutral-500">已扫描</div>
            <div class="grid grid-cols-3 gap-2 text-sm">
              <div v-for="(n, k) in site.fileCount" :key="k" class="rounded-[6px] border-2 border-black px-3 py-2">
                <div class="text-lg font-black">{{ n }}</div>
                <div class="text-xs text-neutral-500">{{ FILE_LABEL[k] || k }}</div>
              </div>
            </div>
            <div class="mt-2 text-xs text-neutral-500">生成于 {{ generatedText }}</div>
          </div>

          <div>
            <div class="mb-1 text-xs font-bold text-neutral-500">AI 模型</div>
            <div class="space-y-1 text-sm">
              <div class="flex items-center gap-2">
                <span class="neo-chip" :class="site.llm.keyConfigured ? 'status-published' : 'status-failed'">
                  {{ site.llm.keyConfigured ? 'Key 已配置' : 'Key 未配置' }}
                </span>
                <span class="text-xs text-neutral-500">任何兼容 OpenAI 协议的服务都能接</span>
              </div>
              <div><span class="text-neutral-500">模型：</span><code class="text-xs">{{ site.llm.model }}</code></div>
              <div class="truncate"><span class="text-neutral-500">端点：</span><code class="text-xs">{{ site.llm.baseUrl }}</code></div>
              <div><span class="text-neutral-500">Key 路径：</span><code class="text-xs">{{ site.llm.keyPath }}</code></div>
            </div>
          </div>

          <div class="rounded-[6px] border-2 border-dashed border-neutral-300 p-3 text-xs leading-6 text-neutral-600">
            平台数据靠 <code>npm run collect</code> 从创作者后台采集（正则按中文标签取值，不依赖 CSS 类名）。
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
