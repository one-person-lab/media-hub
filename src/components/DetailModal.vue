<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { X as IconX } from 'lucide-vue-next'

/** 卡片详情弹层：点卡片原地展开，操作都在弹层里做，不跳页。Esc / 点遮罩关闭。 */
const emit = defineEmits<{ close: [] }>()
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-dialog="'详情'" class="modal">
    <div class="absolute inset-0 bg-black/35" @click="emit('close')" />
    <div class="card modal-card relative z-10 max-w-4xl">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div class="min-w-0 truncate text-sm font-medium"><slot name="title" /></div>
        <button class="btn shrink-0 !px-2.5 !py-1" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">
          <IconX :size="15" />
        </button>
      </div>
      <div class="modal-body p-5"><slot /></div>
    </div>
  </div>
</template>
