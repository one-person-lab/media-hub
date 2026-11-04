<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ComputedRef } from 'vue'

/** 全站页头只有三段：标题（+计数）→ 读数或时间范围 → 右侧动作。
 *  没有副说明位：解释「这一屏是干什么的」不属于界面，要留后果就放进 #meta 的短读数（2026-10-28 密度规范）。
 *  没有站内页签的站，这一行自己钉在内容列顶上（右上角的深浅/账号浮在同一行右侧）；
 *  有页签的站钉的是页签行——选中的那一项就是这一页的名字，不再多钉一行。 */
defineProps<{ title: string; count?: number | string }>()

const sticky = inject<ComputedRef<boolean>>('headerSticky', computed(() => true))

/** 把自身高度报给 --page-header-h：知识库左栏、日历左栏这类页面内的吸顶列要贴着它下沿停住 */
const bar = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
onMounted(() => {
  const el = bar.value
  if (!el) return
  const write = () => document.documentElement.style.setProperty('--page-header-h', `${el.offsetHeight}px`)
  write()
  ro = new ResizeObserver(write)
  ro.observe(el)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  document.documentElement.style.removeProperty('--page-header-h')
})
</script>

<template>
  <header
    ref="bar"
    class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
    :class="sticky ? 'sticky top-0 z-30 -mx-8 bg-canvas px-8 pb-4 pt-4' : 'mb-6'"
  >
    <div class="min-w-0">
      <h1 class="flex items-baseline gap-2 text-h1 text-ink">
        {{ title }}
        <span v-if="count !== undefined" class="text-sm font-normal text-ink-3 tabular-nums">{{ count }}</span>
      </h1>
      <div v-if="$slots.meta" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-aux text-ink-3">
        <slot name="meta" />
      </div>
    </div>
    <div class="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2" :class="sticky && 'pr-[116px]'">
      <slot name="actions" />
    </div>
  </header>
</template>
