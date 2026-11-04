<script setup lang="ts">
/** 账号行首的那张脸：读到头像就摆账号本人的头像，平台 logo 缩成左下角标做区分
 *  （同平台两个号同名时，光看名字分不出是哪一行）。
 *  没读到头像（这平台的后台报不出身份）或图文件丢了，一律回落平台 logo——不留破图。 */
import { computed, ref, watch } from 'vue'
import PlatformLogo from './PlatformLogo.vue'

const props = withDefaults(defineProps<{ src?: string; platform: string; size?: number }>(), { size: 36 })
const broken = ref(false)
watch(() => props.src, () => { broken.value = false })
const photo = computed(() => (props.src && !broken.value ? props.src : ''))
</script>

<template>
  <span class="relative inline-block shrink-0" :style="{ width: `${size}px`, height: `${size}px` }">
    <img
      v-if="photo"
      :src="photo"
      :alt="`${platform}账号头像`"
      class="h-full w-full rounded-full object-cover"
      @error="broken = true"
    >
    <PlatformLogo v-if="!photo" :platform="platform" :size="size" />
    <span v-if="photo" class="absolute -bottom-1 -left-1 rounded-full bg-surface p-[2px]">
      <PlatformLogo :platform="platform" :size="Math.max(12, Math.round(size * 0.34))" />
    </span>
  </span>
</template>
