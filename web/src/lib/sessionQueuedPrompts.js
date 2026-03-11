export function applySessionQueuedPrompts(store, queuedPrompts) {
  if (!store || typeof store !== 'object') return false
  store.queuedPrompts = Array.isArray(queuedPrompts) ? queuedPrompts : []
  store.queueSending = false
  return true
}

export async function refreshSessionQueuedPrompts({
  sessionId,
  apiFetch,
  getSessionStore,
  upsertSessionRow = null,
  shouldApply = null
}) {
  const sid = String(sessionId ?? '').trim()
  if (!sid || typeof apiFetch !== 'function' || typeof getSessionStore !== 'function') return false

  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sid)}`)
  const data = await res.json().catch(() => null)
  if (!res.ok) return false
  if (typeof shouldApply === 'function' && !shouldApply(sid, data)) return false

  if (data?.session && typeof upsertSessionRow === 'function') upsertSessionRow(data.session)
  const store = getSessionStore(sid)
  if (!store) return false
  return applySessionQueuedPrompts(store, data?.queuedPrompts)
}
