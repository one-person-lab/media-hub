<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { NavChild } from '../lib/nav'

const props = defineProps<{ items: NavChild[]; current: string }>()
defineEmits<{ (e: 'select', id: string): void }>()

/** 把自身高度报给 --station-tabs-h：页面自己的吸顶条（灵感库的搜索行、日历左栏…）
 *  要贴着它下沿停住。页签在窄屏会换行、高度会变，写死偏移就会在两条栏之间露出一道会动的缝。 */
const bar = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
onMounted(() => {
  const el = bar.value
  if (!el) return
  const write = () => document.documentElement.style.setProperty('--station-tabs-h', `${el.offsetHeight}px`)
  write()
  ro = new ResizeObserver(write)
  ro.observe(el)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  document.documentElement.style.removeProperty('--station-tabs-h')
})
</script>

<template>
  <!-- 站内页签（版式见 style.css 的 .utab）：无底无框，选中 = 字变亮变粗 + 字下一条强调色短杠。
       钉在内容列顶上，铺满内容列、底色走画布令牌，内容从它底下滚过去不露馅；
       右上角的深浅/账号浮在这一行的右侧，所以这一行右侧让出 76px，换行时不被压住。 -->
  <div ref="bar" class="sticky top-0 z-40 -mx-8 bg-canvas px-8 pb-3 pt-4">
    <div class="flex flex-wrap items-center gap-x-8 gap-y-3 pr-[76px]">
      <button
        v-for="t in items"
        :key="t.id"
        class="utab"
        :class="t.id === props.current ? 'is-active' : ''"
        @click="$emit('select', t.id)"
      >
        <span>{{ t.label }}</span>
        <span class="utab-mark" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
