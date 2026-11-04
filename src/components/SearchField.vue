<script setup lang="ts">
import { Search as IconSearch, X as IconX } from 'lucide-vue-next'
/** 封面墙搜索框（即创素材库同款）：无边填充 + 放大镜在左，有字才出清空叉。
 *  无障碍名走 `label` prop：模板里的 `aria-label` 会被当成透传属性，认不到自定义 prop 上。 */

defineProps<{ modelValue: string; placeholder: string; label: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <div class="relative w-full min-w-[220px] max-w-[420px]">
    <IconSearch :size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-field-placeholder" />
    <input
      :value="modelValue"
      class="input input-search h-9 w-full !py-0 !pl-9 !pr-9"
      :placeholder="placeholder"
      :aria-label="label"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="modelValue"
      class="absolute right-2 top-1/2 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-neutral-200 hover:text-ink"
      aria-label="清空搜索"
      title="清空搜索"
      @click="emit('update:modelValue', '')"
    >
      <IconX :size="13" />
    </button>
  </div>
</template>
