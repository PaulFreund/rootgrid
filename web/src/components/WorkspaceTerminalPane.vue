<script setup>
import { computed, watch } from 'vue'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Loader2, RotateCw, X } from 'lucide-vue-next'

import XtermTerminal from './XtermTerminal.vue'
import { resolveMobileTerminalActionInput } from '../lib/workspaceTerminal.js'

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
  },
  mobile: {
    type: Boolean,
    default: false
  },
  mobileKeyOverlayOpen: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['ready', 'input', 'resize', 'open', 'update:mobileKeyOverlayOpen'])

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

const mobileTerminalKeyRows = Object.freeze([
  [
    { id: 'esc', label: 'Esc' },
    { id: 'tab', label: 'Tab' },
    { id: 'home', label: 'Home' },
    { id: 'end', label: 'End' }
  ],
  [
    { id: 'up', label: 'Up', icon: ArrowUp },
    { id: 'left', label: 'Left', icon: ArrowLeft },
    { id: 'down', label: 'Down', icon: ArrowDown },
    { id: 'right', label: 'Right', icon: ArrowRight }
  ],
  [
    { id: 'pgup', label: 'PgUp' },
    { id: 'pgdn', label: 'PgDn' },
    { id: 'ctrl+c', label: 'Ctrl+C' },
    { id: 'ctrl+d', label: 'Ctrl+D' }
  ],
  [
    { id: 'ctrl+l', label: 'Ctrl+L' },
    { id: 'ctrl+z', label: 'Ctrl+Z' }
  ]
])

const showMobileTerminalKeys = computed(() => (
  props.mobile && Boolean(props.session?.terminalId)
))

function sendMobileTerminalAction(actionId) {
  const text = resolveMobileTerminalActionInput(actionId)
  if (!text || !props.session?.connected) return
  emit('input', text)
}

watch(() => props.mobile, (mobile) => {
  if (!mobile) emit('update:mobileKeyOverlayOpen', false)
})

watch(() => props.session?.terminalId, () => {
  emit('update:mobileKeyOverlayOpen', false)
})

watch(showMobileTerminalKeys, (visible) => {
  if (visible) return
  emit('update:mobileKeyOverlayOpen', false)
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
      v-if="showMobileTerminalKeys && mobileKeyOverlayOpen"
      class="absolute right-3 top-3 z-20"
    >
      <div
        class="w-[232px] rounded-2xl border border-white/10 bg-black/75 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.45)] backdrop-blur"
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">Terminal keys</div>
          <button
            class="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            type="button"
            title="Close keys"
            @click="$emit('update:mobileKeyOverlayOpen', false)"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>

        <div class="space-y-2">
          <div
            v-for="(row, rowIdx) in mobileTerminalKeyRows"
            :key="`mobile-terminal-keys-${rowIdx}`"
            class="grid gap-2"
            :class="row.length >= 4 ? 'grid-cols-4' : 'grid-cols-2'"
          >
            <button
              v-for="item in row"
              :key="item.id"
              class="inline-flex h-10 min-w-0 items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/8 px-2 text-[11px] font-medium text-slate-100 transition-colors hover:bg-white/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="!session?.connected"
              @click="sendMobileTerminalAction(item.id)"
            >
              <component :is="item.icon" v-if="item.icon" class="h-3.5 w-3.5" />
              <span class="truncate">{{ item.label }}</span>
            </button>
          </div>
        </div>
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
