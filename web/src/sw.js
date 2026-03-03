/* eslint-disable no-restricted-globals */
import { precacheAndRoute } from 'workbox-precaching'

// Precache Vite build assets.
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('push', (event) => {
  /** @type {{ title?: string, body?: string, tag?: string, data?: any } | null} */
  let payload = null
  try {
    payload = event?.data ? event.data.json() : null
  } catch {
    payload = null
  }

  const title = payload?.title ?? 'Rootgrid'
  const body = payload?.body ?? ''
  const tag = payload?.tag ?? undefined
  const data = payload?.data ?? undefined

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification?.close?.()

  const data = event.notification?.data ?? null
  const url = (data && typeof data.url === 'string' && data.url) ? data.url : '/'
  const sessionId = (data && typeof data.sessionId === 'string') ? data.sessionId : null

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      try {
        // Focus and ask the app to navigate in-place.
        await w.focus?.()
        if (sessionId) w.postMessage?.({ type: 'navigate', sessionId })
        else w.postMessage?.({ type: 'navigate', url })
        return
      } catch {
      }
    }
    await self.clients.openWindow(url)
  })())
})

