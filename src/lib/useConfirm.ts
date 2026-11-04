import { ref } from 'vue'

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
}

export const confirmState = ref<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)

/** 替代原生 confirm()：弹工作台风格的确认卡片，Promise<boolean> 用法一致 */
export function useConfirm() {
  const confirm = (opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      confirmState.value?.resolve(false)
      confirmState.value = { ...opts, resolve }
    })
  const settle = (ok: boolean) => {
    const c = confirmState.value
    confirmState.value = null
    c?.resolve(ok)
  }
  return { confirm, settle }
}
