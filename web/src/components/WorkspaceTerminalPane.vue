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

const shellLabel = computed(() => {
  const shell = String(props.session?.shell ?? '').trim()
  if (!shell) return ''
  return shell.split('/').filter(Boolean).pop() || shell
})
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-[#0b0f14]">
    <div class="min-h-0 flex-1 overflow-hidden bg-[#0b0f14]">
      <XtermTerminal
        :session-key="session?.terminalId ?? ''"
        :snapshot-text="session?.outputText ?? ''"
        :snapshot-version="session?.outputResetVersion ?? 0"
        :chunk-text="session?.chunkText ?? ''"
        :chunk-version="session?.chunkVersion ?? 0"
        :connected="Boolean(session?.connected)"
        @ready="$emit('ready', $event)"
        @input="$emit('input', $event)"
        @resize="$emit('resize', $event)"
      />
      <div
        v-if="opening && !session?.terminalId"
        class="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-[#0b0f14]/80 text-sm text-slate-200"
      >
        <Loader2 class="h-4 w-4 animate-spin" />
        <span>Opening terminal…</span>
      </div>
    </div>

    <div
      v-if="(error || canOpenNewShell) && !opening"
      class="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full bg-black/65 px-2 py-1 text-[11px] text-slate-200 backdrop-blur"
    >
      <span v-if="statusLabel" class="max-w-[200px] truncate">{{ statusLabel }}</span>
      <button
        v-if="canOpenNewShell"
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[11px] text-slate-100 transition-colors hover:bg-white/15"
        type="button"
        @click="$emit('open')"
      >
        <RotateCw class="h-3.5 w-3.5" />
        <span>{{ openLabel }}</span>
      </button>
    </div>
  </div>
</template>
