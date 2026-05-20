export function applySessionQueuedPrompts(store, queuedPrompts) {
  if (!store || typeof store !== 'object') return false
  store.queuedPrompts = Array.isArray(queuedPrompts) ? queuedPrompts : []
  store.queueSending = false
  return true
}

export function shouldRefreshQueuedPromptsAfterEnvelope({
  env,
  selectedSessionId,
  store
} = {}) {
  const sid = String(selectedSessionId ?? '').trim()
  if (!sid || !store || typeof store !== 'object') return false
  const envSessionId = String(env?.scope?.sessionId ?? env?.payload?.sessionId ?? '').trim()
  if (!envSessionId || envSessionId !== sid) return false
  const hasQueuedPrompts = Array.isArray(store?.queuedPrompts) && store.queuedPrompts.length > 0
  if (!hasQueuedPrompts && !Boolean(store?.queueSending)) return false
  return String(env?.type ?? '').trim() === 'turn.completed'
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
