<script setup lang="ts">
/** 发布前检查面板：底栏那颗按钮点开它，不常驻右栏页签。
 *  待处理按「内容 / 平台规则 / 排期」分组摆出来，已通过项折起来——六条全绿等于没信息。 */
import { computed } from 'vue'
import { CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck, X as IconX } from 'lucide-vue-next'

interface CheckItem {
  level: 'block' | 'warn' | 'ok'
  label: string
}
interface CheckGroup {
  label: string
  items: CheckItem[]
}

const props = defineProps<{ groups: CheckGroup[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const passed = computed(() => props.groups.flatMap((g) => g.items.filter((c) => c.level === 'ok')))
const pendingGroups = computed(() =>
  props.groups.map((g) => ({ label: g.label, items: g.items.filter((c) => c.level !== 'ok') })).filter((g) => g.items.length),
)
const todoCount = computed(() => pendingGroups.value.reduce((n, g) => n + g.items.length, 0))
</script>

<template>
  <Teleport to="body">
    <div v-dialog="'发布前检查'" class="modal">
      <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
      <div class="card modal-card relative z-10 max-w-xl">
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div class="flex items-center gap-2 text-sm font-medium">
            <IconCircleCheck :size="15" class="text-green-700" />
            发布前检查
          </div>
          <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
            <IconX :size="15" />
          </button>
        </div>

        <div class="modal-body space-y-4 p-5">
          <p v-if="!todoCount" class="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm font-medium leading-5">
            <IconCircleCheck :size="15" class="shrink-0 text-green-700" />
            要发出去的东西都齐了。
          </p>

          <div v-for="g in pendingGroups" :key="g.label">
            <div class="mb-1.5 text-sm font-medium text-ink-2">{{ g.label }}</div>
            <ul class="flex flex-col gap-1">
              <li
                v-for="c in g.items"
                :key="c.label"
                class="flex items-start gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm leading-5"
              >
                <IconCircleAlert :size="15" class="mt-0.5 shrink-0"
                  :class="c.level === 'block' ? 'text-red-600' : 'text-amber-600'" />
                <span class="min-w-0 flex-1" :class="c.level === 'block' ? 'text-red-700' : 'font-medium'">
                  {{ c.label }}
                </span>
              </li>
            </ul>
          </div>

          <details v-if="passed.length">
            <summary class="cursor-pointer text-sm leading-6 text-ink-3">已通过 {{ passed.length }} 项</summary>
            <ul class="mt-1 flex flex-col gap-0.5">
              <li v-for="c in passed" :key="c.label" class="flex items-center gap-2 text-sm leading-5 text-ink-3">
                <IconCircleCheck :size="13" class="shrink-0 text-green-700" />
                {{ c.label }}
              </li>
            </ul>
          </details>
        </div>
      </div>
    </div>
  </Teleport>
</template>
