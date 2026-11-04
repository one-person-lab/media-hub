import { onBeforeUnmount, onMounted, ref } from 'vue'

/** JS 逐帧动画（滚动数字、描线）自己判；CSS 那条由 style.css 的全局规则兜住 */
export function useReducedMotion() {
  const reduce = ref(typeof window === 'undefined' ? false : window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  let mql: MediaQueryList | null = null
  const on = (e: MediaQueryListEvent) => (reduce.value = e.matches)
  onMounted(() => {
    mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduce.value = mql.matches
    mql.addEventListener('change', on)
  })
  onBeforeUnmount(() => mql?.removeEventListener('change', on))
  return reduce
}
