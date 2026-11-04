<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { confirmState } from '../lib/useConfirm'

/** 全站确认弹层：替代原生 confirm()，样式跟 neo 卡片一致。挂在 App 外壳上，任何视图都能调 useConfirm()。 */
const emit = defineEmits<{ settle: [ok: boolean] }>()
function onKey(e: KeyboardEvent) {
  if (!confirmState.value) return
  if (e.key === 'Escape') emit('settle', false)
  if (e.key === 'Enter') emit('settle', true)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="confirmState" v-dialog="confirmState.title" class="modal modal--center z-[2110]">
    <div class="absolute inset-0 bg-black/35" @click="emit('settle', false)" />
    <div class="card modal-card relative z-10 max-w-md">
      <div class="shrink-0 border-b border-line px-5 py-3 text-[15px] font-medium">{{ confirmState.title }}</div>
      <div class="modal-body whitespace-pre-line p-5 text-sm leading-relaxed">{{ confirmState.message }}</div>
      <div class="flex shrink-0 justify-end gap-2 px-5 pb-5">
        <button class="btn !px-4 !py-1.5" @click="emit('settle', false)">{{ confirmState.cancelText || '取消' }}</button>
        <button class="btn btn-primary !px-4 !py-1.5" @click="emit('settle', true)">{{ confirmState.confirmText || '确定' }}</button>
      </div>
    </div>
  </div>
</template>
