export function currentVisibilityState(doc = globalThis.document) {
  try {
    if (!doc || typeof doc.visibilityState !== 'string') return 'visible'
    return (doc?.visibilityState === 'visible') ? 'visible' : 'hidden'
  } catch {
    return 'visible'
  }
}

export function readStoredSseEventId({
  storage = globalThis.sessionStorage,
  key = 'rootgrid:last-sse-event-id'
} = {}) {
  try {
    const value = Number(storage?.getItem?.(key) ?? 0)
    return (Number.isFinite(value) && value > 0) ? value : 0
  } catch {
    return 0
  }
}

export function writeStoredSseEventId(eventId, {
  storage = globalThis.sessionStorage,
  key = 'rootgrid:last-sse-event-id'
} = {}) {
  try {
    const value = Number(eventId ?? 0)
    if (!Number.isFinite(value) || value <= 0) {
      storage?.removeItem?.(key)
      return 0
    }
    storage?.setItem?.(key, String(value))
    return value
  } catch {
    return 0
  }
}

export function buildEventsStreamPath({ visibility = 'visible', sessionId = null, machineId = null, lastEventId = null, resume = false } = {}) {
  const params = new URLSearchParams()
  params.set('visibility', String(visibility ?? 'visible'))
  if (sessionId) params.set('sessionId', String(sessionId))
  if (machineId) params.set('machineId', String(machineId))
  if (Number.isFinite(Number(lastEventId)) && Number(lastEventId) > 0) {
    params.set('lastEventId', String(Number(lastEventId)))
  }
  if (resume) params.set('resume', '1')
  return `/api/events?${params.toString()}`
}

export function inferSseDisconnectReason(source, {
  fallback = 'error',
  eventSourceCtor = globalThis.EventSource
} = {}) {
  try {
    const closedState = eventSourceCtor?.CLOSED
    if (closedState !== undefined && source?.readyState === closedState) return 'closed'
  } catch {
  }
  return fallback
}

export function createSessionSseActions({
  apiFetch,
  sseConnectionId,
  lastSseEventId,
  persistLastEventId = null,
  flushDelayMs = 16,
  flushBatchSize = 64,
  reconnectDelayMs = 5_000,
  hasSnapshot = null,
  selectedSessionId,
  selectedMachineId = null,
  stickToBottom,
  scheduleMarkRead,
  clearScheduledMarkRead,
  onVisible,
  sseStatus,
  sseDisconnectReason,
  lastSseMessageAt,
  everConnected,
  handleEnvelope,
  currentVisibility = () => currentVisibilityState(),
  shouldReconnect = () => true
}) {
  let es = null
  let visibilityPostTimer = null
  let visibilityPostDisabledConnectionId = null
  let flushTimer = null
  let reconnectTimer = null
  /** @type {any[]} */
  let pendingEnvelopes = []

  function updateLastEventId(value) {
    const nextId = Number(value ?? 0)
    if (!lastSseEventId || !Number.isFinite(nextId) || nextId <= 0) return
    const current = Number(lastSseEventId.value ?? 0)
    if (nextId <= current) return
    lastSseEventId.value = nextId
    try { persistLastEventId?.(nextId) } catch {}
  }

  function flushPendingEnvelopes() {
    if (flushTimer) {
      try { clearTimeout(flushTimer) } catch {}
      flushTimer = null
    }
    if (!pendingEnvelopes.length) return
    const batch = pendingEnvelopes
    pendingEnvelopes = []
    for (const env of batch) {
      try {
        handleEnvelope(env)
      } catch {
      }
    }
  }

  function scheduleEnvelopeFlush({ immediate = false } = {}) {
    if (immediate || flushDelayMs <= 0 || pendingEnvelopes.length >= flushBatchSize) {
      flushPendingEnvelopes()
      return
    }
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushPendingEnvelopes()
    }, flushDelayMs)
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return
    try { clearTimeout(reconnectTimer) } catch {}
    reconnectTimer = null
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    if (!shouldReconnect()) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!shouldReconnect()) return
      connectSse()
    }, reconnectDelayMs)
  }

  async function postVisibilityNow() {
    const connectionId = sseConnectionId.value
    if (!connectionId) return
    if (visibilityPostDisabledConnectionId === connectionId) return
    const res = await apiFetch('/api/visibility', {
      method: 'POST',
      body: JSON.stringify({
        connectionId,
        visibility: currentVisibility(),
        sessionId: selectedSessionId.value ?? null,
        machineId: selectedMachineId?.value ?? null
      })
    }).catch(() => null)
    const status = Number(res?.status ?? 0)
    if (status === 404 || status === 405) {
      visibilityPostDisabledConnectionId = connectionId
    }
  }

  function schedulePostVisibility() {
    if (visibilityPostTimer) clearTimeout(visibilityPostTimer)
    visibilityPostTimer = setTimeout(() => {
      visibilityPostTimer = null
      const vis = currentVisibility()
      if (sseConnectionId.value) postVisibilityNow()
      if (vis !== 'visible') {
        if (typeof clearScheduledMarkRead === 'function') clearScheduledMarkRead()
      } else if (sseStatus.value === 'error' || sseStatus.value === 'disconnected') {
        clearReconnectTimer()
        if (shouldReconnect()) connectSse()
      } else if (selectedSessionId.value && stickToBottom.value) {
        scheduleMarkRead(selectedSessionId.value)
      }

      if (vis === 'visible' && typeof onVisible === 'function') onVisible()
    }, 150)
  }

  function closeSse() {
    clearReconnectTimer()
    flushPendingEnvelopes()
    if (!es) return
    try { es.close() } catch {}
    es = null
  }

  function connectSse() {
    closeSse()

    sseConnectionId.value = null
    sseStatus.value = 'connecting'
    lastSseMessageAt.value = Date.now()

    const next = new EventSource(buildEventsStreamPath({
      visibility: currentVisibility(),
      sessionId: selectedSessionId.value || null,
      machineId: selectedMachineId?.value || null,
      lastEventId: lastSseEventId?.value ?? null,
      resume: Boolean(hasSnapshot?.value) && Number(lastSseEventId?.value ?? 0) > 0
    }))
    es = next

    next.onopen = () => {
      if (es !== next) return
      clearReconnectTimer()
      sseStatus.value = 'connected'
      sseDisconnectReason.value = null
      everConnected.value = true
      lastSseMessageAt.value = Date.now()
    }

    next.onerror = () => {
      if (es !== next) return
      sseStatus.value = 'error'
      sseDisconnectReason.value = inferSseDisconnectReason(next, {
        fallback: sseDisconnectReason.value ?? 'error'
      })
      scheduleReconnect()
    }

    next.onmessage = (ev) => {
      if (es !== next) return
      lastSseMessageAt.value = Date.now()
      const msgEventId = Number(ev?.lastEventId ?? 0)
      updateLastEventId(msgEventId)
      let env
      try {
        env = JSON.parse(ev.data)
      } catch {
        return
      }
      const envSseId = Number(env?.sseId ?? 0)
      updateLastEventId(envSseId)
      pendingEnvelopes.push(env)
      scheduleEnvelopeFlush({
        immediate: env?.type === 'registry.snapshot'
      })
    }
  }

  function disposeSse() {
    if (visibilityPostTimer) {
      try { clearTimeout(visibilityPostTimer) } catch {}
      visibilityPostTimer = null
    }
    clearReconnectTimer()
    flushPendingEnvelopes()
    closeSse()
  }

  return {
    connectSse,
    schedulePostVisibility,
    postVisibilityNow,
    disposeSse
  }
}
