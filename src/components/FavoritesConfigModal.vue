<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { PLATFORM_META, holdSelfWrite, setHoldAutoRefresh, lastFavoriteAt } from '../data/store'
import { CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, LoaderCircle as IconLoaderCircle, Plus as IconPlus, X as IconX } from 'lucide-vue-next'
import PlatformLogo from './PlatformLogo.vue'
import SyncButton from './SyncButton.vue'

/** 灵感库的采集配置弹窗：搬运只认这份名单（小红书叫专辑、抖音叫收藏夹），名单改完就地同步也在这按。
 *  保存写回 config/favorites.json。 */
const emit = defineEmits<{ (e: 'close'): void }>()

const loading = ref(true)
const saving = ref(false)
const msg = ref('')
const msgOk = ref(true)
const supported = ref<string[]>([])
const form = ref<{ albums: string[]; platforms: string[] }>({ albums: [], platforms: [] })
const saved = ref('')
const nameInput = ref('')

/** 名单没落盘就不给同步：跑起来用的是 config/favorites.json，不是屏幕上这份没保存的 */
const dirty = computed(() => JSON.stringify(form.value) !== saved.value)

onMounted(async () => {
  try {
    const o = await (await fetch('/__favorites-config')).json()
    if (!o.ok) throw new Error(o.error || '读取失败')
    supported.value = o.supportedPlatforms || []
    form.value = { albums: o.config.albums || [], platforms: o.config.platforms || [] }
    saved.value = JSON.stringify(form.value)
  } catch (e) {
    msg.value = `读取失败：${(e as Error).message}`
    msgOk.value = false
  } finally {
    loading.value = false
  }
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
/** 同步一跑十几分钟，中途别人写一条笔记就会广播重建：不挂住刷新，弹层在半道上被刷掉 */
const syncing = ref(false)
watch(syncing, (on) => setHoldAutoRefresh(on))

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (syncing.value) setHoldAutoRefresh(false)
})

const platLabel = (p: string) => PLATFORM_META[p]?.label ?? p

/** 平台是开关不是单选：两个平台可以同时搬，也可以只搬一个 */
function togglePlatform(p: string) {
  form.value.platforms = form.value.platforms.includes(p)
    ? form.value.platforms.filter((x) => x !== p)
    : [...form.value.platforms, p]
}

/** 专辑名 chips：× 删、输入框加。名字要和平台上一字不差，去重在服务端做 */
function addAlbum() {
  const t = nameInput.value.trim()
  if (!t) return
  if (!form.value.albums.includes(t)) form.value.albums.push(t)
  nameInput.value = ''
}
function removeAlbum(name: string) {
  form.value.albums = form.value.albums.filter((a) => a !== name)
}

const canSave = computed(() => !saving.value && !loading.value && form.value.albums.length > 0 && form.value.platforms.length > 0)

async function save() {
  saving.value = true
  msg.value = ''
  try {
    const o = await (await fetch('/__favorites-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albums: form.value.albums, platforms: form.value.platforms }),
    })).json()
    if (!o.ok) throw new Error(o.error || '保存失败')
    saved.value = JSON.stringify(form.value)
    msg.value = '已保存'
    msgOk.value = true
    // 服务端写完会重建广播：不开窗，弹层会被整页刷掉；hold 住让页面就地换名单
    holdSelfWrite()
  } catch (e) {
    msg.value = `保存失败：${(e as Error).message}`
    msgOk.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-dialog="'采集配置'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
    <div class="card modal-card relative z-10 max-w-xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 class="text-[17px] font-semibold text-ink">采集配置</h2>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>

      <div class="modal-body flex flex-col gap-6 px-5 py-5">
        <p v-if="loading" class="text-sm text-ink-2">读取中…</p>

        <template v-else>
          <!-- 采集平台：搬运翻哪几个号的收藏 -->
          <section class="flex flex-col gap-2.5">
            <h3 class="text-section text-ink">平台</h3>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="p in supported"
                :key="p"
                class="seg"
                :class="form.platforms.includes(p) && 'is-selected'"
                @click="togglePlatform(p)"
              >
                <PlatformLogo :platform="platLabel(p)" :size="14" />
                {{ platLabel(p) }}
              </button>
            </div>
          </section>

          <!-- 专辑名单：两边共用一份，按名字原样匹配 -->
          <section class="flex flex-col gap-2.5">
            <div class="flex items-baseline gap-2">
              <h3 class="text-section text-ink">收藏专辑</h3>
              <span class="ml-auto font-metric text-aux tabular-nums text-ink-3">{{ form.albums.length }}</span>
            </div>
            <div class="rounded-inset border border-line bg-surface-2/50 p-3">
              <div class="flex flex-wrap gap-1.5">
                <span v-for="a in form.albums" :key="a" class="chip !pr-1.5">
                  {{ a }}
                  <button class="ml-0.5 font-medium text-ink-3 hover:text-red-600" title="删掉这个专辑" @click="removeAlbum(a)">×</button>
                </span>
                <span v-if="!form.albums.length" class="text-sm text-ink-3">还没有专辑名</span>
              </div>
              <div class="mt-3 flex gap-2">
                <input
                  v-model="nameInput"
                  class="input min-w-0 flex-1 !px-3 !py-1.5"
                  placeholder="回车添加"
                  @keyup.enter="addAlbum"
                />
                <button class="btn btn-ghost shrink-0 !px-2.5" :disabled="!nameInput.trim()" @click="addAlbum">
                  <IconPlus :size="13" />
                  添加
                </button>
              </div>
            </div>
          </section>

          <!-- 同步：这一轮翻收藏夹搬回几条，图标按下去就跑 -->
          <section class="flex flex-col gap-2.5">
            <h3 class="text-section text-ink">同步</h3>
            <div class="flex w-fit items-center gap-1 rounded-inset border border-line bg-surface-2/50 px-1.5 py-1">
              <SyncButton quiet reading :disabled="dirty" task="favorites" :at="lastFavoriteAt" run-label="同步收藏" @busy="syncing = $event" />
            </div>
          </section>
        </template>
      </div>

      <div v-if="!loading" class="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-5 py-3">
        <span v-if="msg" class="flex min-w-0 items-center gap-1.5 text-aux font-medium" :class="msgOk ? 'text-success' : 'text-red-600'">
          <component :is="msgOk ? IconCircleCheck : IconCircleAlert" :size="13" class="shrink-0" />
          <span class="min-w-0 truncate">{{ msg }}</span>
        </span>
        <button class="btn btn-primary ml-auto shrink-0 !px-3.5 !py-1.5" :disabled="!canSave" @click="save">
          <IconLoaderCircle v-if="saving" :size="13" class="animate-spin" />
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
