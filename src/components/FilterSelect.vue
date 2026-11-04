<script setup lang="ts">
/** 封面墙顶栏的下拉筛选（即创「行业类型 ▾」同款）：未选时显示占位标签，选中后按钮与条目都换成该选项文案。 */
import { computed, ref } from 'vue'
import { Check as IconCheck, ChevronDown as IconChevronDown } from 'lucide-vue-next'
import PlatformLogo from './PlatformLogo.vue'

export type FilterOption = { value: string; label: string; logo?: string }

const props = defineProps<{
  /** 未筛选时显示的占位文案，如「来源」 */
  placeholder: string
  modelValue: string
  options: FilterOption[]
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const open = ref(false)
const currentOpt = computed(() => props.options.find((o) => o.value === props.modelValue && o.value !== '') ?? null)
const isSet = computed(() => !!props.modelValue)

function pick(v: string) {
  emit('update:modelValue', v)
  open.value = false
}
</script>

<template>
  <div class="relative">
    <button class="seg shrink-0" :class="isSet && 'is-selected'" :aria-expanded="open" @click="open = !open">
      <span class="flex items-center gap-1.5">
        <PlatformLogo v-if="currentOpt?.logo" :platform="currentOpt.logo" :size="14" />
        {{ currentOpt?.label || placeholder }}
      </span>
      <IconChevronDown :size="13" class="transition-transform" :class="open && 'rotate-180'" />
    </button>
    <template v-if="open">
      <div class="fixed inset-0 z-20" @click="open = false" />
      <div class="absolute right-0 top-full z-30 mt-1 flex w-full min-w-[10rem] flex-col gap-0.5 rounded-lg border border-line bg-surface p-1.5 shadow-neo-lg">
        <button
          v-for="o in options"
          :key="o.value"
          class="seg !justify-between !gap-3 !px-2.5 !py-1.5 text-sm"
          :class="o.value === modelValue && 'is-selected'"
          @click="pick(o.value)"
        >
          <span class="flex items-center gap-1.5">
            <PlatformLogo v-if="o.logo" :platform="o.logo" :size="14" />
            {{ o.label }}
          </span>
          <IconCheck v-if="o.value === modelValue" :size="13" class="shrink-0" />
        </button>
      </div>
    </template>
  </div>
</template>
