const DIFF_CACHE_MAX = 64
const DIFF_CACHE = new Map()
const DIFF_SUMMARY_CACHE = new Map()

function cacheWithLimit(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size <= DIFF_CACHE_MAX) return value
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
  return value
}

function normalizeDiffPath(path) {
  const value = String(path ?? '').trim()
  if (!value || value === '/dev/null') return null
  return value.replace(/^[ab]\//, '')
}

function parseHunkHeader(line) {
  const match = String(line ?? '').match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
  if (!match) return null
  return {
    oldLine: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newLine: Number(match[3]),
    newCount: Number(match[4] ?? 1)
  }
}

function lineNumberValue(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : ''
}

function normalizeDiffWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, '')
}

function annotateWhitespaceOnlyChanges(lines) {
  const items = Array.isArray(lines) ? lines : []
  let idx = 0
  while (idx < items.length) {
    const line = items[idx]
    if (line?.kind !== 'add' && line?.kind !== 'del') {
      idx += 1
      continue
    }

    const block = []
    while (idx < items.length && (items[idx]?.kind === 'add' || items[idx]?.kind === 'del')) {
      block.push(items[idx])
      idx += 1
    }

    const removed = block.filter((entry) => entry?.kind === 'del')
    const added = block.filter((entry) => entry?.kind === 'add')
    for (const entry of block) {
      entry.changeKind = 'substantive'
    }
    const pairs = Math.min(removed.length, added.length)
    for (let pairIdx = 0; pairIdx < pairs; pairIdx += 1) {
      const del = removed[pairIdx]
      const add = added[pairIdx]
      if (!del || !add) continue
      if (del.text === add.text) continue
      if (normalizeDiffWhitespace(del.text) !== normalizeDiffWhitespace(add.text)) continue
      del.changeKind = 'whitespace'
      add.changeKind = 'whitespace'
    }
  }
}

export function parseUnifiedDiff(diffText, { maxBytes = 2_000_000, maxLines = 50_000 } = {}) {
  const key = String(diffText ?? '')
  const cached = DIFF_CACHE.get(key)
  if (cached) return cacheWithLimit(DIFF_CACHE, key, cached)

  const text = key.replace(/\r/g, '')
  if (!text.trim()) return cacheWithLimit(DIFF_CACHE, key, [])

  if (text.length > maxBytes) {
    return cacheWithLimit(DIFF_CACHE, key, [{
      path: 'Diff too large',
      oldPath: null,
      newPath: null,
      lines: [{ kind: 'meta', text: `Diff truncated (${text.length} chars)`, raw: `Diff truncated (${text.length} chars)` }],
      raw: text.slice(0, maxBytes)
    }])
  }

  const lines = text.split('\n')
  const limited = (lines.length > maxLines) ? lines.slice(0, maxLines) : lines
  const files = []
  let cur = null
  let nextOldLine = null
  let nextNewLine = null

  const ensureCurrent = () => {
    if (cur) return cur
    cur = {
      path: 'Changes',
      oldPath: null,
      newPath: null,
      lines: [],
      raw: ''
    }
    files.push(cur)
    return cur
  }

  const finalizeCurrent = () => {
    if (!cur) return
    annotateWhitespaceOnlyChanges(cur.lines)
    cur.path = cur.newPath || cur.oldPath || cur.path || 'Changes'
    cur.raw = cur.lines.map((line) => line.raw ?? line.text ?? '').join('\n')
    cur = null
    nextOldLine = null
    nextNewLine = null
  }

  for (const line of limited) {
    if (line.startsWith('diff --git ')) {
      finalizeCurrent()
      ensureCurrent().lines.push({ kind: 'meta', text: line, raw: line })
      continue
    }

    if (line.startsWith('--- ')) {
      const next = ensureCurrent()
      next.oldPath = normalizeDiffPath(line.slice(4))
      next.lines.push({ kind: 'meta', text: line, raw: line })
      continue
    }

    if (line.startsWith('+++ ')) {
      const next = ensureCurrent()
      next.newPath = normalizeDiffPath(line.slice(4))
      next.path = next.newPath || next.oldPath || next.path
      next.lines.push({ kind: 'meta', text: line, raw: line })
      continue
    }

    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line)
      nextOldLine = header ? header.oldLine : null
      nextNewLine = header ? header.newLine : null
      ensureCurrent().lines.push({ kind: 'hunk', text: line, raw: line, oldLine: '', newLine: '' })
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      ensureCurrent().lines.push({
        kind: 'add',
        text: line.slice(1),
        raw: line,
        oldLine: '',
        newLine: lineNumberValue(nextNewLine)
      })
      if (Number.isFinite(Number(nextNewLine))) nextNewLine += 1
      continue
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      ensureCurrent().lines.push({
        kind: 'del',
        text: line.slice(1),
        raw: line,
        oldLine: lineNumberValue(nextOldLine),
        newLine: ''
      })
      if (Number.isFinite(Number(nextOldLine))) nextOldLine += 1
      continue
    }

    if (line.startsWith(' ')) {
      ensureCurrent().lines.push({
        kind: 'ctx',
        text: line.slice(1),
        raw: line,
        oldLine: lineNumberValue(nextOldLine),
        newLine: lineNumberValue(nextNewLine)
      })
      if (Number.isFinite(Number(nextOldLine))) nextOldLine += 1
      if (Number.isFinite(Number(nextNewLine))) nextNewLine += 1
      continue
    }

    ensureCurrent().lines.push({
      kind: 'meta',
      text: line,
      raw: line,
      oldLine: '',
      newLine: ''
    })
  }

  finalizeCurrent()
  return cacheWithLimit(DIFF_CACHE, key, files)
}

export function summarizeUnifiedDiff(diffText, { maxBytes = 2_000_000, maxLines = 50_000 } = {}) {
  const key = String(diffText ?? '')
  const cached = DIFF_SUMMARY_CACHE.get(key)
  if (cached) return cacheWithLimit(DIFF_SUMMARY_CACHE, key, cached)

  const text = key.replace(/\r/g, '')
  if (!text.trim()) return cacheWithLimit(DIFF_SUMMARY_CACHE, key, { files: 0, added: 0, removed: 0, paths: [] })

  const limitedText = text.length > maxBytes ? text.slice(0, maxBytes) : text
  const lines = limitedText.split('\n')
  const limited = (lines.length > maxLines) ? lines.slice(0, maxLines) : lines

  const paths = []
  const seenPaths = new Set()
  let added = 0
  let removed = 0

  for (const line of limited) {
    if (line.startsWith('+++ ')) {
      const path = normalizeDiffPath(line.slice(4))
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path)
        paths.push(path)
      }
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }

  return cacheWithLimit(DIFF_SUMMARY_CACHE, key, {
    files: paths.length,
    added,
    removed,
    paths
  })
}
