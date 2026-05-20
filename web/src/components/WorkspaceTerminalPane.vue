<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Loader2, RotateCw, X } from 'lucide-vue-next'

import XtermTerminal from './XtermTerminal.vue'
import { applyWorkspaceTerminalInputModifiers, resolveMobileTerminalActionInput } from '../lib/workspaceTerminal.js'

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

const mobileTerminalModifierButtons = Object.freeze([
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' },
  { id: 'meta', label: 'Win' }
])

const mobileTerminalKeyRows = Object.freeze([
  [
    { id: 'esc', label: 'Esc' },
    { id: 'tab', label: 'Tab' },
    { id: 'home', label: 'Home' },
    { id: 'end', label: 'End' }
  ],
  [
    { id: 'ins', label: 'Ins' },
    { id: 'del', label: 'Del' },
    { id: 'pgup', label: 'PgUp' },
    { id: 'pgdn', label: 'PgDn' }
  ],
  [
    { id: 'prtscr', label: 'PrtSc' },
    { id: 'scrolllock', label: 'Scroll' },
    { id: 'pause', label: 'Pause' },
    { id: 'menu', label: 'Menu' }
  ],
  [
    { id: 'left', label: 'Left', icon: ArrowLeft },
    { id: 'up', label: 'Up', icon: ArrowUp },
    { id: 'down', label: 'Down', icon: ArrowDown },
    { id: 'right', label: 'Right', icon: ArrowRight }
  ],
  [
    { id: 'enter', label: 'Enter' },
    { id: 'ctrl+c', label: 'Ctrl+C' },
    { id: 'ctrl+v', label: 'Ctrl+V' },
    { id: 'ctrl+s', label: 'Ctrl+S' }
  ],
  [
    { id: 'ctrl+d', label: 'Ctrl+D' },
    { id: 'ctrl+l', label: 'Ctrl+L' },
    { id: 'ctrl+z', label: 'Ctrl+Z' }
  ]
])

const terminalView = ref(null)
const mobileTerminalModifiers = reactive({
  ctrl: false,
  alt: false,
  shift: false,
  meta: false
})

const showMobileTerminalKeys = computed(() => (
  props.mobile && Boolean(props.session?.terminalId)
))

function focusTerminalSoon() {
  nextTick(() => {
    try { terminalView.value?.focusTerminal?.() } catch {}
  })
}

function preserveTerminalFocus(event) {
  try { event?.preventDefault?.() } catch {}
  focusTerminalSoon()
}

function clearMobileTerminalModifiers() {
  mobileTerminalModifiers.ctrl = false
  mobileTerminalModifiers.alt = false
  mobileTerminalModifiers.shift = false
  mobileTerminalModifiers.meta = false
}

function currentMobileTerminalModifiers() {
  return {
    ctrl: Boolean(mobileTerminalModifiers.ctrl),
    alt: Boolean(mobileTerminalModifiers.alt),
    shift: Boolean(mobileTerminalModifiers.shift),
    meta: Boolean(mobileTerminalModifiers.meta)
  }
}

function toggleMobileTerminalModifier(modifierId) {
  const key = String(modifierId ?? '').trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(mobileTerminalModifiers, key)) return
  mobileTerminalModifiers[key] = !mobileTerminalModifiers[key]
  focusTerminalSoon()
}

function mobileModifierActive(modifierId) {
  const key = String(modifierId ?? '').trim().toLowerCase()
  return Boolean(mobileTerminalModifiers[key])
}

function emitTerminalInputWithModifiers(text) {
  const raw = String(text ?? '')
  if (!raw) return
  if (!props.session?.connected) return
  const modifiers = currentMobileTerminalModifiers()
  const active = Object.values(modifiers).some(Boolean)
  if (!active) {
    emit('input', raw)
    return
  }
  const next = applyWorkspaceTerminalInputModifiers(raw, modifiers)
  clearMobileTerminalModifiers()
  if (!next) return
  emit('input', next)
}

function sendMobileTerminalAction(actionId) {
  const text = resolveMobileTerminalActionInput(actionId, currentMobileTerminalModifiers())
  clearMobileTerminalModifiers()
  focusTerminalSoon()
  if (!text || !props.session?.connected) return
  emit('input', text)
}

function closeMobileKeyOverlay() {
  emit('update:mobileKeyOverlayOpen', false)
  focusTerminalSoon()
}

function mobileModifierButtonClass(modifierId) {
  return mobileModifierActive(modifierId)
    ? 'border-sky-400/45 bg-sky-500/20 text-sky-100'
    : 'border-white/10 bg-white/8 text-slate-100 hover:bg-white/14'
}

function mobileTerminalRowClass(row) {
  if (row.length >= 5) return 'grid-cols-5'
  if (row.length >= 4) return 'grid-cols-4'
  if (row.length >= 3) return 'grid-cols-3'
  return 'grid-cols-2'
}

watch(() => props.mobile, (mobile) => {
  if (!mobile) {
    clearMobileTerminalModifiers()
    emit('update:mobileKeyOverlayOpen', false)
  }
})

watch(() => props.mobileKeyOverlayOpen, (open) => {
  if (!open) clearMobileTerminalModifiers()
  focusTerminalSoon()
})

watch(() => props.session?.terminalId, () => {
  clearMobileTerminalModifiers()
  emit('update:mobileKeyOverlayOpen', false)
})

watch(showMobileTerminalKeys, (visible) => {
  if (visible) return
  clearMobileTerminalModifiers()
  emit('update:mobileKeyOverlayOpen', false)
})
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-[#0b0f14]">
    <div class="min-h-0 flex-1 overflow-hidden bg-[#0b0f14]">
      <XtermTerminal
        ref="terminalView"
        :session-key="session?.terminalId ?? ''"
        :snapshot-text="session?.outputText ?? ''"
        :snapshot-version="session?.outputResetVersion ?? 0"
        :chunk-text="session?.chunkText ?? ''"
        :chunk-version="session?.chunkVersion ?? 0"
        :connected="Boolean(session?.connected)"
        @ready="$emit('ready', $event)"
        @input="emitTerminalInputWithModifiers"
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
        class="w-[min(92vw,320px)] rounded-2xl border border-white/10 bg-black/50 p-3 shadow-none"
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">Terminal keys</div>
          <button
            class="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            type="button"
            tabindex="-1"
            title="Close keys"
            @pointerdown="preserveTerminalFocus"
            @click="closeMobileKeyOverlay"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>

        <div class="mb-2 grid gap-2" :class="mobileTerminalRowClass(mobileTerminalModifierButtons)">
          <button
            v-for="item in mobileTerminalModifierButtons"
            :key="item.id"
            class="inline-flex h-9 min-w-0 items-center justify-center rounded-xl border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            :class="mobileModifierButtonClass(item.id)"
            type="button"
            tabindex="-1"
            :disabled="!session?.connected"
            @pointerdown="preserveTerminalFocus"
            @click="toggleMobileTerminalModifier(item.id)"
          >
            <span class="truncate">{{ item.label }}</span>
          </button>
        </div>

        <div class="space-y-2">
          <div
            v-for="(row, rowIdx) in mobileTerminalKeyRows"
            :key="`mobile-terminal-keys-${rowIdx}`"
            class="grid gap-2"
            :class="mobileTerminalRowClass(row)"
          >
            <button
              v-for="item in row"
              :key="item.id"
              class="inline-flex h-10 min-w-0 items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/8 px-2 text-[11px] font-medium text-slate-100 transition-colors hover:bg-white/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              tabindex="-1"
              :disabled="!session?.connected"
              @pointerdown="preserveTerminalFocus"
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
