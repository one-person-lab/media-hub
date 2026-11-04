<script setup lang="ts">
/** bento 大数字：值变了从当前读数滚过去，不闪回 0；系统要求减弱动效时直接落终值 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { useReducedMotion } from '../lib/useReducedMotion'
import { easeOut } from '../lib/bentoPath'

const props = withDefaults(
  defineProps<{ value: number; prefix?: string; digits?: number; duration?: number }>(),
  { prefix: '', digits: 0, duration: 1100 },
)

const shown = ref(0)
const reduce = useReducedMotion()
let raf = 0

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: props.digits, maximumFractionDigits: props.digits })

function run(to: number) {
  cancelAnimationFrame(raf)
  if (reduce.value || !Number.isFinite(to)) {
    shown.value = to
    return
  }
  const from = shown.value
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / props.duration)
    shown.value = from + (to - from) * easeOut(t)
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

watch(() => props.value, (v) => run(v), { immediate: true })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <span class="tabular-nums">{{ prefix }}{{ fmt(shown) }}</span>
</template>
