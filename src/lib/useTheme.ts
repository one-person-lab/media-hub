import { computed, ref, watch } from 'vue'

export type ThemeId = 'pro' | 'neo' | 'dark'

export interface ThemeMeta {
  id: ThemeId
  label: string
  hint: string
}

/** 三套皮肤只换令牌（见 style.css 的主题变量组），数据与布局不动 */
export const THEMES: ThemeMeta[] = [
  { id: 'dark', label: '暗色', hint: '默认' },
  { id: 'pro', label: '专业', hint: '浅色基准' },
  { id: 'neo', label: '经典', hint: '原风格' },
]

/** 没存过主题时走这一套：平台默认暗色 */
const DEFAULT_THEME: ThemeId = 'dark'

const KEY = 'media-hub-theme'
/** 切回浅色时回到哪一套：顶栏只分深浅，经典这套不能让深浅开关覆盖掉 */
const LIGHT_KEY = 'media-hub-theme-light'

const lastLight = () => ((localStorage.getItem(LIGHT_KEY) as ThemeId) || 'pro')

const current = ref<ThemeId>((localStorage.getItem(KEY) as ThemeId) || DEFAULT_THEME)

// 老用户存的浅色主题可能还没写进 LIGHT_KEY，先补一次，免得第一次切回来变成默认
if (current.value !== 'dark' && !localStorage.getItem(LIGHT_KEY)) localStorage.setItem(LIGHT_KEY, current.value)

// index.html 的内联脚本已在首屏绘制前挂过主题；这里再兜一次（静态站形态或键被清掉时）
if (typeof document !== 'undefined') document.documentElement.dataset.theme = current.value

watch(current, (v) => {
  localStorage.setItem(KEY, v)
  if (v !== 'dark') localStorage.setItem(LIGHT_KEY, v)
  document.documentElement.dataset.theme = v
})

const isDark = computed(() => current.value === 'dark')

/** 模块级单例：设置面板切换，全站即时生效 */
export function useTheme() {
  return {
    current,
    themes: THEMES,
    isDark,
    set: (t: ThemeId) => {
      current.value = t
    },
    toggleMode: () => {
      current.value = isDark.value ? lastLight() : 'dark'
    },
  }
}
