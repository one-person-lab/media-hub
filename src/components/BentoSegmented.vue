<script setup lang="ts">
/** 分段控件：指示块跟着选项滑，选中态仍然是「浅底深字」那套语言，只是有了位移 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PlatformLogo from './PlatformLogo.vue'

const props = defineProps<{
  items: { id: string; label: string; logo?: string }[]
  modelValue: string
  label: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', id: string): void }>()

const btns = ref<(HTMLButtonElement | null)[]>([])
const thumb = ref({ x: 0, w: 0 })
const idx = computed(() => Math.max(0, props.items.findIndex((i) => i.id === props.modelValue)))

async function measure() {
  await nextTick()
  const b = btns.value[idx.value]
  if (b) thumb.value = { x: b.offsetLeft, w: b.offsetWidth }
}

watch(idx, measure)
watch(() => props.items, measure)
onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => window.removeEventListener('resize', measure))
</script>

<template>
  <div
    role="tablist"
    :aria-label="label"
    class="relative inline-grid h-[30px] auto-cols-fr grid-flow-col rounded-[10px] border border-line bg-surface-2 p-[2px]"
  >
    <div
      class="pointer-events-none absolute bottom-[2px] top-[2px] left-[2px] rounded-[8px] border border-line bg-surface shadow-neo-sm transition-[transform,width] duration-300 [transition-timing-function:cubic-bezier(.2,.9,.25,1)]"
      :style="{ width: `${thumb.w}px`, transform: `translateX(${Math.max(thumb.x - 2, 0)}px)` }"
    />
    <button
      v-for="(it, i) in items"
      :key="it.id"
      :ref="(el) => (btns[i] = el as HTMLButtonElement | null)"
      role="tab"
      type="button"
      :aria-selected="i === idx"
      class="relative z-10 flex items-center justify-center gap-1.5 rounded-[8px] px-3 text-xs font-medium tracking-[-0.01em] text-ink-2 transition-colors"
      :class="i === idx ? '!text-ink' : ''"
      @click="emit('update:modelValue', it.id)"
    >
      <PlatformLogo v-if="it.logo" :platform="it.logo" :size="14" />
      {{ it.label }}
    </button>
  </div>
</template>
