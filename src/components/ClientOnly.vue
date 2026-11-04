<script setup lang="ts">
import { clientDownloadUrl } from '../data/store'
import { Download as IconDownload } from 'lucide-vue-next'

/** 远程模式下顶掉执行类按钮的那一颗：这一份跑在没有本机浏览器桥的机器上，动作做不了，
 *  但人要的是「那我该去哪做」，所以它同时是下载地址。本机模式不渲染这个。 */
defineProps<{ what: string }>()
</script>

<template>
  <a
    class="chip inline-flex shrink-0 items-center gap-1 !py-1 text-sm text-ink-2"
    :href="clientDownloadUrl || undefined"
    :target="clientDownloadUrl ? '_blank' : undefined"
    rel="noopener"
    :title="`${what}在桌面客户端里做`"
  >
    <IconDownload :size="13" />
    去桌面端做<span v-if="clientDownloadUrl"> · 下载</span>
  </a>
</template>
