<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

const props = defineProps({
  source: { type: String, default: '' }
})

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const renderer = new marked.Renderer()
renderer.code = (code, infostring) => {
  const lang = String(infostring ?? '').trim().split(/\s+/)[0]
  const encoded = encodeURIComponent(String(code ?? ''))
  return [
    `<div class="rg-codeblock" data-code="${encoded}">`,
    '  <div class="rg-codeblock__header">',
    `    <div class="rg-codeblock__lang">${escapeHtml(lang || 'code')}</div>`,
    '    <button type="button" class="rg-codeblock__copy">Copy</button>',
    '  </div>',
    `  <pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code ?? '')}</code></pre>`,
    '</div>'
  ].join('\n')
}

marked.use({
  gfm: true,
  breaks: true,
  renderer
})

const html = computed(() => {
  const raw = marked.parse(props.source ?? '')
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-code'] })
})

const rootEl = ref(null)
let onClick = null

onMounted(() => {
  const el = rootEl.value
  if (!el) return

  onClick = async (ev) => {
    const btn = ev.target?.closest?.('.rg-codeblock__copy')
    if (!btn) return
    const wrapper = btn.closest('.rg-codeblock')
    const code = decodeURIComponent(wrapper?.dataset?.code ?? '')
    if (!code) return

    try {
      await navigator.clipboard.writeText(code)
      btn.textContent = 'Copied'
      setTimeout(() => { btn.textContent = 'Copy' }, 1000)
    } catch {
      // ignore
    }
  }

  el.addEventListener('click', onClick)
})

onBeforeUnmount(() => {
  const el = rootEl.value
  if (!el || !onClick) return
  el.removeEventListener('click', onClick)
})
</script>

<template>
  <div ref="rootEl" class="rg-prose" v-html="html"></div>
</template>
