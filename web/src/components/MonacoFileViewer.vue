<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

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

const rootEl = ref(null)

let monacoApi = null
let editor = null
let model = null
let mounted = false

function inferLanguageFromPath(path) {
  const name = String(path ?? '').trim().toLowerCase()
  if (!name) return 'plaintext'
  if (name.endsWith('.js') || name.endsWith('.cjs') || name.endsWith('.mjs')) return 'javascript'
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.vue')) return 'html'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.scss')) return 'scss'
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell'
  if (name.endsWith('.py')) return 'python'
  return 'plaintext'
}

function ensureMonacoEnvironment() {
  const globalObj = globalThis
  if (globalObj.MonacoEnvironment?.__rootgridConfigured) return
  globalObj.MonacoEnvironment = {
    __rootgridConfigured: true,
    getWorker(_, label) {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }
}

async function loadMonaco() {
  ensureMonacoEnvironment()
  if (monacoApi) return monacoApi
  monacoApi = await import('monaco-editor/esm/vs/editor/editor.api')
  return monacoApi
}

function disposeModel() {
  if (!model) return
  try { model.dispose() } catch {}
  model = null
}

function disposeEditor() {
  if (!editor) return
  try { editor.dispose() } catch {}
  editor = null
}

async function ensureEditor() {
  if (!mounted || !rootEl.value) return
  const monaco = await loadMonaco()
  if (!mounted || !rootEl.value || editor) return
  model = monaco.editor.createModel(
    String(props.value ?? ''),
    inferLanguageFromPath(props.path),
    monaco.Uri.parse(`file://${encodeURI(String(props.path ?? 'untitled.txt'))}`)
  )
  editor = monaco.editor.create(rootEl.value, {
    model,
    automaticLayout: true,
    readOnly: true,
    glyphMargin: false,
    lineNumbersMinChars: 3,
    minimap: { enabled: false },
    renderLineHighlight: 'none',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    wordWrap: 'on',
    wrappingIndent: 'indent',
    padding: { top: 12, bottom: 12 },
    fontSize: 12,
    lineHeight: 20,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    occurrencesHighlight: 'off',
    selectionHighlight: false
  })
  monaco.editor.defineTheme('rootgrid-file', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#fbfbfa',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#64748b',
      'editorGutter.background': '#fbfbfa',
      'editor.lineHighlightBackground': '#00000000',
      'editor.selectionBackground': '#cbd5e133'
    }
  })
  monaco.editor.setTheme('rootgrid-file')
  await nextTick()
  try { editor.layout() } catch {}
}

async function syncModel() {
  await ensureEditor()
  if (!editor || !model || !monacoApi) return
  const nextPath = String(props.path ?? '')
  const nextValue = String(props.value ?? '')
  const currentPath = model.uri?.path ? decodeURIComponent(model.uri.path) : ''
  const expectedPath = `/${nextPath}`.replace(/\/+/g, '/')
  const samePath = currentPath === expectedPath
  if (!samePath) {
    disposeEditor()
    disposeModel()
    await ensureEditor()
    return
  }
  if (model.getValue() !== nextValue) {
    model.setValue(nextValue)
  }
}

onMounted(async () => {
  mounted = true
  await ensureEditor()
})

onBeforeUnmount(() => {
  mounted = false
  disposeEditor()
  disposeModel()
})

watch(() => [props.path, props.value], () => {
  syncModel().catch(() => {})
})
</script>

<template>
  <div ref="rootEl" class="h-full w-full" />
</template>
