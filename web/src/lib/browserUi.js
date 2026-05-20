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

export function parseWorkspaceFileLinkHref(href) {
  const raw = String(href ?? '').trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^(https?:|mailto:|tel:|javascript:|data:)/i.test(raw)) return null

  let path = raw
  let hash = ''
  const hashIndex = raw.indexOf('#')
  if (hashIndex >= 0) {
    path = raw.slice(0, hashIndex)
    hash = raw.slice(hashIndex + 1)
  }

  try {
    path = decodeURIComponent(path)
  } catch {
  }

  if (/^file:\/\//i.test(path)) {
    try {
      const parsed = new URL(path)
      path = decodeURIComponent(parsed.pathname ?? '')
    } catch {
      return null
    }
  }

  const normalizedPath = /^[A-Za-z]:[\\/]/.test(path)
    ? path.replaceAll('\\', '/')
    : path

  const isUnixAbsolute = /^\/(mnt|home|tmp|Users|var|etc|opt|srv|usr|root)\//.test(normalizedPath)
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(normalizedPath)
  if (!isUnixAbsolute && !isWindowsAbsolute) return null

  const lineMatch = hash.match(/^L(\d+)(?:C(\d+))?$/i)
  const line = lineMatch ? Number(lineMatch[1]) : null

  return {
    path: normalizedPath,
    line: Number.isFinite(line) && line > 0 ? line : null
  }
}

export function dismissToastById(toasts, id) {
  const list = Array.isArray(toasts) ? toasts : []
  const idx = list.findIndex((t) => t?.id === id)
  if (idx < 0) return false
  list.splice(idx, 1)
  return true
}

export function createNotificationSoundPlayer({
  isEnabled = () => false,
  AudioCtor = globalThis.Audio,
  audioUrl = '/notification.mp3'
} = {}) {
  let audio = null

  function getAudio() {
    if (typeof AudioCtor !== 'function') return null
    if (audio) return audio
    try {
      audio = new AudioCtor(audioUrl)
      audio.preload = 'auto'
    } catch {
      audio = null
    }
    return audio
  }

  function preload() {
    if (!isEnabled()) return false
    const instance = getAudio()
    if (!instance) return false
    try { instance.load?.() } catch { }
    return true
  }

  function play() {
    if (!isEnabled()) return false
    const instance = getAudio()
    if (!instance) return false
    try { instance.pause?.() } catch { }
    try { instance.currentTime = 0 } catch { }
    try {
      const pending = instance.play?.()
      pending?.catch?.(() => {})
      return true
    } catch {
      return false
    }
  }

  return {
    preload,
    play
  }
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
