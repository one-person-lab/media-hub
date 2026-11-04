<script setup lang="ts">
/** 封面卡角标：卡面只留图标，名字进 title 由鼠标悬浮给出。
 *  左上那颗只回答「这条还差什么」——差什么都写在悬浮文字里，卡面不铺字。 */
withDefaults(defineProps<{
  /** 悬浮文字 */
  label: string
  /** left = 状态，right = 形态 */
  at?: 'left' | 'right'
  /** warn = 还差东西 */
  tone?: 'ink' | 'warn'
}>(), { at: 'left', tone: 'ink' })
</script>

<template>
  <span
    class="absolute top-3 grid h-6 w-6 place-items-center rounded-full bg-[rgba(17,14,23,0.55)] backdrop-blur-[3px]"
    :class="[
      at === 'left' ? 'left-3' : 'right-3',
      tone === 'warn'
        ? 'border border-[rgba(252,211,77,0.32)] text-amber-300'
        : 'border border-[rgba(245,251,255,0.2)] text-[#F5FBFF]',
    ]"
    :title="label"
  >
    <slot />
  </span>
</template>
