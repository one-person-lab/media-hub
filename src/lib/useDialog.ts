import type { Directive } from 'vue'

/**
 * 弹层语义与焦点收纳：`v-dialog="'弹层标题'"` 挂在 .modal 遮罩根节点上。
 * 作用：role/aria-modal/aria-label + Tab 收在面板内 + 关闭后焦点还回触发元素。
 * 嵌套弹层（确认框浮在设置层上）按 closest('.modal') 判归属，外层不抢内层的焦点。
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(el: HTMLElement) {
  // 不用 offsetParent 判可见：遮罩本身是 position:fixed，子元素的 offsetParent 不可靠
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.getClientRects().length > 0)
}

function trap(e: KeyboardEvent) {
  if (e.key !== 'Tab') return
  const el = e.currentTarget as HTMLElement
  const active = document.activeElement as HTMLElement | null
  if (active && active.closest('.modal') !== el) return
  const items = focusables(el)
  if (!items.length) {
    e.preventDefault()
    el.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && (active === first || active === el)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || active === el)) {
    e.preventDefault()
    first.focus()
  }
}

type DialogEl = HTMLElement & { __returnFocus?: HTMLElement | null }

export const vDialog: Directive<DialogEl, string | undefined> = {
  mounted(el, binding) {
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('tabindex', '-1')
    if (binding.value) el.setAttribute('aria-label', binding.value)
    el.__returnFocus = document.activeElement as HTMLElement | null
    el.addEventListener('keydown', trap)
    // 焦点给面板本身而不是第一个按钮，避免进弹层就停在「删除」上
    requestAnimationFrame(() => el.focus())
  },
  updated(el, binding) {
    if (binding.value && binding.value !== binding.oldValue) el.setAttribute('aria-label', binding.value)
  },
  unmounted(el) {
    el.removeEventListener('keydown', trap)
    if (el.__returnFocus?.isConnected) el.__returnFocus.focus()
  },
}
