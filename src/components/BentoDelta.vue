<script setup lang="ts">
/** 涨跌只报事实：给不出环比（上周期基数不全）就退成绝对差，两者都没有就不占位。
 *  百分比由 store 的 ratio() 算，这里不负责判断能不能算。 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{ pct?: number | null; diff?: number | null; digits?: number }>(),
  { pct: null, diff: null, digits: 1 },
)

const text = computed(() => {
  if (props.pct != null) return `${Math.abs(props.pct).toFixed(props.digits)}%`
  if (props.diff != null) return Math.abs(props.diff).toLocaleString('en-US')
  return ''
})
const flat = computed(() => (props.pct ?? props.diff) === 0)
const up = computed(() => (props.pct ?? props.diff ?? 0) >= 0)
const tone = computed(() => (flat.value ? 'text-ink-3' : up.value ? 'text-green-700' : 'text-red-600'))
</script>

<template>
  <span v-if="text" class="inline-flex items-center gap-[3px] font-semibold" :class="tone">
    <svg
      v-if="!flat"
      viewBox="0 0 12 12"
      class="size-[11px] shrink-0"
      :class="up ? '' : 'rotate-180'"
      aria-hidden="true"
    >
      <path d="M6 10.5V1.5M2 5.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    {{ text }}
  </span>
</template>
