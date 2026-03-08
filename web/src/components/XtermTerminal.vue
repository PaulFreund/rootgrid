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
  outputText: {
    type: String,
    default: ''
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

function applyOutputText(text, { reset = false } = {}) {
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
      background: '#ffffff',
      foreground: '#1f2937',
      cursor: '#111827',
      selectionBackground: 'rgba(148, 163, 184, 0.22)'
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
  applyOutputText(props.outputText, { reset: true })

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      fitTerminal()
    })
    try { resizeObserver.observe(terminalEl.value) } catch {}
  }
}

function disposeTerminal() {
  if (resizeObserver) {
    try { resizeObserver.disconnect() } catch {}
    resizeObserver = null
  }
  if (terminal) {
    try { terminal.dispose() } catch {}
    terminal = null
  }
  fitAddon = null
  renderedText = ''
}

onMounted(() => {
  mountTerminal()
})

onBeforeUnmount(() => {
  disposeTerminal()
})

watch(() => props.outputText, (value) => {
  applyOutputText(value)
})

watch(() => props.sessionKey, () => {
  applyOutputText(props.outputText, { reset: true })
  fitTerminal()
})

watch(() => props.connected, () => {
  if (!terminal) return
  terminal.options.cursorBlink = Boolean(props.connected)
})
</script>

<template>
  <div ref="terminalEl" class="h-full w-full overflow-hidden rounded-2xl bg-white" />
</template>
