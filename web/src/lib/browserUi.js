export function replaceUrlSessionParam(sessionId, { windowObj = globalThis.window } = {}) {
  try {
    const u = new URL(windowObj.location.href)
    if (sessionId) u.searchParams.set('session', String(sessionId))
    else u.searchParams.delete('session')
    windowObj.history.replaceState({}, '', u.toString())
    return true
  } catch {
    return false
  }
}

export function dismissToastById(toasts, id) {
  const list = Array.isArray(toasts) ? toasts : []
  const idx = list.findIndex((t) => t?.id === id)
  if (idx < 0) return false
  list.splice(idx, 1)
  return true
}

export function scheduleToastDismiss({ id, dismiss, ms = 6_000, setTimeoutFn = setTimeout } = {}) {
  if (!id || typeof dismiss !== 'function') return null
  const timer = setTimeoutFn(() => dismiss(id), ms)
  try { timer?.unref?.() } catch { }
  return timer
}

export function showBrowserNotification({
  notificationSupported,
  permission,
  toast,
  NotificationCtor = globalThis.Notification,
  focusWindow = () => {},
  onSessionSelected = () => {}
} = {}) {
  if (!notificationSupported) return false
  if (permission !== 'granted') return false
  try {
    const notification = new NotificationCtor(String(toast?.title ?? 'Rootgrid'), {
      body: String(toast?.message ?? ''),
      tag: (typeof toast?.notificationKey === 'string' && toast.notificationKey.trim())
        ? toast.notificationKey.trim()
        : (toast?.sessionId ? `rootgrid:${toast.sessionId}` : undefined)
    })
    notification.onclick = () => {
      try { focusWindow() } catch {}
      if (toast?.sessionId) onSessionSelected(toast.sessionId)
      try { notification.close?.() } catch {}
    }
    return true
  } catch {
    return false
  }
}

export async function copyTextToClipboard(text, {
  navigatorObj = globalThis.navigator,
  documentObj = globalThis.document
} = {}) {
  const t = String(text ?? '')
  if (!t) return false

  try {
    await navigatorObj?.clipboard?.writeText?.(t)
    return true
  } catch {
  }

  try {
    const el = documentObj.createElement('textarea')
    el.value = t
    el.setAttribute('readonly', 'true')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    documentObj.body.appendChild(el)
    el.select()
    const ok = documentObj.execCommand('copy')
    documentObj.body.removeChild(el)
    return Boolean(ok)
  } catch {
    return false
  }
}
