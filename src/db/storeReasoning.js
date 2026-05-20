import { parseJsonCell } from './storeRows.js'

function parseReasoningHeadingLine(line) {
  const raw = String(line ?? '')
  let trimmed = raw.replace(/^\s+/, '')
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ') || trimmed.startsWith('– ')) {
    trimmed = trimmed.slice(2).replace(/^\s+/, '')
  }
  if (!trimmed.startsWith('**')) return null
  const close = trimmed.indexOf('**', 2)
  if (close < 0) return null
  const title = trimmed.slice(2, close).trim()
  if (!title) return null
  return { title, rest: trimmed.slice(close + 2) }
}

function appendCappedStr(prev, delta, cap = 200_000) {
  const base = String(prev ?? '')
  const chunk = String(delta ?? '')
  if (!chunk) return base
  const next = base + chunk
  if (next.length <= cap) return next
  return next.slice(next.length - cap)
}

export function collectReasoningSegments(rows, { maxChars = 400_000 } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const cap = Math.max(1_000, Math.min(5_000_000, Number(maxChars) || 400_000))

  let text = ''
  let truncated = false
  let lastChunk = null
  const segments = []

  for (const row of list) {
    const payload = parseJsonCell(row?.payload_json, null)
    let chunk = String(payload?.text ?? '')
    if (!chunk) continue
    if (chunk === lastChunk) continue
    lastChunk = chunk

    const start = text.length
    if (text.length + chunk.length > cap) {
      const remaining = cap - text.length
      chunk = remaining > 0 ? chunk.slice(0, remaining) : ''
      truncated = true
    }

    if (!chunk) break
    text += chunk
    segments.push({
      start,
      end: text.length,
      seq: Number.isFinite(Number(row?.seq)) ? Number(row.seq) : null,
      tsMs: Number.isFinite(Number(row?.ts_ms)) ? Number(row.ts_ms) : null
    })

    if (truncated) break
  }

  return { text, truncated, segments }
}

export function parseReasoningSectionsWithStart(markdown, { maxSections = 200, maxBodyChars = 500_000 } = {}) {
  const text = String(markdown ?? '').replace(/\r/g, '')
  if (!text.trim()) return []

  const lines = text.split('\n')
  const sections = []
  let current = null
  let offset = 0

  const startSection = (title, startIndex) => {
    if (sections.length >= maxSections) return null
    current = {
      title: String(title ?? '').trim(),
      body: '',
      startIndex: Number(startIndex) || 0
    }
    sections.push(current)
    return current
  }

  for (const line of lines) {
    const heading = parseReasoningHeadingLine(line)
    if (heading) {
      const baseTitle = String(heading.title ?? '').trim()
      const rest = String(heading.rest ?? '')
      const title = (rest.trim() ? `${baseTitle}${rest}` : baseTitle).trim()
      startSection(title, offset)
      offset += line.length + 1
      continue
    }

    if (!current) {
      if (!String(line ?? '').trim()) {
        offset += line.length + 1
        continue
      }
      startSection('Reasoning', offset)
    }

    if (!current) break
    current.body = appendCappedStr(current.body, `${line}\n`, maxBodyChars)
    offset += line.length + 1
  }

  for (const section of sections) {
    if (typeof section.body === 'string') section.body = section.body.replace(/\n+$/, '\n')
  }
  return sections
}
