<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Archive, ArrowDown, Code, Loader2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Paperclip, Plus, Send, Settings, Square, Trash2, X } from 'lucide-vue-next'

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
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write'
})

const settingsTab = ref('defaults') // defaults|machines|system

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

const showDiff = ref(false)
const showPlan = ref(false)

const chatScrollEl = ref(null)
const stickToBottom = ref(true)

const sidebarCollapsed = ref(false)

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
      seen: new Set(),
      hasMoreBefore: true,
      nextBeforeSeq: null,
      loadingBefore: false,
      toolOutputByItemId: new Map(), // itemId -> { stdout, stderr, loaded, loading, hasMoreBefore, nextBeforeSeq }
      toolExpanded: new Map() // itemId -> boolean
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
  if (l === 'error') return 'border-red-500/30 bg-red-500/10'
  if (l === 'warning') return 'border-amber-500/30 bg-amber-500/10'
  if (l === 'success') return 'border-emerald-500/30 bg-emerald-500/10'
  return 'border-slate-800 bg-slate-950/70'
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
  const last = Number(m?.lastSeenMs ?? 0)
  if (!Number.isFinite(last) || last <= 0) return false
  return (nowMs.value - last) < 45_000
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
      if (stream === 'reasoning' || stream === 'plan') {
        // These can be extremely chatty; keep them out of the main feed for now.
        return
      }
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
    store.hasMoreBefore = true
    store.nextBeforeSeq = null
    store.loadingBefore = false
    store.toolOutputByItemId.clear()
    store.toolExpanded.clear()

    // Load the newest page (summary/"big events" mode).
    const pageRes = await apiFetch(`/api/sessions/${sessionId}/events?mode=summary&limit=200`)
    if (!pageRes.ok) return
    const page = await pageRes.json().catch(() => null)
    if (nonce !== loadSessionNonce) return
    const events = Array.isArray(page?.events) ? page.events : []
    for (const e of events) addSessionEvent(sessionId, e, { atStart: false, applyDerived: true })
    store.hasMoreBefore = Boolean(page?.hasMoreBefore)
    store.nextBeforeSeq = page?.nextBeforeSeq ?? null
  } finally {
    if (nonce === loadSessionNonce) sessionLoading.value = false
  }
}

async function loadMoreBefore(sessionId) {
  const store = getSessionStore(sessionId)
  if (store.loadingBefore) return
  if (!store.hasMoreBefore) return
  const beforeSeq = store.nextBeforeSeq
  if (!beforeSeq) return

  store.loadingBefore = true
  try {
    const el = chatScrollEl.value
    const prevHeight = el ? el.scrollHeight : null
    const prevTop = el ? el.scrollTop : null

    const res = await apiFetch(`/api/sessions/${sessionId}/events?mode=summary&limit=200&beforeSeq=${encodeURIComponent(String(beforeSeq))}`)
    if (!res.ok) return
    const page = await res.json().catch(() => null)
    const events = Array.isArray(page?.events) ? page.events : []

    // Prepend in reverse so overall ordering stays chronological.
    for (let i = events.length - 1; i >= 0; i--) {
      addSessionEvent(sessionId, events[i], { atStart: true, applyDerived: false })
    }
    store.hasMoreBefore = Boolean(page?.hasMoreBefore)
    store.nextBeforeSeq = page?.nextBeforeSeq ?? store.nextBeforeSeq

    await nextTick()
    if (el && prevHeight !== null && prevTop !== null) {
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

function buildChatMessages(store) {
  const events = store?.events ?? []
  const msgs = []
  const toolByItemId = new Map() // itemId -> msg

  for (const e of events) {
    if (e.type === 'session.input') {
      const text = e.payload?.text ?? ''
      const atts = Array.isArray(e.payload?.attachments) ? e.payload.attachments : []
      msgs.push({ id: e.eventId, role: 'user', text, attachments: atts })
      continue
    }

    if (e.type === 'session.output') {
      const stream = e.payload?.stream ?? 'normalized'
      const text = e.payload?.text ?? ''
      if (stream === 'normalized') {
        if (!msgs.length || msgs[msgs.length - 1].role !== 'assistant') {
          msgs.push({ id: e.eventId, role: 'assistant', text: '' })
        }
        msgs[msgs.length - 1].text += text
      } else if (stream === 'stderr') {
        // Un-attributed stderr (important enough to show).
        msgs.push({ id: e.eventId, role: 'system', text: String(text ?? '') })
      }
      continue
    }

    if (e.type === 'session.status' && e.payload?.status === 'failed') {
      msgs.push({ id: e.eventId, role: 'system', text: `Session failed: ${e.payload?.error ?? 'unknown error'}` })
    }

    if (e.type === 'tool.started') {
      const tool = e.payload?.tool
      const itemId = String(e.payload?.itemId ?? '')
      if (!itemId) continue
      const msg = {
        id: `tool-${itemId}`,
        role: 'toolcall',
        tool,
        itemId,
        command: e.payload?.command ?? null,
        cwd: e.payload?.cwd ?? null,
        changes: Array.isArray(e.payload?.changes) ? e.payload.changes : null,
        status: e.payload?.status ?? 'running',
        exitCode: null,
        expanded: Boolean(store?.toolExpanded?.get?.(itemId)),
        output: store?.toolOutputByItemId?.get?.(itemId) ?? null
      }
      msgs.push(msg)
      toolByItemId.set(itemId, msg)
    }

    if (e.type === 'tool.completed') {
      const tool = e.payload?.tool
      const itemId = String(e.payload?.itemId ?? '')
      if (!itemId) continue
      const existing = toolByItemId.get(itemId)
      if (existing) {
        existing.status = e.payload?.status ?? 'completed'
        existing.exitCode = e.payload?.exitCode ?? null
        existing.output = store?.toolOutputByItemId?.get?.(itemId) ?? existing.output
      } else {
        const msg = {
          id: `tool-${itemId}`,
          role: 'toolcall',
          tool,
          itemId,
          command: e.payload?.command ?? null,
          cwd: e.payload?.cwd ?? null,
          changes: Array.isArray(e.payload?.changes) ? e.payload.changes : null,
          status: e.payload?.status ?? 'completed',
          exitCode: e.payload?.exitCode ?? null,
          expanded: Boolean(store?.toolExpanded?.get?.(itemId)),
          output: store?.toolOutputByItemId?.get?.(itemId) ?? null
        }
        msgs.push(msg)
        toolByItemId.set(itemId, msg)
      }
    }
  }

  return msgs
}

const chatMessages = computed(() => buildChatMessages(selectedStore.value ?? null))

function newChat() {
  selectedSessionId.value = null
  messageDraft.value = ''
  attachments.value.splice(0, attachments.value.length)
  showDiff.value = false
  showPlan.value = false
}

function onChatScroll() {
  const el = chatScrollEl.value
  if (!el) return
  if (selectedSessionId.value && el.scrollTop <= 80) {
    loadMoreBefore(selectedSessionId.value).catch(() => {})
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

  try {
    const raw = localStorage.getItem('rootgrid.sidebarCollapsed')
    if (raw === '1') sidebarCollapsed.value = true
  } catch {
  }

  watch(defaults, () => {
    try {
      localStorage.setItem('rootgrid.defaults', JSON.stringify(defaults))
    } catch {
    }
  }, { deep: true })

  watch(sidebarCollapsed, () => {
    try {
      localStorage.setItem('rootgrid.sidebarCollapsed', sidebarCollapsed.value ? '1' : '0')
    } catch {
    }
  })

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
  <div class="h-screen w-screen">
    <div v-if="!authed" class="h-full flex items-center justify-center px-6">
      <div class="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg">
        <div class="text-xl font-semibold tracking-tight">Rootgrid</div>
        <div class="mt-1 text-sm text-slate-400">Enter your client token to connect.</div>

        <div class="mt-6">
          <label class="text-xs uppercase tracking-wider text-slate-500">Client token</label>
          <input
            v-model="authToken"
            type="password"
            class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
            placeholder="paste token from ~/.rootgrid/config.json"
            @keydown.enter.prevent="login"
          />
          <div v-if="authError" class="mt-2 text-sm text-red-400">{{ authError }}</div>
        </div>

        <button
          class="mt-4 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
          @click="login"
        >
          Connect
        </button>
      </div>
    </div>

    <div v-else class="h-full flex flex-col">
      <div
        v-if="connectionBanner"
        class="shrink-0 border-b border-slate-900 bg-slate-950/70 backdrop-blur supports-[backdrop-filter]:bg-slate-950/40"
      >
        <div class="flex items-center justify-between gap-3 px-4 py-2 text-xs">
          <div class="min-w-0 truncate" :class="connectionBanner.tone === 'error' ? 'text-red-200' : 'text-amber-200'">
            {{ connectionBanner.text }}
          </div>
          <button
            class="shrink-0 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            @click="connectSse"
            :disabled="!networkOnline"
          >
            Reconnect
          </button>
        </div>
      </div>

      <div class="flex flex-1 min-h-0">
        <!-- Sidebar -->
        <aside
          class="shrink-0 border-r border-slate-900 bg-slate-950/40 backdrop-blur supports-[backdrop-filter]:bg-slate-950/30 transition-[width] duration-200 ease-out flex flex-col overflow-hidden"
          :class="sidebarCollapsed ? 'w-[76px]' : 'w-[320px]'"
        >
        <div class="shrink-0 px-3 py-4 border-b border-slate-900/80">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <button
                class="inline-flex h-8 w-8 items-center justify-center rounded-md bg-slate-200/10 text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 active:scale-[0.98]"
                @click="sidebarCollapsed = !sidebarCollapsed"
                :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
              >
                <component :is="sidebarCollapsed ? PanelLeftOpen : PanelLeftClose" class="h-4 w-4" />
              </button>
              <div v-if="!sidebarCollapsed" class="font-semibold tracking-tight">Rootgrid</div>
            </div>

            <div class="flex items-center gap-2" :class="sidebarCollapsed ? 'flex-col' : ''">
	              <button
	                class="inline-flex items-center justify-center gap-2 rounded-md bg-slate-200/10 px-2.5 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 active:scale-[0.98]"
	                @click="openSettings('defaults')"
	                title="Settings"
	              >
	                <Settings class="h-3.5 w-3.5" />
	              </button>
	              <button
	                class="inline-flex items-center justify-center gap-2 rounded-md bg-slate-200/10 px-2.5 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 active:scale-[0.98]"
	                @click="openArchiveModal"
	                title="Archived chats"
	              >
	                <Archive class="h-3.5 w-3.5" />
	              </button>
              <button
                class="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 active:scale-[0.98]"
                @click="newChat"
                title="New chat"
              >
                <Plus class="h-3.5 w-3.5" />
                <span v-if="!sidebarCollapsed">New</span>
              </button>
            </div>
          </div>

          <div v-if="!sidebarCollapsed" class="mt-2 text-xs text-slate-500">
            SSE:
            <span :class="sseStatus === 'connected' ? 'text-emerald-400' : (sseStatus === 'error' ? 'text-red-400' : 'text-amber-400')">
              {{ sseStatus }}
            </span>
          </div>
          <div v-else class="mt-2 flex items-center justify-center">
            <span
              class="h-2 w-2 rounded-full"
              :class="sseStatus === 'connected' ? 'bg-emerald-400' : (sseStatus === 'error' ? 'bg-red-400' : 'bg-amber-400')"
            />
          </div>
        </div>

        <div class="flex-1 overflow-auto px-2 py-2">
          <div v-if="!sidebarCollapsed" class="px-2 py-2 text-[11px] uppercase tracking-wider text-slate-500">Chats</div>
          <div v-else class="h-2"></div>

          <div v-if="!hasSnapshot" class="space-y-2 px-2 py-2">
            <div
              v-for="i in 7"
              :key="i"
              class="animate-pulse rounded-xl bg-slate-900/40"
              :class="sidebarCollapsed ? 'h-10' : 'h-12'"
            />
          </div>

          <div v-else>
            <div v-if="!visibleSessions.length" class="px-3 py-10 text-center text-xs text-slate-500">
              <span v-if="!sidebarCollapsed">No chats yet.</span>
            </div>

            <button
              v-for="s in visibleSessions"
              :key="s.sessionId"
              class="group w-full rounded-xl text-left transition-colors hover:bg-slate-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 active:scale-[0.99]"
              :class="[
                sidebarCollapsed ? 'px-2 py-2' : 'px-3 py-2',
                selectedSessionId === s.sessionId ? 'bg-slate-900/70 ring-1 ring-slate-800/80' : 'ring-1 ring-transparent'
              ]"
              :title="sessionTooltip(s)"
              @click="selectedSessionId = s.sessionId"
            >
              <div :class="sidebarCollapsed ? 'flex items-center gap-2' : 'flex items-start gap-2'">
                <span
                  class="h-2.5 w-2.5 rounded-full ring-1 ring-black/25 shadow-sm"
                  :class="[
                    indicatorDotClass(sessionIndicator(s)),
                    sidebarCollapsed ? '' : 'mt-1.5'
                  ]"
                />

                <div v-if="sidebarCollapsed" class="flex-1 flex items-center justify-center">
                  <div class="h-8 w-8 rounded-lg bg-slate-200/5 ring-1 ring-slate-800/70 flex items-center justify-center text-[11px] font-semibold text-slate-200">
                    {{ sessionInitial(s) }}
                  </div>
                </div>

                <div v-else class="min-w-0 flex-1">
                  <div class="flex items-center justify-between gap-2">
                    <div class="truncate text-sm font-medium text-slate-100">{{ sessionListTitle(s) }}</div>
                    <div
                      class="shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider"
                      :class="statusChipClass(s.status)"
                    >
                      {{ (s.status ?? 'unknown') }}
                    </div>
                  </div>

                  <div class="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-slate-500">
                    <button
                      class="shrink-0 max-w-[130px] truncate rounded-md bg-slate-200/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-300 transition-colors hover:bg-slate-200/10 group-hover:bg-slate-200/10"
                      :title="s.cwd"
                      @click.stop="openRenameSession(s, { focus: 'project' })"
                    >
                      {{ sessionProject(s) }}
                    </button>
                    <span class="shrink-0 text-slate-700">·</span>
                    <span class="shrink-0">{{ sessionHostName(s) }}</span>
                  </div>

                  <div class="mt-1 min-w-0 truncate text-xs text-slate-400/90">
                    {{ s.preview ?? '' }}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>
      </aside>

      <!-- Main -->
      <main class="flex-1 grid grid-cols-1" :class="(showDiff || showPlan) ? 'lg:grid-cols-[1fr_520px]' : ''">
        <section class="min-w-0 flex flex-col">
          <header class="border-b border-slate-900 bg-slate-950/40 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-slate-950/25">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    v-if="selectedSession"
                    class="h-2.5 w-2.5 rounded-full ring-1 ring-black/25 shadow-sm"
                    :class="indicatorDotClass(sessionIndicator(selectedSession))"
                  />
                  <button
                    v-if="selectedSession"
                    class="truncate text-sm font-medium text-slate-100 transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 rounded"
                    title="Rename chat"
                    @click="openRenameSession(selectedSession, { focus: 'title' })"
                  >
                    {{ sessionListTitle(selectedSession) }}
                  </button>
                  <div v-else class="truncate text-sm font-medium text-slate-100">New chat</div>
                </div>
                <div class="mt-1 truncate text-xs text-slate-500" :title="selectedSession?.cwd ?? defaults.cwd">
                  {{ selectedSession?.cwd ?? (defaults.cwd ? defaults.cwd : 'Pick a workspace to start') }}
                </div>
                <div v-if="selectedTokenUsage" class="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <span class="truncate">
                    Tokens:
                    <span v-if="selectedTokenUsage.lastTotalTokens !== null" class="text-slate-300">last {{ formatCompactInt(selectedTokenUsage.lastTotalTokens) }}</span>
                    <span v-else class="text-slate-400">last —</span>
                    <span class="text-slate-700">·</span>
                    <span v-if="selectedTokenUsage.totalTotalTokens !== null" class="text-slate-300">total {{ formatCompactInt(selectedTokenUsage.totalTotalTokens) }}</span>
                    <span v-else class="text-slate-400">total —</span>
                    <span v-if="selectedTokenUsage.modelContextWindow !== null" class="text-slate-700">·</span>
                    <span v-if="selectedTokenUsage.modelContextWindow !== null" class="text-slate-400">ctx {{ formatCompactInt(selectedTokenUsage.modelContextWindow) }}</span>
                  </span>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <button
                  v-if="selectedSessionId"
                  class="inline-flex items-center gap-2 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                  @click="openSessionPolicy"
                  title="Approval & sandbox settings"
                >
                  <Settings class="h-3.5 w-3.5" />
                  Policies
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                  @click="showDiff = !showDiff"
                >
                  <component :is="showDiff ? PanelRightClose : PanelRightOpen" class="h-3.5 w-3.5" />
                  Diff
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                  @click="showPlan = !showPlan"
                >
                  <component :is="showPlan ? PanelRightClose : PanelRightOpen" class="h-3.5 w-3.5" />
                  Plan
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 active:scale-[0.99]"
                  @click="openVSCode"
                  title="Open VS Code web (code-server)"
                  :disabled="ideStarting"
                >
                  <Loader2 v-if="ideStarting" class="h-3.5 w-3.5 animate-spin" />
                  <Code v-else class="h-3.5 w-3.5" />
                  VS Code
                </button>
                <button
                  v-if="selectedSessionId && !selectedSession?.archivedMs"
                  class="inline-flex items-center gap-2 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 active:scale-[0.99]"
                  @click="archiveCurrentSession"
                  title="Archive chat"
                >
                  <Archive class="h-3.5 w-3.5" />
                  Archive
                </button>
                <button
                  v-if="selectedSessionId && selectedSession?.archivedMs"
                  class="inline-flex items-center gap-2 rounded-md bg-slate-200/10 px-3 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 active:scale-[0.99]"
                  @click="unarchiveSessionById(selectedSessionId)"
                  title="Unarchive chat"
                >
                  <Archive class="h-3.5 w-3.5" />
                  Unarchive
                </button>
                <button
                  v-if="selectedSessionId"
                  class="inline-flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-200 transition-colors hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 active:scale-[0.99]"
                  @click="openDeleteModal(selectedSessionId)"
                  title="Delete chat"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                  Delete
                </button>
                <button
                  v-if="selectedSession?.turnState === 'running'"
                  class="inline-flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 transition-colors hover:bg-amber-500/15 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
                  @click="stopGenerating"
                >
                  <Square class="h-3.5 w-3.5" />
                  Stop generating
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-200 transition-colors hover:bg-red-500/15 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
                  :disabled="!selectedSessionId"
                  @click="stopSession"
                >
                  End session
                </button>
              </div>
            </div>
          </header>

          <div class="relative flex-1">
            <div ref="chatScrollEl" class="absolute inset-0 overflow-auto px-4 py-6" @scroll="onChatScroll">
              <div class="mx-auto w-full max-w-3xl">
              <div v-if="selectedSessionId && sessionLoading" class="py-10">
                <div class="space-y-3 animate-pulse">
                  <div class="h-8 w-2/3 rounded-xl bg-slate-900/40" />
                  <div class="h-6 w-1/3 rounded-xl bg-slate-900/35" />
                  <div class="h-20 w-full rounded-2xl bg-slate-900/35" />
                  <div class="h-20 w-11/12 rounded-2xl bg-slate-900/30" />
                </div>
              </div>

              <div v-else-if="!selectedSessionId && !chatMessages.length" class="py-16 text-center">
                <div class="text-lg font-semibold text-slate-200">Start a chat</div>
                <div class="mt-2 text-sm text-slate-500">
                  Type a message below to start a new Codex session in your workspace.
                </div>
              </div>

              <div v-else-if="selectedSessionId && !chatMessages.length" class="py-16 text-center">
                <div class="text-sm font-medium text-slate-200">No messages yet</div>
                <div class="mt-2 text-sm text-slate-500">Waiting for events…</div>
              </div>

              <div v-else>
              <div v-if="selectedStore?.loadingBefore" class="pb-4 text-center text-xs text-slate-500">Loading earlier…</div>
              <transition-group name="rg-msg" tag="div" class="space-y-5">
                <div
                  v-for="m in chatMessages"
                  :key="m.id"
                  class="flex"
                  :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
                >
                  <div
                    v-if="m.role === 'system'"
                    class="w-full rounded-lg border border-slate-900 bg-slate-950/30 px-3 py-2 text-xs text-slate-400"
                  >
                    {{ m.text }}
                  </div>

                  <div
                    v-else-if="m.role === 'toolcall'"
                    class="max-w-[860px] rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 shadow-sm"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="text-[11px] uppercase tracking-wider text-slate-500">
                          {{ m.tool === 'commandExecution' ? 'Command' : (m.tool === 'fileChange' ? 'File changes' : 'Tool') }}
                          <span class="text-slate-700">·</span>
                          <span class="text-slate-300">{{ String(m.status ?? '') }}</span>
                          <span v-if="m.exitCode !== null && m.exitCode !== undefined" class="text-slate-700">·</span>
                          <span v-if="m.exitCode !== null && m.exitCode !== undefined" class="text-slate-300">exit {{ m.exitCode }}</span>
                        </div>
                        <div v-if="m.command" class="mt-1 truncate text-xs font-mono text-slate-200" :title="m.command">{{ m.command }}</div>
                        <div v-else-if="m.tool === 'fileChange'" class="mt-1 text-xs text-slate-300">
                          {{ Array.isArray(m.changes) ? `${m.changes.length} file(s)` : 'file changes' }}
                        </div>
                      </div>

                      <button
                        class="shrink-0 rounded-md bg-slate-200/10 px-2.5 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
                        @click="toggleToolExpanded(m.itemId)"
                      >
                        {{ m.expanded ? 'Hide' : 'Details' }}
                      </button>
                    </div>

                    <div v-if="m.expanded" class="mt-3 space-y-3">
                      <div v-if="m.tool === 'fileChange' && Array.isArray(m.changes) && m.changes.length" class="rounded-lg border border-slate-900 bg-slate-950/40 p-3">
                        <div class="text-[11px] uppercase tracking-wider text-slate-500">Files</div>
                        <div class="mt-2 space-y-1 text-xs font-mono text-slate-200">
                          <div v-for="(c, idx) in m.changes.slice(0, 50)" :key="idx" class="truncate" :title="c.path">{{ c.path }}</div>
                          <div v-if="m.changes.length > 50" class="text-[11px] text-slate-500">…and {{ m.changes.length - 50 }} more</div>
                        </div>
                      </div>

                      <div class="rounded-lg border border-slate-900 bg-slate-950/40 p-3">
                        <div class="flex items-center justify-between gap-3">
                          <div class="text-[11px] uppercase tracking-wider text-slate-500">Output</div>
                          <button
                            v-if="m.output?.hasMoreBefore"
                            class="rounded-md bg-slate-200/10 px-2.5 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                            :disabled="m.output?.loading"
                            @click="loadMoreToolOutputBefore(selectedSessionId, m.itemId)"
                          >
                            Load more
                          </button>
                        </div>

                        <div v-if="m.output?.loading" class="mt-2 text-xs text-slate-500">Loading…</div>

                        <div v-if="m.output?.stdout" class="mt-2">
                          <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stdout</div>
                          <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-slate-900 bg-slate-950/50 p-2 text-xs font-mono text-slate-200">{{ m.output.stdout }}</pre>
                        </div>

                        <div v-if="m.output?.stderr" class="mt-2">
                          <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stderr</div>
                          <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-slate-900 bg-slate-950/50 p-2 text-xs font-mono text-slate-200">{{ m.output.stderr }}</pre>
                        </div>

                        <div v-if="m.output && !m.output.loading && !m.output.stdout && !m.output.stderr" class="mt-2 text-xs text-slate-500">
                          (no output)
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    v-else-if="m.role === 'tool'"
                    class="max-w-[860px] rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-xs font-mono text-slate-200 shadow-sm"
                  >
                    <div class="mb-2 flex items-center justify-between text-[10px] font-sans uppercase tracking-wider text-slate-500">
                      <span>{{ m.stream ?? 'tool' }}</span>
                    </div>
                    <pre class="m-0 whitespace-pre-wrap">{{ m.text }}</pre>
                  </div>

                  <div
                    v-else
                    class="max-w-[860px] rounded-2xl border px-4 py-3 text-sm leading-relaxed shadow-sm transition-colors"
                    :class="m.role === 'user'
                      ? 'bg-indigo-500/15 text-indigo-50 border-indigo-400/20'
                      : 'bg-slate-950/40 text-slate-100 border-slate-800/80'"
                  >
                    <div v-if="m.role === 'assistant'">
                      <MarkdownView :source="m.text" />
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
                            class="h-20 w-20 rounded-xl object-cover ring-1 ring-slate-800/70 hover:ring-slate-700"
                          />
                          <div
                            v-else
                            class="flex h-12 max-w-[220px] items-center justify-center rounded-xl bg-slate-200/5 px-3 text-xs text-slate-200 ring-1 ring-slate-800/70 hover:ring-slate-700"
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
              class="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 shadow-lg backdrop-blur transition-colors hover:bg-slate-900/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 active:scale-[0.99]"
              @click="scrollToBottom"
              title="Scroll to bottom"
            >
              <ArrowDown class="h-4 w-4" />
              <span class="hidden sm:inline">New messages</span>
            </button>
          </div>

          <footer
            class="relative border-t border-slate-900 bg-slate-950/40 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-slate-950/25"
            @dragenter.prevent="onComposerDragEnter"
            @dragleave.prevent="onComposerDragLeave"
            @dragover.prevent
            @drop.prevent="onComposerDrop"
          >
            <div class="mx-auto w-full max-w-3xl">
              <div
                v-if="composerDragging"
                class="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-indigo-500/50 bg-indigo-500/5 text-sm font-medium text-indigo-200"
              >
                Drop files to attach
              </div>
              <div v-if="ideError" class="mb-2 text-sm text-red-400">{{ ideError }}</div>
              <div v-if="sendError" class="mb-2 text-sm text-red-400">{{ sendError }}</div>

              <div class="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
                <div class="truncate">
                  Workspace:
                  <span class="text-slate-200">{{ defaults.cwd || '(not set)' }}</span>
                  <span class="text-slate-500"> · </span>
                  Machine:
                  <span class="text-slate-200">{{ defaults.machineId ? defaults.machineId.slice(0, 8) : 'auto' }}</span>
                </div>
                <button class="text-slate-300 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 rounded" @click="openSettings('defaults')">Edit</button>
              </div>

              <div v-if="attachments.length" class="mb-2 flex flex-wrap gap-2">
                <div
                  v-for="a in attachments"
                  :key="a.id"
                  class="relative rounded-xl border border-slate-800 bg-slate-950/60 p-2"
                >
                  <button
                    class="absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-950 text-slate-200 ring-1 ring-slate-800/70 hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                    @click="removeAttachment(a.id)"
                    title="Remove"
                  >
                    <X class="h-3.5 w-3.5" />
                  </button>

                  <img
                    v-if="a.previewUrl"
                    :src="a.previewUrl"
                    :alt="a.filename"
                    class="h-16 w-16 rounded-lg object-cover"
                  />
                  <div v-else class="flex h-16 w-40 items-center justify-center rounded-lg bg-slate-200/5 px-2 text-xs text-slate-200">
                    <div class="truncate" :title="a.filename">{{ a.filename }}</div>
                  </div>
                </div>
              </div>

              <div class="flex items-end gap-2">
                <input
                  ref="fileInputEl"
                  type="file"
                  class="hidden"
                  multiple
                  @change="onFilesPicked"
                />
                <button
                  class="inline-flex items-center justify-center rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-slate-200 transition-colors hover:bg-slate-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 active:scale-[0.99]"
                  @click="openFilePicker"
                  title="Attach files"
                >
                  <Paperclip class="h-4 w-4" />
                </button>
                <textarea
                  v-model="messageDraft"
                  rows="2"
                  class="flex-1 resize-none rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
                  placeholder="Message Codex…"
                  @keydown.enter.exact.prevent="submit"
                  @paste="onComposerPaste"
                />
                <button
                  class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 active:scale-[0.99]"
                  @click="submit"
                  :disabled="sending || (!messageDraft.trim() && !attachments.length)"
                >
                  <Loader2 v-if="sending" class="h-4 w-4 animate-spin" />
                  <Send v-else class="h-4 w-4" />
                  Send
                </button>
              </div>
              <div class="mt-2 text-xs text-slate-500">Enter to send · Shift+Enter for newline</div>
            </div>
          </footer>
        </section>

        <aside v-if="showDiff || showPlan" class="hidden lg:flex min-w-0 flex-col border-l border-slate-900 bg-slate-950/40">
          <div v-if="showDiff" class="flex flex-1 min-h-0 flex-col">
            <div class="border-b border-slate-900 px-4 py-3">
              <div class="text-xs uppercase tracking-wider text-slate-500">Diff</div>
            </div>
            <div class="flex-1 overflow-auto p-4">
              <pre class="whitespace-pre-wrap break-words rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200">{{ selectedStore?.diff ?? '' }}</pre>
            </div>
          </div>

          <div v-if="showPlan" class="flex flex-1 min-h-0 flex-col border-t border-slate-900">
            <div class="border-b border-slate-900 px-4 py-3">
              <div class="text-xs uppercase tracking-wider text-slate-500">Plan</div>
            </div>
            <div class="flex-1 overflow-auto p-4">
              <div v-if="selectedStore?.planExplanation" class="mb-3 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs text-slate-300 whitespace-pre-wrap">
                {{ selectedStore.planExplanation }}
              </div>

              <div v-if="Array.isArray(selectedStore?.plan) && selectedStore.plan.length" class="space-y-2">
                <div
                  v-for="(step, idx) in selectedStore.plan"
                  :key="idx"
                  class="flex items-start gap-3 rounded-lg border border-slate-900 bg-slate-950/30 p-3"
                >
                  <span class="mt-1 h-2.5 w-2.5 rounded-full" :class="planDotClass(step.status)" />
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-slate-200 whitespace-pre-wrap">{{ step.step }}</div>
                  </div>
                  <div class="shrink-0 text-[10px] uppercase tracking-wider text-slate-500">
                    {{ step.status }}
                  </div>
                </div>
              </div>

              <div v-else class="rounded-lg border border-slate-900 bg-slate-950/30 p-3 text-xs text-slate-500">
                No plan yet.
              </div>
            </div>
          </div>
        </aside>
	      </main>

      </div>
	
	      <!-- Workspace & defaults modal -->
		      <transition name="rg-fade">
		        <div v-if="defaultsOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
		          <div class="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
		            <div class="flex items-start justify-between gap-4">
		              <div class="min-w-0">
		                <div class="text-sm font-semibold text-slate-100">Settings</div>
		                <div class="mt-1 text-xs text-slate-500">Defaults, machines, and system settings.</div>
		              </div>
		              <button
		                class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                @click="defaultsOpen = false"
		              >
		                Close
		              </button>
		            </div>

		            <div class="mt-4 flex items-center gap-2 text-xs">
		              <button
		                class="rounded-lg border px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                :class="settingsTab === 'defaults' ? 'border-slate-700 bg-slate-200/10 text-slate-100' : 'border-slate-900 bg-slate-950/40 text-slate-400 hover:bg-slate-200/5'"
		                @click="settingsTab = 'defaults'"
		              >
		                Defaults
		              </button>
		              <button
		                class="rounded-lg border px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                :class="settingsTab === 'machines' ? 'border-slate-700 bg-slate-200/10 text-slate-100' : 'border-slate-900 bg-slate-950/40 text-slate-400 hover:bg-slate-200/5'"
		                @click="settingsTab = 'machines'"
		              >
		                Machines
		              </button>
		              <button
		                class="rounded-lg border px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                :class="settingsTab === 'system' ? 'border-slate-700 bg-slate-200/10 text-slate-100' : 'border-slate-900 bg-slate-950/40 text-slate-400 hover:bg-slate-200/5'"
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
	                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="/home/me/project"
	                />
	              </div>
	
	              <div class="grid grid-cols-2 gap-2">
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Machine</div>
	                  <select
	                    v-model="defaults.machineId"
	                    class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                  >
	                    <option value="">(auto)</option>
	                    <option v-for="m in machines" :key="m.machineId" :value="m.machineId">
	                      {{ m.machineName }}
	                    </option>
	                  </select>
	                </div>
	
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Model</div>
	                  <input
	                    v-model="defaults.model"
	                    class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                    placeholder="(optional)"
	                  />
	                </div>
	              </div>
	
	              <div class="grid grid-cols-2 gap-2">
	                <div>
	                  <div class="text-xs uppercase tracking-wider text-slate-500">Approval policy</div>
	                  <select
	                    v-model="defaults.approvalPolicy"
	                    class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
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
	                    class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                  >
	                    <option value="read-only">read-only</option>
	                    <option value="workspace-write">workspace-write</option>
	                    <option value="danger-full-access">danger-full-access</option>
	                  </select>
	                </div>
		              </div>
		
		              <div v-if="defaultsError" class="text-sm text-red-400">{{ defaultsError }}</div>
		            </div>

		            <div v-else-if="settingsTab === 'machines'" class="mt-4 space-y-3">
		              <div v-if="!machines.length" class="rounded-xl border border-slate-900 bg-slate-950/40 p-6 text-center text-sm text-slate-500">
		                No machines connected yet.
		              </div>

		              <div v-else class="space-y-2">
		                <div
		                  v-for="m in machines"
		                  :key="m.machineId"
		                  class="rounded-xl border border-slate-900 bg-slate-950/40 p-3"
		                >
		                  <div class="flex items-center justify-between gap-3">
		                    <div class="min-w-0 flex items-center gap-2">
		                      <span class="h-2.5 w-2.5 rounded-full" :class="machineIsOnline(m) ? 'bg-emerald-400' : 'bg-slate-600'" />
		                      <div class="truncate text-sm font-medium text-slate-100">{{ m.machineName }}</div>
		                      <div class="shrink-0 rounded-md border border-slate-800 bg-slate-950/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
		                        {{ m.platform }}
		                      </div>
		                    </div>
		                    <div class="shrink-0 text-xs text-slate-500">{{ formatAgo(m.lastSeenMs) }}</div>
		                  </div>
		                  <div class="mt-2 flex items-center justify-between gap-3">
		                    <div class="min-w-0 truncate text-xs font-mono text-slate-400" :title="m.machineId">{{ m.machineId }}</div>
		                    <div class="shrink-0 text-[11px]" :class="machineIsOnline(m) ? 'text-emerald-400' : 'text-slate-500'">
		                      {{ machineIsOnline(m) ? 'online' : 'offline' }}
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
		                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
		                />
		                <div class="mt-2 text-xs text-slate-500">Rootgrid prunes its own sessions/events beyond this window.</div>
		              </div>

		              <div>
		                <div class="text-xs uppercase tracking-wider text-slate-500">SSE notifications</div>
		                <select
		                  v-model="sseToastsDraft"
		                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
		                >
		                  <option value="if-not-visible">If not visible</option>
		                  <option value="always">Always</option>
		                  <option value="never">Never</option>
		                </select>
		                <div class="mt-2 text-xs text-slate-500">Controls toast/desktop notifications emitted over SSE (approvals, ready, failures).</div>

		                <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-900 bg-slate-950/40 p-3">
		                  <div class="min-w-0">
		                    <div class="text-[11px] uppercase tracking-wider text-slate-500">Browser notifications</div>
		                    <div class="mt-1 text-xs text-slate-300">Permission: {{ notificationPermission }}</div>
		                    <div class="mt-1 text-xs text-slate-500">Needed to alert you while the tab/app is not visible.</div>
		                  </div>
		                  <button
		                    class="shrink-0 rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
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
		                    class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
		                  >
		                    <option value="if-not-visible">If not visible</option>
		                    <option value="always">Always</option>
		                    <option value="never">Never</option>
		                  </select>
		                  <div class="mt-2 text-xs text-slate-500">Uses the PWA service worker + VAPID. Requires a secure context (localhost/https) and subscription. “If not visible” means the relevant session isn’t currently open in a visible Rootgrid tab.</div>

		                  <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-900 bg-slate-950/40 p-3">
		                    <div class="min-w-0">
		                      <div class="text-[11px] uppercase tracking-wider text-slate-500">Push subscription</div>
		                      <div class="mt-1 text-xs text-slate-300">Status: {{ pushStatus }}</div>
		                      <div v-if="pushEndpoint" class="mt-1 truncate text-[11px] text-slate-500" :title="pushEndpoint">endpoint: {{ pushEndpoint }}</div>
		                      <div v-if="pushError" class="mt-1 text-xs text-red-400">{{ pushError }}</div>
		                    </div>
		                    <div class="shrink-0 flex items-center gap-2">
		                      <button
		                        class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
		                        @click="enablePush"
		                        :disabled="pushWorking || pushStatus === 'subscribed' || pushStatus === 'unsupported' || pushStatus === 'insecure'"
		                      >
		                        Enable
		                      </button>
		                      <button
		                        class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
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
		                <div class="rounded-xl border border-slate-900 bg-slate-950/40 p-3">
		                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Host</div>
		                  <div class="mt-2 text-xs text-slate-200 font-mono">
		                    {{ appSettings.host?.listen?.host ?? '—' }}:{{ appSettings.host?.listen?.port ?? '—' }}
		                  </div>
		                  <div class="mt-2 text-xs text-slate-500">trustProxy: {{ appSettings.host?.trustProxy ? 'true' : 'false' }}</div>
		                  <div v-if="appSettings.host?.publicUrl" class="mt-2 text-xs text-slate-500 truncate" :title="appSettings.host.publicUrl">
		                    publicUrl: <span class="text-slate-300">{{ appSettings.host.publicUrl }}</span>
		                  </div>
		                </div>

		                <div class="rounded-xl border border-slate-900 bg-slate-950/40 p-3">
		                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Runner</div>
		                  <div class="mt-2 text-xs text-slate-200">
		                    {{ appSettings.runner?.enabled ? 'enabled' : 'disabled' }}
		                  </div>
		                  <div class="mt-2 text-xs text-slate-500 truncate" :title="appSettings.runner?.machineId ?? ''">
		                    machineId: <span class="text-slate-300 font-mono">{{ appSettings.runner?.machineId ? appSettings.runner.machineId.slice(0, 12) + '…' : '—' }}</span>
		                  </div>
		                  <div class="mt-2 text-xs text-slate-500 truncate" :title="appSettings.runner?.machineName ?? ''">
		                    machineName: <span class="text-slate-300">{{ appSettings.runner?.machineName ?? '—' }}</span>
		                  </div>
		                </div>
		              </div>

		              <div v-if="appSettingsError" class="text-sm text-red-400">{{ appSettingsError }}</div>

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
	          <div class="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
	            <div class="flex items-start justify-between gap-4">
	              <div class="min-w-0">
	                <div class="text-sm font-semibold text-slate-100">Archived chats</div>
	                <div class="mt-1 text-xs text-slate-500">Hidden from the main chat list.</div>
	              </div>
	              <button
	                class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="archiveOpen = false"
	              >
	                Close
	              </button>
	            </div>

	            <div class="mt-4">
	              <div v-if="archiveLoading" class="space-y-2">
	                <div v-for="i in 6" :key="i" class="h-12 rounded-xl bg-slate-900/40 animate-pulse" />
	              </div>

	              <div v-else-if="archiveError" class="text-sm text-red-400">{{ archiveError }}</div>

	              <div v-else-if="!archivedSessions.length" class="rounded-xl border border-slate-900 bg-slate-950/40 p-6 text-center text-sm text-slate-500">
	                No archived chats.
	              </div>

	              <div v-else class="max-h-[65vh] overflow-auto space-y-2 pr-1">
	                <button
	                  v-for="s in archivedSessions"
	                  :key="s.sessionId"
	                  class="group w-full rounded-xl border border-slate-900 bg-slate-950/40 p-3 text-left transition-colors hover:bg-slate-950/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                  @click="selectedSessionId = s.sessionId; archiveOpen = false"
	                  :title="sessionTooltip(s)"
	                >
	                  <div class="flex items-start justify-between gap-3">
	                    <div class="min-w-0">
	                      <div class="truncate text-sm font-medium text-slate-100">{{ sessionListTitle(s) }}</div>
	                      <div class="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
	                        <span class="truncate" :title="s.cwd">{{ sessionProject(s) }}</span>
	                        <span class="text-slate-700">·</span>
	                        <span>{{ sessionHostName(s) }}</span>
	                      </div>
	                      <div class="mt-1 truncate text-xs text-slate-400/90">{{ s.preview ?? '' }}</div>
	                    </div>

	                    <div class="shrink-0 flex items-center gap-2">
	                      <button
	                        class="rounded-md bg-slate-200/10 px-2.5 py-1.5 text-xs text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                        @click.stop="unarchiveFromArchiveModal(s.sessionId)"
	                      >
	                        Unarchive
	                      </button>
	                      <button
	                        class="inline-flex items-center gap-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-200 transition-colors hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
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

	      <!-- Delete chat modal -->
	      <transition name="rg-fade">
	        <div v-if="deleteOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-100">Delete chat?</div>
	            <div class="mt-1 text-xs text-slate-500">This permanently deletes the session and its history.</div>

	            <div v-if="deleteError" class="mt-3 text-sm text-red-400">{{ deleteError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="deleteOpen = false"
	                :disabled="deleteWorking"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-red-500/15 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
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
	          <div class="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-100">Rename chat</div>
	            <div class="mt-1 text-xs text-slate-500">Update the chat title and/or project label.</div>
	
	            <div class="mt-4 space-y-3">
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Chat title</div>
	                <input
	                  v-model="renameTitleValue"
	                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="(leave empty to use the default title)"
	                  :autofocus="renameFocus === 'title'"
	                  @keydown.enter.prevent="saveRenameSession"
	                />
	              </div>
	
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Project label</div>
	                <input
	                  v-model="renameProjectValue"
	                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="(leave empty to use folder name)"
	                  :autofocus="renameFocus === 'project'"
	                  @keydown.enter.prevent="saveRenameSession"
	                />
	              </div>

	              <div v-if="renameError" class="text-sm text-red-400">{{ renameError }}</div>
	            </div>
	
	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="renameOpen = false"
	              >
	                Cancel
	              </button>
	              <button
	                class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
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
	          <div class="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-100">Session policies</div>
	            <div class="mt-1 text-xs text-slate-500">Updates Codex approval + sandbox settings (applies on the next turn).</div>

	            <div class="mt-4 grid grid-cols-2 gap-2">
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Approval policy</div>
	                <select
	                  v-model="sessionApprovalDraft"
	                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
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
	                  class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                >
	                  <option value="read-only">read-only</option>
	                  <option value="workspace-write">workspace-write</option>
	                  <option value="danger-full-access">danger-full-access</option>
	                </select>
	              </div>
	            </div>

	            <div v-if="sessionPolicyError" class="mt-3 text-sm text-red-400">{{ sessionPolicyError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="sessionPolicyOpen = false"
	                :disabled="sessionPolicySaving"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
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
	          <div class="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-100">
	              {{ pendingApproval.kind === 'userInput' ? 'Input requested' : 'Approval requested' }}
	            </div>
	            <div class="mt-1 text-xs text-slate-500">
	              Session: {{ pendingApproval.sessionId }} · Kind: {{ pendingApproval.kind }}<span v-if="pendingApproval.itemId"> · Item: {{ pendingApproval.itemId }}</span>
	            </div>
	
	            <!-- EXPERIMENTAL: user input request -->
	            <div v-if="pendingApproval.kind === 'userInput'" class="mt-4">
	              <div v-if="Array.isArray(pendingApproval.questions) && pendingApproval.questions.length" class="space-y-4">
	                <div v-for="(q, idx) in pendingApproval.questions" :key="q?.id ?? idx">
	                  <div v-if="q?.id && userInputForm[String(q.id)]">
	                    <div class="text-xs uppercase tracking-wider text-slate-500">{{ q.header || q.id }}</div>
	                    <div class="mt-1 text-sm text-slate-200 whitespace-pre-wrap">{{ q.question }}</div>
	
	                    <div v-if="Array.isArray(q.options) && q.options.length" class="mt-3 space-y-2">
	                      <label
	                        v-for="opt in q.options"
	                        :key="opt.label"
	                        class="flex gap-3 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-sm text-slate-100 hover:bg-slate-950/60 cursor-pointer"
	                      >
	                        <input
	                          type="radio"
	                          class="mt-0.5 accent-indigo-500"
	                          :name="`q-${q.id}`"
	                          :value="opt.label"
	                          v-model="userInputForm[String(q.id)].choice"
	                        />
	                        <div class="min-w-0">
	                          <div class="text-sm text-slate-100">{{ opt.label }}</div>
	                          <div class="text-xs text-slate-400">{{ opt.description }}</div>
	                        </div>
	                      </label>
	
	                      <label
	                        v-if="q.isOther"
	                        class="flex gap-3 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-sm text-slate-100 hover:bg-slate-950/60 cursor-pointer"
	                      >
	                        <input
	                          type="radio"
	                          class="mt-0.5 accent-indigo-500"
	                          :name="`q-${q.id}`"
	                          value="__other__"
	                          v-model="userInputForm[String(q.id)].choice"
	                        />
	                        <div class="min-w-0 w-full">
	                          <div class="text-sm text-slate-100">Other</div>
	                          <input
	                            v-if="userInputForm[String(q.id)].choice === '__other__'"
	                            v-model="userInputForm[String(q.id)].other"
	                            :type="q.isSecret ? 'password' : 'text'"
	                            class="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                            placeholder="Type an answer…"
	                          />
	                        </div>
	                      </label>
	                    </div>
	
	                    <div v-else class="mt-3">
	                      <input
	                        v-model="userInputForm[String(q.id)].text"
	                        :type="q.isSecret ? 'password' : 'text'"
	                        class="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none transition-colors focus:border-slate-600 focus:ring-2 focus:ring-indigo-500/20"
	                        placeholder="Type an answer…"
	                      />
	                    </div>
	                  </div>
	                </div>
	              </div>
	
	              <div v-if="userInputError" class="mt-3 text-sm text-red-400">{{ userInputError }}</div>
	
	              <div class="mt-5 flex items-center justify-end gap-2">
	                <button
	                  class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                  @click="cancelUserInput"
	                  :disabled="userInputSubmitting"
	                >
	                  Cancel
	                </button>
	                <button
	                  class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
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
	                <div class="mt-2 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-sm text-slate-200 whitespace-pre-wrap">{{ pendingApproval.reason }}</div>
	              </div>
	
	              <div v-if="pendingApproval.command" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Command</div>
	                <pre class="mt-2 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ pendingApproval.command }}</pre>
	              </div>

	              <div v-if="pendingApproval.cwd" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Working directory</div>
	                <pre class="mt-2 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ pendingApproval.cwd }}</pre>
	              </div>

	              <div v-if="pendingApproval.grantRoot" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Grant root</div>
	                <pre class="mt-2 rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ pendingApproval.grantRoot }}</pre>
	              </div>

	              <div v-if="pendingApproval.additionalPermissions" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Additional permissions</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.additionalPermissions, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.availableDecisions" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Available decisions</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.availableDecisions, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.commandActions" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Command actions</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.commandActions, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.proposedExecpolicyAmendment" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Proposed execpolicy amendment</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.proposedExecpolicyAmendment, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.proposedNetworkPolicyAmendments" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Proposed network policy amendments</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.proposedNetworkPolicyAmendments, null, 2) }}</pre>
	              </div>

	              <div v-if="pendingApproval.networkApprovalContext" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Network approval context</div>
	                <pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-900 bg-slate-950/40 p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap">{{ JSON.stringify(pendingApproval.networkApprovalContext, null, 2) }}</pre>
	              </div>

	              <div v-if="approvalExtraActions.length" class="mt-4">
	                <div class="text-xs uppercase tracking-wider text-slate-500">Quick actions</div>
	                <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
	                  <button
	                    v-for="a in approvalExtraActions"
	                    :key="a.id"
	                    class="rounded-md px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2"
	                    :class="a.variant === 'emerald-solid'
	                      ? 'bg-emerald-500 text-emerald-950 hover:bg-emerald-400 focus-visible:ring-emerald-500/50'
	                      : (a.variant === 'red-outline'
	                        ? 'bg-red-500/10 text-red-200 hover:bg-red-500/15 focus-visible:ring-red-500/40'
	                        : 'bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15 focus-visible:ring-emerald-500/40')"
	                    @click="respondApproval(a.decision)"
	                    :disabled="approvalResponding"
	                  >
	                    {{ a.label }}
	                  </button>
	                </div>
	              </div>
	
	              <div v-if="approvalRespondError" class="mt-3 text-sm text-red-400">{{ approvalRespondError }}</div>
	
	              <div class="mt-5 flex items-center justify-end gap-2">
	                <button
	                  v-if="approvalAllows('cancel')"
	                  class="rounded-md bg-slate-200/10 px-3 py-2 text-sm text-slate-100 transition-colors hover:bg-slate-200/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                  @click="respondApproval('cancel')"
	                  :disabled="approvalResponding"
	                >
	                  Cancel
	                </button>
	                <button
	                  v-if="approvalAllows('decline')"
	                  class="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-200 transition-colors hover:bg-red-500/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
	                  @click="respondApproval('decline')"
	                  :disabled="approvalResponding"
	                >
	                  Decline
	                </button>
	                <button
	                  v-if="approvalAllows('accept')"
	                  class="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 transition-colors hover:bg-emerald-500/15 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
	                  @click="respondApproval('accept')"
	                  :disabled="approvalResponding"
	                >
	                  Accept
	                </button>
	                <button
	                  v-if="approvalAllows('acceptForSession')"
	                  class="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
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
	            class="pointer-events-auto rounded-xl border p-3 shadow-lg backdrop-blur"
	            :class="toastBorderClass(t.level)"
	            @click="t.sessionId ? (selectedSessionId = t.sessionId) : null"
	          >
	            <div class="flex items-start justify-between gap-3">
	              <div class="min-w-0">
	                <div class="text-sm font-medium text-slate-100 truncate">{{ t.title }}</div>
	                <div v-if="t.message" class="mt-1 text-xs text-slate-300 whitespace-pre-wrap">{{ t.message }}</div>
	              </div>
	              <button
	                class="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md bg-slate-200/10 text-slate-200 transition-colors hover:bg-slate-200/15"
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
