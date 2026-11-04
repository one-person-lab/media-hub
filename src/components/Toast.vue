<script setup lang="ts">
import { Transition } from 'vue'
import { useToast } from '../lib/useToast'
import { CircleAlert as IconCircleAlert, CircleCheck as IconCircleCheck } from 'lucide-vue-next'

const { toastMsg, toastKind } = useToast()
</script>

<template>
  <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 translate-y-1"
    leave-active-class="transition duration-150 ease-in" leave-to-class="opacity-0">
    <div v-if="toastMsg" role="status"
      class="fixed bottom-6 right-6 z-[2120] flex max-w-[min(560px,80vw)] items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium shadow-neo">
      <IconCircleCheck v-if="toastKind === 'ok'" :size="15" class="shrink-0 text-green-700" />
      <IconCircleAlert v-else-if="toastKind === 'fail'" :size="15" class="shrink-0 text-red-700" />
      <span class="min-w-0">{{ toastMsg }}</span>
    </div>
  </Transition>
</template>
