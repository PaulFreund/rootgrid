<script setup>
import { computed } from 'vue'

import { inferFileLanguage } from '../lib/fileLanguage.js'

const props = defineProps({
  path: {
    type: String,
    default: ''
  },
  value: {
    type: String,
    default: ''
  }
})

const text = computed(() => String(props.value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n'))
const language = computed(() => inferFileLanguage(props.path))
const lines = computed(() => text.value.split('\n'))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-[#fbfbfa]">
    <div class="flex items-center justify-between gap-3 border-b border-black/[0.05] bg-[#f7f7f4] px-4 py-2 text-xs text-slate-500">
      <div class="font-mono">{{ language }}</div>
      <div>{{ lines.length }} lines</div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div class="min-w-full">
        <div
          v-for="(line, index) in lines"
          :key="index"
          class="grid min-w-full grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-4 px-4 text-xs leading-5"
        >
          <div class="select-none py-0.5 text-right font-mono text-slate-400">
            {{ index + 1 }}
          </div>
          <pre class="rg-code-file-line m-0 min-w-0 overflow-visible py-0.5 font-mono text-slate-900">{{ line || ' ' }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rg-code-file-line {
  white-space: pre;
  tab-size: 2;
}
</style>
