<script setup>
import { computed } from 'vue'
import { Loader2, RotateCw } from 'lucide-vue-next'

import XtermTerminal from './XtermTerminal.vue'

const props = defineProps({
  session: {
    type: Object,
    default: null
  },
  error: {
    type: String,
    default: ''
  },
  opening: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['ready', 'input', 'resize', 'open'])

const cwdLabel = computed(() => String(props.session?.cwd ?? '').trim() || 'Current workspace')

const shellLabel = computed(() => {
  const shell = String(props.session?.shell ?? '').trim()
  if (!shell) return ''
  return shell.split('/').filter(Boolean).pop() || shell
})

const statusLabel = computed(() => {
  if (props.error) return String(props.error)
  if (props.opening || !props.session?.terminalId) return 'Opening shell…'
  if (props.session?.connected) return shellLabel.value || 'Connected'
  const exitCode = Number(props.session?.exitCode)
  const signal = Number(props.session?.signal)
  if (Number.isFinite(exitCode)) return `Exited (${exitCode})`
  if (Number.isFinite(signal)) return `Exited (signal ${signal})`
  return 'Disconnected'
})

const canOpenNewShell = computed(() => {
  if (props.opening) return false
  if (props.error) return true
  if (!props.session?.terminalId) return false
  return !props.session?.connected
})

const openLabel = computed(() => (props.error ? 'Retry' : 'New shell'))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <div class="min-w-0">
        <div class="truncate font-mono text-xs text-slate-800" :title="cwdLabel">{{ cwdLabel }}</div>
        <div class="mt-1 truncate text-[11px]" :class="error ? 'text-red-600' : 'text-slate-500'">{{ statusLabel }}</div>
      </div>
      <button
        v-if="canOpenNewShell"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-slate-600 transition-colors hover:bg-black/[0.04] hover:text-slate-900"
        type="button"
        @click="$emit('open')"
      >
        <RotateCw class="h-3.5 w-3.5" />
        <span>{{ openLabel }}</span>
      </button>
    </div>

    <div class="relative min-h-0 flex-1 overflow-hidden rounded-[24px] bg-white">
      <XtermTerminal
        :session-key="session?.terminalId ?? ''"
        :output-text="session?.outputText ?? ''"
        :connected="Boolean(session?.connected)"
        @ready="$emit('ready', $event)"
        @input="$emit('input', $event)"
        @resize="$emit('resize', $event)"
      />

      <div
        v-if="opening && !session?.terminalId"
        class="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-white/70 text-sm text-slate-500"
      >
        <Loader2 class="h-4 w-4 animate-spin" />
        <span>Opening terminal…</span>
      </div>
    </div>
  </div>
</template>
