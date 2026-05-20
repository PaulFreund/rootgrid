const DEFAULT_RETENTION_DAYS = 30
const HOST_SELF_UPDATE_RELOAD_INITIAL_DELAY_MS = 1_000
const HOST_SELF_UPDATE_RELOAD_POLL_MS = 1_000
const HOST_SELF_UPDATE_RELOAD_TIMEOUT_MS = 90_000

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  sseToasts: 'if-not-visible',
  webPush: 'if-not-visible',
  sound: false
})

const VALID_NOTIFICATION_POLICIES = new Set([
  'always',
  'never',
  'if-not-visible'
])

function normalizeRetentionDays(value, fallback = DEFAULT_RETENTION_DAYS) {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function normalizeNotificationPolicy(value, fallback = DEFAULT_NOTIFICATION_SETTINGS.sseToasts) {
  const policy = String(value ?? '').trim()
  return VALID_NOTIFICATION_POLICIES.has(policy) ? policy : fallback
}

export function normalizeNotificationSettings(input, fallback = DEFAULT_NOTIFICATION_SETTINGS) {
  const base = (fallback && typeof fallback === 'object') ? fallback : DEFAULT_NOTIFICATION_SETTINGS
  return {
    sseToasts: normalizeNotificationPolicy(input?.sseToasts, normalizeNotificationPolicy(base.sseToasts)),
    webPush: normalizeNotificationPolicy(input?.webPush, normalizeNotificationPolicy(base.webPush)),
    sound: input?.sound === true || (input?.sound === undefined && base.sound === true)
  }
}

export function normalizeAppSettingsPayload(input, fallback = {}) {
  const base = (fallback && typeof fallback === 'object') ? fallback : {}
  return {
    appVersion: String(input?.appVersion ?? base.appVersion ?? '').trim() || null,
    retentionDays: normalizeRetentionDays(input?.retentionDays, normalizeRetentionDays(base.retentionDays)),
    notifications: normalizeNotificationSettings(input?.notifications, base.notifications),
    host: input?.host ?? base.host ?? null,
    runner: input?.runner ?? base.runner ?? null
  }
}

export function validateAppSettingsDraft({
  retentionDraft,
  sseToastsDraft,
  webPushDraft,
  soundNotificationsDraft
}) {
  const n = Number.parseInt(String(retentionDraft ?? ''), 10)
  if (!Number.isFinite(n) || n < 1 || n > 3650) {
    return {
      ok: false,
      error: 'Retention days must be an integer between 1 and 3650.'
    }
  }

  const toastPolicy = String(sseToastsDraft ?? '').trim()
  if (!VALID_NOTIFICATION_POLICIES.has(toastPolicy)) {
    return {
      ok: false,
      error: 'Notification policy must be Always/Never/If not visible.'
    }
  }

  const pushPolicy = String(webPushDraft ?? '').trim()
  if (!VALID_NOTIFICATION_POLICIES.has(pushPolicy)) {
    return {
      ok: false,
      error: 'Web Push policy must be Always/Never/If not visible.'
    }
  }

  if (typeof soundNotificationsDraft !== 'boolean') {
    return {
      ok: false,
      error: 'Sound notifications must be enabled or disabled.'
    }
  }

  return {
    ok: true,
    payload: {
      retentionDays: n,
      notifications: {
        sseToasts: toastPolicy,
        webPush: pushPolicy,
        sound: soundNotificationsDraft
      }
    }
  }
}

export function applyAppSettingsPayload({
  appSettings,
  appSettingsLoaded,
  retentionDraft,
  sseToastsDraft,
  webPushDraft,
  soundNotificationsDraft
}, payload) {
  const normalized = normalizeAppSettingsPayload(payload, appSettings)
  appSettings.appVersion = normalized.appVersion
  appSettings.retentionDays = normalized.retentionDays
  appSettings.notifications = normalized.notifications
  appSettings.host = normalized.host
  appSettings.runner = normalized.runner
  retentionDraft.value = String(normalized.retentionDays)
  sseToastsDraft.value = String(normalized.notifications?.sseToasts ?? DEFAULT_NOTIFICATION_SETTINGS.sseToasts)
  webPushDraft.value = String(normalized.notifications?.webPush ?? DEFAULT_NOTIFICATION_SETTINGS.webPush)
  soundNotificationsDraft.value = normalized.notifications?.sound === true
  appSettingsLoaded.value = true
  return normalized
}

function defaultReloadPage() {
  const location = globalThis.location
  if (!location) return false

  try {
    const url = new URL(location.href)
    url.searchParams.set('_rgHostReload', String(Date.now()))
    location.replace(url.toString())
    return true
  } catch {
  }

  try {
    location.reload()
    return true
  } catch {
  }

  return false
}

export function createAppSettingsActions({
  apiFetch,
  authed,
  authToken,
  authError,
  appSettings,
  appSettingsLoaded,
  appSettingsError,
  appSettingsSaving,
  retentionDraft,
  sseToastsDraft,
  webPushDraft,
  soundNotificationsDraft,
  hostSelfUpdateWorking = { value: false },
  hostSelfUpdateError = { value: '' },
  hostSelfUpdateStatus = { value: '' },
  hostSelfUpdateReloadInitialDelayMs = HOST_SELF_UPDATE_RELOAD_INITIAL_DELAY_MS,
  hostSelfUpdateReloadPollMs = HOST_SELF_UPDATE_RELOAD_POLL_MS,
  hostSelfUpdateReloadTimeoutMs = HOST_SELF_UPDATE_RELOAD_TIMEOUT_MS,
  scheduleTimer = (...args) => globalThis.setTimeout(...args),
  clearTimer = (...args) => globalThis.clearTimeout(...args),
  now = () => Date.now(),
  reloadPage = defaultReloadPage,
  onLogin
}) {
  let hostSelfUpdateReloadTimer = null
  let hostSelfUpdateReloadDeadlineMs = 0

  function clearHostSelfUpdateReloadTimer() {
    if (!hostSelfUpdateReloadTimer) return
    try { clearTimer(hostSelfUpdateReloadTimer) } catch {
    }
    hostSelfUpdateReloadTimer = null
  }

  function finishHostSelfUpdateWithManualReload(message) {
    clearHostSelfUpdateReloadTimer()
    hostSelfUpdateWorking.value = false
    hostSelfUpdateError.value = String(message ?? 'Host update completed, but automatic reload failed. Reload this page manually.')
    return false
  }

  function completeHostSelfUpdateReload() {
    hostSelfUpdateStatus.value = 'Host restarted. Reloading…'
    if (reloadPage() === true) return true
    return finishHostSelfUpdateWithManualReload('Host restarted, but automatic reload was blocked. Reload this page manually.')
  }

  function scheduleHostSelfUpdateReload(delayMs = hostSelfUpdateReloadInitialDelayMs) {
    clearHostSelfUpdateReloadTimer()
    hostSelfUpdateReloadTimer = scheduleTimer(async () => {
      hostSelfUpdateReloadTimer = null
      if (!hostSelfUpdateWorking.value) return

      try {
        const res = await apiFetch('/api/settings', {
          cache: 'no-store'
        })

        if (res.status === 401 || res.status === 403) {
          completeHostSelfUpdateReload()
          return
        }

        if (res.ok) {
          const data = await res.json().catch(() => null)
          const awaitingRestart = data?.host?.selfUpdate?.awaitingRestart === true
          if (!awaitingRestart) {
            completeHostSelfUpdateReload()
            return
          }
        }
      } catch {
      }

      if (now() >= hostSelfUpdateReloadDeadlineMs) {
        finishHostSelfUpdateWithManualReload('Host update started, but automatic reload timed out. Reload this page manually.')
        return
      }

      scheduleHostSelfUpdateReload(hostSelfUpdateReloadPollMs)
    }, delayMs)
  }

  async function loadAppSettings() {
    appSettingsError.value = ''
    appSettingsLoaded.value = false

    const res = await apiFetch('/api/settings')
    if (!res.ok) return null

    const data = await res.json().catch(() => null)
    if (!data || typeof data !== 'object') return null

    return applyAppSettingsPayload({
      appSettings,
      appSettingsLoaded,
      retentionDraft,
      sseToastsDraft,
      webPushDraft,
      soundNotificationsDraft
    }, data)
  }

  async function checkAuth() {
    const res = await apiFetch('/api/settings')
    if (!res.ok) {
      authed.value = false
      return null
    }
    authed.value = true

    const data = await res.json().catch(() => null)
    if (!data || typeof data !== 'object') return null

    return applyAppSettingsPayload({
      appSettings,
      appSettingsLoaded,
      retentionDraft,
      sseToastsDraft,
      webPushDraft,
      soundNotificationsDraft
    }, data)
  }

  async function saveRetentionDays() {
    appSettingsError.value = ''
    const valid = validateAppSettingsDraft({
      retentionDraft: retentionDraft.value,
      sseToastsDraft: sseToastsDraft.value,
      webPushDraft: webPushDraft.value,
      soundNotificationsDraft: soundNotificationsDraft.value
    })
    if (!valid.ok) {
      appSettingsError.value = valid.error
      return false
    }

    appSettingsSaving.value = true
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(valid.payload)
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        appSettingsError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }

      const data = await res.json().catch(() => null)
      if (data && typeof data === 'object') {
        applyAppSettingsPayload({
          appSettings,
          appSettingsLoaded,
          retentionDraft,
          sseToastsDraft,
          webPushDraft,
          soundNotificationsDraft
        }, data)
      }
      return true
    } finally {
      appSettingsSaving.value = false
    }
  }

  async function startHostSelfUpdate() {
    hostSelfUpdateError.value = ''
    hostSelfUpdateStatus.value = ''
    if (hostSelfUpdateWorking.value) return false

    clearHostSelfUpdateReloadTimer()
    hostSelfUpdateWorking.value = true
    let ok = false
    try {
      const res = await apiFetch('/api/host/self-update', {
        method: 'POST',
        body: JSON.stringify({})
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        hostSelfUpdateError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }

      const data = await res.json().catch(() => null)
      hostSelfUpdateStatus.value = String(data?.message ?? 'Host update started.')
      hostSelfUpdateReloadDeadlineMs = now() + Math.max(1_000, Number(hostSelfUpdateReloadTimeoutMs) || HOST_SELF_UPDATE_RELOAD_TIMEOUT_MS)
      scheduleHostSelfUpdateReload(Math.max(250, Number(hostSelfUpdateReloadInitialDelayMs) || HOST_SELF_UPDATE_RELOAD_INITIAL_DELAY_MS))
      ok = true
      return true
    } catch (err) {
      hostSelfUpdateError.value = String(err?.message ?? err)
      return false
    } finally {
      if (!ok) {
        clearHostSelfUpdateReloadTimer()
        hostSelfUpdateWorking.value = false
      }
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
      return false
    }
    authed.value = true
    await loadAppSettings().catch(() => {})
    if (typeof onLogin === 'function') onLogin()
    return true
  }

  return {
    loadAppSettings,
    checkAuth,
    saveRetentionDays,
    startHostSelfUpdate,
    login
  }
}
