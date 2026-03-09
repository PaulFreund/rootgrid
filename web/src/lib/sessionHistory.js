import { nextTick, reactive } from 'vue'

export function appendCapped(prev, delta, cap = 200_000) {
  const p = String(prev ?? '')
  const d = String(delta ?? '')
  if (!d) return p
  const next = p + d
  if (next.length <= cap) return next
  return next.slice(next.length - cap)
}

export function toolOutputHasMeaningfulText(output) {
  if (!output) return false
  const stdout = String(output?.stdout ?? '')
  const stderr = String(output?.stderr ?? '')
  const combined = `${stdout}\n${stderr}`.trim()
  if (!combined) return false

  const lines = combined.split(/\r?\n/).map((l) => String(l ?? '').trim()).filter(Boolean)
  if (!lines.length) return false

  const allInternal = lines.every((l) => l.startsWith('[codex] terminal interaction'))
  if (allInternal) return false

  return true
}

export function canCoalesceSessionEvent(prev, next, { atStart = false } = {}) {
  if (atStart) return false
  if (!prev || !next) return false
  if (prev?.type !== 'session.output' || next?.type !== 'session.output') return false

  const prevPayload = prev?.payload ?? {}
  const nextPayload = next?.payload ?? {}
  if (prevPayload?.itemId || nextPayload?.itemId) return false

  const prevStream = String(prevPayload?.stream ?? 'normalized')
  const nextStream = String(nextPayload?.stream ?? 'normalized')
  if (prevStream !== nextStream) return false
  if (
    prevStream !== 'normalized' &&
    prevStream !== 'commentary' &&
    prevStream !== 'reasoning' &&
    prevStream !== 'stdout' &&
    prevStream !== 'stderr'
  ) return false

  return typeof nextPayload?.text === 'string' && nextPayload.text.length > 0
}

export function coalesceSessionEvent(prev, next) {
  const prevPayload = prev?.payload ?? {}
  const nextPayload = next?.payload ?? {}
  const nextSeq = Number(next?.seq ?? 0)
  const nextTs = Number(next?.tsMs ?? 0)

  prev.payload = {
    ...prevPayload,
    ...nextPayload,
    text: `${String(prevPayload?.text ?? '')}${String(nextPayload?.text ?? '')}`
  }
  if (Number.isFinite(nextSeq) && nextSeq > 0) prev.seq = nextSeq
  if (Number.isFinite(nextTs) && nextTs > 0) prev.tsMs = nextTs
  return prev
}

export function getToolOutputState(store, itemId) {
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

export function appendToolOutput({ getSessionStore, sessionId, itemId, stream, text }) {
  const store = getSessionStore(sessionId)
  const st = getToolOutputState(store, itemId)
  if (!st) return
  if (stream === 'stderr') st.stderr = appendCapped(st.stderr, text)
  else st.stdout = appendCapped(st.stdout, text)
  st.loaded = true
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
}

export async function ensureToolOutputLoaded({ apiFetch, getSessionStore, sessionId, itemId }) {
  const store = getSessionStore(sessionId)
  const st = getToolOutputState(store, itemId)
  if (!st) return
  if (st.loading || st.loaded) return

  st.loading = true
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}/items/${encodeURIComponent(String(itemId))}/output?limit=500`)
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    const events = Array.isArray(data?.events) ? data.events : []

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
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  } finally {
    st.loading = false
  }
}

export async function loadMoreToolOutputBefore({ apiFetch, getSessionStore, sessionId, itemId }) {
  const store = getSessionStore(sessionId)
  const st = getToolOutputState(store, itemId)
  if (!st) return
  if (st.loading || !st.hasMoreBefore) return
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
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  } finally {
    st.loading = false
  }
}

export function getTurnReasoningState(store, turnId) {
  const key = String(turnId ?? '').trim()
  if (!key) return null
  let state = store.reasoningByTurnId.get(key)
  if (!state) {
    state = reactive({
      loading: false,
      loaded: false,
      loadingBody: false,
      bodyLoaded: false,
      error: '',
      truncated: false,
      sections: []
    })
    store.reasoningByTurnId.set(key, state)
  }
  return state
}

export async function ensureTurnReasoningLoaded({
  apiFetch,
  getSessionStore,
  parseReasoningSections,
  sessionId,
  turnId
}) {
  const sid = String(sessionId ?? '').trim()
  const tid = String(turnId ?? '').trim()
  if (!sid || !tid) return
  const store = getSessionStore(sid)
  const st = getTurnReasoningState(store, tid)
  if (!st || st.loading || st.loaded) return

  st.loading = true
  st.error = ''
  try {
    const res = await apiFetch(`/api/sessions/${sid}/turns/${encodeURIComponent(tid)}/reasoning?maxChars=400000&meta=1`)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

    const sections = Array.isArray(data?.sections) ? data.sections : null
    if (sections) {
      st.sections = sections
    } else {
      const text = String(data?.text ?? '')
      st.sections = parseReasoningSections(text).map((section) => ({
        ...section,
        body: null
      }))
    }
    st.truncated = Boolean(data?.truncated)
    st.loaded = true
    st.bodyLoaded = false
    if (st.sections.length) store.turnHasReasoningHistory.add(tid)
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  } catch (err) {
    st.error = String(err?.message ?? err)
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  } finally {
    st.loading = false
  }
}

export async function ensureTurnReasoningBodyLoaded({
  apiFetch,
  getSessionStore,
  parseReasoningSections,
  sessionId,
  turnId
}) {
  const sid = String(sessionId ?? '').trim()
  const tid = String(turnId ?? '').trim()
  if (!sid || !tid) return
  const store = getSessionStore(sid)
  const st = getTurnReasoningState(store, tid)
  if (!st || st.loadingBody || st.bodyLoaded) return

  st.loadingBody = true
  st.error = ''
  try {
    const res = await apiFetch(`/api/sessions/${sid}/turns/${encodeURIComponent(tid)}/reasoning?maxChars=400000`)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

    const sections = Array.isArray(data?.sections) ? data.sections : null
    if (sections) {
      st.sections = sections
    } else {
      const text = String(data?.text ?? '')
      st.sections = parseReasoningSections(text)
    }
    st.truncated = Boolean(data?.truncated)
    st.loaded = true
    st.bodyLoaded = true
    if (st.sections.length) store.turnHasReasoningHistory.add(tid)
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  } catch (err) {
    st.error = String(err?.message ?? err)
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  } finally {
    st.loadingBody = false
  }
}

export function addSessionEvent({
  getSessionStore,
  onDerivedEvent,
  sessionId,
  event,
  atStart = false,
  applyDerived = true
}) {
  const store = getSessionStore(sessionId)
  if (store.seen.has(event.eventId)) return
  store.seen.add(event.eventId)
  const seq = Number(event?.seq ?? 0)
  if (Number.isFinite(seq) && seq > 0) {
    store.lastLoadedSeq = Math.max(Number(store.lastLoadedSeq ?? 0), seq)
  }
  if (!atStart && canCoalesceSessionEvent(store.events[store.events.length - 1], event, { atStart })) {
    coalesceSessionEvent(store.events[store.events.length - 1], event)
  } else if (atStart) store.events.unshift(event)
  else store.events.push(event)
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  if (applyDerived && typeof onDerivedEvent === 'function') {
    onDerivedEvent(sessionId, event, store)
  }
}

export function resetSessionStoreState(store) {
  store.events.splice(0, store.events.length)
  store.seen.clear()
  store.historyLoaded = false
  store.lastLoadedSeq = 0
  try { store.queuedPrompts?.splice?.(0, store.queuedPrompts.length) } catch {}
  store.queueSending = false
  store.diff = ''
  store.plan = null
  store.planExplanation = null
  store.currentTurnId = null
  store.turnHasReasoningLive.clear()
  store.turnHasReasoningHistory.clear()
  store.turnHasReasoningTokens.clear()
  store.backgroundExpandedByTurnId.clear()
  store.reasoningByTurnId.clear()
  store.hasMoreBefore = true
  store.nextBeforeSeq = null
  store.loadingBefore = false
  store.loadingAfter = false
  store.lastRealtimeSeqSeen = 0
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  try { store.pendingAfter?.splice?.(0, store.pendingAfter.length) } catch {}
  store.toolOutputByItemId.clear()
  store.toolExpanded.clear()
  try { store.diffExpandedByEventId?.clear?.() } catch {}
  try { store.diffSelectedFileByEventId?.clear?.() } catch {}
}

export function getSessionStoreLoadedSeq(store) {
  const storeSeq = Number(store?.lastLoadedSeq ?? 0)
  if (Number.isFinite(storeSeq) && storeSeq > 0) return storeSeq

  const events = Array.isArray(store?.events) ? store.events : []
  let maxSeq = 0
  for (const event of events) {
    const seq = Number(event?.seq ?? 0)
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
  }
  return maxSeq
}

export function applyTurnReasoningHints(store, turnIds) {
  const ids = Array.isArray(turnIds) ? turnIds : []
  let changed = false
  for (const turnId of ids) {
    const key = String(turnId ?? '').trim()
    if (!key) continue
    if (store.turnHasReasoningHistory.has(key)) continue
    store.turnHasReasoningHistory.add(key)
    changed = true
  }
  if (changed) store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  return changed
}

export function shouldReuseSessionHistory(store, sessionRow) {
  if (!store || !store.historyLoaded) return false
  const knownSeq = getSessionStoreLoadedSeq(store)
  const targetSeq = Number(sessionRow?.lastSeq ?? 0)
  if (!Number.isFinite(targetSeq) || targetSeq <= 0) return true
  return knownSeq >= targetSeq
}

export function shouldBackfillSessionHistory(store, sessionRow) {
  if (!store || !store.historyLoaded) return false
  const knownSeq = getSessionStoreLoadedSeq(store)
  const targetSeq = Number(sessionRow?.lastSeq ?? 0)
  return Number.isFinite(targetSeq) && targetSeq > knownSeq && knownSeq >= 0
}

function applySessionEventsPage({
  events,
  reasoningTurnIds = [],
  sessionId,
  addSessionEvent,
  getSessionStore
}) {
  const store = getSessionStore(sessionId)
  applyTurnReasoningHints(store, reasoningTurnIds)
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    addSessionEvent({
      sessionId,
      event,
      atStart: false,
      applyDerived: true
    })
  }
  return list.length
}

function deriveCurrentTurnId(events) {
  let active = null
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type === 'turn.started') active = ev.payload?.turnId ?? active
    if (ev?.type === 'turn.completed') active = null
  }
  return active
}

async function warmSessionHistoryInBackground({
  apiFetch,
  getSessionStore,
  addSessionEvent,
  chatScrollEl,
  sessionId,
  shouldContinue,
  stopAtInput = false,
  maxPages = 1,
  limit = 500
}) {
  for (let i = 0; i < maxPages; i++) {
    if (typeof shouldContinue === 'function' && !shouldContinue()) break
    const store = getSessionStore(sessionId)
    if (!store.hasMoreBefore || !store.nextBeforeSeq) break
    if (stopAtInput && store.events.some((ev) => ev?.type === 'session.input')) break
    await loadMoreSessionHistoryBefore({
      apiFetch,
      getSessionStore,
      addSessionEvent,
      chatScrollEl,
      sessionId,
      pages: 1,
      limit
    })
  }
}

export async function loadMoreSessionHistoryBefore({
  apiFetch,
  getSessionStore,
  addSessionEvent,
  chatScrollEl,
  sessionId,
  pages = 1,
  limit = 200
}) {
  const store = getSessionStore(sessionId)
  if (store.loadingBefore || !store.hasMoreBefore || !store.nextBeforeSeq) return

  const pageCount = Math.max(1, Math.min(10, Number(pages) || 1))
  const pageLimit = Math.max(1, Math.min(2000, Number(limit) || 200))

  store.loadingBefore = true
  try {
    const el = chatScrollEl?.value ?? null
    const prevHeight = el ? el.scrollHeight : null
    const prevTop = el ? el.scrollTop : null

    const prependChunks = []
    let fetchedAny = false
    for (let p = 0; p < pageCount; p++) {
      if (!store.hasMoreBefore) break
      const beforeSeq = store.nextBeforeSeq
      if (!beforeSeq) break

      const res = await apiFetch(`/api/sessions/${sessionId}/events?mode=summary&limit=${encodeURIComponent(String(pageLimit))}&beforeSeq=${encodeURIComponent(String(beforeSeq))}`)
      if (!res.ok) break
      const page = await res.json().catch(() => null)
      const events = Array.isArray(page?.events) ? page.events : []
      applyTurnReasoningHints(store, page?.reasoningTurnIds)

      const toAdd = []
      for (const ev of events) {
        if (!ev?.eventId) continue
        if (store.seen.has(ev.eventId)) continue
        store.seen.add(ev.eventId)
        toAdd.push(ev)
      }
      if (toAdd.length) {
        prependChunks.unshift(toAdd)
        fetchedAny = true
      }

      store.hasMoreBefore = Boolean(page?.hasMoreBefore)
      store.nextBeforeSeq = page?.nextBeforeSeq ?? store.nextBeforeSeq
      if (!events.length) break

      if (p + 1 >= pageCount) {
        const firstType = prependChunks.length
          ? (prependChunks[0]?.[0]?.type ?? null)
          : (store.events?.[0]?.type ?? null)
        if (firstType === 'session.input') break
      }
    }

    const prepend = prependChunks.flat()
    if (prepend.length) store.events.unshift(...prepend)

    await nextTick()
    if (el && prevHeight !== null && prevTop !== null && fetchedAny) {
      const nextHeight = el.scrollHeight
      el.scrollTop = prevTop + (nextHeight - prevHeight)
    }
  } finally {
    store.loadingBefore = false
    try {
      const pending = Array.isArray(store.pendingAfter) ? store.pendingAfter : []
      if (pending.length) {
        const toFlush = pending.splice(0, pending.length)
        for (const ev of toFlush) {
          addSessionEvent({
            sessionId,
            event: ev,
            atStart: false,
            applyDerived: true
          })
        }
      }
    } catch {
    }
  }
}

export async function loadSessionHistory({
  apiFetch,
  upsertSessionRow,
  getSessionStore,
  addSessionEvent,
  chatScrollEl,
  loadSessionNonce,
  sessionLoading,
  sessionId,
  schedule = (fn) => setTimeout(fn, 0)
}) {
  const nonce = ++loadSessionNonce.value
  sessionLoading.value = true
  let initialResolved = false
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}?bootstrap=1&limit=800&prefetchPages=2&prefetchLimit=800`)
    if (!res.ok) return
    const data = await res.json()
    if (nonce !== loadSessionNonce.value) return
    if (data?.session) upsertSessionRow(data.session)

    const store = getSessionStore(sessionId)
    resetSessionStoreState(store)

    if (Array.isArray(data?.events)) {
      store.queuedPrompts = Array.isArray(data?.queuedPrompts) ? data.queuedPrompts : []
      applySessionEventsPage({
        events: data.events,
        reasoningTurnIds: data?.reasoningTurnIds,
        sessionId,
        addSessionEvent,
        getSessionStore
      })
      store.hasMoreBefore = Boolean(data?.hasMoreBefore)
      store.nextBeforeSeq = data?.nextBeforeSeq ?? null
    } else {
      const pageRes = await apiFetch(`/api/sessions/${sessionId}/events?mode=summary&limit=800`)
      if (!pageRes.ok) return
      const page = await pageRes.json().catch(() => null)
      if (nonce !== loadSessionNonce.value) return
      store.queuedPrompts = Array.isArray(data?.queuedPrompts) ? data.queuedPrompts : []
      applySessionEventsPage({
        events: page?.events,
        reasoningTurnIds: page?.reasoningTurnIds,
        sessionId,
        addSessionEvent,
        getSessionStore
      })
      store.hasMoreBefore = Boolean(page?.hasMoreBefore)
      store.nextBeforeSeq = page?.nextBeforeSeq ?? null
    }

    store.currentTurnId = deriveCurrentTurnId(store.events)
    store.historyLoaded = true
    store.lastLoadedSeq = Math.max(getSessionStoreLoadedSeq(store), Number(data?.session?.lastSeq ?? 0), Number(store.lastLoadedSeq ?? 0))
    if (loadSessionNonce.value === nonce) {
      sessionLoading.value = false
      initialResolved = true
    }

    try {
      schedule(() => {
        if (nonce !== loadSessionNonce.value) return
        warmSessionHistoryInBackground({
          apiFetch,
          getSessionStore,
          addSessionEvent,
          chatScrollEl,
          sessionId,
          shouldContinue: () => nonce === loadSessionNonce.value,
          stopAtInput: !Boolean(data?.containsInput),
          maxPages: data?.containsInput ? 0 : 6,
          limit: 800
        }).then(() => {
          if (nonce !== loadSessionNonce.value) return
          return warmSessionHistoryInBackground({
            apiFetch,
            getSessionStore,
            addSessionEvent,
            chatScrollEl,
            sessionId,
            shouldContinue: () => nonce === loadSessionNonce.value,
            maxPages: 3,
            stopAtInput: false,
            limit: 500
          })
        }).catch(() => {})
      })
    } catch {
    }
  } finally {
    if (loadSessionNonce.value === nonce && !initialResolved) sessionLoading.value = false
  }
}

export async function backfillSessionAfter({
  apiFetch,
  getSessionStore,
  onEnvelope,
  sessionId,
  afterSeq,
  limit = 500
}) {
  const sid = String(sessionId ?? '').trim()
  const cursorStart = Number(afterSeq ?? 0)
  if (!sid || !Number.isFinite(cursorStart) || cursorStart < 0) return

  const store = getSessionStore(sid)
  if (store.loadingAfter) return
  store.loadingAfter = true

  try {
    let cursor = cursorStart
    for (let i = 0; i < 10; i++) {
      const res = await apiFetch(`/api/sessions/${sid}/events?mode=full&limit=${encodeURIComponent(String(limit))}&afterSeq=${encodeURIComponent(String(cursor))}`)
      if (!res.ok) break
      const page = await res.json().catch(() => null)
      const events = Array.isArray(page?.events) ? page.events : []
      for (const ev of events) {
        onEnvelope({
          id: ev.eventId,
          ts: ev.tsMs,
          type: ev.type,
          scope: { sessionId: sid },
          payload: ev.payload,
          eventSeq: ev.seq
        })
      }

      if (!Boolean(page?.hasMoreAfter)) break
      const nextAfterSeq = Number(page?.nextAfterSeq ?? cursor)
      if (!Number.isFinite(nextAfterSeq) || nextAfterSeq <= cursor) break
      cursor = nextAfterSeq
    }
  } finally {
    store.loadingAfter = false
  }
}
