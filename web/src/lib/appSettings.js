const DEFAULT_RETENTION_DAYS = 30

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  sseToasts: 'if-not-visible',
  webPush: 'if-not-visible'
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
    webPush: normalizeNotificationPolicy(input?.webPush, normalizeNotificationPolicy(base.webPush))
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
  webPushDraft
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

  return {
    ok: true,
    payload: {
      retentionDays: n,
      notifications: {
        sseToasts: toastPolicy,
        webPush: pushPolicy
      }
    }
  }
}

export function applyAppSettingsPayload({
  appSettings,
  appSettingsLoaded,
  retentionDraft,
  sseToastsDraft,
  webPushDraft
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
  appSettingsLoaded.value = true
  return normalized
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
  hostSelfUpdateWorking = { value: false },
  hostSelfUpdateError = { value: '' },
  hostSelfUpdateStatus = { value: '' },
  onLogin
}) {
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
      webPushDraft
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
      webPushDraft
    }, data)
  }

  async function saveRetentionDays() {
    appSettingsError.value = ''
    const valid = validateAppSettingsDraft({
      retentionDraft: retentionDraft.value,
      sseToastsDraft: sseToastsDraft.value,
      webPushDraft: webPushDraft.value
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
          webPushDraft
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
      ok = true
      return true
    } catch (err) {
      hostSelfUpdateError.value = String(err?.message ?? err)
      return false
    } finally {
      if (!ok) hostSelfUpdateWorking.value = false
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
