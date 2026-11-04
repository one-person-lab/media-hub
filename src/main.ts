import { createApp } from 'vue'
import './style.css'
import { vDialog } from './lib/useDialog'
import { installLoginGuard } from './lib/useAuth'

/**
 * App.vue 静态依赖 data/store.ts，那里有顶层 await：数据没读到就整条模块链 reject、
 * App 从不挂载。错误卡由 index.html 的内联脚本画（服务连不上时本模块压根不会执行），
 * 这里只负责：挂载成功打标，让看门狗别再插手；挂载失败即呼叫错误卡。
 */
// 要在 App 之前装：首屏那几趟请求也得走这道判断
installLoginGuard()

import('./App.vue')
  .then((m) => {
    const app = createApp(m.default)
    app.directive('dialog', vDialog)
    app.mount('#app')
    document.getElementById('app')!.dataset.bootHandled = '1'
  })
  .catch(() => (window as any).__bootError?.())
