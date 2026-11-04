<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTheme } from '../lib/useTheme'
import { authOpen, useAuth } from '../lib/useAuth'
import { loginViaGithub, loginViaGoogle, loginViaMail } from '../data/store'
import { CircleUser as IconCircleUser, LogOut as IconLogOut, Moon as IconMoon, Sun as IconSun, User as IconUser } from 'lucide-vue-next'

/**
 * 顶栏右侧那一块：深浅两档 + 我的账号。
 * 两件事都是从设置面板/侧栏里提上来的，提上来就在同一处删掉，不留第二个入口。
 * 三套配色的选择在设置里，这里只分深浅。
 */
const { isDark, toggleMode } = useTheme()
const { me, logout } = useAuth()

const accountOpen = ref(false)

/** GitHub 那边把邮箱设成私有的号只有 login 可显示，别在顶栏留一个空头像位 */
const who = computed(() => me.value?.email || me.value?.name || '')
const since = computed(() => (me.value?.createdAt || '').slice(0, 10))

/** 登出后整页重取：门后那份数据这时候已经取不到了，留着旧屏等于让人以为还在自己账号里 */
async function signOut() {
  accountOpen.value = false
  await logout()
  location.reload()
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-3">
    <button
      class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      :aria-label="isDark ? '切到浅色' : '切到深色'"
      :title="isDark ? '切到浅色' : '切到深色'"
      @click="toggleMode"
    >
      <component :is="isDark ? IconMoon : IconSun" :size="18" />
    </button>

    <div class="relative">
      <button
        v-if="me"
        class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:bg-surface hover:text-ink"
        :aria-expanded="accountOpen"
        aria-haspopup="menu"
        :aria-label="me.email"
        :title="me.email"
        @click="accountOpen = !accountOpen"
      >
        <IconCircleUser :size="18" />
      </button>
      <!-- 这颗钮按「这台机器有没有登录法」决定摆不摆，不按演示数据摆：
           纯静态托管那份多半压根没有后台（点了只会报错），服务器上的游客却是要在这登进来的 -->
      <!-- 未登录也占成同一个圆，这一格始终是头像位；登录靠里面的灰人形轮廓 + 提示语说清 -->
      <button
        v-else-if="loginViaGithub || loginViaGoogle || loginViaMail"
        class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface-2 text-ink-3 transition-colors hover:bg-surface hover:text-ink-2"
        aria-label="登录"
        title="登录"
        @click="authOpen = true"
      >
        <IconUser :size="18" />
      </button>
      <template v-if="accountOpen && me">
        <div class="fixed inset-0 z-20" @click="accountOpen = false" />
        <div class="absolute right-0 top-full z-30 mt-1 flex w-[15rem] flex-col gap-1 rounded-lg border border-line bg-surface p-3 shadow-neo-lg">
          <p class="truncate text-sm font-medium text-ink" :title="who">{{ who }}</p>
          <p v-if="since" class="text-xs text-ink-3">注册于 {{ since }}</p>
          <span class="my-1 h-px bg-line" aria-hidden />
          <button class="btn-ghost !justify-start !px-2 !py-1.5 text-sm" @click="signOut">
            <IconLogOut :size="15" class="shrink-0" />
            退出登录
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
