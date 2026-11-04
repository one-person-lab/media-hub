import { ref } from 'vue'

/** 轻提示的三种语气：成 / 败 / 只是说一句。info 不画图标，免得满屏图标 */
export type ToastKind = 'ok' | 'fail' | 'info'

const toastMsg = ref('')
const toastKind = ref<ToastKind>('info')
let timer: ReturnType<typeof setTimeout> | undefined

/** 全局轻提示：右下角浮层，2.6 秒自动消失 */
export function useToast() {
  const toast = (m: string, kind: ToastKind = 'info') => {
    toastMsg.value = m
    toastKind.value = kind
    clearTimeout(timer)
    timer = setTimeout(() => (toastMsg.value = ''), 2600)
  }
  return { toast, toastMsg, toastKind }
}
