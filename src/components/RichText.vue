<script setup lang="ts">
/** 稿面文字的排版显示：空行分段、`#` 标题、`- ` 列表、`**加粗**`。
 *  平台编辑器都不渲染 Markdown（推送前星号被脚本剥掉），这里只保证工作台里看得清结构。 */
import { computed } from 'vue'
import { parseRichText } from '../lib/richText'

const props = defineProps<{ text: string }>()
const blocks = computed(() => parseRichText(props.text))
</script>

<template>
  <div class="flex flex-col gap-3 text-sm leading-7">
    <template v-for="(b, i) in blocks" :key="i">
      <h4 v-if="b.kind === 'h'" class="text-sm font-semibold text-ink">
        <span v-for="(s, j) in b.segs" :key="j">{{ s.text }}</span>
      </h4>
      <ul v-else-if="b.kind === 'ul'" class="list-disc space-y-1.5 pl-5 marker:text-ink-2">
        <li v-for="(it, j) in b.items" :key="j">
          <span v-for="(s, k) in it" :key="k" :class="s.bold ? 'font-medium' : ''">{{ s.text }}</span>
        </li>
      </ul>
      <p v-else>
        <span v-for="(s, j) in b.segs" :key="j" :class="s.bold ? 'font-medium' : ''">{{ s.text }}</span>
      </p>
    </template>
  </div>
</template>
