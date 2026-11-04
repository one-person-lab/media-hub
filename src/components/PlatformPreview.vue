<script setup lang="ts">
/** 右栏：这一版发出去在平台里长什么样。照各平台后台的预览栏做——手机壳里是真图、真标题、真文案、真话题，
 *  不摆假头像、不摆假点赞数：预览只用来核对「读者会看到什么」，不是装饰。 */
import { computed, ref } from 'vue'
import type { Article } from '../data/store'
import { target } from '../data/store'
import { formOf } from '../lib/platformForm'
import { Heart as IconHeart, MessageCircle as IconMessageCircle, Star as IconStar } from 'lucide-vue-next'

const props = defineProps<{ article: Article; platform: string; account?: string }>()

const form = computed(() => formOf(props.platform, props.account))
const card = computed(() => props.article.card)
const pages = computed(() => card.value?.urls ?? [])
const cover = computed(() => pages.value[0] || '')
const videoUrl = computed(() => card.value?.videoUrl || '')
const tabs = computed(() => form.value.preview.tabs)
const tab = ref('')
const cur = computed(() => tab.value || tabs.value[0] || '')
const isCoverTab = computed(() => tabs.value.length > 1 && cur.value.startsWith('封面'))
const who = computed(() => target?.signature || target?.brandName || '')
const bodyLines = computed(() => (props.article.copy || '').split('\n').map((s) => s.trim()).filter(Boolean))
const tagList = computed(() => (props.article.tags || '').split(/\s+/).filter(Boolean))
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <div v-if="tabs.length > 1" class="flex items-center gap-1">
      <button v-for="t in tabs" :key="t" class="seg !px-2.5 !py-1" :class="cur === t ? 'is-selected' : ''" @click="tab = t">
        {{ t }}
      </button>
    </div>
    <p v-else class="text-sm font-medium text-ink-2">{{ tabs[0] }}</p>

    <!-- 手机壳 -->
    <div v-if="form.preview.shell === 'phone'"
      class="mx-auto w-[268px] shrink-0 overflow-hidden rounded-[2.2rem] border-[5px] border-ink-3/70 bg-surface shadow-neo">
      <div v-if="!pages.length && !videoUrl" class="flex h-[300px] flex-col items-center justify-center gap-2 px-4 text-center">
        <p class="text-sm leading-5 text-ink-3">这一版还没有图</p>
      </div>
      <template v-else>
        <div v-if="who" class="flex items-center gap-1.5 px-3 pb-1.5 pt-2.5">
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ who }}</span>
          <span class="text-[11px] text-ink-3">{{ account || platform }}</span>
        </div>

        <video v-if="videoUrl" :src="videoUrl" controls class="block w-full bg-black" />
        <img v-else-if="isCoverTab || !bodyLines.length" :src="cover" class="block w-full" alt="" />
        <template v-else>
          <img :src="cover" class="block w-full" alt="" />
          <div class="flex flex-col gap-1.5 px-3 pb-2 pt-2.5">
            <p class="text-[14px] font-semibold leading-5">{{ article.title }}</p>
            <p v-for="(l, i) in bodyLines.slice(0, 6)" :key="i" class="text-[12px] leading-[18px] text-ink-2">{{ l }}</p>
            <p v-if="bodyLines.length > 6" class="text-[12px] leading-5 text-ink-3">全文共 {{ bodyLines.length }} 段</p>
            <p v-if="tagList.length" class="flex flex-wrap gap-x-1.5 text-[12px] font-medium leading-5 text-accent">
              <span v-for="t in tagList.slice(0, 6)" :key="t">{{ t }}</span>
            </p>
          </div>
        </template>

        <div class="flex items-center gap-2.5 border-t border-line px-3 py-2 text-ink-3">
          <span class="min-w-0 flex-1 truncate text-[11px]">说点什么…</span>
          <IconHeart :size="14" class="shrink-0" />
          <IconStar :size="14" class="shrink-0" />
          <IconMessageCircle :size="14" class="shrink-0" />
        </div>
      </template>
    </div>

    <!-- 公众号：图文消息卡片，不是竖屏手机壳 -->
    <div v-else class="overflow-hidden rounded-xl border border-line bg-surface shadow-neo">
      <div class="flex flex-col gap-2 p-3">
        <p class="text-[15px] font-semibold leading-6">{{ article.title }}</p>
        <p v-if="who" class="text-[12px] text-ink-3">{{ who }}</p>
        <img v-if="cover" :src="cover" class="w-full rounded-lg" alt="" />
        <p v-for="(l, i) in bodyLines.slice(0, 4)" :key="i" class="text-[13px] leading-6 text-ink-2">{{ l }}</p>
        <p v-if="bodyLines.length > 4" class="text-[12px] text-ink-3">共 {{ bodyLines.length }} 段</p>
      </div>
    </div>
  </div>
</template>
