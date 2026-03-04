<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Archive, ArrowDown, Code, Copy, Loader2, PanelRightClose, PanelRightOpen, Plus, Send, Settings, Square, Trash2, X } from 'lucide-vue-next'

import MarkdownView from './components/MarkdownView.vue'

const authed = ref(false)
const authToken = ref('')
const authError = ref('')

const sseStatus = ref('disconnected') // disconnected|connecting|connected|error
const everConnected = ref(false)
const networkOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
const sseDisconnectReason = ref(null) // heartbeat-timeout|closed|error|null
const lastSseMessageAt = ref(Date.now())
let heartbeatCheckTimer = null
let es = null
const sseConnectionId = ref(null)
let visibilityPostTimer = null
let onlineHandler = null
let offlineHandler = null

const machines = ref([])
const sessions = ref([])
const selectedSessionId = ref(null)
const hasSnapshot = ref(false)

const visibleSessions = computed(() => sessions.value.filter((s) => !s?.archivedMs))

const newThreadRecentWorkspaces = computed(() => {
  const mid = String(newThreadMachineId.value ?? '').trim()
  const rows = sessions.value
    .filter((s) => !s?.archivedMs && (!mid || s.machineId === mid))
    .slice()
    .sort((a, b) => Number(b?.updatedMs ?? 0) - Number(a?.updatedMs ?? 0))

  const seen = new Set()
  const out = []
  for (const s of rows) {
    const cwd = String(s?.cwd ?? '').trim()
    if (!cwd || seen.has(cwd)) continue
    seen.add(cwd)
    out.push({ cwd, label: sessionProject(s) })
    if (out.length >= 10) break
  }
  return out
})

const composerDragging = ref(false)
let composerDragDepth = 0

const machineNameById = computed(() => {
  const m = new Map()
  for (const row of machines.value) m.set(row.machineId, row.machineName)
  return m
})

const connectionBanner = computed(() => {
  if (!authed.value) return null
  if (!networkOnline.value) {
    return { tone: 'error', text: 'Offline. Reconnecting when back online…' }
  }
  if (sseStatus.value === 'connected') return null
  const reason = sseDisconnectReason.value
  const reasonSuffix = reason ? ` (${String(reason)})` : ''
  if (sseStatus.value === 'connecting') {
    return { tone: 'warning', text: (everConnected.value ? 'Reconnecting…' : 'Connecting…') + reasonSuffix }
  }
  if (sseStatus.value === 'error') {
    return { tone: 'warning', text: (everConnected.value ? 'Connection lost. Retrying…' : 'Unable to connect. Retrying…') + reasonSuffix }
  }
  return { tone: 'warning', text: 'Disconnected.' + reasonSuffix }
})

// sessionId -> { events: [], diff: string, seen: Set<string> }
const sessionStores = reactive(new Map())
// sessionId -> { tokenUsage?: any, info?: any }
const tokenUsageBySessionId = reactive(new Map())
const approvalQueue = ref([]) // [{ approvalId, sessionId, kind, ... }]

const approvalResponding = ref(false)
const approvalRespondError = ref('')

const userInputSubmitting = ref(false)
const userInputError = ref('')
// questionId -> { choice: string, other: string, text: string }
const userInputForm = reactive({})

const defaultsOpen = ref(false)
const defaultsError = ref('')
const defaults = reactive({
  cwd: '',
  machineId: '',
  model: '',
  reasoningEffort: '',
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write'
})

// New thread dialog (Codex-style "pick machine + workspace" before starting).
const newThreadOpen = ref(false)
const newThreadMachineId = ref('')
const newThreadCwd = ref('')
const newThreadError = ref('')

const newThreadBrowseOpen = ref(false)
const newThreadBrowsePath = ref('')
const newThreadBrowseParent = ref(null)
const newThreadBrowseEntries = ref([]) // [{ name, path, kind }]
const newThreadBrowseLoading = ref(false)
const newThreadBrowseError = ref('')

const settingsTab = ref('defaults') // defaults|machines|system

const machinesForSelect = computed(() => {
  return machines.value
    .slice()
    .sort((a, b) => {
      const ao = machineIsOnline(a) ? 1 : 0
      const bo = machineIsOnline(b) ? 1 : 0
      if (ao !== bo) return bo - ao
      return Number(b?.lastSeenMs ?? 0) - Number(a?.lastSeenMs ?? 0)
    })
})

const newThreadSelectedMachine = computed(() => {
  const mid = String(newThreadMachineId.value ?? '').trim()
  if (!mid) return null
  return machines.value.find((m) => m?.machineId === mid) ?? null
})

const newThreadSelectedMachineOnline = computed(() => {
  const m = newThreadSelectedMachine.value
  return m ? machineIsOnline(m) : false
})

const defaultsSelectedMachine = computed(() => {
  const mid = String(defaults.machineId ?? '').trim()
  if (!mid) return null
  return machines.value.find((m) => m?.machineId === mid) ?? null
})

const deleteMachineRow = computed(() => {
  const mid = String(deleteMachineId.value ?? '').trim()
  if (!mid) return null
  return machines.value.find((m) => m?.machineId === mid) ?? null
})

const appSettingsLoaded = ref(false)
const appSettingsError = ref('')
const appSettingsSaving = ref(false)
const retentionDraft = ref('')
const sseToastsDraft = ref('if-not-visible') // always|never|if-not-visible
const webPushDraft = ref('if-not-visible') // always|never|if-not-visible
const appSettings = reactive({
  retentionDays: 30,
  notifications: { sseToasts: 'if-not-visible', webPush: 'if-not-visible' },
  host: null,
  runner: null
})

// Web Push subscription state (service worker push manager).
const pushSupported = computed(() => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window)
const pushStatus = ref('unknown') // unknown|subscribed|unsubscribed|unsupported|insecure
const pushEndpoint = ref(null)
const pushWorking = ref(false)
const pushError = ref('')

const deepLinkSessionId = ref(null)

const nowMs = ref(Date.now())
let nowTimer = null

const messageDraft = ref('')
const attachments = ref([]) // [{ id, filename, mimeType, sizeBytes, contentBase64, previewUrl }]
const fileInputEl = ref(null)
const sendError = ref('')
const ideError = ref('')
const sending = ref(false)
const ideStarting = ref(false)

const showPlan = ref(false)

const chatScrollEl = ref(null)
const stickToBottom = ref(true)

// Toast notifications delivered via SSE (host-generated).
const toasts = ref([]) // [{ id, level, title, message, sessionId?, stickyUntilVisible? }]
let toastSeq = 0

const renameOpen = ref(false)
const renameSessionId = ref(null)
const renameTitleValue = ref('')
const renameProjectValue = ref('')
const renameFocus = ref('title') // title|project
const renameError = ref('')

const sessionPolicyOpen = ref(false)
const sessionPolicySaving = ref(false)
const sessionPolicyError = ref('')
const sessionApprovalDraft = ref('on-request')
const sessionSandboxDraft = ref('workspace-write')

const archiveOpen = ref(false)
const archivedSessions = ref([])
const archiveLoading = ref(false)
const archiveError = ref('')

const deleteOpen = ref(false)
const deleteSessionId = ref(null)
const deleteWorking = ref(false)
const deleteError = ref('')

const deleteMachineOpen = ref(false)
const deleteMachineId = ref(null)
const deleteMachineWorking = ref(false)
const deleteMachineError = ref('')

const machineDisconnectWorkingId = ref(null)
const machineDisconnectError = ref('')

let markReadTimer = null
const sessionLoading = ref(false)
let loadSessionNonce = 0
let keydownHandler = null
let visibilityHandler = null
let swMessageHandler = null

function getSessionStore(sessionId) {
  let store = sessionStores.get(sessionId)
  if (!store) {
    store = reactive({
      events: [],
      diff: '',
      plan: null,
      planExplanation: null,
      lastReasoningChunk: { text: null, tsMs: 0 },
      seen: new Set(),
      hasMoreBefore: true,
      nextBeforeSeq: null,
      loadingBefore: false,
      toolOutputByItemId: new Map(), // itemId -> { stdout, stderr, loaded, loading, hasMoreBefore, nextBeforeSeq }
      toolExpanded: new Map(), // itemId -> boolean
      diffSelectedFileByEventId: new Map() // diffEventId -> path
    })
    sessionStores.set(sessionId, store)
  }
  return store
}

function upsertById(arr, key, value) {
  const idx = arr.findIndex((x) => x?.[key] === value?.[key])
  if (idx >= 0) arr[idx] = { ...arr[idx], ...value }
  else arr.push(value)
}

function upsertSessionRow(value) {
  const sessionId = value?.sessionId
  if (!sessionId) return
  const idx = sessions.value.findIndex((s) => s.sessionId === sessionId)
  if (idx >= 0) sessions.value[idx] = { ...sessions.value[idx], ...value }
  else sessions.value.unshift(value)
}

function bumpSessionToTop(sessionId) {
  const idx = sessions.value.findIndex((s) => s.sessionId === sessionId)
  if (idx <= 0) return
  const [row] = sessions.value.splice(idx, 1)
  sessions.value.unshift(row)
}

function removeMachineLocal(machineId) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return

  // Drop sessions first (also clears any selected view + cached stores).
  for (let i = sessions.value.length - 1; i >= 0; i--) {
    const s = sessions.value[i]
    if (s?.machineId !== mid) continue
    const sid = s?.sessionId
    sessions.value.splice(i, 1)
    if (sid) {
      if (selectedSessionId.value === sid) selectedSessionId.value = null
      try { sessionStores.delete(sid) } catch {}
    }
  }

  const midx = machines.value.findIndex((m) => m?.machineId === mid)
  if (midx >= 0) machines.value.splice(midx, 1)

  if (defaults.machineId === mid) defaults.machineId = ''
  if (newThreadMachineId.value === mid) newThreadMachineId.value = machinesForSelect.value[0]?.machineId ?? ''
}

function basenamePath(input) {
  const p = String(input ?? '')
  if (!p) return ''
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function sessionProject(s) {
  return (s?.projectLabel && String(s.projectLabel).trim()) ? String(s.projectLabel).trim() : basenamePath(s?.cwd)
}

function sessionHostName(s) {
  const name = machineNameById.value.get(s?.machineId)
  if (name) return name
  return s?.machineId ? String(s.machineId).slice(0, 8) : 'unknown'
}

function sessionListTitle(s) {
  const t = String(s?.title ?? '').trim()
  return t || sessionProject(s) || (s?.sessionId ? String(s.sessionId).slice(0, 8) : 'Session')
}

function sessionInitial(s) {
  const t = sessionListTitle(s)
  const c = String(t ?? '').trim().slice(0, 1).toUpperCase()
  return c || 'S'
}

function sessionTooltip(s) {
  const parts = [
    sessionListTitle(s),
    `${sessionProject(s)} · ${sessionHostName(s)} · ${String(s?.status ?? 'unknown')}`
  ]
  return parts.filter(Boolean).join(' — ')
}

function replaceUrlSessionParam(sessionId) {
  try {
    const u = new URL(window.location.href)
    if (sessionId) u.searchParams.set('session', String(sessionId))
    else u.searchParams.delete('session')
    window.history.replaceState({}, '', u.toString())
  } catch {
  }
}

function sessionIndicator(s) {
  const pending = Number(s?.pendingApprovals ?? 0)
  if (pending > 0) return 'red'
  const working = (s?.turnState === 'running') || (s?.status === 'starting')
  if (working) return 'orange'
  const unread = Number(s?.lastSeq ?? 0) > Number(s?.lastReadSeq ?? 0)
  if (unread) return 'blue'
  return 'green'
}

function indicatorDotClass(color) {
  if (color === 'red') return 'bg-red-500'
  if (color === 'orange') return 'bg-amber-500'
  if (color === 'blue') return 'bg-sky-500'
  return 'bg-emerald-500'
}

function statusChipClass(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'failed') return 'border-red-500/20 bg-red-500/10 text-red-200'
  if (s === 'exited') return 'border-slate-700/60 bg-slate-200/5 text-slate-300'
  if (s === 'starting') return 'border-amber-500/20 bg-amber-500/10 text-amber-200'
  if (s === 'stopping') return 'border-slate-700/60 bg-slate-200/5 text-slate-300'
  if (s === 'running') return 'border-slate-800 bg-slate-950/60 text-slate-400'
  return 'border-slate-800 bg-slate-950/60 text-slate-400'
}

function planDotClass(status) {
  const s = String(status ?? '')
  if (s === 'completed') return 'bg-emerald-400'
  if (s === 'inProgress') return 'bg-amber-400'
  return 'bg-slate-600'
}

async function apiFetch(path, opts = {}) {
  return await fetch(path, {
    ...opts,
    credentials: 'include',
    headers: {
      ...(opts.headers ?? {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    }
  })
}

function currentVisibility() {
  try {
    return (document.visibilityState === 'visible') ? 'visible' : 'hidden'
  } catch {
    return 'visible'
  }
}

async function postVisibilityNow() {
  const connectionId = sseConnectionId.value
  if (!connectionId) return
  await apiFetch('/api/visibility', {
    method: 'POST',
    body: JSON.stringify({ connectionId, visibility: currentVisibility() })
  }).catch(() => {})
}

function schedulePostVisibility() {
  if (!sseConnectionId.value) return
  if (visibilityPostTimer) clearTimeout(visibilityPostTimer)
  visibilityPostTimer = setTimeout(() => {
    visibilityPostTimer = null
    postVisibilityNow()

    const vis = currentVisibility()
    if (vis !== 'visible') {
      if (markReadTimer) clearTimeout(markReadTimer)
      markReadTimer = null
    } else if (selectedSessionId.value && stickToBottom.value) {
      scheduleMarkRead(selectedSessionId.value)
    }

    // If we just became visible, surface any sticky toasts (no browser permission)
    if (vis === 'visible') {
      for (const t of toasts.value) {
        if (!t?.stickyUntilVisible) continue
        t.stickyUntilVisible = false
        scheduleDismissToast(t.id, 7_500)
      }
    }
  }, 150)
}

const notificationSupported = computed(() => typeof window !== 'undefined' && 'Notification' in window)
const notificationPermission = ref('unsupported') // unsupported|default|denied|granted

function refreshNotificationPermission() {
  if (!notificationSupported.value) {
    notificationPermission.value = 'unsupported'
    return
  }
  try {
    notificationPermission.value = Notification.permission
  } catch {
    notificationPermission.value = 'unsupported'
  }
}

async function requestNotificationPermission() {
  if (!notificationSupported.value) return
  try {
    const p = await Notification.requestPermission()
    notificationPermission.value = p
  } catch {
    refreshNotificationPermission()
  }
}

function toastBorderClass(level) {
  const l = String(level ?? '')
  if (l === 'error') return 'border-red-200 bg-red-50'
  if (l === 'warning') return 'border-amber-200 bg-amber-50'
  if (l === 'success') return 'border-emerald-200 bg-emerald-50'
  return 'border-slate-200 bg-white'
}

function dismissToast(id) {
  const idx = toasts.value.findIndex((t) => t?.id === id)
  if (idx >= 0) toasts.value.splice(idx, 1)
}

function scheduleDismissToast(id, ms = 6_000) {
  setTimeout(() => dismissToast(id), ms).unref?.()
}

function showBrowserToast(toast) {
  if (!notificationSupported.value) return false
  if (notificationPermission.value !== 'granted') return false
  try {
    const n = new Notification(String(toast?.title ?? 'Rootgrid'), {
      body: String(toast?.message ?? ''),
      tag: toast?.sessionId ? `rootgrid:${toast.sessionId}` : undefined
    })
    n.onclick = () => {
      try { window.focus() } catch {}
      if (toast?.sessionId) selectedSessionId.value = toast.sessionId
      try { n.close() } catch {}
    }
    return true
  } catch {
    return false
  }
}

function urlBase64ToUint8Array(base64String) {
  // Base64URL → Uint8Array (for PushManager subscribe)
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function refreshPushSubscription() {
  pushError.value = ''
  pushEndpoint.value = null

  if (!pushSupported.value) {
    pushStatus.value = 'unsupported'
    return
  }

  if (typeof window !== 'undefined' && !window.isSecureContext) {
    pushStatus.value = 'insecure'
    return
  }

  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) {
      pushStatus.value = 'unsubscribed'
      return
    }
    pushStatus.value = 'subscribed'
    pushEndpoint.value = sub.endpoint ?? null
  } catch (err) {
    pushStatus.value = 'unknown'
    pushError.value = String(err?.message ?? err)
  }
}

async function enablePush() {
  pushError.value = ''
  if (!pushSupported.value) return
  pushWorking.value = true
  try {
    if (notificationPermission.value !== 'granted') {
      await requestNotificationPermission()
    }
    if (notificationPermission.value !== 'granted') {
      pushError.value = 'Notification permission not granted.'
      return
    }

    const keyRes = await apiFetch('/api/push/vapid-public-key')
    if (!keyRes.ok) {
      const err = await keyRes.json().catch(() => null)
      pushError.value = err?.error ?? `HTTP ${keyRes.status}`
      return
    }
    const keyData = await keyRes.json().catch(() => null)
    const publicKey = keyData?.publicKey
    if (!publicKey || typeof publicKey !== 'string') {
      pushError.value = 'Invalid VAPID public key.'
      return
    }

    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    })

    const res = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub)
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      pushError.value = err?.error ?? `HTTP ${res.status}`
      return
    }

    await refreshPushSubscription()
  } catch (err) {
    pushError.value = String(err?.message ?? err)
  } finally {
    pushWorking.value = false
  }
}

async function disablePush() {
  pushError.value = ''
  if (!pushSupported.value) return
  pushWorking.value = true
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) {
      await refreshPushSubscription()
      return
    }

    await apiFetch('/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: sub.endpoint })
    }).catch(() => {})

    try { await sub.unsubscribe() } catch { }
    await refreshPushSubscription()
  } catch (err) {
    pushError.value = String(err?.message ?? err)
  } finally {
    pushWorking.value = false
  }
}

function openSettings(tab = 'defaults') {
  settingsTab.value = tab
  defaultsOpen.value = true
  if (authed.value && !appSettingsLoaded.value) {
    // fire-and-forget
    loadAppSettings().catch(() => {})
  }
  if (tab === 'system') {
    refreshPushSubscription().catch(() => {})
  }
}

function formatAgo(ts) {
  const ms = Number(ts ?? 0)
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown'
  const delta = Math.max(0, nowMs.value - ms)
  if (delta < 5_000) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function formatAgeShort(ts) {
  const ms = Number(ts ?? 0)
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const delta = Math.max(0, nowMs.value - ms)
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 14) return `${day}d`
  const wk = Math.floor(day / 7)
  if (wk < 9) return `${wk}w`
  const mo = Math.floor(day / 30)
  if (mo < 24) return `${mo}mo`
  const yr = Math.floor(day / 365)
  return `${yr}y`
}

function formatCompactInt(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function normalizeTokenUsage(payload) {
  if (!payload || typeof payload !== 'object') return null

  const v2 = payload.tokenUsage
  if (v2 && typeof v2 === 'object') {
    const lastTotal = Number(v2?.last?.totalTokens ?? NaN)
    const totalTotal = Number(v2?.total?.totalTokens ?? NaN)
    const ctx = (v2?.modelContextWindow === null || v2?.modelContextWindow === undefined) ? null : Number(v2.modelContextWindow)
    if (Number.isFinite(lastTotal) || Number.isFinite(totalTotal)) {
      return {
        kind: 'v2',
        lastTotalTokens: Number.isFinite(lastTotal) ? lastTotal : null,
        totalTotalTokens: Number.isFinite(totalTotal) ? totalTotal : null,
        modelContextWindow: Number.isFinite(ctx) ? ctx : null
      }
    }
  }

  const info = payload.info
  if (info && typeof info === 'object') {
    const lastTotal = Number(info?.last_token_usage?.total_tokens ?? info?.last_token_usage?.totalTokens ?? NaN)
    const totalTotal = Number(info?.total_token_usage?.total_tokens ?? info?.total_token_usage?.totalTokens ?? NaN)
    const ctx = (info?.model_context_window === null || info?.model_context_window === undefined)
      ? (info?.modelContextWindow ?? null)
      : info.model_context_window
    const ctxNum = (ctx === null || ctx === undefined) ? null : Number(ctx)
    if (Number.isFinite(lastTotal) || Number.isFinite(totalTotal)) {
      return {
        kind: 'v1',
        lastTotalTokens: Number.isFinite(lastTotal) ? lastTotal : null,
        totalTotalTokens: Number.isFinite(totalTotal) ? totalTotal : null,
        modelContextWindow: Number.isFinite(ctxNum) ? ctxNum : null
      }
    }
  }

  return null
}

function maybeUpdateTokenUsage(sessionId, payload) {
  if (!sessionId) return
  const norm = normalizeTokenUsage(payload)
  if (!norm) return
  tokenUsageBySessionId.set(sessionId, norm)
}

function machineIsOnline(m) {
  if (typeof m?.connected === 'boolean') return m.connected
  const last = Number(m?.lastSeenMs ?? 0)
  if (!Number.isFinite(last) || last <= 0) return false
  return (nowMs.value - last) < 45_000
}

function machineShowLastSeen(m) {
  if (!m || machineIsOnline(m)) return false
  const last = Number(m?.lastSeenMs ?? 0)
  if (!Number.isFinite(last) || last <= 0) return false
  return (nowMs.value - last) >= 5 * 60_000
}

function machineStatusLabel(m) {
  if (!m) return ''
  if (machineIsOnline(m)) return 'online'
  if (machineShowLastSeen(m)) return `last seen ${formatAgo(m.lastSeenMs)}`
  return 'offline'
}

async function markSessionRead(sessionId) {
  if (!sessionId) return
  const res = await apiFetch(`/api/sessions/${sessionId}/read`, { method: 'POST' })
  if (!res.ok) return
  const data = await res.json().catch(() => null)
  if (data?.session) upsertSessionRow(data.session)
}

function scheduleMarkRead(sessionId) {
  if (!sessionId) return
  if (currentVisibility() !== 'visible') {
    if (markReadTimer) clearTimeout(markReadTimer)
    markReadTimer = null
    return
  }
  if (markReadTimer) clearTimeout(markReadTimer)
  markReadTimer = setTimeout(() => {
    markReadTimer = null
    markSessionRead(sessionId)
  }, 500)
}

function openRenameSession(session, { focus = 'title' } = {}) {
  renameError.value = ''
  renameSessionId.value = session?.sessionId ?? null
  renameTitleValue.value = String(session?.title ?? sessionListTitle(session) ?? '')
  renameProjectValue.value = String(session?.projectLabel ?? '')
  renameFocus.value = focus
  renameOpen.value = true
}

async function saveRenameSession() {
  renameError.value = ''
  const sessionId = renameSessionId.value
  if (!sessionId) return
  const title = renameTitleValue.value.trim()
  const projectLabel = renameProjectValue.value.trim()
  const res = await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: title || null,
      projectLabel: projectLabel || null
    })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    renameError.value = err?.error ?? `HTTP ${res.status}`
    return
  }
  const data = await res.json().catch(() => null)
  if (data?.session) upsertSessionRow(data.session)
  renameOpen.value = false
}

function openSessionPolicy() {
  sessionPolicyError.value = ''
  const s = selectedSession.value
  if (!s) return
  sessionApprovalDraft.value = String(s.approvalPolicy ?? defaults.approvalPolicy ?? 'on-request')
  sessionSandboxDraft.value = String(s.sandbox ?? defaults.sandbox ?? 'workspace-write')
  sessionPolicyOpen.value = true
}

async function saveSessionPolicy() {
  sessionPolicyError.value = ''
  const sessionId = selectedSessionId.value
  if (!sessionId) return
  if (sessionPolicySaving.value) return
  sessionPolicySaving.value = true
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}/options`, {
      method: 'PUT',
      body: JSON.stringify({
        options: {
          approvalPolicy: sessionApprovalDraft.value,
          sandbox: sessionSandboxDraft.value
        }
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      sessionPolicyError.value = err?.error ?? `HTTP ${res.status}`
      return
    }
    const data = await res.json().catch(() => null)
    if (data?.session) upsertSessionRow(data.session)
    sessionPolicyOpen.value = false
  } finally {
    sessionPolicySaving.value = false
  }
}

async function loadAppSettings() {
  appSettingsError.value = ''
  appSettingsLoaded.value = false

  const res = await apiFetch('/api/settings')
  if (!res.ok) return null

  const data = await res.json().catch(() => null)
  if (!data || typeof data !== 'object') return null

  appSettings.retentionDays = Number(data.retentionDays ?? 30) || 30
  appSettings.notifications = data.notifications ?? { sseToasts: 'if-not-visible', webPush: 'if-not-visible' }
  appSettings.host = data.host ?? null
  appSettings.runner = data.runner ?? null
  retentionDraft.value = String(appSettings.retentionDays)
  sseToastsDraft.value = String(appSettings.notifications?.sseToasts ?? 'if-not-visible')
  webPushDraft.value = String(appSettings.notifications?.webPush ?? 'if-not-visible')
  appSettingsLoaded.value = true
  return data
}

async function checkAuth() {
  const res = await apiFetch('/api/settings')
  if (!res.ok) {
    authed.value = false
    return
  }
  authed.value = true

  const data = await res.json().catch(() => null)
  if (data && typeof data === 'object') {
    appSettings.retentionDays = Number(data.retentionDays ?? 30) || 30
    appSettings.notifications = data.notifications ?? { sseToasts: 'if-not-visible', webPush: 'if-not-visible' }
    appSettings.host = data.host ?? null
    appSettings.runner = data.runner ?? null
    retentionDraft.value = String(appSettings.retentionDays)
    sseToastsDraft.value = String(appSettings.notifications?.sseToasts ?? 'if-not-visible')
    webPushDraft.value = String(appSettings.notifications?.webPush ?? 'if-not-visible')
    appSettingsLoaded.value = true
  }
}

async function saveRetentionDays() {
  appSettingsError.value = ''
  const n = Number.parseInt(String(retentionDraft.value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1 || n > 3650) {
    appSettingsError.value = 'Retention days must be an integer between 1 and 3650.'
    return
  }

  const toastPolicy = String(sseToastsDraft.value ?? '')
  if (toastPolicy !== 'always' && toastPolicy !== 'never' && toastPolicy !== 'if-not-visible') {
    appSettingsError.value = 'Notification policy must be Always/Never/If not visible.'
    return
  }

  const pushPolicy = String(webPushDraft.value ?? '')
  if (pushPolicy !== 'always' && pushPolicy !== 'never' && pushPolicy !== 'if-not-visible') {
    appSettingsError.value = 'Web Push policy must be Always/Never/If not visible.'
    return
  }

  appSettingsSaving.value = true
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ retentionDays: n, notifications: { sseToasts: toastPolicy, webPush: pushPolicy } })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      appSettingsError.value = err?.error ?? `HTTP ${res.status}`
      return
    }

    const data = await res.json().catch(() => null)
    if (data && typeof data === 'object') {
      appSettings.retentionDays = Number(data.retentionDays ?? n) || n
      appSettings.notifications = data.notifications ?? appSettings.notifications
      appSettings.host = data.host ?? appSettings.host
      appSettings.runner = data.runner ?? appSettings.runner
      retentionDraft.value = String(appSettings.retentionDays)
      sseToastsDraft.value = String(appSettings.notifications?.sseToasts ?? toastPolicy)
      webPushDraft.value = String(appSettings.notifications?.webPush ?? pushPolicy)
      appSettingsLoaded.value = true
    }
  } finally {
    appSettingsSaving.value = false
  }
}

async function login() {
  authError.value = ''
  const res = await apiFetch('/api/auth', {
    method: 'POST',
    body: JSON.stringify({ token: authToken.value })
  })
  if (!res.ok) {
    authError.value = 'Unauthorized (token invalid).'
    return
  }
  authed.value = true
  await loadAppSettings().catch(() => {})
  connectSse()
}

function connectSse() {
  if (es) {
    try { es.close() } catch {}
    es = null
  }

  sseConnectionId.value = null
  sseStatus.value = 'connecting'
  lastSseMessageAt.value = Date.now()
  const vis = currentVisibility()
  const params = new URLSearchParams()
  params.set('visibility', vis)
  if (selectedSessionId.value) params.set('sessionId', selectedSessionId.value)
  const next = new EventSource(`/api/events?${params.toString()}`)
  es = next

  next.onopen = () => {
    if (es !== next) return
    sseStatus.value = 'connected'
    sseDisconnectReason.value = null
    everConnected.value = true
    lastSseMessageAt.value = Date.now()
  }
  next.onerror = () => {
    if (es !== next) return
    sseStatus.value = 'error'
    try {
      // eslint-disable-next-line no-undef
      const st = next.readyState
      // eslint-disable-next-line no-undef
      if (st === EventSource.CLOSED) sseDisconnectReason.value = 'closed'
      else sseDisconnectReason.value = sseDisconnectReason.value ?? 'error'
    } catch {
      sseDisconnectReason.value = sseDisconnectReason.value ?? 'error'
    }
  }

  next.onmessage = (ev) => {
    if (es !== next) return
    lastSseMessageAt.value = Date.now()
    let env
    try {
      env = JSON.parse(ev.data)
    } catch {
      return
    }
    handleEnvelope(env)
  }
}

function addSessionEvent(sessionId, event, { atStart = false, applyDerived = true } = {}) {
  const store = getSessionStore(sessionId)
  if (store.seen.has(event.eventId)) return
  store.seen.add(event.eventId)
  if (atStart) store.events.unshift(event)
  else store.events.push(event)

  if (applyDerived) {
    if (event.type === 'diff.updated' && typeof event.payload?.diff === 'string') {
      store.diff = event.payload.diff
    }

    if (event.type === 'plan.updated') {
      store.plan = Array.isArray(event.payload?.plan) ? event.payload.plan : null
      store.planExplanation = event.payload?.explanation ?? null
    }

    if (event.type === 'thread.tokenUsage.updated' || event.type === 'token.count') {
      maybeUpdateTokenUsage(sessionId, event.payload)
    }
  }
}

function appendCapped(prev, delta, cap = 200_000) {
  const p = String(prev ?? '')
  const d = String(delta ?? '')
  if (!d) return p
  const next = p + d
  if (next.length <= cap) return next
  return next.slice(next.length - cap)
}

function shouldDropReasoningChunk(store, text) {
  const t = String(text ?? '')
  if (!t) return true
  const now = Date.now()
  const last = store?.lastReasoningChunk ?? null
  if (last && last.text === t && (now - Number(last.tsMs ?? 0)) < 500) return true
  if (store) store.lastReasoningChunk = { text: t, tsMs: now }
  return false
}

function toolOutputHasMeaningfulText(output) {
  if (!output) return false
  const stdout = String(output?.stdout ?? '')
  const stderr = String(output?.stderr ?? '')
  const combined = `${stdout}\n${stderr}`.trim()
  if (!combined) return false

  const lines = combined.split(/\r?\n/).map((l) => String(l ?? '').trim()).filter(Boolean)
  if (!lines.length) return false

  // Ignore Codex internal "terminal interaction" markers (not useful to users).
  const allInternal = lines.every((l) => l.startsWith('[codex] terminal interaction'))
  if (allInternal) return false

  return true
}

function getToolOutputState(store, itemId) {
  const key = String(itemId ?? '')
  if (!key) return null
  let state = store.toolOutputByItemId.get(key)
  if (!state) {
    state = reactive({
      stdout: '',
      stderr: '',
      loaded: false,
      loading: false,
      hasMoreBefore: false,
      nextBeforeSeq: null
    })
    store.toolOutputByItemId.set(key, state)
  }
  return state
}

function appendToolOutput(sessionId, itemId, stream, text) {
  const store = getSessionStore(sessionId)
  const st = getToolOutputState(store, itemId)
  if (!st) return
  if (stream === 'stderr') st.stderr = appendCapped(st.stderr, text)
  else st.stdout = appendCapped(st.stdout, text)
  st.loaded = true
}

async function ensureToolOutputLoaded(sessionId, itemId) {
  const store = getSessionStore(sessionId)
  const st = getToolOutputState(store, itemId)
  if (!st) return
  if (st.loading) return

  // If we already have output (live streaming or previously fetched), don't refetch.
  if (st.loaded) return

  st.loading = true
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}/items/${encodeURIComponent(String(itemId))}/output?limit=500`)
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    const events = Array.isArray(data?.events) ? data.events : []

    // Reset and rebuild (newest page).
    st.stdout = ''
    st.stderr = ''
    for (const e of events) {
      const stream = e.payload?.stream ?? 'stdout'
      const text = e.payload?.text ?? ''
      if (stream === 'stderr') st.stderr = appendCapped(st.stderr, text)
      else st.stdout = appendCapped(st.stdout, text)
    }
    st.loaded = true
    st.hasMoreBefore = Boolean(data?.hasMoreBefore)
    st.nextBeforeSeq = data?.nextBeforeSeq ?? null
  } finally {
    st.loading = false
  }
}

async function loadMoreToolOutputBefore(sessionId, itemId) {
  const store = getSessionStore(sessionId)
  const st = getToolOutputState(store, itemId)
  if (!st) return
  if (st.loading) return
  if (!st.hasMoreBefore) return
  const beforeSeq = st.nextBeforeSeq
  if (!beforeSeq) return

  st.loading = true
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}/items/${encodeURIComponent(String(itemId))}/output?limit=500&beforeSeq=${encodeURIComponent(String(beforeSeq))}`)
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    const events = Array.isArray(data?.events) ? data.events : []

    let stdoutPrefix = ''
    let stderrPrefix = ''
    for (const e of events) {
      const stream = e.payload?.stream ?? 'stdout'
      const text = e.payload?.text ?? ''
      if (stream === 'stderr') stderrPrefix = appendCapped(stderrPrefix, text, 500_000)
      else stdoutPrefix = appendCapped(stdoutPrefix, text, 500_000)
    }

    st.stdout = appendCapped(stdoutPrefix, st.stdout, 500_000)
    st.stderr = appendCapped(stderrPrefix, st.stderr, 500_000)
    st.hasMoreBefore = Boolean(data?.hasMoreBefore)
    st.nextBeforeSeq = data?.nextBeforeSeq ?? st.nextBeforeSeq
  } finally {
    st.loading = false
  }
}

function toggleToolExpanded(itemId) {
  const sid = selectedSessionId.value
  if (!sid || !itemId) return
  const store = getSessionStore(sid)
  const key = String(itemId)
  const next = !Boolean(store.toolExpanded.get(key))
  store.toolExpanded.set(key, next)
  if (next) ensureToolOutputLoaded(sid, key).catch(() => {})
}

function onToolDetailsToggle(itemId, ev) {
  const sid = selectedSessionId.value
  if (!sid || !itemId) return
  const open = Boolean(ev?.target?.open)
  const store = getSessionStore(sid)
  const key = String(itemId)
  const current = Boolean(store.toolExpanded.get(key))
  if (current === open) return
  store.toolExpanded.set(key, open)
  if (open) ensureToolOutputLoaded(sid, key).catch(() => {})
}

function toolDisplayCommand(m) {
  const actions = Array.isArray(m?.commandActions) ? m.commandActions : null
  if (actions) {
    for (const a of actions) {
      const c = (a && typeof a === 'object' && typeof a.command === 'string') ? a.command.trim() : ''
      if (c) return c
    }
  }
  const cmd = String(m?.command ?? '').trim()
  return cmd
}

function handleEnvelope(env) {
  if (!env || typeof env.type !== 'string') return

  if (env.type === 'toast') {
    const p = env.payload ?? {}
    const toast = {
      id: env.id ?? `toast-${++toastSeq}`,
      level: p.level ?? 'info',
      title: p.title ?? 'Rootgrid',
      message: p.message ?? '',
      sessionId: p.sessionId ?? null,
      stickyUntilVisible: false
    }

    const visible = currentVisibility() === 'visible'
    if (!visible && showBrowserToast(toast)) return

    // If we can't show a browser notification while hidden, keep it sticky
    // until the user returns to the tab.
    if (!visible && notificationPermission.value !== 'granted') toast.stickyUntilVisible = true

    toasts.value.push(toast)
    if (visible) scheduleDismissToast(toast.id, 7_500)
    return
  }

  if (env.type === 'registry.snapshot') {
    sseConnectionId.value = env.payload?.connectionId ?? null
    machines.value = env.payload?.machines ?? []
    sessions.value = env.payload?.sessions ?? []
    approvalQueue.value = Array.isArray(env.payload?.approvals) ? env.payload.approvals : []
    hasSnapshot.value = true
    schedulePostVisibility()
    return
  }

  if (env.type === 'registry.machine.upsert') {
    upsertById(machines.value, 'machineId', env.payload)
    return
  }

  if (env.type === 'registry.machine.delete') {
    const mid = env.payload?.machineId ?? env.scope?.machineId
    if (mid) removeMachineLocal(mid)
    return
  }

  if (env.type === 'registry.session.upsert') {
    // Session upserts can be sent for metadata-only changes (rename/read) and
    // should not reorder the list. We only place *new* sessions at the top.
    upsertSessionRow(env.payload)
    return
  }

  if (env.type === 'registry.session.delete') {
    const sid = env.payload?.sessionId
    if (sid) {
      const idx = sessions.value.findIndex((s) => s?.sessionId === sid)
      if (idx >= 0) sessions.value.splice(idx, 1)
      if (selectedSessionId.value === sid) selectedSessionId.value = null
      try { sessionStores.delete(sid) } catch {}
    }
    return
  }

  // Session-scoped events
  const sessionId = env.scope?.sessionId ?? env.payload?.sessionId ?? null
  if (!sessionId) return

  const s = sessions.value.find((row) => row.sessionId === sessionId) ?? null
  if (s) {
    s.lastSeq = Number(s.lastSeq ?? 0) + 1

    if (env.type === 'session.status' && env.payload?.status) {
      s.status = env.payload.status
      if (env.payload.codexThreadId) s.codexThreadId = env.payload.codexThreadId
    }

    if (env.type === 'session.input') {
      const t = String(env.payload?.text ?? '').replace(/\s+/g, ' ').trim()
      if (t) s.preview = (t.length > 160) ? `${t.slice(0, 157)}…` : t
      if (env.payload?.isInitial && !String(s.title ?? '').trim()) {
        s.title = s.preview
      }
    }

    if (env.type === 'turn.started') {
      s.turnState = 'running'
    }

    if (env.type === 'turn.completed') {
      s.turnState = 'idle'
      const p = String(env.payload?.preview ?? '').replace(/\s+/g, ' ').trim()
      if (p) s.preview = (p.length > 160) ? `${p.slice(0, 157)}…` : p
    }

    if (env.type === 'approval.request') {
      const approvalId = env.payload?.approvalId
      if (!approvalId || !approvalQueue.value.some((x) => x?.approvalId === approvalId)) {
        approvalQueue.value.push(env.payload)
      }
      s.pendingApprovals = Number(s.pendingApprovals ?? 0) + 1
    }

    if (env.type === 'approval.resolved') {
      s.pendingApprovals = Math.max(0, Number(s.pendingApprovals ?? 0) - 1)
      const approvalId = env.payload?.approvalId
      if (approvalId) {
        const idx = approvalQueue.value.findIndex((x) => x?.approvalId === approvalId)
        if (idx >= 0) approvalQueue.value.splice(idx, 1)
      }
    }

    // If we're actively reading this session at the bottom, keep it "read".
    if (selectedSessionId.value === sessionId && stickToBottom.value) {
      scheduleMarkRead(sessionId)
    }

    const stream = env.type === 'session.output' ? (env.payload?.stream ?? 'normalized') : null
    const shouldBump = !(env.type === 'session.output' && stream !== 'normalized')
      && env.type !== 'thread.tokenUsage.updated'
      && env.type !== 'token.count'
    if (shouldBump) bumpSessionToTop(sessionId)
  } else if (env.type === 'approval.request') {
    const approvalId = env.payload?.approvalId
    if (!approvalId || !approvalQueue.value.some((x) => x?.approvalId === approvalId)) {
      approvalQueue.value.push(env.payload)
    }
  }

  if (selectedSessionId.value === sessionId) {
    if (env.type === 'turn.started') {
      const store = getSessionStore(sessionId)
      store.lastReasoningChunk = { text: null, tsMs: 0 }
    }

    // Compact history view: keep big events in the main list; route tool output
    // streams into per-item buffers that can be expanded on demand.
    if (env.type === 'session.output') {
      const stream = env.payload?.stream ?? 'normalized'
      const itemId = env.payload?.itemId ?? null
      const text = env.payload?.text ?? ''
      if (stream !== 'normalized' && itemId && (stream === 'stdout' || stream === 'stderr')) {
        appendToolOutput(sessionId, String(itemId), stream, String(text ?? ''))
        return
      }
      if (stream === 'reasoning') {
        const store = getSessionStore(sessionId)
        const chunk = String(text ?? '')
        if (shouldDropReasoningChunk(store, chunk)) return
        // Fall through: reasoning is rendered as interleaved "step lines" in the timeline.
      }
      if (stream === 'plan') return
    }

    addSessionEvent(sessionId, {
      eventId: env.id,
      tsMs: env.ts,
      type: env.type,
      payload: env.payload
    }, { atStart: false, applyDerived: true })
  }
}

async function loadSession(sessionId) {
  const nonce = ++loadSessionNonce
  sessionLoading.value = true
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}`)
    if (!res.ok) return
    const data = await res.json()
    if (nonce !== loadSessionNonce) return
    if (data?.session) upsertSessionRow(data.session)

    const store = getSessionStore(sessionId)
    store.events.splice(0, store.events.length)
    store.seen.clear()
    store.diff = ''
    store.plan = null
    store.planExplanation = null
    store.lastReasoningChunk = { text: null, tsMs: 0 }
    store.hasMoreBefore = true
    store.nextBeforeSeq = null
    store.loadingBefore = false
    store.toolOutputByItemId.clear()
    store.toolExpanded.clear()
    try { store.diffSelectedFileByEventId?.clear?.() } catch {}

    // Load the newest page (summary/"big events" mode).
    // Summary mode now includes reasoning; bump the initial page size so we
    // reliably include the triggering user message + tool steps (reasoning can
    // be chunked into many events).
    const pageRes = await apiFetch(`/api/sessions/${sessionId}/events?mode=summary&limit=2000`)
    if (!pageRes.ok) return
    const page = await pageRes.json().catch(() => null)
    if (nonce !== loadSessionNonce) return
    const events = Array.isArray(page?.events) ? page.events : []
    for (const e of events) addSessionEvent(sessionId, e, { atStart: false, applyDerived: true })
    store.hasMoreBefore = Boolean(page?.hasMoreBefore)
    store.nextBeforeSeq = page?.nextBeforeSeq ?? null

    // Cache a few pages back so streamed reasoning headlines aren't cut mid-line.
    await loadMoreBefore(sessionId, { pages: 3 })

    // Ensure the loaded window includes at least the most recent user message.
    // (Reasoning can be chunked into many events and push the `session.input`
    // out of the first page.)
    for (let i = 0; i < 8; i++) {
      if (nonce !== loadSessionNonce) break
      if (store.events.some((ev) => ev?.type === 'session.input')) break
      if (!store.hasMoreBefore || !store.nextBeforeSeq) break
      await loadMoreBefore(sessionId, { pages: 3 })
    }
  } finally {
    if (nonce === loadSessionNonce) sessionLoading.value = false
  }
}

async function loadMoreBefore(sessionId, { pages = 1, limit = 200 } = {}) {
  const store = getSessionStore(sessionId)
  if (store.loadingBefore) return
  if (!store.hasMoreBefore) return
  if (!store.nextBeforeSeq) return

  const pageCount = Math.max(1, Math.min(10, Number(pages) || 1))
  const pageLimit = Math.max(1, Math.min(2000, Number(limit) || 200))

  store.loadingBefore = true
  try {
    const el = chatScrollEl.value
    const prevHeight = el ? el.scrollHeight : null
    const prevTop = el ? el.scrollTop : null

    let fetchedAny = false
    for (let p = 0; p < pageCount; p++) {
      if (!store.hasMoreBefore) break
      const beforeSeq = store.nextBeforeSeq
      if (!beforeSeq) break

      const res = await apiFetch(`/api/sessions/${sessionId}/events?mode=summary&limit=${encodeURIComponent(String(pageLimit))}&beforeSeq=${encodeURIComponent(String(beforeSeq))}`)
      if (!res.ok) break
      const page = await res.json().catch(() => null)
      const events = Array.isArray(page?.events) ? page.events : []

      // Prepend in one batch (chronological order within page is oldest-first).
      const toAdd = []
      for (const ev of events) {
        if (!ev?.eventId) continue
        if (store.seen.has(ev.eventId)) continue
        store.seen.add(ev.eventId)
        toAdd.push(ev)
      }
      if (toAdd.length) store.events.unshift(...toAdd)

      store.hasMoreBefore = Boolean(page?.hasMoreBefore)
      store.nextBeforeSeq = page?.nextBeforeSeq ?? store.nextBeforeSeq
      fetchedAny = fetchedAny || Boolean(events.length)
      if (!events.length) break
    }

    await nextTick()
    if (el && prevHeight !== null && prevTop !== null && fetchedAny) {
      const nextHeight = el.scrollHeight
      el.scrollTop = prevTop + (nextHeight - prevHeight)
    }
  } finally {
    store.loadingBefore = false
  }
}

watch(selectedSessionId, async (sid) => {
  if (!sid) {
    replaceUrlSessionParam(null)
    if (authed.value) connectSse()
    loadSessionNonce += 1
    sessionLoading.value = false
    return
  }

  replaceUrlSessionParam(sid)
  if (authed.value) connectSse()
  await loadSession(sid)
  const s = sessions.value.find((x) => x.sessionId === sid)
  if (s?.cwd) defaults.cwd = s.cwd
  stickToBottom.value = true
  await nextTick()
  scheduleMarkRead(sid)
})

watch(settingsTab, (t) => {
  if (!defaultsOpen.value) return
  if (t === 'system') refreshPushSubscription().catch(() => {})
})

const selectedSession = computed(() => sessions.value.find((s) => s.sessionId === selectedSessionId.value) ?? null)
const selectedStore = computed(() => selectedSessionId.value ? sessionStores.get(selectedSessionId.value) : null)
const selectedTokenUsage = computed(() => selectedSessionId.value ? (tokenUsageBySessionId.get(selectedSessionId.value) ?? null) : null)

const recentModels = computed(() => {
  const seen = new Set()
  const out = []
  const add = (v) => {
    const s = String(v ?? '').trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  // Prefer the current session + defaults, then the rest of recent sessions.
  add(selectedSession.value?.model)
  add(defaults.model)
  for (const s of sessions.value) add(s?.model)
  return out.slice(0, 20)
})

const modelCatalog = ref([]) // Codex app-server model/list (per machine)
const modelCatalogMachineId = ref('')
const modelCatalogUpdatedMs = ref(0)
const modelCatalogLoading = ref(false)
const modelCatalogError = ref('')

const composerModelsMachineId = computed(() => {
  const sid = selectedSession.value?.machineId
  if (sid) return String(sid)
  const dmid = String(defaults.machineId ?? '').trim()
  if (dmid) return dmid
  const online = machinesForSelect.value.find((m) => machineIsOnline(m))
  return online?.machineId ?? ''
})

const composerModelsMachineOnline = computed(() => {
  const mid = String(composerModelsMachineId.value ?? '').trim()
  if (!mid) return false
  const row = machines.value.find((m) => m?.machineId === mid) ?? null
  return row ? machineIsOnline(row) : false
})

async function loadModelCatalog({ force = false } = {}) {
  modelCatalogError.value = ''
  const machineId = String(composerModelsMachineId.value ?? '').trim()
  if (!machineId) return
  if (!composerModelsMachineOnline.value) return

  const now = Date.now()
  if (!force && modelCatalogMachineId.value === machineId && modelCatalog.value.length && (now - modelCatalogUpdatedMs.value) < 60_000) {
    return
  }
  if (modelCatalogLoading.value) return
  modelCatalogLoading.value = true
  try {
    const cwd = selectedSession.value?.cwd ?? defaults.cwd ?? ''
    const res = await apiFetch(`/api/models?machineId=${encodeURIComponent(machineId)}&cwd=${encodeURIComponent(String(cwd ?? ''))}`)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
    const list = Array.isArray(data?.models) ? data.models : []
    modelCatalog.value = list
    modelCatalogMachineId.value = machineId
    modelCatalogUpdatedMs.value = now
  } catch (err) {
    modelCatalogError.value = String(err?.message ?? err)
  } finally {
    modelCatalogLoading.value = false
  }
}

watch(
  [() => authed.value, () => composerModelsMachineId.value, () => composerModelsMachineOnline.value],
  ([isAuthed, machineId, online], prev = []) => {
    const [wasAuthed, prevMachineId, prevOnline] = prev
    if (!isAuthed) return
    if (!machineId || !online) return
    const changed = !wasAuthed || machineId !== prevMachineId || (online && !prevOnline)
    if (changed) loadModelCatalog().catch(() => {})
  },
  { immediate: true }
)

function labelReasoningEffort(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const norm = raw.toLowerCase().replace(/[\s_-]+/g, '')
  if (norm === 'none') return 'None'
  if (norm === 'minimal') return 'Minimal'
  if (norm === 'low') return 'Low'
  if (norm === 'medium') return 'Medium'
  if (norm === 'high') return 'High'
  if (norm === 'xhigh' || norm === 'extrahigh') return 'Extra High'
  return raw
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

const defaultCodexModel = computed(() => {
  const list = Array.isArray(modelCatalog.value) ? modelCatalog.value : []
  return list.find((m) => Boolean(m?.isDefault ?? m?.is_default ?? m?.default)) ?? null
})

const selectedCodexModel = computed(() => {
  const list = Array.isArray(modelCatalog.value) ? modelCatalog.value : []
  if (!list.length) return null
  const id = String(composerModel.value ?? '').trim()
  if (id) return list.find((m) => String(m?.id ?? m?.model ?? '').trim() === id) ?? null
  return defaultCodexModel.value
})

const selectedCodexDefaultReasoningEffort = computed(() => {
  const m = selectedCodexModel.value
  if (!m) return null
  const raw = m?.defaultReasoningEffort ?? m?.default_reasoning_effort ?? null
  const e = String(raw ?? '').trim()
  return e ? e : null
})

const composerModelOptions = computed(() => {
  const list = Array.isArray(modelCatalog.value) ? modelCatalog.value : []
  const out = []
  const seen = new Set()

  const defaultId = String(defaultCodexModel.value?.id ?? defaultCodexModel.value?.model ?? '').trim()

  if (list.length) {
    for (const m of list) {
      if (!m || typeof m !== 'object') continue
      const id = String(m.id ?? m.model ?? '').trim()
      if (!id || seen.has(id)) continue
      if (defaultId && id === defaultId) continue
      seen.add(id)
      out.push({
        value: id,
        label: String(m.displayName ?? m.display_name ?? id).trim() || id
      })
    }
  } else {
    for (const id of recentModels.value) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({ value: id, label: id })
    }
  }

  // If the currently-selected model isn't present, keep it visible.
  const current = String(composerModel.value ?? '').trim()
  if (current && !seen.has(current) && current !== defaultId) {
    out.unshift({ value: current, label: current })
  }

  return out
})

const composerReasoningEffortOptions = computed(() => {
  const m = selectedCodexModel.value
  const list = Array.isArray(m?.reasoningEffort)
    ? m.reasoningEffort
    : (
        Array.isArray(m?.reasoning_effort)
          ? m.reasoning_effort
          : (
              Array.isArray(m?.supportedReasoningEfforts)
                ? m.supportedReasoningEfforts
                : (Array.isArray(m?.supported_reasoning_efforts) ? m.supported_reasoning_efforts : null)
            )
      )
  if (list && list.length) {
    const out = []
    const seen = new Set()
    for (const e of list) {
      let effort = null
      if (typeof e === 'string') effort = e
      else if (e && typeof e === 'object') {
        if (typeof e.effort === 'string') effort = e.effort
        else if (e.effort && typeof e.effort === 'object') {
          effort = e.effort.value ?? e.effort.id ?? e.effort.name ?? null
        } else if (typeof e.value === 'string') effort = e.value
        else if (typeof e.id === 'string') effort = e.id
        else if (typeof e.name === 'string') effort = e.name
        else if (typeof e.key === 'string') effort = e.key
        else if (typeof e.level === 'string') effort = e.level
        else if (typeof e.reasoningEffort === 'string') effort = e.reasoningEffort
        else if (typeof e.reasoning_effort === 'string') effort = e.reasoning_effort
      }

      effort = String(effort ?? '').trim()
      if (!effort) continue
      if (effort.toLowerCase() === 'auto') continue
      if (seen.has(effort)) continue
      seen.add(effort)

      const label = (e && typeof e === 'object')
        ? String(e.label ?? e.displayName ?? e.display_name ?? '').trim()
        : ''
      const desc = (e && typeof e === 'object') ? String(e.description ?? '').trim() : ''

      out.push({
        value: effort,
        label: label || labelReasoningEffort(effort) || effort,
        description: desc || null
      })
    }

    // If the currently-selected effort isn't present, keep it visible.
    const current = String((selectedSession.value ? selectedSession.value.reasoningEffort : defaults.reasoningEffort) ?? '').trim()
    if (current && !seen.has(current)) {
      out.unshift({ value: current, label: labelReasoningEffort(current) || current, description: null })
    }
    return out
  }
  return [
    { value: 'none', label: 'None' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra High' }
  ]
})

const composerOptionsError = ref('')

async function patchSelectedSessionOptions(patch) {
  composerOptionsError.value = ''
  const sessionId = selectedSessionId.value
  if (!sessionId) return false
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}/options`, {
      method: 'PUT',
      body: JSON.stringify({ options: patch })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      composerOptionsError.value = err?.error ?? `HTTP ${res.status}`
      return false
    }
    const data = await res.json().catch(() => null)
    if (data?.session) upsertSessionRow(data.session)
    return true
  } catch (err) {
    composerOptionsError.value = String(err?.message ?? err)
    return false
  }
}

const composerModel = computed({
  get() {
    return String((selectedSession.value ? selectedSession.value.model : defaults.model) ?? '')
  },
  set(v) {
    const next = String(v ?? '').trim()
    const current = String((selectedSession.value ? selectedSession.value.model : defaults.model) ?? '').trim()
    if (next === current) return
    if (selectedSession.value) patchSelectedSessionOptions({ model: next || null })
    else defaults.model = next
  }
})

const composerReasoningEffort = computed({
  get() {
    return String((selectedSession.value ? selectedSession.value.reasoningEffort : defaults.reasoningEffort) ?? '')
  },
  set(v) {
    const next = String(v ?? '').trim()
    const current = String((selectedSession.value ? selectedSession.value.reasoningEffort : defaults.reasoningEffort) ?? '').trim()
    if (next === current) return
    if (selectedSession.value) patchSelectedSessionOptions({ reasoningEffort: next || null })
    else defaults.reasoningEffort = next
  }
})

const composerApprovalPolicy = computed({
  get() {
    const v = selectedSession.value ? selectedSession.value.approvalPolicy : defaults.approvalPolicy
    return String(v ?? defaults.approvalPolicy ?? 'on-request')
  },
  set(v) {
    const next = String(v ?? '').trim()
    if (!next) return
    const current = String((selectedSession.value ? selectedSession.value.approvalPolicy : defaults.approvalPolicy) ?? '').trim()
    if (next === current) return
    if (selectedSession.value) patchSelectedSessionOptions({ approvalPolicy: next })
    else defaults.approvalPolicy = next
  }
})

const composerSandbox = computed({
  get() {
    const v = selectedSession.value ? selectedSession.value.sandbox : defaults.sandbox
    return String(v ?? defaults.sandbox ?? 'workspace-write')
  },
  set(v) {
    const next = String(v ?? '').trim()
    if (!next) return
    const current = String((selectedSession.value ? selectedSession.value.sandbox : defaults.sandbox) ?? '').trim()
    if (next === current) return
    if (selectedSession.value) patchSelectedSessionOptions({ sandbox: next })
    else defaults.sandbox = next
  }
})

function splitShellStatements(cmd) {
  const s = String(cmd ?? '')
  const out = []
  let cur = ''
  let quote = null

  const push = () => {
    const v = cur.trim()
    cur = ''
    if (v) out.push(v)
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
  let v = String(s ?? '').trim()
  for (let i = 0; i < 4; i++) {
    if (v.startsWith('(') && v.endsWith(')')) v = v.slice(1, -1).trim()
    else break
  }
  return v
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

function formatExploreTitle({ files = 0, searches = 0, lists = 0 } = {}) {
  const parts = []
  const pl = (n, one, many) => (Number(n) === 1 ? one : many)
  if (files) parts.push(`${files} ${pl(files, 'file', 'files')}`)
  if (searches) parts.push(`${searches} ${pl(searches, 'search', 'searches')}`)
  if (lists) parts.push(`${lists} ${pl(lists, 'list', 'lists')}`)
  if (!parts.length) return 'Explored'
  return `Explored ${parts.join(', ')}`
}

function parseExploreActionsFromCommand(command) {
  const cmd = String(command ?? '').trim()
  if (!cmd) return { actions: [], hasNonExplore: false }

  const segs = splitShellStatements(cmd)
  const actions = []
  let hasNonExplore = false

  const commandName = (word0) => {
    let n = String(word0 ?? '').trim()
    n = n.replace(/^[({]+/, '').replace(/[)}]+$/, '')
    if (n.includes('/')) n = n.split('/').pop()
    return n
  }

  for (const seg0 of segs) {
    let seg = beforeFirstPipe(seg0)
    seg = stripOuterParens(seg)
    if (!seg) continue

    const words0 = shellSplitWords(seg)
    if (!words0.length) continue

    let words = words0
    let name = commandName(words[0])
    if (!name) continue

    // Ignore leading `cd ...` segments.
    if (name === 'cd') continue

    // Unwrap sudo.
    if (name === 'sudo' && words.length > 1) {
      words = words.slice(1)
      name = commandName(words[0])
      if (!name) continue
    }

    // Ignore simple no-ops.
    if (name === 'true' || name === ':') continue

    if (name === 'ls') {
      const paths = []
      for (const w of words.slice(1)) {
        if (!w) continue
        if (w === '--') continue
        if (w.startsWith('-')) continue
        paths.push(w)
      }
      if (!paths.length) paths.push('.')
      for (const p of paths) {
        const label = (p === '.' || p === '..')
          ? `Listed files in ${p}`
          : (looksLikeFileToken(p) ? `Listed ${p}` : `Listed files in ${p}`)
        actions.push({ kind: 'list', label })
      }
      continue
    }

    if (name === 'find') {
      let root = null
      for (const w of words.slice(1)) {
        if (!w) continue
        if (w.startsWith('-')) break
        root = w
        break
      }
      root = root || '.'
      actions.push({ kind: 'list', label: `Listed files in ${root}` })
      continue
    }

    if (name === 'rg' || name === 'grep') {
      const rest = words.slice(1)
      let i = 0
      while (i < rest.length) {
        const w = rest[i]
        if (w === '--') { i += 1; break }
        if (!(w && w.startsWith('-'))) break
        i += 1
      }
      const pattern = (i < rest.length) ? rest[i] : ''
      i += 1
      const paths = rest.slice(i).filter((w) => w && w !== '--')

      const base = (pattern ? `Searched for ${pattern.length > 40 ? `${pattern.slice(0, 37)}…` : pattern}` : 'Searched for files')
      const pathLabel = (paths.length && !(paths.length === 1 && (paths[0] === '.' || paths[0] === './')))
        ? ` in ${paths.join(', ')}`
        : ''
      actions.push({ kind: 'search', label: base + pathLabel })
      continue
    }

    if (name === 'cat') {
      const files = words.slice(1).filter((w) => w && !w.startsWith('-') && looksLikePath(w))
      if (!files.length) { hasNonExplore = true; continue }
      for (const f of files) actions.push({ kind: 'read', label: `Read ${f}` })
      continue
    }

    if (name === 'sed') {
      const candidates = words.slice(1).filter((w) => w && !w.startsWith('-') && looksLikePath(w))
      const f = candidates.length ? candidates[candidates.length - 1] : null
      if (!f) { hasNonExplore = true; continue }
      actions.push({ kind: 'read', label: `Read ${f}` })
      continue
    }

    if (name === 'nl') {
      const candidates = words.slice(1).filter((w) => w && !w.startsWith('-') && looksLikePath(w))
      const f = candidates.length ? candidates[candidates.length - 1] : null
      if (!f) { hasNonExplore = true; continue }
      actions.push({ kind: 'read', label: `Read ${f}` })
      continue
    }

    // Ignore truncation/formatting helpers.
    if (name === 'head' || name === 'tail' || name === 'wc' || name === 'cut') continue

    hasNonExplore = true
  }

  return { actions, hasNonExplore }
}

function normalizeDiffPath(p) {
  let s = String(p ?? '').trim()
  if (!s) return null
  // Strip timestamps in `--- a/file\t2024-...` form.
  s = s.split('\t')[0].trim()
  if (!s || s === '/dev/null') return null
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2)
  return s || null
}

function parseUnifiedDiff(diffText, { maxBytes = 2_000_000, maxLines = 50_000 } = {}) {
  let text = String(diffText ?? '')
  if (!text.trim()) return []
  if (text.length > maxBytes) text = text.slice(0, maxBytes)
  text = text.replace(/\r/g, '')

  const lines = text.split('\n')
  const files = []

  let cur = null
  let curRaw = []
  let inHunk = false
  let oldLine = 0
  let newLine = 0

  const finish = () => {
    if (!cur) return
    cur.raw = curRaw.join('\n')
    if (!cur.path) cur.path = cur.newPath || cur.oldPath || 'edited'
    files.push(cur)
    cur = null
    curRaw = []
    inHunk = false
    oldLine = 0
    newLine = 0
  }

  const ensureFile = (hintId) => {
    if (cur) return cur
    cur = {
      id: hintId || `f-${files.length + 1}`,
      oldPath: null,
      newPath: null,
      path: null,
      added: 0,
      removed: 0,
      lines: [],
      raw: ''
    }
    curRaw = []
    inHunk = false
    oldLine = 0
    newLine = 0
    return cur
  }

  const parseHunk = (line) => {
    const m = String(line ?? '').match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/)
    if (!m) return null
    return { oldStart: Number(m[1]) || 0, newStart: Number(m[3]) || 0 }
  }

  const pushLine = (obj) => {
    if (!cur) return
    cur.lines.push(obj)
    if (cur.lines.length > maxLines) {
      // Stop parsing huge diffs; keep raw for copy.
      inHunk = false
    }
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finish()
      const m = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/)
      const oldPath = m ? m[1] : null
      const newPath = m ? m[2] : null
      const f = ensureFile(`diff-${files.length + 1}`)
      f.oldPath = oldPath
      f.newPath = newPath
      f.path = newPath || oldPath || f.path
      curRaw.push(line)
      continue
    }

    // Start a file section even if there is no `diff --git` header.
    if (!cur && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      ensureFile(`diff-${files.length + 1}`)
    }

    if (cur) curRaw.push(line)
    if (!cur) continue

    if (line.startsWith('--- ')) {
      cur.oldPath = normalizeDiffPath(line.slice(4))
      if (!cur.path) cur.path = cur.oldPath
      continue
    }

    if (line.startsWith('+++ ')) {
      cur.newPath = normalizeDiffPath(line.slice(4))
      cur.path = cur.newPath || cur.oldPath || cur.path
      continue
    }

    if (line.startsWith('@@ ')) {
      const info = parseHunk(line)
      if (info) {
        inHunk = true
        oldLine = info.oldStart
        newLine = info.newStart
        pushLine({ kind: 'hunk', oldLine: null, newLine: null, text: line })
      }
      continue
    }

    if (!inHunk) continue

    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      cur.added += 1
      pushLine({ kind: 'add', oldLine: null, newLine, text: line.slice(1) })
      newLine += 1
      continue
    }

    if (line.startsWith('-') && !line.startsWith('--- ')) {
      cur.removed += 1
      pushLine({ kind: 'del', oldLine, newLine: null, text: line.slice(1) })
      oldLine += 1
      continue
    }

    if (line.startsWith(' ')) {
      pushLine({ kind: 'ctx', oldLine, newLine, text: line.slice(1) })
      oldLine += 1
      newLine += 1
      continue
    }

    if (line.startsWith('\\')) {
      pushLine({ kind: 'meta', oldLine: null, newLine: null, text: line })
    }
  }

  finish()

  // Drop empty file records (can happen with truncated/partial diffs).
  return files.filter((f) => (Array.isArray(f.lines) && f.lines.length) || String(f.raw ?? '').trim())
}

async function copyText(text) {
  const t = String(text ?? '')
  if (!t) return
  try {
    await navigator.clipboard.writeText(t)
    return
  } catch {
  }
  try {
    const el = document.createElement('textarea')
    el.value = t
    el.setAttribute('readonly', 'true')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  } catch {
  }
}

function diffStepSelectedPath(stepId, files) {
  const sid = selectedSessionId.value
  if (!sid) return ''
  const store = getSessionStore(sid)
  const list = Array.isArray(files) ? files : []
  const key = String(stepId ?? '')
  if (!key) return list[0]?.path ?? ''

  const existing = String(store?.diffSelectedFileByEventId?.get?.(key) ?? '').trim()
  if (existing && list.some((f) => f?.path === existing)) return existing

  const fallback = String(list[0]?.path ?? '').trim()
  if (fallback) {
    try { store.diffSelectedFileByEventId.set(key, fallback) } catch {}
  }
  return fallback
}

function setDiffStepSelectedPath(stepId, path) {
  const sid = selectedSessionId.value
  if (!sid) return
  const store = getSessionStore(sid)
  const key = String(stepId ?? '')
  if (!key) return
  try { store.diffSelectedFileByEventId.set(key, String(path ?? '')) } catch {}
}

function diffStepSelectedFile(stepId, files) {
  const list = Array.isArray(files) ? files : []
  if (!list.length) return null
  const path = diffStepSelectedPath(stepId, list)
  return list.find((f) => f?.path === path) ?? list[0] ?? null
}

function buildChatMessages(store) {
  const events = store?.events ?? []
  const msgs = []
  let currentAssistant = null
  /** @type {Map<string, any>} */
  const toolMsgByItemId = new Map()

  // VS Code-like folding: collapse consecutive file reads/search/list commands
  // (shell-based "exploration") into a single expandable "Explored …" line.
  let exploreCurrent = null
  let exploreSeq = 0
  const exploreSeenItemIds = new Set()
  const resetExplore = () => { exploreCurrent = null }
  const ensureExploreGroup = (idHint) => {
    if (exploreCurrent) return exploreCurrent
    const msg = {
      id: `explore-${idHint ?? (++exploreSeq)}`,
      role: 'step',
      stepKind: 'explore',
      title: 'Explored',
      files: 0,
      searches: 0,
      lists: 0,
      entries: []
    }
    exploreCurrent = msg
    msgs.push(msg)
    return msg
  }

  let lastDiffText = null

  // Reasoning is streamed as markdown with section headings like "**Title**"
  // on their own line. Render each heading as a single expandable "step line".
  let reasoningCurrent = null
  let reasoningBuf = ''
  let lastReasoningEventId = null
  /** @type {Map<string, number>} */
  const reasoningStepIdxByEventId = new Map()

  const ensureAssistant = (idHint) => {
    if (currentAssistant) return currentAssistant
    resetExplore()
    currentAssistant = { id: idHint, role: 'assistant', text: '' }
    msgs.push(currentAssistant)
    return currentAssistant
  }

  const nextReasoningStepId = (eventId) => {
    const key = String(eventId ?? 'reasoning')
    const next = (reasoningStepIdxByEventId.get(key) ?? 0) + 1
    reasoningStepIdxByEventId.set(key, next)
    return `reason-${key}-${next}`
  }

  const startReasoningStep = (eventId, title) => {
    resetExplore()
    const msg = {
      id: nextReasoningStepId(eventId),
      role: 'step',
      stepKind: 'reasoning',
      _placeholder: false,
      title: String(title ?? '').trim(),
      body: ''
    }
    msgs.push(msg)
    reasoningCurrent = msg
    return msg
  }

  const appendReasoningBody = (eventId, text) => {
    const chunk = String(text ?? '')
    if (!chunk) return
    if (!reasoningCurrent) {
      if (!chunk.trim()) return
      startReasoningStep(eventId, 'Reasoning')
    }
    reasoningCurrent.body = appendCapped(reasoningCurrent.body, chunk, 500_000)
  }

  const parseReasoningHeading = (line) => {
    const raw = String(line ?? '')
    const ltrim = raw.replace(/^\s+/, '')
    if (!ltrim.startsWith('**')) return null
    const close = ltrim.indexOf('**', 2)
    if (close < 0) return null
    const title = ltrim.slice(2, close).trim()
    if (!title) return null
    const rest = ltrim.slice(close + 2)
    return { title, rest }
  }

  const handleReasoningLine = (eventId, line, trailingNewline) => {
    const raw = String(line ?? '')
    const heading = parseReasoningHeading(raw)
    if (heading) {
      const baseTitle = String(heading.title ?? '').trim()
      const rest = String(heading.rest ?? '')
      const title = (rest.trim() ? `${baseTitle}${rest}` : baseTitle).trim()
      if (reasoningCurrent?._placeholder && !String(reasoningCurrent?.body ?? '').trim()) {
        reasoningCurrent.title = title
        reasoningCurrent._placeholder = false
      } else {
        startReasoningStep(eventId, title)
      }
      return
    }
    if (!reasoningCurrent && !raw.trim()) return
    appendReasoningBody(eventId, raw + (trailingNewline ? '\n' : ''))
  }

  const feedReasoning = (eventId, chunk) => {
    lastReasoningEventId = eventId
    reasoningBuf += String(chunk ?? '')
    let idx
    while ((idx = reasoningBuf.indexOf('\n')) >= 0) {
      let line = reasoningBuf.slice(0, idx)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      reasoningBuf = reasoningBuf.slice(idx + 1)
      handleReasoningLine(eventId, line, true)
    }

    // If we have started receiving reasoning but haven't reached a newline yet,
    // still show a single expandable "Reasoning" line immediately.
    if (!reasoningCurrent && reasoningBuf.trim()) {
      const msg = startReasoningStep(eventId, 'Reasoning')
      msg._placeholder = true
    }
  }

  const flushReasoningBuf = (eventId) => {
    if (!reasoningBuf) return
    const id = eventId ?? lastReasoningEventId ?? 'reasoning'
    handleReasoningLine(id, reasoningBuf, false)
    reasoningBuf = ''
  }

  for (const e of events) {
    if (e.type === 'session.input') {
      flushReasoningBuf()
      const text = e.payload?.text ?? ''
      const atts = Array.isArray(e.payload?.attachments) ? e.payload.attachments : []
      msgs.push({ id: e.eventId, role: 'user', text, attachments: atts })
      currentAssistant = null
      resetExplore()
      exploreSeenItemIds.clear()
      toolMsgByItemId.clear()
      reasoningCurrent = null
      reasoningBuf = ''
      lastReasoningEventId = null
      reasoningStepIdxByEventId.clear()
      continue
    }

    if (e.type === 'turn.started') {
      flushReasoningBuf()
      currentAssistant = null
      resetExplore()
      exploreSeenItemIds.clear()
      toolMsgByItemId.clear()
      reasoningCurrent = null
      reasoningBuf = ''
      lastReasoningEventId = null
      reasoningStepIdxByEventId.clear()
      continue
    }

    if (e.type === 'turn.completed') {
      flushReasoningBuf()
      currentAssistant = null
      resetExplore()
      exploreSeenItemIds.clear()
      reasoningCurrent = null
      reasoningBuf = ''
      lastReasoningEventId = null
      reasoningStepIdxByEventId.clear()
      continue
    }

    if (e.type === 'diff.updated') {
      flushReasoningBuf()
      resetExplore()
      const diff = (typeof e.payload?.diff === 'string') ? e.payload.diff : ''
      const trimmed = String(diff ?? '').trim()
      if (!trimmed) continue
      if (lastDiffText === diff) continue
      lastDiffText = diff

      const files = parseUnifiedDiff(diff)
      msgs.push({
        id: e.eventId,
        role: 'step',
        stepKind: 'diff',
        files,
        raw: diff
      })
      continue
    }

    if (e.type === 'session.output') {
      const stream = e.payload?.stream ?? 'normalized'
      const text = e.payload?.text ?? ''
      if (stream === 'normalized') {
        const a = ensureAssistant(currentAssistant?.id ?? e.eventId)
        a.text += text
      } else if (stream === 'reasoning') {
        feedReasoning(e.eventId, String(text ?? ''))
      } else if ((stream === 'stderr' || stream === 'stdout') && !e.payload?.itemId) {
        // Un-attributed stdout/stderr (important enough to show).
        resetExplore()
        msgs.push({ id: e.eventId, role: 'system', stream, text: String(text ?? '') })
      }
      continue
    }

    if (e.type === 'session.status' && e.payload?.status === 'failed') {
      resetExplore()
      msgs.push({ id: e.eventId, role: 'system', text: `Session failed: ${e.payload?.error ?? 'unknown error'}` })
    }

    if (e.type === 'tool.started' || e.type === 'tool.completed') {
      const tool = e.payload?.tool
      const itemId = String(e.payload?.itemId ?? '')
      if (!itemId) continue

      // Fold "exploration" commands (ls/find/rg/sed/cat/...) into a single
      // VS Code-like "Explored …" group instead of showing raw command steps.
      if (String(tool ?? '').toLowerCase() === 'commandexecution') {
        const cmd = toolDisplayCommand({ commandActions: e.payload?.commandActions ?? null, command: e.payload?.command ?? null })
        const parsed = parseExploreActionsFromCommand(cmd)
        const exitCode = (e.payload?.exitCode === null || e.payload?.exitCode === undefined) ? null : Number(e.payload.exitCode)
        const allowExit = (exitCode === null || exitCode === 0 || (exitCode === 1 && parsed.actions.some((a) => a.kind === 'search')))

        if (parsed.actions.length && !parsed.hasNonExplore && allowExit) {
          if (!exploreSeenItemIds.has(itemId)) {
            const g = ensureExploreGroup(e.eventId)
            for (const a of parsed.actions) {
              const kind = a.kind
              const label = String(a.label ?? '').trim()
              if (!kind || !label) continue
              g.entries.push({
                id: `explore-${itemId}-${g.entries.length + 1}`,
                kind,
                label,
                itemId
              })
              if (kind === 'read') g.files += 1
              else if (kind === 'search') g.searches += 1
              else g.lists += 1
            }
            g.title = formatExploreTitle(g)
            exploreSeenItemIds.add(itemId)
          }
          continue
        }
      }

      // Any non-folded tool step breaks the current explore group.
      resetExplore()

      let msg = toolMsgByItemId.get(itemId) ?? null
      if (!msg) {
        msg = {
          id: `tool-${itemId}`,
          role: 'step',
          stepKind: 'tool',
          tool,
          itemId,
          command: e.payload?.command ?? null,
          commandActions: e.payload?.commandActions ?? null,
          cwd: e.payload?.cwd ?? null,
          changes: Array.isArray(e.payload?.changes) ? e.payload.changes : null,
          status: e.payload?.status ?? (e.type === 'tool.started' ? 'running' : 'completed'),
          exitCode: e.payload?.exitCode ?? null,
          expanded: Boolean(store?.toolExpanded?.get?.(itemId)),
          output: store?.toolOutputByItemId?.get?.(itemId) ?? null
        }
        msgs.push(msg)
        toolMsgByItemId.set(itemId, msg)
      } else {
        msg.tool = tool ?? msg.tool
        msg.command = e.payload?.command ?? msg.command
        msg.commandActions = e.payload?.commandActions ?? msg.commandActions
        msg.cwd = e.payload?.cwd ?? msg.cwd
        msg.changes = Array.isArray(e.payload?.changes) ? e.payload.changes : msg.changes
        msg.status = e.payload?.status ?? msg.status
        if (!msg.status) msg.status = (e.type === 'tool.started') ? 'running' : 'completed'
        if (e.payload?.exitCode !== undefined) msg.exitCode = e.payload.exitCode
        msg.expanded = Boolean(store?.toolExpanded?.get?.(itemId))
        msg.output = store?.toolOutputByItemId?.get?.(itemId) ?? msg.output
      }
    }
  }

  return msgs
}

const chatMessages = computed(() => buildChatMessages(selectedStore.value ?? null))

function openNewThreadDialog() {
  newThreadError.value = ''
  newThreadBrowseError.value = ''
  newThreadBrowseOpen.value = false
  newThreadBrowsePath.value = ''
  newThreadBrowseParent.value = null
  newThreadBrowseEntries.value = []

  // Prefer current defaults, but ensure the selected machine exists and is online.
  const preferred = String(defaults.machineId ?? '').trim()
  const preferredRow = preferred ? (machines.value.find((m) => m.machineId === preferred) ?? null) : null
  const preferredOnline = preferredRow ? machineIsOnline(preferredRow) : false
  newThreadMachineId.value = preferredOnline ? preferred : (machinesForSelect.value[0]?.machineId ?? '')

  newThreadCwd.value = String(defaults.cwd ?? '')
  newThreadOpen.value = true
}

function closeNewThreadDialog() {
  newThreadOpen.value = false
  newThreadError.value = ''
  newThreadBrowseOpen.value = false
  newThreadBrowseError.value = ''
}

async function loadNewThreadBrowse(path) {
  newThreadBrowseLoading.value = true
  newThreadBrowseError.value = ''
  try {
    const machineId = String(newThreadMachineId.value ?? '').trim()
    if (!machineId) throw new Error('Select a machine first.')
    if (!newThreadSelectedMachineOnline.value) throw new Error('runner not connected')

    const res = await apiFetch(`/api/fs/list?machineId=${encodeURIComponent(machineId)}&path=${encodeURIComponent(String(path ?? ''))}`)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

    newThreadBrowsePath.value = String(data?.path ?? '')
    newThreadBrowseParent.value = (data?.parent === null || data?.parent === undefined) ? null : String(data.parent)
    newThreadBrowseEntries.value = Array.isArray(data?.entries) ? data.entries : []
  } catch (err) {
    newThreadBrowseError.value = String(err?.message ?? err)
  } finally {
    newThreadBrowseLoading.value = false
  }
}

function openNewThreadBrowse() {
  if (!String(newThreadMachineId.value ?? '').trim()) {
    newThreadError.value = 'Machine is required.'
    return
  }
  if (!newThreadSelectedMachineOnline.value) {
    newThreadError.value = 'Runner not connected for this machine. Choose an online machine.'
    return
  }
  newThreadBrowseOpen.value = true
  loadNewThreadBrowse(newThreadCwd.value || '').catch(() => {})
}

function selectNewThreadBrowseFolder() {
  if (!newThreadBrowsePath.value) return
  newThreadCwd.value = newThreadBrowsePath.value
  newThreadBrowseOpen.value = false
}

function confirmNewThreadDialog() {
  newThreadError.value = ''
  const machineId = String(newThreadMachineId.value ?? '').trim()
  const cwd = String(newThreadCwd.value ?? '').trim()

  if (!machineId) {
    newThreadError.value = 'Machine is required.'
    return
  }
  if (!newThreadSelectedMachineOnline.value) {
    newThreadError.value = 'Runner not connected for this machine. Choose an online machine.'
    return
  }
  if (!cwd) {
    newThreadError.value = 'Workspace is required.'
    return
  }

  defaults.machineId = machineId
  defaults.cwd = cwd

  closeNewThreadDialog()
  newChat()
}

watch(newThreadMachineId, () => {
  // Folder browser depends on machine selection.
  if (!newThreadBrowseOpen.value) return
  loadNewThreadBrowse('').catch(() => {})
})

function newChat() {
  selectedSessionId.value = null
  messageDraft.value = ''
  attachments.value.splice(0, attachments.value.length)
  showPlan.value = false
}

function onChatScroll() {
  const el = chatScrollEl.value
  if (!el) return
  if (selectedSessionId.value && el.scrollTop <= 80) {
    loadMoreBefore(selectedSessionId.value, { pages: 3 }).catch(() => {})
  }
  const nearBottom = (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 80)
  const was = stickToBottom.value
  stickToBottom.value = nearBottom
  if (!was && nearBottom && selectedSessionId.value) {
    scheduleMarkRead(selectedSessionId.value)
  }
}

function scrollToBottom() {
  const el = chatScrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  stickToBottom.value = true
  if (selectedSessionId.value) scheduleMarkRead(selectedSessionId.value)
}

watch(
  () => (selectedStore.value?.events.length ?? 0),
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    const el = chatScrollEl.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    if (selectedSessionId.value) scheduleMarkRead(selectedSessionId.value)
  }
)

function ensureDefaultsReady() {
  defaultsError.value = ''
  if (!defaults.cwd.trim()) {
    defaultsError.value = 'Workspace (cwd) is required.'
    openSettings('defaults')
    return false
  }
  return true
}

function isImageType(mimeType) {
  return String(mimeType ?? '').toLowerCase().startsWith('image/')
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function openFilePicker() {
  try { fileInputEl.value?.click?.() } catch {}
}

async function addFiles(files) {
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
  for (const f of (Array.isArray(files) ? files : [])) {
    if (!f) continue
    if (Number(f.size ?? 0) > MAX_UPLOAD_BYTES) {
      sendError.value = `File too large: ${f.name} (max 50MB)`
      continue
    }

    let dataUrl = ''
    try {
      dataUrl = await fileToDataUrl(f)
    } catch {
      sendError.value = `Failed to read file: ${f.name}`
      continue
    }
    const base64 = String(dataUrl).split(',')[1] ?? ''
    if (!base64) {
      sendError.value = `Failed to read file: ${f.name}`
      continue
    }

    const mimeType = f.type || 'application/octet-stream'
    attachments.value.push({
      id: crypto.randomUUID(),
      filename: f.name,
      mimeType,
      sizeBytes: Number(f.size ?? 0) || 0,
      contentBase64: base64,
      previewUrl: isImageType(mimeType) ? dataUrl : null
    })
  }
}

async function onFilesPicked(ev) {
  sendError.value = ''
  const files = Array.from(ev?.target?.files ?? [])
  // allow re-selecting the same file
  try { ev.target.value = '' } catch {}
  if (!files.length) return
  await addFiles(files)
}

async function onComposerPaste(ev) {
  try {
    const files = Array.from(ev?.clipboardData?.files ?? [])
    if (!files.length) return
    sendError.value = ''
    await addFiles(files)
    // If the paste had no text, prevent the browser from inserting odd characters.
    const txt = ev?.clipboardData?.getData?.('text') ?? ''
    if (!String(txt ?? '').trim()) ev.preventDefault?.()
  } catch {
  }
}

function onComposerDragEnter() {
  composerDragDepth += 1
  composerDragging.value = true
}

function onComposerDragLeave() {
  composerDragDepth -= 1
  if (composerDragDepth <= 0) {
    composerDragDepth = 0
    composerDragging.value = false
  }
}

async function onComposerDrop(ev) {
  composerDragDepth = 0
  composerDragging.value = false
  sendError.value = ''
  const files = Array.from(ev?.dataTransfer?.files ?? [])
  if (!files.length) return
  await addFiles(files)
}

function removeAttachment(id) {
  const idx = attachments.value.findIndex((a) => a?.id === id)
  if (idx >= 0) attachments.value.splice(idx, 1)
}

async function createSessionFromDraft(prompt) {
  if (!ensureDefaultsReady()) return null

  const options = {
    ...(defaults.model.trim() ? { model: defaults.model.trim() } : {}),
    ...(String(defaults.reasoningEffort ?? '').trim() ? { reasoningEffort: String(defaults.reasoningEffort).trim() } : {}),
    approvalPolicy: defaults.approvalPolicy,
    sandbox: defaults.sandbox
  }

  const res = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      cwd: defaults.cwd.trim(),
      prompt,
      ...(defaults.machineId ? { machineId: defaults.machineId } : {}),
      options,
      ...(attachments.value.length ? {
        attachments: attachments.value.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          contentBase64: a.contentBase64
        }))
      } : {})
    })
  })

  if (!res.ok) {
    const err = await res.json().catch(() => null)
    sendError.value = err?.error ?? `HTTP ${res.status}`
    return null
  }

  const data = await res.json()
  selectedSessionId.value = data.sessionId
  attachments.value.splice(0, attachments.value.length)
  return data.sessionId
}

async function submit() {
  sendError.value = ''
  if (selectedSession.value?.turnState === 'running') {
    await stopGenerating()
    return
  }
  const text = messageDraft.value.trim()
  if (!text && !attachments.value.length) return
  if (sending.value) return
  sending.value = true

  try {
    // If no session is selected, the first message starts a new session (ChatGPT-style).
    if (!selectedSessionId.value) {
      const sessionId = await createSessionFromDraft(text)
      if (sessionId) {
        messageDraft.value = ''
        attachments.value.splice(0, attachments.value.length)
      }
      return
    }

    const sessionId = selectedSessionId.value
    const res = await apiFetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        ...(attachments.value.length ? {
          attachments: attachments.value.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            contentBase64: a.contentBase64
          }))
        } : {})
      })
    })

    if (!res.ok) {
      const err = await res.json().catch(() => null)
      sendError.value = err?.error ?? `HTTP ${res.status}`
      return
    }

    messageDraft.value = ''
    attachments.value.splice(0, attachments.value.length)
  } finally {
    sending.value = false
  }
}

async function stopSession() {
  const sessionId = selectedSessionId.value
  if (!sessionId) return
  await apiFetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
}

async function stopGenerating() {
  const sessionId = selectedSessionId.value
  if (!sessionId) return
  await apiFetch(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
}

async function archiveCurrentSession() {
  const sessionId = selectedSessionId.value
  if (!sessionId) return
  const res = await apiFetch(`/api/sessions/${sessionId}/archive`, { method: 'POST' })
  if (!res.ok) return
  const data = await res.json().catch(() => null)
  if (data?.session) upsertSessionRow(data.session)
  // If we just archived the open session, go back to a new chat.
  if (selectedSessionId.value === sessionId) {
    selectedSessionId.value = null
  }
}

async function unarchiveSessionById(sessionId) {
  if (!sessionId) return
  const res = await apiFetch(`/api/sessions/${sessionId}/unarchive`, { method: 'POST' })
  if (!res.ok) return
  const data = await res.json().catch(() => null)
  if (data?.session) upsertSessionRow(data.session)
}

async function unarchiveFromArchiveModal(sessionId) {
  await unarchiveSessionById(sessionId)
  const idx = archivedSessions.value.findIndex((s) => s?.sessionId === sessionId)
  if (idx >= 0) archivedSessions.value.splice(idx, 1)
}

async function loadArchivedSessions() {
  archiveError.value = ''
  archiveLoading.value = true
  try {
    const res = await apiFetch('/api/sessions?archived=1')
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      archiveError.value = err?.error ?? `HTTP ${res.status}`
      return
    }
    const data = await res.json().catch(() => null)
    archivedSessions.value = Array.isArray(data?.sessions) ? data.sessions : []
  } finally {
    archiveLoading.value = false
  }
}

function openArchiveModal() {
  archiveOpen.value = true
  loadArchivedSessions().catch(() => {})
}

function openDeleteModal(sessionId) {
  deleteError.value = ''
  deleteSessionId.value = sessionId ?? selectedSessionId.value
  deleteOpen.value = true
}

async function confirmDeleteSession() {
  deleteError.value = ''
  const sessionId = deleteSessionId.value
  if (!sessionId) return
  if (deleteWorking.value) return
  deleteWorking.value = true
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      deleteError.value = err?.error ?? `HTTP ${res.status}`
      return
    }
    deleteOpen.value = false
    // If we deleted the current session, reset view.
    if (selectedSessionId.value === sessionId) selectedSessionId.value = null
    const liveIdx = sessions.value.findIndex((s) => s?.sessionId === sessionId)
    if (liveIdx >= 0) sessions.value.splice(liveIdx, 1)
    // Also remove from archived list view if open.
    const idx = archivedSessions.value.findIndex((s) => s?.sessionId === sessionId)
    if (idx >= 0) archivedSessions.value.splice(idx, 1)
  } finally {
    deleteWorking.value = false
  }
}

function openDeleteMachineModal(machineId) {
  deleteMachineError.value = ''
  deleteMachineId.value = machineId
  deleteMachineOpen.value = true
}

async function confirmDeleteMachine() {
  deleteMachineError.value = ''
  const machineId = String(deleteMachineId.value ?? '').trim()
  if (!machineId) return
  if (deleteMachineWorking.value) return

  const m = machines.value.find((row) => row?.machineId === machineId) ?? null
  if (m && machineIsOnline(m)) {
    deleteMachineError.value = 'Machine is online. Disconnect the runner before deleting.'
    return
  }

  deleteMachineWorking.value = true
  try {
    const res = await apiFetch(`/api/machines/${encodeURIComponent(machineId)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      deleteMachineError.value = err?.error ?? `HTTP ${res.status}`
      return
    }
    deleteMachineOpen.value = false
    removeMachineLocal(machineId)
  } finally {
    deleteMachineWorking.value = false
  }
}

async function disconnectMachine(machineId) {
  machineDisconnectError.value = ''
  const mid = String(machineId ?? '').trim()
  if (!mid) return
  if (machineDisconnectWorkingId.value) return
  machineDisconnectWorkingId.value = mid
  try {
    const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/disconnect`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      machineDisconnectError.value = err?.error ?? `HTTP ${res.status}`
      return
    }
  } finally {
    machineDisconnectWorkingId.value = null
  }
}

async function openVSCode() {
  ideError.value = ''
  if (ideStarting.value) return
  if (!ensureDefaultsReady()) return
  ideStarting.value = true

  const cwd = selectedSession.value?.cwd ?? defaults.cwd.trim()
  const machineId = selectedSession.value?.machineId ?? (defaults.machineId || null)

  try {
    const res = await apiFetch('/api/ide-sessions', {
      method: 'POST',
      body: JSON.stringify({
        cwd,
        ...(machineId ? { machineId } : {})
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      ideError.value = err?.error ?? `HTTP ${res.status}`
      return
    }

    const data = await res.json().catch(() => null)
    const urlPath = data?.urlPath
    if (!urlPath) {
      ideError.value = 'IDE session did not return a urlPath.'
      return
    }

    window.open(urlPath, '_blank', 'noopener')
  } finally {
    ideStarting.value = false
  }
}

const pendingApproval = computed(() => approvalQueue.value[0] ?? null)

function approvalAllows(decision) {
  const p = pendingApproval.value
  const allowed = p?.availableDecisions
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  return allowed.some((d) => {
    if (typeof d === 'string') return d === decision
    if (d && typeof d === 'object') {
      if (decision === 'acceptWithExecpolicyAmendment') return 'acceptWithExecpolicyAmendment' in d
      if (decision === 'applyNetworkPolicyAmendment') return 'applyNetworkPolicyAmendment' in d
    }
    return false
  })
}

const approvalExtraActions = computed(() => {
  const p = pendingApproval.value
  if (!p || p.kind !== 'command') return []

  const actions = []

  const allowed = Array.isArray(p.availableDecisions) ? p.availableDecisions : null
  if (allowed) {
    for (const d of allowed) {
      if (!d || typeof d !== 'object') continue

      if ('acceptWithExecpolicyAmendment' in d) {
        actions.push({
          id: 'acceptWithExecpolicyAmendment',
          label: 'Accept + remember',
          decision: d,
          variant: 'emerald-solid'
        })
      }

      if ('applyNetworkPolicyAmendment' in d) {
        const amend = d.applyNetworkPolicyAmendment?.network_policy_amendment ?? null
        const host = String(amend?.host ?? '').trim()
        const action = String(amend?.action ?? '').trim()
        const label = (host && action) ? `Always ${action} ${host}` : 'Apply network rule'
        actions.push({
          id: `applyNetworkPolicyAmendment:${action}:${host}`,
          label,
          decision: d,
          variant: (action === 'deny') ? 'red-outline' : 'emerald-outline'
        })
      }
    }
    return actions
  }

  // Fallbacks (when Codex didn't provide availableDecisions).
  if (Array.isArray(p.proposedExecpolicyAmendment) && p.proposedExecpolicyAmendment.length) {
    actions.push({
      id: 'acceptWithExecpolicyAmendment:fallback',
      label: 'Accept + remember',
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment }
      },
      variant: 'emerald-solid'
    })
  }

  if (Array.isArray(p.proposedNetworkPolicyAmendments)) {
    for (const a of p.proposedNetworkPolicyAmendments) {
      const host = String(a?.host ?? '').trim()
      const action = String(a?.action ?? '').trim()
      if (!host || (action !== 'allow' && action !== 'deny')) continue
      actions.push({
        id: `applyNetworkPolicyAmendment:fallback:${action}:${host}`,
        label: `Always ${action} ${host}`,
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action, host }
          }
        },
        variant: (action === 'deny') ? 'red-outline' : 'emerald-outline'
      })
    }
  }

  return actions
})

async function respondApproval(decision) {
  const p = pendingApproval.value
  if (!p || approvalResponding.value) return
  approvalRespondError.value = ''
  approvalResponding.value = true
  try {
    const res = await apiFetch(`/api/approvals/${p.approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      approvalRespondError.value = err?.error ?? `HTTP ${res.status}`
      return
    }
    approvalQueue.value.shift()
  } finally {
    approvalResponding.value = false
  }
}

function resetUserInputForm(p) {
  userInputError.value = ''
  userInputSubmitting.value = false
  for (const k of Object.keys(userInputForm)) delete userInputForm[k]

  if (p?.kind !== 'userInput') return
  const questions = Array.isArray(p?.questions) ? p.questions : []
  for (const q of questions) {
    const qid = String(q?.id ?? '')
    if (!qid) continue
    const opts = Array.isArray(q?.options) ? q.options : []
    const first = opts.length ? String(opts[0]?.label ?? '') : ''
    userInputForm[qid] = { choice: first, other: '', text: '' }
  }
}

watch(pendingApproval, (p) => {
  approvalRespondError.value = ''
  resetUserInputForm(p)
})

async function submitUserInput() {
  const p = pendingApproval.value
  if (!p || p.kind !== 'userInput' || userInputSubmitting.value) return
  userInputError.value = ''
  userInputSubmitting.value = true
  try {
    const questions = Array.isArray(p?.questions) ? p.questions : []
    const answers = {}
    for (const q of questions) {
      const qid = String(q?.id ?? '')
      if (!qid) continue
      const state = userInputForm[qid] ?? null
      const opts = Array.isArray(q?.options) ? q.options : []

      let val = ''
      if (opts.length) {
        const choice = String(state?.choice ?? '')
        if (choice === '__other__') val = String(state?.other ?? '').trim()
        else val = choice
      } else {
        val = String(state?.text ?? '').trim()
      }

      if (!val) {
        userInputError.value = `Please answer: ${String(q?.header ?? qid)}`
        return
      }
      answers[qid] = { answers: [val] }
    }

    const res = await apiFetch(`/api/approvals/${p.approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'accept', answers })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      userInputError.value = err?.error ?? `HTTP ${res.status}`
      return
    }

    approvalQueue.value.shift()
  } finally {
    userInputSubmitting.value = false
  }
}

async function cancelUserInput() {
  const p = pendingApproval.value
  if (!p || p.kind !== 'userInput' || userInputSubmitting.value) return
  userInputError.value = ''
  userInputSubmitting.value = true
  try {
    const res = await apiFetch(`/api/approvals/${p.approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'cancel' })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      userInputError.value = err?.error ?? `HTTP ${res.status}`
      return
    }

    approvalQueue.value.shift()
  } finally {
    userInputSubmitting.value = false
  }
}

onMounted(async () => {
  refreshNotificationPermission()
  try {
    const u = new URL(window.location.href)
    const sid = u.searchParams.get('session')
    if (sid) deepLinkSessionId.value = sid
  } catch {
  }

  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const onMsg = (ev) => {
      const data = ev?.data ?? null
      if (!data || typeof data !== 'object') return
      if (data.type !== 'navigate') return
      const sid = data.sessionId
      if (typeof sid === 'string' && sid) {
        selectedSessionId.value = sid
      } else if (typeof data.url === 'string' && data.url) {
        try { window.location.href = data.url } catch { }
      }
    }
    swMessageHandler = onMsg
    try { navigator.serviceWorker.addEventListener('message', onMsg) } catch { }
  }

  try {
    const raw = localStorage.getItem('rootgrid.defaults')
    if (raw) Object.assign(defaults, JSON.parse(raw))
  } catch {
  }

  watch(defaults, () => {
    try {
      localStorage.setItem('rootgrid.defaults', JSON.stringify(defaults))
    } catch {
    }
  }, { deep: true })

  // Network offline/online banner support.
  try {
    networkOnline.value = navigator.onLine
  } catch {
  }
  const onOnline = () => {
    networkOnline.value = true
    if (authed.value) connectSse()
  }
  const onOffline = () => {
    networkOnline.value = false
  }
  onlineHandler = onOnline
  offlineHandler = onOffline
  try { window.addEventListener('online', onOnline) } catch {}
  try { window.addEventListener('offline', onOffline) } catch {}

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      if (renameOpen.value) renameOpen.value = false
      else if (defaultsOpen.value) defaultsOpen.value = false
      else if (sessionPolicyOpen.value) sessionPolicyOpen.value = false
      else if (deleteOpen.value) deleteOpen.value = false
      else if (deleteMachineOpen.value) deleteMachineOpen.value = false
      else if (archiveOpen.value) archiveOpen.value = false
    }
  }
  keydownHandler = onKeyDown
  window.addEventListener('keydown', onKeyDown)

  const onVisibility = () => schedulePostVisibility()
  visibilityHandler = onVisibility
  try { document.addEventListener('visibilitychange', onVisibility) } catch {}
  try { window.addEventListener('focus', onVisibility) } catch {}
  try { window.addEventListener('blur', onVisibility) } catch {}

  nowTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 10_000)
  nowTimer.unref?.()

  heartbeatCheckTimer = setInterval(() => {
    if (!authed.value) return
    if (!networkOnline.value) return
    if (sseStatus.value !== 'connected') return
    const age = Date.now() - Number(lastSseMessageAt.value ?? 0)
    if (age > 95_000) {
      sseDisconnectReason.value = 'heartbeat-timeout'
      connectSse()
    }
  }, 5_000)

  await checkAuth()
  if (authed.value) {
    connectSse()
    if (deepLinkSessionId.value) {
      selectedSessionId.value = deepLinkSessionId.value
      deepLinkSessionId.value = null
    }
  }
})

onBeforeUnmount(() => {
  if (nowTimer) {
    try { clearInterval(nowTimer) } catch {}
    nowTimer = null
  }
  if (heartbeatCheckTimer) {
    try { clearInterval(heartbeatCheckTimer) } catch {}
    heartbeatCheckTimer = null
  }
  if (keydownHandler) {
    window.removeEventListener('keydown', keydownHandler)
    keydownHandler = null
  }

  if (onlineHandler) {
    try { window.removeEventListener('online', onlineHandler) } catch {}
    onlineHandler = null
  }
  if (offlineHandler) {
    try { window.removeEventListener('offline', offlineHandler) } catch {}
    offlineHandler = null
  }

  if (visibilityHandler) {
    try { document.removeEventListener('visibilitychange', visibilityHandler) } catch {}
    try { window.removeEventListener('focus', visibilityHandler) } catch {}
    try { window.removeEventListener('blur', visibilityHandler) } catch {}
    visibilityHandler = null
  }

  if (swMessageHandler && typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try { navigator.serviceWorker.removeEventListener('message', swMessageHandler) } catch {}
    swMessageHandler = null
  }
})
</script>

<template>
  <div class="h-screen w-screen bg-slate-50 text-slate-900">
    <div v-if="!authed" class="h-full flex items-center justify-center px-6">
      <div class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="text-xl font-semibold tracking-tight text-slate-900">Rootgrid</div>
        <div class="mt-1 text-sm text-slate-600">Enter your client token to connect.</div>

        <div class="mt-6">
          <label class="text-xs uppercase tracking-wider text-slate-500">Client token</label>
          <input
            v-model="authToken"
            type="password"
            class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
            placeholder="paste token from ~/.rootgrid/config.json"
            @keydown.enter.prevent="login"
          />
          <div v-if="authError" class="mt-2 text-sm text-red-600">{{ authError }}</div>
        </div>

        <button
          class="mt-4 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
          @click="login"
        >
          Connect
        </button>
      </div>
    </div>

    <div v-else class="h-full flex flex-col">
      <div
        v-if="connectionBanner"
        class="shrink-0 border-b border-slate-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60"
      >
        <div class="flex items-center justify-between gap-3 px-4 py-2 text-xs">
          <div class="min-w-0 truncate" :class="connectionBanner.tone === 'error' ? 'text-red-700' : 'text-amber-700'">
            {{ connectionBanner.text }}
          </div>
          <button
            class="shrink-0 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            @click="connectSse"
            :disabled="!networkOnline"
          >
            Reconnect
          </button>
        </div>
      </div>

      <div class="flex flex-1 min-h-0">
        <!-- Sidebar -->
        <aside class="shrink-0 w-[320px] border-r border-slate-200 bg-white flex flex-col">
          <div class="shrink-0 px-4 py-4">
            <div class="flex items-center justify-between gap-3">
              <div class="font-semibold tracking-tight text-slate-900">Rootgrid</div>
              <span
                class="h-2 w-2 rounded-full"
                :class="sseStatus === 'connected' ? 'bg-emerald-500' : (sseStatus === 'error' ? 'bg-red-500' : 'bg-amber-500')"
                :title="`SSE: ${sseStatus}`"
              />
            </div>

            <div class="mt-4 space-y-1">
              <button
                class="w-full inline-flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
                @click="openNewThreadDialog"
              >
                <Plus class="h-4 w-4 text-slate-500" />
                New thread
              </button>
            </div>
          </div>

          <div class="shrink-0 px-4 pb-2">
            <div class="flex items-center justify-between gap-2">
              <div class="text-[11px] uppercase tracking-wider text-slate-500">Threads</div>
              <button
                class="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                @click="openArchiveModal"
                title="Archived threads"
              >
                <Archive class="h-4 w-4" />
              </button>
            </div>
          </div>

          <div class="flex-1 overflow-auto px-2 pb-2">
            <div v-if="!hasSnapshot" class="space-y-2 px-2 py-2">
              <div
                v-for="i in 7"
                :key="i"
                class="h-11 animate-pulse rounded-lg bg-slate-100"
              />
            </div>

            <div v-else>
              <div v-if="!visibleSessions.length" class="px-3 py-10 text-center text-xs text-slate-500">
                No threads yet.
              </div>

              <button
                v-for="s in visibleSessions"
                :key="s.sessionId"
                class="group w-full rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
                :class="selectedSessionId === s.sessionId ? 'bg-slate-100' : 'hover:bg-slate-50'"
                :title="sessionTooltip(s)"
                @click="selectedSessionId = s.sessionId"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0 flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full" :class="indicatorDotClass(sessionIndicator(s))" />
                    <div class="truncate text-sm font-medium text-slate-900">{{ sessionListTitle(s) }}</div>
                  </div>
                  <div class="shrink-0 text-xs text-slate-500">{{ formatAgeShort(s.updatedMs) }}</div>
                </div>

                <div class="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
                  <button
                    class="shrink-0 max-w-[160px] truncate rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600 transition-colors hover:bg-slate-200/60"
                    :title="s.cwd"
                    @click.stop="openRenameSession(s, { focus: 'project' })"
                  >
                    {{ sessionProject(s) }}
                  </button>
                  <span class="shrink-0 text-slate-300">·</span>
                  <span class="truncate">{{ sessionHostName(s) }}</span>
                </div>
              </button>
            </div>
          </div>

          <div class="shrink-0 border-t border-slate-200 p-2">
            <button
              class="w-full inline-flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
              @click="openSettings('defaults')"
            >
              <Settings class="h-4 w-4 text-slate-500" />
              Settings
            </button>
          </div>
        </aside>

      <!-- Main -->
      <main class="flex-1 grid grid-cols-1 bg-slate-50" :class="showPlan ? 'lg:grid-cols-[1fr_520px]' : ''">
        <section class="min-w-0 flex flex-col bg-white">
          <header class="border-b border-slate-200 bg-white px-4 py-3">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    v-if="selectedSession"
                    class="h-2.5 w-2.5 rounded-full ring-1 ring-black/25 shadow-sm"
                    :class="indicatorDotClass(sessionIndicator(selectedSession))"
                  />
                  <div v-if="selectedSession" class="min-w-0 flex items-center gap-2">
                    <button
                      class="truncate text-sm font-medium text-slate-900 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 rounded"
                      title="Rename thread"
                      @click="openRenameSession(selectedSession, { focus: 'title' })"
                    >
                      {{ sessionListTitle(selectedSession) }}
                    </button>
                    <button
                      class="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-700 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                      title="Rename project label"
                      @click="openRenameSession(selectedSession, { focus: 'project' })"
                    >
                      {{ sessionProject(selectedSession) }}
                    </button>
                  </div>
                  <div v-else class="truncate text-sm font-medium text-slate-900">New thread</div>
                </div>
                <div class="mt-1 truncate text-xs text-slate-600" :title="selectedSession?.cwd ?? defaults.cwd">
                  {{ selectedSession?.cwd ?? (defaults.cwd ? defaults.cwd : 'Pick a workspace to start') }}
                </div>
                <div v-if="selectedTokenUsage" class="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <span class="truncate">
                    Tokens:
                    <span v-if="selectedTokenUsage.lastTotalTokens !== null" class="text-slate-700">last {{ formatCompactInt(selectedTokenUsage.lastTotalTokens) }}</span>
                    <span v-else class="text-slate-500">last —</span>
                    <span class="text-slate-300">·</span>
                    <span v-if="selectedTokenUsage.totalTotalTokens !== null" class="text-slate-700">total {{ formatCompactInt(selectedTokenUsage.totalTotalTokens) }}</span>
                    <span v-else class="text-slate-500">total —</span>
                    <span v-if="selectedTokenUsage.modelContextWindow !== null" class="text-slate-300">·</span>
                    <span v-if="selectedTokenUsage.modelContextWindow !== null" class="text-slate-500">ctx {{ formatCompactInt(selectedTokenUsage.modelContextWindow) }}</span>
                  </span>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <button
                  class="inline-flex items-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                  @click="showPlan = !showPlan"
                >
                  <component :is="showPlan ? PanelRightClose : PanelRightOpen" class="h-3.5 w-3.5" />
                  Plan
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
                  @click="openVSCode"
                  title="Open VS Code web (code-server)"
                  :disabled="ideStarting"
                >
                  <Loader2 v-if="ideStarting" class="h-3.5 w-3.5 animate-spin" />
                  <Code v-else class="h-3.5 w-3.5" />
                  Open
                </button>
              </div>
            </div>
          </header>

          <div class="relative flex-1">
            <div ref="chatScrollEl" class="absolute inset-0 overflow-auto px-4 py-6" @scroll="onChatScroll">
              <div class="mx-auto w-full max-w-3xl">
              <div v-if="selectedSessionId && sessionLoading" class="py-10">
                <div class="space-y-3 animate-pulse">
                  <div class="h-8 w-2/3 rounded-xl bg-slate-100" />
                  <div class="h-6 w-1/3 rounded-xl bg-slate-100" />
                  <div class="h-20 w-full rounded-2xl bg-slate-100" />
                  <div class="h-20 w-11/12 rounded-2xl bg-slate-100" />
                </div>
              </div>

              <div v-else-if="!selectedSessionId && !chatMessages.length" class="py-16 text-center">
                <div class="text-lg font-semibold text-slate-900">Start a thread</div>
                <div class="mt-2 text-sm text-slate-600">
                  Type a message below to start a new Codex session in your workspace.
                </div>
              </div>

              <div v-else-if="selectedSessionId && !chatMessages.length" class="py-16 text-center">
                <div class="text-sm font-medium text-slate-900">No messages yet</div>
                <div class="mt-2 text-sm text-slate-600">Waiting for events…</div>
              </div>

              <div v-else>
              <div v-if="selectedStore?.loadingBefore" class="pb-4 text-center text-xs text-slate-500">Loading earlier…</div>
              <transition-group name="rg-msg" tag="div" class="space-y-3">
                <div
                  v-for="m in chatMessages"
                  :key="m.id"
                  class="flex"
                  :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
                >
                  <!-- Interleaved "step lines" (reasoning sections + tools) -->
                  <div v-if="m.role === 'step'" class="w-full">
                    <!-- Reasoning step -->
                    <details v-if="m.stepKind === 'reasoning'" class="group w-full">
                      <summary class="cursor-pointer select-none truncate text-xs font-medium text-slate-700 hover:text-slate-900">
                        {{ m.title || 'Reasoning' }}
                      </summary>
                      <div v-if="String(m.body ?? '').trim()" class="mt-2 border-l border-slate-200 pl-4">
                        <MarkdownView :source="m.body" />
                      </div>
                    </details>

                    <!-- Explore fold (derived from read/search/list commands) -->
                    <details v-else-if="m.stepKind === 'explore'" class="group w-full">
                      <summary class="cursor-pointer select-none truncate text-xs font-medium text-slate-700 hover:text-slate-900">
                        {{ m.title || 'Explored' }}
                      </summary>
                      <div v-if="Array.isArray(m.entries) && m.entries.length" class="mt-2 border-l border-slate-200 pl-4">
                        <div class="space-y-1 text-xs text-slate-700">
                          <div v-for="e in m.entries" :key="e.id" class="truncate" :title="e.label">{{ e.label }}</div>
                        </div>
                      </div>
                    </details>

                    <!-- Inline diffs (VS Code-like) -->
                    <div v-else-if="m.stepKind === 'diff'" class="w-full">
                      <div class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                        <div class="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                          <div class="shrink-0 text-[11px] uppercase tracking-wider text-slate-500">Edited file</div>
                          <select
                            v-if="Array.isArray(m.files) && m.files.length > 1"
                            :value="diffStepSelectedPath(m.id, m.files)"
                            class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-400/30"
                            @change="setDiffStepSelectedPath(m.id, $event.target.value)"
                          >
                            <option v-for="f in m.files" :key="f.path" :value="f.path">{{ f.path }}</option>
                          </select>
                          <div v-else class="min-w-0 flex-1 truncate text-xs font-mono text-slate-800">
                            {{ diffStepSelectedFile(m.id, m.files)?.path ?? '' }}
                          </div>
                          <button
                            class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/40"
                            title="Copy diff"
                            @click="copyText(diffStepSelectedFile(m.id, m.files)?.raw ?? m.raw ?? '')"
                          >
                            <Copy class="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div v-if="!Array.isArray(m.files) || !m.files.length" class="p-3">
                          <pre class="m-0 whitespace-pre-wrap break-words text-xs font-mono text-slate-800">{{ m.raw ?? '' }}</pre>
                        </div>

                        <template v-else>
                          <div class="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                            <div class="min-w-0 truncate text-xs font-mono text-slate-800">
                              {{ diffStepSelectedFile(m.id, m.files)?.path ?? '' }}
                            </div>
                            <div class="shrink-0 text-xs font-mono">
                              <span class="text-emerald-700">+{{ diffStepSelectedFile(m.id, m.files)?.added ?? 0 }}</span>
                              <span class="ml-2 text-rose-700">-{{ diffStepSelectedFile(m.id, m.files)?.removed ?? 0 }}</span>
                            </div>
                          </div>

                          <div class="max-h-[520px] overflow-auto">
                            <table class="w-full border-collapse text-xs font-mono">
                              <tbody>
                                <tr
                                  v-for="(l, idx) in (diffStepSelectedFile(m.id, m.files)?.lines ?? [])"
                                  :key="idx"
                                  :class="l.kind === 'add'
                                    ? 'bg-emerald-50'
                                    : (l.kind === 'del'
                                      ? 'bg-rose-50'
                                      : (l.kind === 'hunk' ? 'bg-slate-100' : 'bg-white'))"
                                >
                                  <td class="w-12 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400">{{ l.oldLine ?? '' }}</td>
                                  <td class="w-12 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400">{{ l.newLine ?? '' }}</td>
                                  <td class="pr-3 align-top">
                                    <pre
                                      class="m-0 whitespace-pre text-slate-800"
                                      :class="l.kind === 'hunk' ? 'text-slate-600' : ''"
                                    >{{ l.kind === 'hunk' ? l.text : l.text }}</pre>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </template>
                      </div>
                    </div>

                    <!-- Tool step -->
                    <details
                      v-else
                      class="group w-full"
                      :open="m.expanded"
                      @toggle="onToolDetailsToggle(m.itemId, $event)"
                    >
                      <summary class="cursor-pointer select-none flex items-center justify-between gap-3">
                        <div class="min-w-0 flex items-center gap-2 text-xs text-slate-600">
                          <span class="shrink-0 text-[10px] uppercase tracking-wider text-slate-400">
                            {{ m.tool === 'commandExecution' ? 'Command' : (m.tool === 'fileChange' ? 'File changes' : 'Tool') }}
                          </span>
                          <span class="shrink-0 text-slate-300">·</span>
                          <span class="shrink-0 text-slate-600">{{ String(m.status ?? '') }}</span>
                          <span v-if="m.exitCode !== null && m.exitCode !== undefined" class="shrink-0 text-slate-300">·</span>
                          <span v-if="m.exitCode !== null && m.exitCode !== undefined" class="shrink-0 text-slate-600">exit {{ m.exitCode }}</span>

                          <span
                            v-if="toolDisplayCommand(m)"
                            class="min-w-0 truncate font-mono text-slate-800"
                            :title="toolDisplayCommand(m)"
                          >
                            {{ toolDisplayCommand(m) }}
                          </span>
                          <span v-else-if="m.tool === 'fileChange'" class="min-w-0 truncate text-slate-700">
                            {{ Array.isArray(m.changes) ? `${m.changes.length} file(s)` : 'file changes' }}
                          </span>
                        </div>
                      </summary>

                      <div class="mt-2 space-y-3 border-l border-slate-200 pl-4">
                        <div
                          v-if="m.tool === 'fileChange' && Array.isArray(m.changes) && m.changes.length"
                          class="rounded-lg border border-slate-200 bg-slate-50 p-3"
                        >
                          <div class="text-[11px] uppercase tracking-wider text-slate-500">Files</div>
                          <div class="mt-2 space-y-1 text-xs font-mono text-slate-800">
                            <div v-for="(c, idx) in m.changes.slice(0, 50)" :key="idx" class="truncate" :title="c.path">{{ c.path }}</div>
                            <div v-if="m.changes.length > 50" class="text-[11px] text-slate-500">…and {{ m.changes.length - 50 }} more</div>
                          </div>
                        </div>

                        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <div class="flex items-center justify-between gap-3">
                            <div class="text-[11px] uppercase tracking-wider text-slate-500">Output</div>
                            <button
                              v-if="m.output?.hasMoreBefore"
                              class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                              :disabled="m.output?.loading"
                              @click="loadMoreToolOutputBefore(selectedSessionId, m.itemId)"
                            >
                              Load more
                            </button>
                          </div>

                          <div v-if="!m.output" class="mt-2 text-xs text-slate-500">Loading…</div>
                          <div v-else>
                            <div v-if="m.output.loading" class="mt-2 text-xs text-slate-500">Loading…</div>

                            <div v-if="m.output.stdout" class="mt-2">
                              <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stdout</div>
                              <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-2 text-xs font-mono text-slate-800">{{ m.output.stdout }}</pre>
                            </div>

                            <div v-if="m.output.stderr" class="mt-2">
                              <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stderr</div>
                              <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-2 text-xs font-mono text-slate-800">{{ m.output.stderr }}</pre>
                            </div>

                            <div v-if="!m.output.loading && !m.output.stdout && !m.output.stderr" class="mt-2 text-xs text-slate-500">
                              (no output)
                            </div>
                          </div>
                        </div>
                      </div>
                    </details>
                  </div>

                  <!-- System lines -->
                  <div v-else-if="m.role === 'system'" class="w-full text-xs text-slate-600">
                    <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-400">{{ m.stream ?? 'system' }}</div>
                    <pre class="m-0 whitespace-pre-wrap">{{ m.text }}</pre>
                  </div>

                  <!-- User + assistant bubbles -->
                  <div
                    v-else
                    class="max-w-[860px] rounded-2xl border px-4 py-3 text-sm leading-relaxed shadow-sm transition-colors"
                    :class="m.role === 'user'
                      ? 'bg-indigo-50 text-indigo-950 border-indigo-200'
                      : 'bg-white text-slate-900 border-slate-200'"
                  >
                    <div v-if="m.role === 'assistant'">
                      <div v-if="String(m.text ?? '').trim()">
                        <MarkdownView :source="m.text" />
                      </div>
                    </div>
                    <div v-else>
                      <div v-if="Array.isArray(m.attachments) && m.attachments.length" class="mb-2 flex flex-wrap gap-2">
                        <a
                          v-for="a in m.attachments"
                          :key="a.uploadId ?? a.url ?? a.filename"
                          :href="a.url"
                          class="block"
                          target="_blank"
                          rel="noopener noreferrer"
                          :title="a.filename"
                        >
                          <img
                            v-if="isImageType(a.mimeType)"
                            :src="a.url"
                            :alt="a.filename"
                            class="h-20 w-20 rounded-xl object-cover ring-1 ring-slate-200 hover:ring-slate-300"
                          />
                          <div
                            v-else
                            class="flex h-12 max-w-[220px] items-center justify-center rounded-xl bg-white px-3 text-xs text-slate-800 ring-1 ring-slate-200 hover:ring-slate-300"
                          >
                            <div class="truncate">{{ a.filename }}</div>
                          </div>
                        </a>
                      </div>
                      <div v-if="String(m.text ?? '').trim()" class="whitespace-pre-wrap">{{ m.text }}</div>
                    </div>
                  </div>
                </div>
              </transition-group>
              </div>
              </div>
            </div>

            <button
              v-if="selectedSessionId && !stickToBottom"
              class="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 shadow-lg transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
              @click="scrollToBottom"
              title="Scroll to bottom"
            >
              <ArrowDown class="h-4 w-4" />
              <span class="hidden sm:inline">New messages</span>
            </button>
          </div>

          <footer
            class="relative border-t border-slate-200 bg-white px-4 py-3"
            @dragenter.prevent="onComposerDragEnter"
            @dragleave.prevent="onComposerDragLeave"
            @dragover.prevent
            @drop.prevent="onComposerDrop"
          >
            <div class="mx-auto w-full max-w-3xl">
              <div
                v-if="composerDragging"
                class="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-slate-900/30 bg-slate-900/5 text-sm font-medium text-slate-700"
              >
                Drop files to attach
              </div>
              <div v-if="ideError" class="mb-2 text-sm text-red-600">{{ ideError }}</div>
              <div v-if="sendError" class="mb-2 text-sm text-red-600">{{ sendError }}</div>
              <div v-if="composerOptionsError" class="mb-2 text-sm text-red-600">{{ composerOptionsError }}</div>
              <div v-if="modelCatalogError" class="mb-2 text-sm text-red-600">{{ modelCatalogError }}</div>

              <div class="rounded-3xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors focus-within:border-slate-300 focus-within:ring-2 focus-within:ring-slate-400/30">
                <textarea
                  v-model="messageDraft"
                  rows="2"
                  class="w-full resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
                  placeholder="Ask for follow-up changes…"
                  @keydown.enter.exact.prevent="submit"
                  @paste="onComposerPaste"
                />

                <div v-if="attachments.length" class="mt-2 flex flex-wrap gap-2">
                  <div
                    v-for="a in attachments"
                    :key="a.id"
                    class="relative rounded-2xl border border-slate-200 bg-white p-2"
                  >
                    <button
                      class="absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                      @click="removeAttachment(a.id)"
                      title="Remove"
                    >
                      <X class="h-3.5 w-3.5" />
                    </button>

                    <img
                      v-if="a.previewUrl"
                      :src="a.previewUrl"
                      :alt="a.filename"
                      class="h-14 w-14 rounded-xl object-cover"
                    />
                    <div v-else class="flex h-14 w-40 items-center justify-center rounded-xl bg-slate-50 px-2 text-xs text-slate-800">
                      <div class="truncate" :title="a.filename">{{ a.filename }}</div>
                    </div>
                  </div>
                </div>

                <div class="mt-2 flex items-center justify-between gap-2">
                  <div class="flex min-w-0 items-center gap-2">
                    <input
                      ref="fileInputEl"
                      type="file"
                      class="hidden"
                      multiple
                      @change="onFilesPicked"
                    />
                    <button
                      class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-transparent text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 active:scale-[0.99]"
                      @click="openFilePicker"
                      title="Upload files/images"
                    >
                      <Plus class="h-4 w-4" />
                    </button>

                    <select
                      v-model="composerModel"
                      class="h-9 max-w-[170px] rounded-full border border-slate-200 bg-white px-3 pr-8 text-xs text-slate-900 outline-none transition-colors focus:border-slate-400 focus:ring-2 focus:ring-slate-400/30 sm:max-w-[220px]"
                      title="Model"
                      :disabled="modelCatalogLoading && !composerModelOptions.length"
                    >
                      <option value="">
                        {{ defaultCodexModel ? String(defaultCodexModel.displayName ?? defaultCodexModel.display_name ?? defaultCodexModel.id ?? defaultCodexModel.model) : 'Model' }}
                      </option>
                      <option v-for="opt in composerModelOptions" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </option>
                    </select>

                    <select
                      v-model="composerReasoningEffort"
                      class="h-9 rounded-full border border-slate-200 bg-white px-3 pr-8 text-xs text-slate-900 outline-none transition-colors focus:border-slate-400 focus:ring-2 focus:ring-slate-400/30"
                      title="Reasoning effort"
                    >
                      <option value="">
                        {{
                          selectedCodexDefaultReasoningEffort
                            ? `Auto (${labelReasoningEffort(selectedCodexDefaultReasoningEffort)})`
                            : 'Auto'
                        }}
                      </option>
                      <option v-for="opt in composerReasoningEffortOptions" :key="opt.value" :value="opt.value" :title="opt.description || ''">
                        {{ opt.label }}
                      </option>
                    </select>

                    <select
                      v-model="composerApprovalPolicy"
                      class="h-9 rounded-full border border-slate-200 bg-white px-3 pr-8 text-xs text-slate-900 outline-none transition-colors focus:border-slate-400 focus:ring-2 focus:ring-slate-400/30"
                      title="Approvals"
                    >
                      <option value="on-request">Ask</option>
                      <option value="untrusted">Unless trusted</option>
                      <option value="on-failure">On failure</option>
                      <option value="never">Never ask</option>
                    </select>

                    <select
                      v-model="composerSandbox"
                      class="h-9 rounded-full border border-slate-200 bg-white px-3 pr-8 text-xs text-slate-900 outline-none transition-colors focus:border-slate-400 focus:ring-2 focus:ring-slate-400/30"
                      title="Permissions"
                    >
                      <option value="read-only">Read only</option>
                      <option value="workspace-write">Workspace write</option>
                      <option value="danger-full-access">Full access</option>
                    </select>
                  </div>

                  <button
                    class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 active:scale-[0.99]"
                    @click="submit"
                    :disabled="sending || (selectedSession?.turnState !== 'running' && !messageDraft.trim() && !attachments.length)"
                    :title="selectedSession?.turnState === 'running' ? 'Stop' : 'Send'"
                  >
                    <Loader2 v-if="sending" class="h-4 w-4 animate-spin" />
                    <Square v-else-if="selectedSession?.turnState === 'running'" class="h-4 w-4" />
                    <Send v-else class="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </footer>
        </section>

        <aside v-if="showPlan" class="hidden lg:flex min-w-0 flex-col border-l border-slate-200 bg-white">
          <div class="flex flex-1 min-h-0 flex-col">
            <div class="border-b border-slate-200 px-4 py-3">
              <div class="text-xs uppercase tracking-wider text-slate-500">Plan</div>
            </div>
            <div class="flex-1 overflow-auto p-4">
              <div v-if="selectedStore?.planExplanation" class="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 whitespace-pre-wrap">
                {{ selectedStore.planExplanation }}
              </div>

              <div v-if="Array.isArray(selectedStore?.plan) && selectedStore.plan.length" class="space-y-2">
                <div
                  v-for="(step, idx) in selectedStore.plan"
                  :key="idx"
                  class="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3"
                >
                  <span class="mt-1 h-2.5 w-2.5 rounded-full" :class="planDotClass(step.status)" />
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-slate-900 whitespace-pre-wrap">{{ step.step }}</div>
                  </div>
                  <div class="shrink-0 text-[10px] uppercase tracking-wider text-slate-500">
                    {{ step.status }}
                  </div>
                </div>
              </div>

              <div v-else class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                No plan yet.
              </div>
            </div>
          </div>
        </aside>
	      </main>

      </div>
	
	      <!-- New thread modal -->
	      <transition name="rg-fade">
	        <div v-if="newThreadOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="flex items-start justify-between gap-4">
	              <div class="min-w-0">
	                <div class="text-sm font-semibold text-slate-900">New thread</div>
	                <div class="mt-1 text-xs text-slate-600">Choose a machine and workspace before starting.</div>
	              </div>
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="closeNewThreadDialog"
	              >
	                Close
	              </button>
	            </div>

	            <div class="mt-4 space-y-4">
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">1) Machine</div>
	                <select
	                  v-model="newThreadMachineId"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  :disabled="!machinesForSelect.length"
	                >
	                  <option value="" disabled>(select a machine)</option>
	                  <option v-for="m in machinesForSelect" :key="m.machineId" :value="m.machineId">
	                    {{ m.machineName }} · {{ m.platform }} · {{ machineStatusLabel(m) }} · {{ String(m.machineId).slice(0, 8) }}
	                  </option>
	                </select>
	                <div v-if="!machines.length" class="mt-2 text-xs text-slate-600">
	                  No machines yet.
	                </div>
	                <div v-else-if="newThreadSelectedMachine" class="mt-2 flex items-center gap-2 text-xs" :class="newThreadSelectedMachineOnline ? 'text-emerald-700' : 'text-slate-700'">
	                  <span class="h-2.5 w-2.5 rounded-full" :class="newThreadSelectedMachineOnline ? 'bg-emerald-500' : 'bg-slate-400'" />
	                  <span>{{ machineStatusLabel(newThreadSelectedMachine) }}</span>
	                </div>
	              </div>

	              <div>
	                <div class="flex items-end justify-between gap-3">
	                  <div class="text-xs uppercase tracking-wider text-slate-500">2) Workspace</div>
	                  <button
	                    class="rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                    @click="openNewThreadBrowse"
	                    :disabled="!newThreadMachineId || !newThreadSelectedMachineOnline"
	                  >
	                    Browse…
	                  </button>
	                </div>
	                <input
	                  v-model="newThreadCwd"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="/home/me/project"
	                />

	                <div v-if="newThreadRecentWorkspaces.length" class="mt-3">
	                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Recent projects</div>
	                  <div class="mt-2 space-y-1">
	                    <button
	                      v-for="p in newThreadRecentWorkspaces"
	                      :key="p.cwd"
	                      class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
	                      @click="newThreadCwd = p.cwd"
	                      :title="p.cwd"
	                    >
	                      <div class="truncate text-sm font-medium text-slate-900">{{ p.label }}</div>
	                      <div class="mt-0.5 truncate text-xs text-slate-600">{{ p.cwd }}</div>
	                    </button>
	                  </div>
	                </div>
	              </div>

	              <div v-if="newThreadBrowseOpen" class="rounded-xl border border-slate-200 bg-slate-50 p-3">
	                <div class="flex items-center justify-between gap-3">
	                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Folder browser</div>
	                  <button
	                    class="rounded-md bg-white px-2.5 py-1.5 text-xs text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                    @click="newThreadBrowseOpen = false"
	                  >
	                    Close
	                  </button>
	                </div>

	                <div class="mt-2 flex items-center gap-2">
	                  <button
	                    class="rounded-md bg-white px-2.5 py-1.5 text-xs text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
	                    @click="newThreadBrowseParent ? loadNewThreadBrowse(newThreadBrowseParent) : null"
	                    :disabled="!newThreadBrowseParent || newThreadBrowseLoading"
	                  >
	                    Up
	                  </button>
	                  <div class="min-w-0 flex-1 truncate rounded-md bg-white px-3 py-1.5 text-xs text-slate-700 ring-1 ring-slate-200" :title="newThreadBrowsePath">
	                    {{ newThreadBrowsePath || (newThreadBrowseLoading ? 'Loading…' : '—') }}
	                  </div>
	                  <button
	                    class="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                    @click="selectNewThreadBrowseFolder"
	                    :disabled="!newThreadBrowsePath"
	                  >
	                    Select
	                  </button>
	                </div>

	                <div v-if="newThreadBrowseError" class="mt-2 text-xs text-red-600">{{ newThreadBrowseError }}</div>
	                <div v-else-if="newThreadBrowseLoading" class="mt-2 text-xs text-slate-600">Loading…</div>

	                <div v-else class="mt-3 max-h-64 overflow-auto space-y-1">
	                  <button
	                    v-for="e in newThreadBrowseEntries"
	                    :key="e.path"
	                    class="w-full rounded-lg bg-white px-3 py-2 text-left text-sm text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                    @click="loadNewThreadBrowse(e.path)"
	                    :title="e.path"
	                  >
	                    {{ e.name }}
	                  </button>
	                  <div v-if="!newThreadBrowseEntries.length" class="px-3 py-6 text-center text-xs text-slate-600">(empty)</div>
	                </div>
	              </div>

	              <div v-if="newThreadError" class="text-sm text-red-600">{{ newThreadError }}</div>

	              <div class="mt-5 flex items-center justify-end gap-2">
	                <button
	                  class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                  @click="closeNewThreadDialog"
	                >
	                  Cancel
	                </button>
	                <button
	                  class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                  @click="confirmNewThreadDialog"
	                >
	                  Start
	                </button>
	              </div>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Workspace & defaults modal -->
		      <transition name="rg-fade">
		        <div v-if="defaultsOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
		          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
		            <div class="flex items-start justify-between gap-4">
		              <div class="min-w-0">
		                <div class="text-sm font-semibold text-slate-900">Settings</div>
		                <div class="mt-1 text-xs text-slate-600">Defaults, machines, and system settings.</div>
		              </div>
		              <button
		                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                @click="defaultsOpen = false"
		              >
		                Close
		              </button>
		            </div>

		            <div class="mt-4 flex items-center gap-2 text-xs">
		              <button
		                class="rounded-lg border px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                :class="settingsTab === 'defaults' ? 'border-slate-300 bg-slate-100 text-slate-900' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'"
		                @click="settingsTab = 'defaults'"
		              >
		                Defaults
		              </button>
		              <button
		                class="rounded-lg border px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                :class="settingsTab === 'machines' ? 'border-slate-300 bg-slate-100 text-slate-900' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'"
		                @click="settingsTab = 'machines'"
		              >
		                Machines
		              </button>
		              <button
		                class="rounded-lg border px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                :class="settingsTab === 'system' ? 'border-slate-300 bg-slate-100 text-slate-900' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'"
		                @click="settingsTab = 'system'"
		              >
		                System
		              </button>
		            </div>
		
		            <div v-if="settingsTab === 'defaults'" class="mt-4 space-y-3">
		              <div>
		                <div class="text-xs uppercase tracking-wider text-slate-500">Workspace (cwd)</div>
		                <input
		                  v-model="defaults.cwd"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="/home/me/project"
	                />
	              </div>
	
	              <div class="grid grid-cols-2 gap-2">
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Machine</div>
	                  <select
	                    v-model="defaults.machineId"
	                    class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  >
	                    <option value="">(auto)</option>
	                    <option v-for="m in machinesForSelect" :key="m.machineId" :value="m.machineId">
	                      {{ m.machineName }} · {{ m.platform }} · {{ machineStatusLabel(m) }} · {{ String(m.machineId).slice(0, 8) }}
	                    </option>
	                  </select>
	                  <div v-if="defaultsSelectedMachine" class="mt-2 flex items-center gap-2 text-xs" :class="machineIsOnline(defaultsSelectedMachine) ? 'text-emerald-700' : 'text-slate-700'">
	                    <span class="h-2.5 w-2.5 rounded-full" :class="machineIsOnline(defaultsSelectedMachine) ? 'bg-emerald-500' : 'bg-slate-400'" />
	                    <span>{{ machineStatusLabel(defaultsSelectedMachine) }}</span>
	                  </div>
	                </div>
	
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Model</div>
	                  <input
	                    v-model="defaults.model"
	                    class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                    placeholder="(optional)"
	                  />
	                </div>
	              </div>
	
	              <div class="grid grid-cols-2 gap-2">
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Approval policy</div>
	                  <select
	                    v-model="defaults.approvalPolicy"
	                    class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  >
	                    <option value="untrusted">untrusted</option>
	                    <option value="on-request">on-request</option>
	                    <option value="never">never</option>
	                    <option value="on-failure">on-failure</option>
	                  </select>
	                </div>
	
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Sandbox</div>
	                  <select
	                    v-model="defaults.sandbox"
	                    class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  >
	                    <option value="read-only">read-only</option>
	                    <option value="workspace-write">workspace-write</option>
	                    <option value="danger-full-access">danger-full-access</option>
	                  </select>
	                </div>
		              </div>
		
		              <div v-if="defaultsError" class="text-sm text-red-600">{{ defaultsError }}</div>
		            </div>

		            <div v-else-if="settingsTab === 'machines'" class="mt-4 space-y-3">
		              <div v-if="!machines.length" class="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">
		                No machines connected yet.
		              </div>

		              <div v-else class="space-y-2">
		                <div v-if="machineDisconnectError" class="text-sm text-red-600">{{ machineDisconnectError }}</div>
		                <div
		                  v-for="m in machinesForSelect"
		                  :key="m.machineId"
		                  class="rounded-xl border border-slate-200 bg-white p-3"
		                >
		                  <div class="flex items-center justify-between gap-3">
		                    <div class="min-w-0 flex items-center gap-2">
		                      <span class="h-2.5 w-2.5 rounded-full" :class="machineIsOnline(m) ? 'bg-emerald-500' : 'bg-slate-400'" />
		                      <div class="truncate text-sm font-medium text-slate-900">{{ m.machineName }}</div>
		                      <div class="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">
		                        {{ m.platform }}
		                      </div>
		                    </div>
		                    <div class="shrink-0 flex items-center gap-2">
		                      <button
		                        v-if="machineIsOnline(m)"
		                        class="inline-flex items-center gap-2 rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                        @click="disconnectMachine(m.machineId)"
		                        :disabled="machineDisconnectWorkingId === m.machineId"
		                        title="Disconnect the runner (it may reconnect if the runner process is still running)."
		                      >
		                        <Loader2 v-if="machineDisconnectWorkingId === m.machineId" class="h-3.5 w-3.5 animate-spin" />
		                        Disconnect
		                      </button>
		                      <button
		                        v-else
		                        class="inline-flex items-center gap-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
		                        @click="openDeleteMachineModal(m.machineId)"
		                        title="Delete this machine and all its sessions."
		                      >
		                        <Trash2 class="h-3.5 w-3.5" />
		                        Delete
		                      </button>
		                    </div>
		                  </div>
		                  <div class="mt-2 flex items-center justify-between gap-3">
		                    <div class="min-w-0 truncate text-xs font-mono text-slate-500" :title="m.machineId">{{ m.machineId }}</div>
		                    <div class="shrink-0 text-[11px]" :class="machineIsOnline(m) ? 'text-emerald-600' : 'text-slate-500'">
		                      {{ machineStatusLabel(m) }}
		                    </div>
		                  </div>
		                </div>
		              </div>
		            </div>

		            <div v-else-if="settingsTab === 'system'" class="mt-4 space-y-3">
		              <div>
		                <div class="text-xs uppercase tracking-wider text-slate-500">Retention (days)</div>
		                <input
		                  v-model="retentionDraft"
		                  type="number"
		                  min="1"
		                  max="3650"
		                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
		                />
		                <div class="mt-2 text-xs text-slate-500">Rootgrid prunes its own sessions/events beyond this window.</div>
		              </div>

		              <div>
		                <div class="text-xs uppercase tracking-wider text-slate-500">SSE notifications</div>
		                <select
		                  v-model="sseToastsDraft"
		                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
		                >
		                  <option value="if-not-visible">If not visible</option>
		                  <option value="always">Always</option>
		                  <option value="never">Never</option>
		                </select>
		                <div class="mt-2 text-xs text-slate-500">Controls toast/desktop notifications emitted over SSE (approvals, ready, failures).</div>

		                <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
		                  <div class="min-w-0">
		                    <div class="text-[11px] uppercase tracking-wider text-slate-500">Browser notifications</div>
		                    <div class="mt-1 text-xs text-slate-700">Permission: {{ notificationPermission }}</div>
		                    <div class="mt-1 text-xs text-slate-500">Needed to alert you while the tab/app is not visible.</div>
		                  </div>
		                  <button
		                    class="shrink-0 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                    @click="requestNotificationPermission"
		                    :disabled="!notificationSupported || notificationPermission === 'granted'"
		                  >
		                    Enable
		                  </button>
		                </div>

		                <div class="mt-3">
		                  <div class="text-xs uppercase tracking-wider text-slate-500">Web Push notifications</div>
		                  <select
		                    v-model="webPushDraft"
		                    class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
		                  >
		                    <option value="if-not-visible">If not visible</option>
		                    <option value="always">Always</option>
		                    <option value="never">Never</option>
		                  </select>
		                  <div class="mt-2 text-xs text-slate-500">Uses the PWA service worker + VAPID. Requires a secure context (localhost/https) and subscription. “If not visible” means the relevant session isn’t currently open in a visible Rootgrid tab.</div>

		                  <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
		                    <div class="min-w-0">
		                      <div class="text-[11px] uppercase tracking-wider text-slate-500">Push subscription</div>
		                      <div class="mt-1 text-xs text-slate-700">Status: {{ pushStatus }}</div>
		                      <div v-if="pushEndpoint" class="mt-1 truncate text-[11px] text-slate-500" :title="pushEndpoint">endpoint: {{ pushEndpoint }}</div>
		                      <div v-if="pushError" class="mt-1 text-xs text-red-600">{{ pushError }}</div>
		                    </div>
		                    <div class="shrink-0 flex items-center gap-2">
		                      <button
		                        class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                        @click="enablePush"
		                        :disabled="pushWorking || pushStatus === 'subscribed' || pushStatus === 'unsupported' || pushStatus === 'insecure'"
		                      >
		                        Enable
		                      </button>
		                      <button
		                        class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                        @click="disablePush"
		                        :disabled="pushWorking || pushStatus !== 'subscribed'"
		                      >
		                        Disable
		                      </button>
		                    </div>
		                  </div>
		                </div>
		              </div>

		              <div class="grid grid-cols-2 gap-2">
		                <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
		                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Host</div>
		                  <div class="mt-2 text-xs text-slate-900 font-mono">
		                    {{ appSettings.host?.listen?.host ?? '—' }}:{{ appSettings.host?.listen?.port ?? '—' }}
		                  </div>
		                  <div class="mt-2 text-xs text-slate-500">trustProxy: {{ appSettings.host?.trustProxy ? 'true' : 'false' }}</div>
		                  <div v-if="appSettings.host?.publicUrl" class="mt-2 text-xs text-slate-500 truncate" :title="appSettings.host.publicUrl">
		                    publicUrl: <span class="text-slate-700">{{ appSettings.host.publicUrl }}</span>
		                  </div>
		                </div>

		                <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
		                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Runner</div>
		                  <div class="mt-2 text-xs text-slate-900">
		                    {{ appSettings.runner?.enabled ? 'enabled' : 'disabled' }}
		                  </div>
		                  <div class="mt-2 text-xs text-slate-500 truncate" :title="appSettings.runner?.machineId ?? ''">
		                    machineId: <span class="text-slate-700 font-mono">{{ appSettings.runner?.machineId ? appSettings.runner.machineId.slice(0, 12) + '…' : '—' }}</span>
		                  </div>
		                  <div class="mt-2 text-xs text-slate-500 truncate" :title="appSettings.runner?.machineName ?? ''">
		                    machineName: <span class="text-slate-700">{{ appSettings.runner?.machineName ?? '—' }}</span>
		                  </div>
		                </div>
		              </div>

		              <div v-if="appSettingsError" class="text-sm text-red-600">{{ appSettingsError }}</div>

		              <div class="flex items-center justify-end">
		                <button
		                  class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
		                  @click="saveRetentionDays"
		                  :disabled="appSettingsSaving"
		                >
		                  <Loader2 v-if="appSettingsSaving" class="h-4 w-4 animate-spin" />
		                  Save
		                </button>
		              </div>
		            </div>
		          </div>
		        </div>
		      </transition>

	      <!-- Archived chats modal -->
	      <transition name="rg-fade">
	        <div v-if="archiveOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="flex items-start justify-between gap-4">
	              <div class="min-w-0">
	                <div class="text-sm font-semibold text-slate-900">Archived threads</div>
	                <div class="mt-1 text-xs text-slate-600">Hidden from the main thread list.</div>
	              </div>
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="archiveOpen = false"
	              >
	                Close
	              </button>
	            </div>

	            <div class="mt-4">
	              <div v-if="archiveLoading" class="space-y-2">
	                <div v-for="i in 6" :key="i" class="h-12 rounded-xl bg-slate-100 animate-pulse" />
	              </div>

	              <div v-else-if="archiveError" class="text-sm text-red-600">{{ archiveError }}</div>

	              <div v-else-if="!archivedSessions.length" class="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">
	                No archived threads.
	              </div>

	              <div v-else class="max-h-[65vh] overflow-auto space-y-2 pr-1">
	                <button
	                  v-for="s in archivedSessions"
	                  :key="s.sessionId"
	                  class="group w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                  @click="selectedSessionId = s.sessionId; archiveOpen = false"
	                  :title="sessionTooltip(s)"
	                >
	                  <div class="flex items-start justify-between gap-3">
	                    <div class="min-w-0">
	                      <div class="truncate text-sm font-medium text-slate-900">{{ sessionListTitle(s) }}</div>
	                      <div class="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
	                        <span class="truncate" :title="s.cwd">{{ sessionProject(s) }}</span>
	                        <span class="text-slate-300">·</span>
	                        <span>{{ sessionHostName(s) }}</span>
	                      </div>
	                      <div class="mt-1 truncate text-xs text-slate-600">{{ s.preview ?? '' }}</div>
	                    </div>

	                    <div class="shrink-0 flex items-center gap-2">
	                      <button
	                        class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                        @click.stop="unarchiveFromArchiveModal(s.sessionId)"
	                      >
	                        Unarchive
	                      </button>
	                      <button
	                        class="inline-flex items-center gap-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
	                        @click.stop="openDeleteModal(s.sessionId)"
	                      >
	                        <Trash2 class="h-3.5 w-3.5" />
	                        Delete
	                      </button>
	                    </div>
	                  </div>
	                </button>
	              </div>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Delete machine modal -->
	      <transition name="rg-fade">
	        <div v-if="deleteMachineOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Delete machine?</div>
	            <div class="mt-1 text-xs text-slate-600">This permanently deletes the machine and all of its sessions and history from Rootgrid.</div>

	            <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
	              <div class="text-sm font-medium text-slate-900">
	                {{ deleteMachineRow?.machineName ?? 'unknown' }}
	              </div>
	              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
	                <span class="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">{{ deleteMachineRow?.platform ?? 'unknown' }}</span>
	                <span class="text-slate-300">·</span>
	                <span class="font-mono">{{ deleteMachineId }}</span>
	              </div>
	              <div class="mt-2 text-xs" :class="deleteMachineRow && machineIsOnline(deleteMachineRow) ? 'text-red-700' : 'text-slate-600'">
	                {{ deleteMachineRow && machineIsOnline(deleteMachineRow) ? 'This machine is online. Disconnect the runner before deleting.' : 'Runner disconnected (ok to delete).' }}
	              </div>
	            </div>

	            <div v-if="deleteMachineError" class="mt-3 text-sm text-red-600">{{ deleteMachineError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="deleteMachineOpen = false"
	                :disabled="deleteMachineWorking"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
	                @click="confirmDeleteMachine"
	                :disabled="deleteMachineWorking || (deleteMachineRow && machineIsOnline(deleteMachineRow))"
	              >
	                <Loader2 v-if="deleteMachineWorking" class="h-4 w-4 animate-spin" />
	                Delete
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Delete chat modal -->
	      <transition name="rg-fade">
	        <div v-if="deleteOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Delete thread?</div>
	            <div class="mt-1 text-xs text-slate-600">This permanently deletes the session and its history.</div>

	            <div v-if="deleteError" class="mt-3 text-sm text-red-600">{{ deleteError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="deleteOpen = false"
	                :disabled="deleteWorking"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
	                @click="confirmDeleteSession"
	                :disabled="deleteWorking"
	              >
	                <Loader2 v-if="deleteWorking" class="h-4 w-4 animate-spin" />
	                Delete
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>
	
	      <!-- Rename modal -->
	      <transition name="rg-fade">
	        <div v-if="renameOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Rename thread</div>
	            <div class="mt-1 text-xs text-slate-600">Update the thread title and/or project label.</div>
	
	            <div class="mt-4 space-y-3">
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Chat title</div>
	                <input
	                  v-model="renameTitleValue"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="(leave empty to use the default title)"
	                  :autofocus="renameFocus === 'title'"
	                  @keydown.enter.prevent="saveRenameSession"
	                />
	              </div>
	
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Project label</div>
	                <input
	                  v-model="renameProjectValue"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="(leave empty to use folder name)"
	                  :autofocus="renameFocus === 'project'"
	                  @keydown.enter.prevent="saveRenameSession"
	                />
	              </div>

	              <div v-if="renameError" class="text-sm text-red-600">{{ renameError }}</div>
	            </div>
	
	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="renameOpen = false"
	              >
	                Cancel
	              </button>
	              <button
	                class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                @click="saveRenameSession"
	              >
	                Save
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Session policy modal -->
	      <transition name="rg-fade">
	        <div v-if="sessionPolicyOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Session policies</div>
	            <div class="mt-1 text-xs text-slate-600">Updates Codex approval + sandbox settings (applies on the next turn).</div>

	            <div class="mt-4 grid grid-cols-2 gap-2">
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Approval policy</div>
	                <select
	                  v-model="sessionApprovalDraft"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                >
	                  <option value="untrusted">untrusted</option>
	                  <option value="on-request">on-request</option>
	                  <option value="never">never</option>
	                  <option value="on-failure">on-failure</option>
	                </select>
	              </div>

	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Sandbox</div>
	                <select
	                  v-model="sessionSandboxDraft"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                >
	                  <option value="read-only">read-only</option>
	                  <option value="workspace-write">workspace-write</option>
	                  <option value="danger-full-access">danger-full-access</option>
	                </select>
	              </div>
	            </div>

	            <div v-if="sessionPolicyError" class="mt-3 text-sm text-red-600">{{ sessionPolicyError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="sessionPolicyOpen = false"
	                :disabled="sessionPolicySaving"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                @click="saveSessionPolicy"
	                :disabled="sessionPolicySaving"
	              >
	                <Loader2 v-if="sessionPolicySaving" class="h-4 w-4 animate-spin" />
	                Save
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>
	
	      <!-- Approvals modal -->
	      <transition name="rg-fade">
	        <div v-if="pendingApproval" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">
	              {{ pendingApproval.kind === 'userInput' ? 'Input requested' : 'Approval requested' }}
	            </div>
	            <div class="mt-1 text-xs text-slate-600">
	              Session: {{ pendingApproval.sessionId }} · Kind: {{ pendingApproval.kind }}<span v-if="pendingApproval.itemId"> · Item: {{ pendingApproval.itemId }}</span>
	            </div>
	
	            <!-- EXPERIMENTAL: user input request -->
	            <div v-if="pendingApproval.kind === 'userInput'" class="mt-4">
	              <div v-if="Array.isArray(pendingApproval.questions) && pendingApproval.questions.length" class="space-y-4">
	                <div v-for="(q, idx) in pendingApproval.questions" :key="q?.id ?? idx">
	                  <div v-if="q?.id && userInputForm[String(q.id)]">
	                    <div class="text-xs uppercase tracking-wider text-slate-500">{{ q.header || q.id }}</div>
	                    <div class="mt-1 text-sm text-slate-900 whitespace-pre-wrap">{{ q.question }}</div>
	
	                    <div v-if="Array.isArray(q.options) && q.options.length" class="mt-3 space-y-2">
	                      <label
	                        v-for="opt in q.options"
	                        :key="opt.label"
	                        class="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 hover:bg-slate-100 cursor-pointer"
	                      >
	                        <input
	                          type="radio"
	                          class="mt-0.5 accent-indigo-500"
	                          :name="`q-${q.id}`"
	                          :value="opt.label"
	                          v-model="userInputForm[String(q.id)].choice"
	                        />
	                        <div class="min-w-0">
	                          <div class="text-sm text-slate-900">{{ opt.label }}</div>
	                          <div class="text-xs text-slate-400">{{ opt.description }}</div>
	                        </div>
	                      </label>
	
	                      <label
	                        v-if="q.isOther"
	                        class="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 hover:bg-slate-100 cursor-pointer"
	                      >
	                        <input
	                          type="radio"
	                          class="mt-0.5 accent-indigo-500"
	                          :name="`q-${q.id}`"
	                          value="__other__"
	                          v-model="userInputForm[String(q.id)].choice"
	                        />
	                        <div class="min-w-0 w-full">
	                          <div class="text-sm text-slate-900">Other</div>
	                          <input
	                            v-if="userInputForm[String(q.id)].choice === '__other__'"
	                            v-model="userInputForm[String(q.id)].other"
	                            :type="q.isSecret ? 'password' : 'text'"
	                            class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                            placeholder="Type an answer…"
	                          />
	                        </div>
	                      </label>
	                    </div>
	
	                    <div v-else class="mt-3">
	                      <input
	                        v-model="userInputForm[String(q.id)].text"
	                        :type="q.isSecret ? 'password' : 'text'"
	                        class="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                        placeholder="Type an answer…"
	                      />
	                    </div>
	                  </div>
	                </div>
	              </div>
	
	              <div v-if="userInputError" class="mt-3 text-sm text-red-600">{{ userInputError }}</div>
	
	              <div class="mt-5 flex items-center justify-end gap-2">
	                <button
	                  class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                  @click="cancelUserInput"
	                  :disabled="userInputSubmitting"
	                >
	                  Cancel
	                </button>
	                <button
	                  class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                  @click="submitUserInput"
	                  :disabled="userInputSubmitting"
	                >
	                  <Loader2 v-if="userInputSubmitting" class="h-4 w-4 animate-spin" />
	                  Submit
	                </button>
	              </div>
	            </div>
	
	            <!-- command / file-change approvals -->
	            <div v-else>
	              <div v-if="pendingApproval.reason" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Reason</div>
	                <div class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 whitespace-pre-wrap">{{ pendingApproval.reason }}</div>
	              </div>
	
	              <div v-if="pendingApproval.command" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Command</div>
	                <pre class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ pendingApproval.command }}</pre>
	              </div>

	              <div v-if="pendingApproval.cwd" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Working directory</div>
	                <pre class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ pendingApproval.cwd }}</pre>
	              </div>

	              <div v-if="pendingApproval.grantRoot" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Grant root</div>
	                <pre class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ pendingApproval.grantRoot }}</pre>
	              </div>

	              <div v-if="pendingApproval.additionalPermissions" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Additional permissions</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.additionalPermissions, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.availableDecisions" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Available decisions</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.availableDecisions, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.commandActions" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Command actions</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.commandActions, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.proposedExecpolicyAmendment" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Proposed execpolicy amendment</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.proposedExecpolicyAmendment, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.proposedNetworkPolicyAmendments" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Proposed network policy amendments</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.proposedNetworkPolicyAmendments, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.networkApprovalContext" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Network approval context</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono text-slate-800 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.networkApprovalContext, null, 2) }}</pre>
	              </div>

	              <div v-if="approvalExtraActions.length" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Quick actions</div>
	                <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
	                  <button
	                    v-for="a in approvalExtraActions"
	                    :key="a.id"
	                    class="rounded-md px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2"
	                    :class="a.variant === 'emerald-solid'
	                      ? 'bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:ring-emerald-500/30'
	                      : (a.variant === 'red-outline'
	                        ? 'bg-red-50 text-red-700 hover:bg-red-100 focus-visible:ring-red-500/30'
	                        : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus-visible:ring-emerald-500/30')"
	                    @click="respondApproval(a.decision)"
	                    :disabled="approvalResponding"
	                  >
	                    {{ a.label }}
	                  </button>
	                </div>
	              </div>
	
	              <div v-if="approvalRespondError" class="mt-3 text-sm text-red-600">{{ approvalRespondError }}</div>
	
	              <div class="mt-5 flex items-center justify-end gap-2">
	                <button
	                  v-if="approvalAllows('cancel')"
	                  class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                  @click="respondApproval('cancel')"
	                  :disabled="approvalResponding"
	                >
	                  Cancel
	                </button>
	                <button
	                  v-if="approvalAllows('decline')"
	                  class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
	                  @click="respondApproval('decline')"
	                  :disabled="approvalResponding"
	                >
	                  Decline
	                </button>
	                <button
	                  v-if="approvalAllows('accept')"
	                  class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
	                  @click="respondApproval('accept')"
	                  :disabled="approvalResponding"
	                >
	                  Accept
	                </button>
	                <button
	                  v-if="approvalAllows('acceptForSession')"
	                  class="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
	                  @click="respondApproval('acceptForSession')"
	                  :disabled="approvalResponding"
	                >
	                  Accept for session
	                </button>
	              </div>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Toasts -->
	      <div class="pointer-events-none fixed right-4 top-4 z-40 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
	        <transition-group name="rg-fade">
	          <div
	            v-for="t in toasts"
	            :key="t.id"
	            class="pointer-events-auto rounded-xl border p-3 shadow-lg"
	            :class="toastBorderClass(t.level)"
	            @click="t.sessionId ? (selectedSessionId = t.sessionId) : null"
	          >
	            <div class="flex items-start justify-between gap-3">
	              <div class="min-w-0">
	                <div class="text-sm font-medium text-slate-900 truncate">{{ t.title }}</div>
	                <div v-if="t.message" class="mt-1 text-xs text-slate-700 whitespace-pre-wrap">{{ t.message }}</div>
	              </div>
	              <button
	                class="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-slate-700 transition-colors hover:bg-slate-50"
	                @click.stop="dismissToast(t.id)"
	                title="Dismiss"
	              >
	                <X class="h-4 w-4" />
	              </button>
	            </div>
	          </div>
	        </transition-group>
	      </div>
    </div>
  </div>
</template>
