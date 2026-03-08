<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

const props = defineProps({
  sessionKey: {
    type: String,
    default: ''
  },
  snapshotText: {
    type: String,
    default: ''
  },
  snapshotVersion: {
    type: Number,
    default: 0
  },
  chunkText: {
    type: String,
    default: ''
  },
  chunkVersion: {
    type: Number,
    default: 0
  },
  connected: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['ready', 'input', 'resize'])

const terminalEl = ref(null)

let terminal = null
let fitAddon = null
let resizeObserver = null
let renderedText = ''
let suppressResizeEmit = false
let outputFlushTimer = null
let pendingOutputText = null
let pendingReset = false
let fitTimer = null

function applyOutputTextNow(text, { reset = false } = {}) {
  if (!terminal) return
  const nextText = String(text ?? '')
  if (reset || !nextText.startsWith(renderedText)) {
    terminal.reset()
    renderedText = ''
  }
  const delta = nextText.slice(renderedText.length)
  if (delta) terminal.write(delta)
  renderedText = nextText
}

function appendChunkNow(chunk) {
  if (!terminal) return
  const text = String(chunk ?? '')
  if (!text) return
  terminal.write(text)
  renderedText = `${renderedText}${text}`
}

function flushPendingOutput() {
  if (outputFlushTimer) {
    try { clearTimeout(outputFlushTimer) } catch {}
    outputFlushTimer = null
  }
  const nextText = pendingOutputText
  const reset = pendingReset
  pendingOutputText = null
  pendingReset = false
  if (nextText === null) return
  applyOutputTextNow(nextText, { reset })
}

function applyOutputText(text, { reset = false, immediate = false } = {}) {
  pendingOutputText = String(text ?? '')
  pendingReset = pendingReset || reset
  if (immediate) {
    flushPendingOutput()
    return
  }
  if (outputFlushTimer) return
  outputFlushTimer = setTimeout(() => {
    outputFlushTimer = null
    flushPendingOutput()
  }, 16)
}

function emitResize() {
  if (!terminal || suppressResizeEmit) return
  emit('resize', {
    cols: terminal.cols,
    rows: terminal.rows
  })
}

function fitTerminal() {
  if (!terminal || !fitAddon) return
  try {
    suppressResizeEmit = true
    fitAddon.fit()
  } catch {
  } finally {
    suppressResizeEmit = false
  }
  emitResize()
}

function scheduleFitTerminal() {
  if (fitTimer) return
  fitTimer = setTimeout(() => {
    fitTimer = null
    fitTerminal()
  }, 40)
}

async function mountTerminal() {
  if (!terminalEl.value || terminal) return
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: {
      background: '#0b0f14',
      foreground: '#f8fafc',
      cursor: '#f8fafc',
      cursorAccent: '#0b0f14',
      selectionBackground: 'rgba(248, 250, 252, 0.22)'
    }
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalEl.value)
  terminal.onData((data) => emit('input', String(data ?? '')))
  await nextTick()
  fitTerminal()
  emit('ready', {
    cols: terminal.cols,
    rows: terminal.rows
  })
  applyOutputText(props.snapshotText, { reset: true, immediate: true })

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      scheduleFitTerminal()
    })
    try { resizeObserver.observe(terminalEl.value) } catch {}
  }
}

function disposeTerminal() {
  if (resizeObserver) {
    try { resizeObserver.disconnect() } catch {}
    resizeObserver = null
  }
  if (fitTimer) {
    try { clearTimeout(fitTimer) } catch {}
    fitTimer = null
  }
  if (outputFlushTimer) {
    try { clearTimeout(outputFlushTimer) } catch {}
    outputFlushTimer = null
  }
  if (terminal) {
    try { terminal.dispose() } catch {}
    terminal = null
  }
  fitAddon = null
  renderedText = ''
  pendingOutputText = null
  pendingReset = false
}

onMounted(() => {
  mountTerminal()
})

onBeforeUnmount(() => {
  disposeTerminal()
})

watch(() => [props.sessionKey, props.snapshotVersion], () => {
  applyOutputText(props.snapshotText, { reset: true, immediate: true })
  fitTerminal()
})

watch(() => props.chunkVersion, () => {
  appendChunkNow(props.chunkText)
})

watch(() => props.connected, () => {
  if (!terminal) return
  terminal.options.cursorBlink = Boolean(props.connected)
})
</script>

<template>
  <div ref="terminalEl" class="h-full w-full overflow-hidden rounded-2xl bg-[#0b0f14]" />
</template>
