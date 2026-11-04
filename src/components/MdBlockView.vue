<script setup lang="ts">
import type { MdBlock } from '../data/store'

/** build-data 切出来的一个内容块。
 *  正文只有一档字号（15px / 1.85 行距），层级全靠字重与灰度拉开，不靠底色和边框堆。 */
defineProps<{ b: MdBlock }>()

/** 转义后只放行 **粗体** 与 `行内代码`，其余按纯文本渲染 */
function mdInline(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-ink">$1</strong>')
    .replace(
      /`([^`]+)`/g,
      '<code class="rounded-[5px] border border-line bg-surface-2 px-1 py-px font-mono text-[12.5px] text-ink">$1</code>',
    )
}

function isTodo(item: string) {
  return /^\[[ x]\]\s/.test(item)
}
function isDone(item: string) {
  return /^\[x]\s/.test(item)
}
function todoText(item: string) {
  return item.replace(/^\[[ x]\]\s*/, '')
}
</script>

<template>
  <p v-if="b.t === 'p'" class="text-[15px] leading-[1.85] text-ink" v-html="mdInline(b.text || '')" />

  <!-- 小节内的三级标题：与正文同字号，只靠字重和上方留白分节 -->
  <h4 v-else-if="b.t === 'h'" class="pt-4 text-[15px] font-semibold text-ink">{{ b.text }}</h4>

  <!-- 有序列表保留源文件的编号（评分体系的规则互相引用「§四」「第 6 条」，编号是内容不是装饰）；
       无序用圆点，待办画真方框，都对齐第一行文字中线 -->
  <ul v-else-if="b.t === 'ul'" class="flex flex-col gap-1.5">
    <li v-for="(item, j) in b.items" :key="j" class="flex items-start gap-2.5 text-[15px] leading-[1.85] text-ink">
      <span v-if="b.ordered" class="w-5 shrink-0 pt-[5px] text-right text-sm tabular-nums text-ink-3">{{ j + 1 }}</span>
      <template v-else>
        <span v-if="isTodo(item)" class="mt-[9px] h-3 w-3 shrink-0 rounded-[3px] border border-line-strong" :class="isDone(item) && 'border-ink bg-ink'" />
        <span v-else class="mt-[13px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
      </template>
      <span v-html="mdInline(isTodo(item) ? todoText(item) : item)" />
    </li>
  </ul>

  <!-- 引用块是文档里的重点句、公式与摘要：一条竖线 + 正文色，不再压成一块灰底 -->
  <blockquote
    v-else-if="b.t === 'quote'"
    class="whitespace-pre-line border-l-[3px] border-line-strong py-0.5 pl-4 text-[15px] leading-[1.85] text-ink"
    v-html="mdInline(b.text || '')"
  />

  <div v-else-if="b.t === 'table'" class="overflow-x-auto">
    <table class="w-full border-collapse text-[14px]">
      <thead>
        <tr>
          <th
            v-for="(h, j) in b.head"
            :key="j"
            class="border-b border-line-strong px-4 pb-2 text-left align-bottom text-[13px] font-medium whitespace-nowrap text-ink-3"
            :class="j === 0 && '!pl-0'"
            v-html="mdInline(h || '')"
          />
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, j) in b.rows" :key="j" class="align-top">
          <td
            v-for="(c, k) in r"
            :key="k"
            class="border-b border-line px-4 py-2.5 leading-[1.75] text-ink-2"
            :class="k === 0 ? '!pl-0 whitespace-nowrap font-medium text-ink' : ''"
            v-html="mdInline(c || '')"
          />
        </tr>
      </tbody>
    </table>
  </div>

  <pre v-else-if="b.t === 'code'" class="overflow-x-auto rounded-lg bg-surface-2 p-4 font-mono text-[13px] leading-6 whitespace-pre text-ink">{{ b.text }}</pre>

  <div v-else-if="b.t === 'hr'" class="border-t border-line" />
</template>
