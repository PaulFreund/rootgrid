import { getTurnReasoningState } from './sessionHistory.js'

const DIFF_CACHE_MAX = 64
const COMMAND_ACTIONS_CACHE = new WeakMap()
const DIFF_CACHE = new Map()
const DIFF_SUMMARY_CACHE = new Map()
const CHAT_MESSAGES_CACHE = new WeakMap()

function cacheDiff(key, value) {
  if (DIFF_CACHE.has(key)) DIFF_CACHE.delete(key)
  DIFF_CACHE.set(key, value)
  if (DIFF_CACHE.size <= DIFF_CACHE_MAX) return value
  const oldest = DIFF_CACHE.keys().next().value
  if (oldest !== undefined) DIFF_CACHE.delete(oldest)
  return value
}

function splitShellStatements(cmd) {
  const s = String(cmd ?? '')
  const out = []
  let cur = ''
  let quote = null

  const push = () => {
    const value = cur.trim()
    cur = ''
    if (value) out.push(value)
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        cur += ch
        continue
      }
      if (quote === '"' && ch === '\\' && i + 1 < s.length) {
        cur += ch + s[i + 1]
        i += 1
        continue
      }
      cur += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }

    if (ch === ';' || ch === '\n') {
      push()
      continue
    }

    if (ch === '&' && s[i + 1] === '&') {
      push()
      i += 1
      continue
    }

    cur += ch
  }
  push()
  return out
}

function beforeFirstPipe(seg) {
  const s = String(seg ?? '')
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"' && ch === '\\' && i + 1 < s.length) i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '|') return s.slice(0, i).trim()
  }
  return s.trim()
}

function stripOuterParens(s) {
  let value = String(s ?? '').trim()
  for (let i = 0; i < 4; i++) {
    if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim()
    else break
  }
  return value
}

function shellSplitWords(s) {
  const input = String(s ?? '')
  const out = []
  let cur = ''
  let quote = null
  let tokenStarted = false

  const push = () => {
    out.push(cur)
    cur = ''
    tokenStarted = false
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        tokenStarted = true
        continue
      }
      if (quote === '"' && ch === '\\' && i + 1 < input.length) {
        cur += input[i + 1]
        i += 1
        tokenStarted = true
        continue
      }
      cur += ch
      tokenStarted = true
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      tokenStarted = true
      continue
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) push()
      continue
    }

    if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1]
      i += 1
      tokenStarted = true
      continue
    }

    cur += ch
    tokenStarted = true
  }
  if (tokenStarted) push()
  return out
}

function looksLikePath(token) {
  const t = String(token ?? '').trim()
  if (!t) return false
  if (t === '.' || t === '..') return true
  if (t.includes('/')) return true
  if (t.startsWith('.')) return true
  if (/\.[a-z0-9]{1,8}$/i.test(t)) return true
  if (/^(README|LICENSE|Makefile|Dockerfile)$/i.test(t)) return true
  if (/^(Cargo\.toml|Cargo\.lock|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(t)) return true
  return false
}

function looksLikeFileToken(token) {
  const t = String(token ?? '').trim()
  if (!t) return false
  if (t.endsWith('/')) return false
  const base = t.split('/').pop() || t
  const lower = base.toLowerCase()
  if (lower === '.vscode' || lower === '.git' || lower === '.github' || lower === '.rootgrid') return false
  if (lower === '.gitignore' || lower === '.env' || lower === '.npmrc' || lower === '.editorconfig') return true
  if (!base.startsWith('.') && base.includes('.')) return true
  return false
}

function formatExploreTitle({ files = 0, searches = 0, lists = 0, active = false } = {}) {
  const parts = []
  const plural = (n, one, many) => (Number(n) === 1 ? one : many)
  if (files) parts.push(`${files} ${plural(files, 'file', 'files')}`)
  if (searches) parts.push(`${searches} ${plural(searches, 'search', 'searches')}`)
  if (lists) parts.push(`${lists} ${plural(lists, 'list', 'lists')}`)
  const prefix = active ? 'Exploring' : 'Explored'
  if (!parts.length) return prefix
  return `${prefix} ${parts.join(', ')}`
}

function normalizeCommandActions(commandActions) {
  if (Array.isArray(commandActions) && COMMAND_ACTIONS_CACHE.has(commandActions)) {
    return COMMAND_ACTIONS_CACHE.get(commandActions)
  }

  const raw = Array.isArray(commandActions) ? commandActions : []
  const out = []
  for (const action of raw) {
    if (!action || typeof action !== 'object') continue
    const type = String(action.type ?? '').trim()
    const command = String(action.command ?? '').trim()
    if (type === 'read') {
      const name = String(action.name ?? '').trim() || String(action.path ?? '').trim() || command
      const path = (action.path === undefined || action.path === null) ? null : String(action.path)
      out.push({ kind: 'read', command, name, path })
      continue
    }
    if (type === 'listFiles') {
      const path = (action.path === undefined || action.path === null) ? null : String(action.path)
      out.push({ kind: 'list', command, path })
      continue
    }
    if (type === 'search') {
      const query = (action.query === undefined || action.query === null) ? null : String(action.query)
      const path = (action.path === undefined || action.path === null) ? null : String(action.path)
      out.push({ kind: 'search', command, query, path })
      continue
    }
    if (type === 'unknown') {
      out.push({ kind: 'unknown', command })
      continue
    }
    if (command) out.push({ kind: 'unknown', command })
  }

  if (Array.isArray(commandActions)) COMMAND_ACTIONS_CACHE.set(commandActions, out)
  return out
}

function isExploringCallFromActions(actions) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) return false
  return list.every((action) => action && typeof action === 'object' && (
    action.kind === 'read' || action.kind === 'list' || action.kind === 'search'
  ))
}

function exploreCountKey(action) {
  if (!action || typeof action !== 'object') return null
  if (action.kind === 'read') {
    return `read:${String(action.name ?? '').trim() || String(action.path ?? '').trim() || String(action.command ?? '').trim()}`
  }
  if (action.kind === 'list') return `list:${String(action.path ?? '').trim() || String(action.command ?? '').trim()}`
  if (action.kind === 'search') {
    const q = String(action.query ?? '').trim() || String(action.command ?? '').trim()
    const p = String(action.path ?? '').trim()
    return `search:${q}::${p}`
  }
  return null
}

function buildTurnBackgroundTimeline({ exploreCalls, reasoningState, toolCalls, reasoningChunks, commentaryChunks, diffEvents }) {
  const calls = Array.isArray(exploreCalls) ? exploreCalls : []
  const tools = Array.isArray(toolCalls) ? toolCalls : []
  const rawReasoningChunks = Array.isArray(reasoningChunks) ? reasoningChunks : []
  const rawCommentaryChunks = Array.isArray(commentaryChunks) ? commentaryChunks : []
  const diffs = Array.isArray(diffEvents) ? diffEvents : []
  const hasDiffs = diffs.some((diff) => String(diff?.raw ?? '').trim())
  const reasoningLoaded = Boolean(reasoningState?.loaded)
  const reasoningSections = rawReasoningChunks.length
    ? []
    : ((reasoningLoaded && Array.isArray(reasoningState?.sections)) ? reasoningState.sections : [])
  const items = []

  for (const section of reasoningSections) {
    if (!section) continue
    const title = String(section.title ?? '').trim()
    const body = String(section.body ?? '')
    if (!title && !body.trim()) continue
    const seq = Number(section.startSeq ?? section.seq ?? NaN)
    const tsMs = Number(section.tsMs ?? NaN)
    items.push({
      kind: 'reasoning',
      id: `reasoning-${String(section.id ?? title ?? items.length + 1)}`,
      seq: Number.isFinite(seq) ? seq : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
      section
    })
  }

  for (const chunk of rawReasoningChunks) {
    if (!chunk) continue
    const text = String(chunk.text ?? '')
    if (!text.trim()) continue
    const seq = Number(chunk.seq ?? NaN)
    const tsMs = Number(chunk.tsMs ?? NaN)
    items.push({
      kind: 'reasoningChunk',
      id: `reasoning-live-${String(chunk.id ?? items.length + 1)}`,
      seq: Number.isFinite(seq) ? seq : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
      text
    })
  }

  for (const chunk of rawCommentaryChunks) {
    if (!chunk) continue
    const text = String(chunk.text ?? '')
    if (!text.trim()) continue
    const seq = Number(chunk.seq ?? NaN)
    const tsMs = Number(chunk.tsMs ?? NaN)
    items.push({
      kind: 'commentaryChunk',
      id: `commentary-live-${String(chunk.id ?? items.length + 1)}`,
      seq: Number.isFinite(seq) ? seq : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
      text
    })
  }

  for (const call of calls) {
    if (!call) continue
    const actions = Array.isArray(call.actions) ? call.actions : []
    if (!actions.length) continue
    const seq = Number(call.seq ?? NaN)
    const tsMs = Number(call.tsMs ?? NaN)
    items.push({
      kind: 'exploreCall',
      id: `explorecall-${String(call.itemId ?? items.length + 1)}`,
      seq: Number.isFinite(seq) ? seq : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
      itemId: String(call.itemId ?? ''),
      actions
    })
  }

  for (const call of tools) {
    if (!call || typeof call !== 'object') continue
    const seq = Number(call.seq ?? NaN)
    const tsMs = Number(call.tsMs ?? NaN)
    items.push({
      kind: 'tool',
      id: `tool-${String(call.itemId ?? items.length + 1)}`,
      seq: Number.isFinite(seq) ? seq : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
      call
    })
  }

  for (const diff of diffs) {
    if (!diff || typeof diff !== 'object') continue
    const raw = String(diff.raw ?? '')
    if (!raw.trim()) continue
    const seq = Number(diff.seq ?? NaN)
    const tsMs = Number(diff.tsMs ?? NaN)
    items.push({
      kind: 'diff',
      id: String(diff.eventId ?? `diff-${items.length + 1}`),
      seq: Number.isFinite(seq) ? seq : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
      raw,
      expanded: Boolean(diff.expanded)
    })
  }

  if (!items.length) return []

  const useSeq = items.every((item) => (typeof item.seq === 'number' && Number.isFinite(item.seq)))
  const ordered = items.map((item, idx) => ({
    ...item,
    _idx: idx,
    _key: useSeq
      ? item.seq
      : ((typeof item.tsMs === 'number' && Number.isFinite(item.tsMs))
        ? item.tsMs
        : ((typeof item.seq === 'number' && Number.isFinite(item.seq)) ? item.seq : idx))
  }))

  ordered.sort((a, b) => (a._key - b._key) || (a._idx - b._idx))

  const readsOnly = (item) => item?.kind === 'exploreCall' &&
    Array.isArray(item.actions) &&
    item.actions.length &&
    item.actions.every((action) => action?.kind === 'read')

  const merged = []
  for (const item of ordered) {
    const prev = merged.length ? merged[merged.length - 1] : null
    if (prev?.kind === 'reasoningChunk' && item.kind === 'reasoningChunk') {
      prev.text += item.text
      continue
    }
    if (prev?.kind === 'commentaryChunk' && item.kind === 'commentaryChunk') {
      prev.text += item.text
      continue
    }
    if (readsOnly(prev) && readsOnly(item)) {
      prev.actions.push(...item.actions)
      continue
    }
    merged.push({ ...item })
  }

  const out = []

  const pushExploreLine = (baseId, label) => {
    const value = String(label ?? '').trim()
    if (!value) return
    out.push({ kind: 'explore', id: `${baseId}-${out.length + 1}`, label: value })
  }

  for (const item of merged) {
    if (item.kind === 'reasoningChunk') {
      out.push({
        kind: 'reasoningText',
        id: item.id,
        text: item.text
      })
      continue
    }
    if (item.kind === 'commentaryChunk') {
      out.push({
        kind: 'commentaryText',
        id: item.id,
        text: item.text
      })
      continue
    }
    if (item.kind === 'reasoning') {
      out.push({ kind: 'reasoning', id: item.id, section: item.section })
      continue
    }
    if (item.kind === 'tool') {
      if (hasDiffs && String(item.call?.tool ?? '') === 'fileChange') continue
      out.push({
        kind: 'tool',
        id: item.id,
        itemId: item.call.itemId,
        tool: item.call.tool,
        command: item.call.command,
        commandActions: item.call.commandActions,
        cwd: item.call.cwd,
        changes: item.call.changes,
        status: item.call.status,
        exitCode: item.call.exitCode,
        expanded: item.call.expanded,
        output: item.call.output
      })
      continue
    }
    if (item.kind === 'diff') {
      out.push({
        kind: 'diff',
        id: item.id,
        raw: item.raw,
        expanded: item.expanded
      })
      continue
    }
    if (item.kind !== 'exploreCall') continue

    const actions = Array.isArray(item.actions) ? item.actions : []
    if (!actions.length) continue

    const readsOnlyActions = actions.every((action) => action?.kind === 'read')
    if (readsOnlyActions) {
      const seen = new Set()
      const names = []
      for (const action of actions) {
        const name = String(action?.name ?? action?.path ?? action?.command ?? '').trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
      if (names.length) pushExploreLine(item.id, `Read ${names.join(', ')}`)
      continue
    }

    for (const action of actions) {
      if (!action || typeof action !== 'object') continue
      if (action.kind === 'read') {
        const name = String(action.name ?? action.path ?? action.command ?? '').trim()
        if (name) pushExploreLine(item.id, `Read ${name}`)
      } else if (action.kind === 'list') {
        const path = String(action.path ?? '').trim() || String(action.command ?? '').trim()
        if (path) pushExploreLine(item.id, `List ${path}`)
      } else if (action.kind === 'search') {
        const query = String(action.query ?? '').trim()
        const path = String(action.path ?? '').trim()
        const cmd = String(action.command ?? '').trim()
        if (query && path) pushExploreLine(item.id, `Search ${query} in ${path}`)
        else if (query) pushExploreLine(item.id, `Search ${query}`)
        else if (cmd) pushExploreLine(item.id, `Search ${cmd}`)
      } else if (action.kind === 'unknown') {
        const cmd = String(action.command ?? '').trim()
        if (cmd) pushExploreLine(item.id, `Run ${cmd}`)
      }
    }
  }

  return out
}

function formatThoughtDuration(ms) {
  const value = Number(ms ?? NaN)
  if (!Number.isFinite(value) || value <= 0) return 'Thought'

  const totalSeconds = Math.max(1, Math.round(value / 1000))
  if (totalSeconds < 60) return `Thought for ${totalSeconds}s`

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    if (minutes > 0) return `Thought for ${hours}h ${minutes}m`
    return `Thought for ${hours}h`
  }
  if (seconds > 0) return `Thought for ${minutes}m ${seconds}s`
  return `Thought for ${minutes}m`
}

function parseReasoningHeading(line) {
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
  const rest = trimmed.slice(close + 2)
  return { title, rest }
}

export function parseReasoningSections(markdown, { maxSections = 200, maxBodyChars = 500_000 } = {}) {
  const text = String(markdown ?? '').replace(/\r/g, '')
  if (!text.trim()) return []

  const lines = text.split('\n')
  const sections = []
  let cur = null

  const start = (title) => {
    if (sections.length >= maxSections) return false
    cur = { id: sections.length + 1, title, body: '' }
    sections.push(cur)
    return true
  }

  for (const line of lines) {
    const heading = parseReasoningHeading(line)
    if (heading) {
      if (!start(heading.title)) break
      const rest = String(heading.rest ?? '').replace(/^\s*:\s*/, '').trim()
      if (rest) cur.body += rest
      continue
    }

    if (!cur) {
      if (!start('Summary')) break
    } else if (cur.body) {
      cur.body += '\n'
    }
    cur.body += line

    if (cur.body.length > maxBodyChars) {
      cur.body = cur.body.slice(0, maxBodyChars)
      break
    }
  }

  return sections
    .map((section) => ({
      ...section,
      title: String(section.title ?? '').trim(),
      body: String(section.body ?? '').trim()
    }))
    .filter((section) => section.title || section.body)
}

function normalizeDiffPath(path) {
  return String(path ?? '')
    .replace(/^[ab]\//, '')
    .replace(/^"(.*)"$/, '$1')
    .trim()
}

export function parseUnifiedDiff(diffText, { maxBytes = 2_000_000, maxLines = 50_000 } = {}) {
  const key = String(diffText ?? '')
  const cached = DIFF_CACHE.get(key)
  if (cached) {
    DIFF_CACHE.delete(key)
    DIFF_CACHE.set(key, cached)
    return cached
  }

  const text = key.replace(/\r/g, '')
  if (!text.trim()) return cacheDiff(key, [])

  if (text.length > maxBytes) {
    return cacheDiff(key, [{
      path: 'Diff too large',
      added: 0,
      removed: 0,
      lines: [{ kind: 'meta', text: `Diff truncated (${text.length} chars)` }],
      raw: text.slice(0, maxBytes)
    }])
  }

  const lines = text.split('\n')
  const limited = (lines.length > maxLines) ? lines.slice(0, maxLines) : lines
  const files = []
  let cur = null

  const ensureCurrent = () => {
    if (cur) return cur
    cur = {
      path: 'Changes',
      oldPath: null,
      newPath: null,
      added: 0,
      removed: 0,
      lines: [],
      raw: ''
    }
    files.push(cur)
    return cur
  }

  const finalizeCurrent = () => {
    if (!cur) return
    cur.path = cur.newPath || cur.oldPath || cur.path || 'Changes'
    cur.raw = cur.lines.map((line) => line.raw ?? line.text ?? '').join('\n')
    cur = null
  }

  for (const line of limited) {
    if (line.startsWith('diff --git ')) {
      finalizeCurrent()
      const next = ensureCurrent()
      next.lines.push({ kind: 'meta', text: line, raw: line })
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
      ensureCurrent().lines.push({ kind: 'hunk', text: line, raw: line })
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const next = ensureCurrent()
      next.added += 1
      next.lines.push({ kind: 'add', text: line.slice(1), raw: line })
      continue
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      const next = ensureCurrent()
      next.removed += 1
      next.lines.push({ kind: 'del', text: line.slice(1), raw: line })
      continue
    }

    ensureCurrent().lines.push({
      kind: line.startsWith(' ') ? 'ctx' : 'meta',
      text: line.startsWith(' ') ? line.slice(1) : line,
      raw: line
    })
  }

  finalizeCurrent()
  return cacheDiff(key, files)
}

export function summarizeUnifiedDiff(diffText, { maxBytes = 2_000_000, maxLines = 50_000 } = {}) {
  const key = String(diffText ?? '')
  const cached = DIFF_SUMMARY_CACHE.get(key)
  if (cached) {
    DIFF_SUMMARY_CACHE.delete(key)
    DIFF_SUMMARY_CACHE.set(key, cached)
    return cached
  }

  const text = key.replace(/\r/g, '')
  if (!text.trim()) {
    const empty = { files: 0, added: 0, removed: 0, paths: [] }
    DIFF_SUMMARY_CACHE.set(key, empty)
    return empty
  }

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
    if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1
    }
  }

  const summary = { files: paths.length, added, removed, paths }
  DIFF_SUMMARY_CACHE.set(key, summary)
  if (DIFF_SUMMARY_CACHE.size > DIFF_CACHE_MAX) {
    const oldest = DIFF_SUMMARY_CACHE.keys().next().value
    if (oldest !== undefined) DIFF_SUMMARY_CACHE.delete(oldest)
  }
  return summary
}

export function diffStepSelectedPath(stepId, files, store) {
  const key = String(stepId ?? '').trim()
  const list = Array.isArray(files) ? files : []
  if (!key || !list.length) return list[0]?.path ?? ''
  const existing = String(store?.diffSelectedFileByEventId?.get?.(key) ?? '').trim()
  if (existing && list.some((file) => file?.path === existing)) return existing
  const fallback = String(list[0]?.path ?? '').trim()
  if (fallback) {
    try { store?.diffSelectedFileByEventId?.set?.(key, fallback) } catch {}
  }
  return fallback
}

export function setDiffStepSelectedPath(stepId, path, store) {
  const key = String(stepId ?? '').trim()
  if (!key) return
  try { store?.diffSelectedFileByEventId?.set?.(key, String(path ?? '')) } catch {}
}

export function diffStepSelectedFile(stepId, files, store) {
  const list = Array.isArray(files) ? files : []
  if (!list.length) return null
  const path = diffStepSelectedPath(stepId, list, store)
  return list.find((file) => file?.path === path) ?? list[0] ?? null
}

function buildChatMessagesSlow(store) {
  const events = Array.isArray(store?.events) ? store.events : []
  const msgs = []
  let currentAssistant = null
  const toolMsgByItemId = new Map()
  let lastDiffText = null

  const reasoningTurnIds = new Set()
  try {
    for (const turnId of store?.turnHasReasoningTokens ?? []) reasoningTurnIds.add(String(turnId))
  } catch {
  }
  try {
    for (const turnId of store?.turnHasReasoningLive ?? []) reasoningTurnIds.add(String(turnId))
  } catch {
  }
  try {
    for (const turnId of store?.turnHasReasoningHistory ?? []) reasoningTurnIds.add(String(turnId))
  } catch {
  }

  let activeTurnId = null
  const turnStateById = new Map()
  const exploreTurnByItemId = new Map()
  const backgroundToolTurnByItemId = new Map()

  const getOrCreateTurnState = (turnId) => {
    const key = String(turnId ?? '').trim()
    if (!key) return null
    let state = turnStateById.get(key)
    if (state) return state
    state = {
      turnId: key,
      msg: {
        id: `bg-${key}`,
        role: 'step',
        stepKind: 'background',
        turnId: key,
        expanded: Boolean(store?.backgroundExpandedByTurnId?.get?.(key)),
        title: 'Thinking',
        hasReasoning: false,
        reasoning: null,
        explore: { files: 0, searches: 0, lists: 0, active: false },
        timeline: null,
        active: false,
        durationMs: null
      },
      inserted: false,
      startedTsMs: null,
      completedTsMs: null,
      exploreFileKeys: new Set(),
      exploreSearchKeys: new Set(),
      exploreListKeys: new Set(),
      exploreCalls: [],
      exploreActiveItemIds: new Set(),
      exploreSeenItemIds: new Set(),
      toolByItemId: new Map(),
      diffEvents: [],
      reasoningChunks: [],
      commentaryChunks: []
    }
    turnStateById.set(key, state)
    return state
  }

  const ensureTurnBackgroundMessage = (turnId) => {
    const state = getOrCreateTurnState(turnId)
    if (!state) return null
    if (!state.inserted) {
      msgs.push(state.msg)
      state.inserted = true
    }
    return state
  }

  const beginTurn = (turnId, tsMs = null) => {
    activeTurnId = String(turnId ?? '').trim() || null
    if (!activeTurnId) return
    const state = ensureTurnBackgroundMessage(activeTurnId)
    const startTs = Number(tsMs ?? NaN)
    if (state && Number.isFinite(startTs) && startTs > 0) state.startedTsMs = startTs
  }

  const ensureAssistant = (idHint) => {
    if (currentAssistant) return currentAssistant
    currentAssistant = {
      id: idHint,
      role: 'assistant',
      text: '',
      turnId: activeTurnId ? String(activeTurnId) : null
    }
    msgs.push(currentAssistant)
    return currentAssistant
  }

  for (const event of events) {
    if (event.type === 'session.input') {
      msgs.push({
        id: event.eventId,
        role: 'user',
        text: event.payload?.text ?? '',
        attachments: Array.isArray(event.payload?.attachments) ? event.payload.attachments : []
      })
      currentAssistant = null
      activeTurnId = null
      toolMsgByItemId.clear()
      continue
    }

    if (event.type === 'turn.started') {
      currentAssistant = null
      toolMsgByItemId.clear()
      beginTurn(event.payload?.turnId ?? event.eventId, event.tsMs)
      continue
    }

    if (event.type === 'turn.completed') {
      currentAssistant = null
      const turnId = String(event.payload?.turnId ?? '').trim() || activeTurnId
      const state = getOrCreateTurnState(turnId)
      const completedTs = Number(event.tsMs ?? NaN)
      if (state && Number.isFinite(completedTs) && completedTs > 0) state.completedTsMs = completedTs
      activeTurnId = null
      continue
    }

    if (event.type === 'diff.updated') {
      const diff = (typeof event.payload?.diff === 'string') ? event.payload.diff : ''
      if (!String(diff ?? '').trim()) continue
      if (lastDiffText === diff) continue
      lastDiffText = diff
      const turnId = String(activeTurnId ?? '').trim()
      if (turnId) {
        const state = ensureTurnBackgroundMessage(turnId)
        if (state) {
          state.diffEvents.push({
            eventId: event.eventId,
            raw: diff,
            seq: event.seq ?? null,
            tsMs: event.tsMs ?? null,
            expanded: Boolean(store?.diffExpandedByEventId?.get?.(String(event.eventId)))
          })
          continue
        }
      }
      msgs.push({
        id: event.eventId,
        role: 'step',
        stepKind: 'diff',
        raw: diff,
        expanded: Boolean(store?.diffExpandedByEventId?.get?.(String(event.eventId)))
      })
      continue
    }

    if (event.type === 'session.output') {
      const stream = event.payload?.stream ?? 'normalized'
      const text = event.payload?.text ?? ''
      if (stream === 'reasoning') {
        const turnId = String(activeTurnId ?? '').trim()
        if (turnId) {
          const state = ensureTurnBackgroundMessage(turnId)
          if (state && String(text ?? '').trim()) {
            state.reasoningChunks.push({
              id: event.eventId,
              text: String(text ?? ''),
              seq: event.seq ?? null,
              tsMs: event.tsMs ?? null
            })
          }
        }
        continue
      }
      if (stream === 'commentary') {
        const turnId = String(activeTurnId ?? '').trim()
        if (turnId) {
          const state = ensureTurnBackgroundMessage(turnId)
          if (state && String(text ?? '').trim()) {
            state.commentaryChunks.push({
              id: event.eventId,
              text: String(text ?? ''),
              seq: event.seq ?? null,
              tsMs: event.tsMs ?? null
            })
          }
        }
        continue
      }
      if (stream === 'normalized') {
        ensureAssistant(currentAssistant?.id ?? event.eventId).text += text
      } else if ((stream === 'stderr' || stream === 'stdout') && !event.payload?.itemId) {
        msgs.push({ id: event.eventId, role: 'system', stream, text: String(text ?? '') })
      }
      continue
    }

    if (event.type === 'session.status' && event.payload?.status === 'failed') {
      msgs.push({ id: event.eventId, role: 'system', text: `Session failed: ${event.payload?.error ?? 'unknown error'}` })
      continue
    }

    if (event.type !== 'tool.started' && event.type !== 'tool.completed') continue

    const tool = event.payload?.tool
    const itemId = String(event.payload?.itemId ?? '')
    if (!itemId) continue

    const lowerTool = String(tool ?? '').toLowerCase()
    const displayTool = lowerTool === 'commandexecution'
      ? 'commandExecution'
      : (lowerTool === 'filechange' ? 'fileChange' : tool)
    if (lowerTool === 'commandexecution') {
      const actions = normalizeCommandActions(event.payload?.commandActions)
      const exploreTurnId = String(exploreTurnByItemId.get(itemId) ?? activeTurnId ?? '').trim() || null
      if (isExploringCallFromActions(actions)) {
        if (!exploreTurnId) continue
        const state = ensureTurnBackgroundMessage(exploreTurnId)
        if (!state) continue
        if (event.type === 'tool.started') {
          exploreTurnByItemId.set(itemId, exploreTurnId)
          state.exploreActiveItemIds.add(itemId)
        } else {
          state.exploreActiveItemIds.delete(itemId)
          if (state.exploreSeenItemIds.has(itemId)) continue
          state.exploreSeenItemIds.add(itemId)

          for (const action of actions) {
            const key = exploreCountKey(action)
            if (!key) continue
            if (action.kind === 'read') state.exploreFileKeys.add(key)
            else if (action.kind === 'search') state.exploreSearchKeys.add(key)
            else if (action.kind === 'list') state.exploreListKeys.add(key)
          }
          state.exploreCalls.push({ itemId, actions, seq: event.seq ?? null, tsMs: event.tsMs ?? null })
        }
        continue
      }
    }

    const foldIntoBackground = lowerTool === 'commandexecution' || lowerTool === 'filechange'
    const toolTurnId = String(backgroundToolTurnByItemId.get(itemId) ?? activeTurnId ?? '').trim() || null
    if (foldIntoBackground && toolTurnId) {
      if (event.type === 'tool.started') backgroundToolTurnByItemId.set(itemId, toolTurnId)
      const state = ensureTurnBackgroundMessage(toolTurnId)
      if (!state) continue
      let call = state.toolByItemId.get(itemId) ?? null
      if (!call) {
        call = {
          itemId,
          tool: displayTool,
          command: event.payload?.command ?? null,
          commandActions: event.payload?.commandActions ?? null,
          cwd: event.payload?.cwd ?? null,
          changes: Array.isArray(event.payload?.changes) ? event.payload.changes : null,
          status: event.payload?.status ?? (event.type === 'tool.started' ? 'running' : 'completed'),
          exitCode: event.payload?.exitCode ?? null,
          expanded: Boolean(store?.toolExpanded?.get?.(itemId)),
          output: store?.toolOutputByItemId?.get?.(itemId) ?? null,
          seq: event.seq ?? null,
          tsMs: event.tsMs ?? null
        }
        state.toolByItemId.set(itemId, call)
      } else {
        call.tool = displayTool ?? call.tool
        call.command = event.payload?.command ?? call.command
        call.commandActions = event.payload?.commandActions ?? call.commandActions
        call.cwd = event.payload?.cwd ?? call.cwd
        call.changes = Array.isArray(event.payload?.changes) ? event.payload.changes : call.changes
        call.status = event.payload?.status ?? call.status
        if (!call.status) call.status = (event.type === 'tool.started') ? 'running' : 'completed'
        if (event.payload?.exitCode !== undefined) call.exitCode = event.payload.exitCode
        if ((call.seq === null || call.seq === undefined) && event.seq !== undefined) call.seq = event.seq
        if ((call.tsMs === null || call.tsMs === undefined) && event.tsMs !== undefined) call.tsMs = event.tsMs
      }
      call.expanded = Boolean(store?.toolExpanded?.get?.(itemId))
      call.output = store?.toolOutputByItemId?.get?.(itemId) ?? call.output
      continue
    }

    let msg = toolMsgByItemId.get(itemId) ?? null
    if (!msg) {
      msg = {
        id: `tool-${itemId}`,
        role: 'step',
        stepKind: 'tool',
        tool: displayTool,
        itemId,
        command: event.payload?.command ?? null,
        commandActions: event.payload?.commandActions ?? null,
        cwd: event.payload?.cwd ?? null,
        changes: Array.isArray(event.payload?.changes) ? event.payload.changes : null,
        status: event.payload?.status ?? (event.type === 'tool.started' ? 'running' : 'completed'),
        exitCode: event.payload?.exitCode ?? null,
        expanded: Boolean(store?.toolExpanded?.get?.(itemId)),
        output: store?.toolOutputByItemId?.get?.(itemId) ?? null
      }
      msgs.push(msg)
      toolMsgByItemId.set(itemId, msg)
    } else {
      msg.tool = displayTool ?? msg.tool
      msg.command = event.payload?.command ?? msg.command
      msg.commandActions = event.payload?.commandActions ?? msg.commandActions
      msg.cwd = event.payload?.cwd ?? msg.cwd
      msg.changes = Array.isArray(event.payload?.changes) ? event.payload.changes : msg.changes
      msg.status = event.payload?.status ?? msg.status
      if (!msg.status) msg.status = (event.type === 'tool.started') ? 'running' : 'completed'
      if (event.payload?.exitCode !== undefined) msg.exitCode = event.payload.exitCode
      msg.expanded = Boolean(store?.toolExpanded?.get?.(itemId))
      msg.output = store?.toolOutputByItemId?.get?.(itemId) ?? msg.output
    }
  }

  const filtered = msgs.filter((msg) => {
    if (msg?.stepKind !== 'background') return true
    const state = turnStateById.get(String(msg.turnId ?? ''))
    if (!state) return false

    const isCurrentTurn = String(store?.currentTurnId ?? '').trim() === state.turnId
    const toolCalls = Array.from(state.toolByItemId.values())
    const explore = {
      files: state.exploreFileKeys.size,
      searches: state.exploreSearchKeys.size,
      lists: state.exploreListKeys.size,
      active: Boolean(state.exploreActiveItemIds.size)
    }
    const hasCommentary = Array.isArray(state.commentaryChunks) && state.commentaryChunks.length > 0
    const hasRunningTool = toolCalls.some((call) => String(call?.status ?? '').toLowerCase() === 'running')
    const active = Boolean(isCurrentTurn || explore.active || hasRunningTool)
    const expanded = active || Boolean(store?.backgroundExpandedByTurnId?.get?.(state.turnId))
    const reasoningState = expanded ? getTurnReasoningState(store, state.turnId) : null
    const hasReasoning = reasoningTurnIds.has(state.turnId) || Boolean(
      reasoningState?.loaded &&
      Array.isArray(reasoningState?.sections) &&
      reasoningState.sections.length
    )
    if (!isCurrentTurn && !hasReasoning && !hasCommentary && !explore.files && !explore.searches && !explore.lists && !explore.active && !toolCalls.length && !state.diffEvents.length) {
      return false
    }

    msg.expanded = expanded
    const startedTsMs = Number(state.startedTsMs ?? NaN)
    const completedTsMs = Number(state.completedTsMs ?? NaN)
    const durationMs = (Number.isFinite(startedTsMs) && Number.isFinite(completedTsMs) && completedTsMs >= startedTsMs)
      ? (completedTsMs - startedTsMs)
      : null
    msg.title = active ? 'Thinking' : formatThoughtDuration(durationMs)
    msg.hasReasoning = hasReasoning
    msg.hasCommentary = hasCommentary
    msg.reasoning = reasoningState
    msg.explore = explore
    msg.active = active
    msg.durationMs = durationMs
    msg.timeline = expanded
      ? buildTurnBackgroundTimeline({
          exploreCalls: state.exploreCalls,
          reasoningState,
          toolCalls,
          diffEvents: state.diffEvents,
          reasoningChunks: state.reasoningChunks,
          commentaryChunks: state.commentaryChunks
        })
      : null
    return true
  })

  const currentTurnId = String(store?.currentTurnId ?? '').trim()
  const visible = currentTurnId
    ? filtered.filter((msg) => !(msg?.role === 'assistant' && String(msg?.turnId ?? '').trim() === currentTurnId))
    : filtered

  const activeBackgrounds = visible.filter((msg) => msg?.stepKind === 'background' && msg.active)
  if (!activeBackgrounds.length) return visible

  const remaining = visible.filter((msg) => !(msg?.stepKind === 'background' && msg.active))
  remaining.push(...activeBackgrounds)
  return remaining
}

export function buildChatMessages(store) {
  if (!store) return []
  const events = Array.isArray(store.events) ? store.events : []
  const version = Number(store.messageViewVersion ?? 0)
  const lastEventId = events.length ? String(events[events.length - 1]?.eventId ?? '') : ''
  const cached = CHAT_MESSAGES_CACHE.get(store)
  if (
    cached &&
    cached.version === version &&
    cached.eventCount === events.length &&
    cached.lastEventId === lastEventId
  ) {
    return cached.messages
  }

  const messages = buildChatMessagesSlow(store)
  CHAT_MESSAGES_CACHE.set(store, {
    version,
    eventCount: events.length,
    lastEventId,
    messages
  })
  return messages
}
