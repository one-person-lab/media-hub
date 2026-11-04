import { onBeforeUnmount, ref } from 'vue'

/** SVG 折线要按真实像素画才不糊描边，所以尺寸来自容器而不是 viewBox 拉伸。
 *  绑法用 :ref="setEl"：模板里的字符串 ref 在类型层看不见引用，会被 noUnusedLocals 判成死代码。 */
export function useSize() {
  const size = ref({ w: 0, h: 0 })
  let ro: ResizeObserver | null = null
  let observed: HTMLElement | null = null

  const setEl = (el: unknown) => {
    if (!(el instanceof HTMLElement) || el === observed) return
    ro?.disconnect()
    observed = el
    ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      if (w !== size.value.w || h !== size.value.h) size.value = { w, h }
    })
    ro.observe(el)
  }

  onBeforeUnmount(() => ro?.disconnect())
  return { setEl, size }
}
