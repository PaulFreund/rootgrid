import { computed, ref } from 'vue'

export function urlBase64ToUint8Array(base64String, {
  atobFn = globalThis.atob
} = {}) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atobFn(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function createSystemSettingsActions({
  apiFetch,
  authed,
  appSettings = null,
  appSettingsLoaded,
  loadAppSettings,
  settingsTab,
  defaultsOpen,
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  notificationCtor = globalThis.Notification,
  atobFn = globalThis.atob
}) {
  const notificationSupported = computed(() => Boolean(windowObj && notificationCtor))
  const notificationPermission = ref('unsupported') // unsupported|default|denied|granted

  const pushSupported = computed(() => {
    return Boolean(windowObj && navigatorObj && 'serviceWorker' in navigatorObj && 'PushManager' in windowObj)
  })
  const pushStatus = ref('unknown') // unknown|subscribed|unsubscribed|unsupported|insecure
  const pushEndpoint = ref(null)
  const pushWorking = ref(false)
  const pushError = ref('')
  let autoEnablePushAttempted = false

  function refreshNotificationPermission() {
    if (!notificationSupported.value) {
      notificationPermission.value = 'unsupported'
      return
    }
    try {
      notificationPermission.value = notificationCtor.permission
    } catch {
      notificationPermission.value = 'unsupported'
    }
  }

  async function requestNotificationPermission() {
    if (!notificationSupported.value) return 'unsupported'
    try {
      const permission = await notificationCtor.requestPermission()
      notificationPermission.value = permission
      return permission
    } catch {
      refreshNotificationPermission()
      return notificationPermission.value
    }
  }

  async function refreshPushSubscription() {
    pushError.value = ''
    pushEndpoint.value = null

    if (!pushSupported.value) {
      pushStatus.value = 'unsupported'
      return
    }

    if (windowObj && !windowObj.isSecureContext) {
      pushStatus.value = 'insecure'
      return
    }

    try {
      const reg = await navigatorObj.serviceWorker.ready
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

  async function enablePush({ silent = false } = {}) {
    if (!silent) pushError.value = ''
    if (!pushSupported.value) return false

    pushWorking.value = true
    try {
      if (windowObj && !windowObj.isSecureContext) {
        pushStatus.value = 'insecure'
        if (!silent) pushError.value = 'Push notifications require a secure context.'
        return false
      }

      if (notificationPermission.value !== 'granted') {
        await requestNotificationPermission()
      }
      if (notificationPermission.value !== 'granted') {
        if (!silent) pushError.value = 'Notification permission not granted.'
        return false
      }

      const keyRes = await apiFetch('/api/push/vapid-public-key')
      if (!keyRes.ok) {
        const err = await keyRes.json().catch(() => null)
        if (!silent) pushError.value = err?.error ?? `HTTP ${keyRes.status}`
        return false
      }
      const keyData = await keyRes.json().catch(() => null)
      const publicKey = keyData?.publicKey
      if (!publicKey || typeof publicKey !== 'string') {
        if (!silent) pushError.value = 'Invalid VAPID public key.'
        return false
      }

      const reg = await navigatorObj.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      const sub = existing ?? await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey, { atobFn })
      })

      const res = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub)
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        if (!silent) pushError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }

      await refreshPushSubscription()
      return true
    } catch (err) {
      if (!silent) pushError.value = String(err?.message ?? err)
      return false
    } finally {
      pushWorking.value = false
    }
  }

  function currentWebPushPolicy() {
    return String(appSettings?.notifications?.webPush ?? 'if-not-visible').trim() || 'if-not-visible'
  }

  async function autoEnablePushOnLoad({ force = false } = {}) {
    if (!authed.value || !appSettingsLoaded.value) return false
    if (currentWebPushPolicy() === 'never') return false
    if (autoEnablePushAttempted && !force) return false
    autoEnablePushAttempted = true

    await refreshPushSubscription()
    if (pushStatus.value === 'subscribed') return true
    if (pushStatus.value === 'unsupported' || pushStatus.value === 'insecure') return false
    if (notificationPermission.value === 'denied') return false

    return await enablePush({ silent: true })
  }

  async function disablePush() {
    pushError.value = ''
    if (!pushSupported.value) return false

    pushWorking.value = true
    try {
      const reg = await navigatorObj.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (!sub) {
        await refreshPushSubscription()
        return true
      }

      await apiFetch('/api/push/subscribe', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(() => {})

      try { await sub.unsubscribe() } catch { }
      await refreshPushSubscription()
      return true
    } catch (err) {
      pushError.value = String(err?.message ?? err)
      return false
    } finally {
      pushWorking.value = false
    }
  }

  function openSettings(tab = 'machines') {
    const nextTab = tab === 'defaults' ? 'machines' : tab
    settingsTab.value = nextTab
    defaultsOpen.value = true
    if (authed.value && !appSettingsLoaded.value) {
      loadAppSettings().catch(() => {})
    }
    if (nextTab === 'system') {
      refreshPushSubscription().catch(() => {})
    }
  }

  return {
    notificationSupported,
    notificationPermission,
    pushSupported,
    pushStatus,
    pushEndpoint,
    pushWorking,
    pushError,
    refreshNotificationPermission,
    requestNotificationPermission,
    refreshPushSubscription,
    enablePush,
    autoEnablePushOnLoad,
    disablePush,
    openSettings
  }
}
