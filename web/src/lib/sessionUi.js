export function createSessionStoreState() {
  return {
    events: [],
    diff: '',
    plan: null,
    planExplanation: null,
    planPinnedOpen: true,
    currentTurnId: null,
    turnHasReasoningLive: new Set(),
    turnHasReasoningHistory: new Set(),
    turnHasReasoningTokens: new Set(),
    backgroundExpandedByTurnId: new Map(),
    reasoningByTurnId: new Map(),
    seen: new Set(),
    historyLoaded: false,
    lastLoadedSeq: 0,
    hasMoreBefore: true,
    nextBeforeSeq: null,
    loadingBefore: false,
    loadingAfter: false,
    pendingAfter: [],
    lastRealtimeSeqSeen: 0,
    messageViewVersion: 0,
    chatScrollTop: 0,
    chatStickToBottom: true,
    queuedPrompts: [],
    queueSending: false,
    restoredPrompt: null,
    restoredPromptError: '',
    toolOutputByItemId: new Map(),
    toolExpanded: new Map(),
    diffExpandedByEventId: new Map(),
    diffSelectedFileByEventId: new Map()
  }
}

export function upsertById(arr, key, value) {
  const idx = arr.findIndex((x) => x?.[key] === value?.[key])
  if (idx >= 0) arr[idx] = { ...arr[idx], ...value }
  else arr.push(value)
}

export function basenamePath(input) {
  const path = String(input ?? '')
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

export function sessionProject(session) {
  return (session?.projectLabel && String(session.projectLabel).trim())
    ? String(session.projectLabel).trim()
    : basenamePath(session?.cwd)
}

export function sessionHostName(session, machineNameById) {
  const value = machineNameById?.get?.(session?.machineId)
  if (typeof value === 'string' && value) return value
  if (value?.machineAlias) return String(value.machineAlias)
  if (value?.machineName) return String(value.machineName)
  return session?.machineId ? String(session.machineId).slice(0, 8) : 'unknown'
}

export function sessionListTitle(session) {
  const title = String(session?.title ?? '').trim()
  if (title) return title

  const lastSeq = Number(session?.lastSeq ?? 0) || 0
  const preview = String(session?.preview ?? '').trim()
  if (!preview && lastSeq <= 0) return 'New thread'

  return sessionProject(session) || (session?.sessionId ? String(session.sessionId).slice(0, 8) : 'Session')
}

export function sessionInitial(session) {
  const title = sessionListTitle(session)
  const ch = String(title ?? '').trim().slice(0, 1).toUpperCase()
  return ch || 'S'
}

export function sessionTooltip(session, machineNameById) {
  const parts = [
    sessionListTitle(session),
    `${sessionProject(session)} · ${sessionHostName(session, machineNameById)} · ${String(session?.status ?? 'unknown')}`
  ]
  return parts.filter(Boolean).join(' — ')
}

export function sessionIndicator(session) {
  const pending = Number(session?.pendingApprovals ?? 0)
  if (pending > 0) return 'red'
  const working = (session?.turnState === 'running') || (session?.status === 'starting')
  if (working) return 'orange'
  const unread = Number(session?.lastSeq ?? 0) > Number(session?.lastReadSeq ?? 0)
  if (unread) return 'blue'
  return 'green'
}

export function sessionListAccentTone(session) {
  const pending = Number(session?.pendingApprovals ?? 0)
  const status = String(session?.status ?? '').toLowerCase()
  if (pending > 0 || status === 'failed') return 'red'
  const unread = Number(session?.lastSeq ?? 0) > Number(session?.lastReadSeq ?? 0)
  if (unread) return 'blue'
  return 'default'
}

export function sessionListAccentClass(session, { selected = false } = {}) {
  const tone = sessionListAccentTone(session)
  if (tone === 'red') return selected ? 'bg-red-500 text-white' : 'bg-red-500 text-white hover:bg-red-500'
  if (tone === 'blue') return selected ? 'bg-sky-500 text-white' : 'bg-sky-500 text-white hover:bg-sky-500'
  return selected ? 'bg-[#ecece8]' : 'hover:bg-black/[0.035]'
}

export function sessionListTextClass(session, { muted = false, chip = false } = {}) {
  const tone = sessionListAccentTone(session)
  if (tone === 'default') {
    if (chip) return 'border-black/[0.08] text-slate-500'
    return muted ? 'text-slate-400' : 'text-slate-700'
  }
  if (chip) return 'border-white/25 text-white/90'
  return muted ? 'text-white/80' : 'text-white'
}
