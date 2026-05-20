export function readSessionPageInfo(payload = null) {
  return {
    hasMoreBefore: Boolean(payload?.hasMoreBefore ?? payload?.sessionsHasMore),
    nextBeforeUpdatedMs: payload?.nextBeforeUpdatedMs ?? payload?.sessionsNextBeforeUpdatedMs ?? null,
    nextBeforeSessionId: payload?.nextBeforeSessionId ?? payload?.sessionsNextBeforeSessionId ?? null
  }
}

export function buildSessionListPagePath({
  archived = false,
  limit = 200,
  beforeUpdatedMs = null,
  beforeSessionId = null
} = {}) {
  const params = new URLSearchParams()
  if (archived === true) params.set('archived', '1')
  else if (archived === null) params.set('archived', 'all')
  params.set('limit', String(Math.max(1, Math.min(500, Number(limit) || 200))))
  const updatedMs = Number(beforeUpdatedMs)
  if (Number.isFinite(updatedMs) && updatedMs > 0) params.set('beforeUpdatedMs', String(updatedMs))
  const sessionId = String(beforeSessionId ?? '').trim()
  if (sessionId) params.set('beforeSessionId', sessionId)
  return `/api/sessions?${params.toString()}`
}

export function createSessionListLoader({
  apiFetch,
  appendSessionRows,
  sessionListLoading,
  sessionListHasMore,
  sessionListNextBeforeUpdatedMs,
  sessionListNextBeforeSessionId,
  schedule = (fn) => setTimeout(fn, 0)
}) {
  let warmToken = 0

  function applySessionPageInfo(payload) {
    const pageInfo = readSessionPageInfo(payload)
    sessionListHasMore.value = Boolean(pageInfo.hasMoreBefore)
    sessionListNextBeforeUpdatedMs.value = pageInfo.nextBeforeUpdatedMs ?? null
    sessionListNextBeforeSessionId.value = pageInfo.nextBeforeSessionId ?? null
    return pageInfo
  }

  async function loadMoreSessions({ archived = false, limit = 200 } = {}) {
    if (sessionListLoading.value || !sessionListHasMore.value) return false
    const beforeUpdatedMs = Number(sessionListNextBeforeUpdatedMs.value ?? 0)
    const beforeSessionId = String(sessionListNextBeforeSessionId.value ?? '').trim()
    if (!Number.isFinite(beforeUpdatedMs) || beforeUpdatedMs <= 0 || !beforeSessionId) {
      sessionListHasMore.value = false
      return false
    }

    sessionListLoading.value = true
    try {
      const res = await apiFetch(buildSessionListPagePath({
        archived,
        limit,
        beforeUpdatedMs,
        beforeSessionId
      }))
      if (!res.ok) return false
      const data = await res.json().catch(() => null)
      appendSessionRows(Array.isArray(data?.sessions) ? data.sessions : [])
      applySessionPageInfo(data)
      return Array.isArray(data?.sessions) && data.sessions.length > 0
    } finally {
      sessionListLoading.value = false
    }
  }

  function warmSessionListInBackground({ archived = false, limit = 200 } = {}) {
    const token = ++warmToken
    schedule(async () => {
      for (let i = 0; i < 50; i++) {
        if (token !== warmToken) return
        if (!sessionListHasMore.value) return
        const loaded = await loadMoreSessions({ archived, limit })
        if (!loaded) return
        await Promise.resolve()
      }
    })
  }

  async function fetchAllSessionPages({
    archived = false,
    limit = 200,
    onPage = () => {},
    shouldContinue = () => true
  } = {}) {
    let beforeUpdatedMs = null
    let beforeSessionId = null

    for (let i = 0; i < 200; i++) {
      if (typeof shouldContinue === 'function' && !shouldContinue()) break
      const res = await apiFetch(buildSessionListPagePath({
        archived,
        limit,
        beforeUpdatedMs,
        beforeSessionId
      }))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json().catch(() => null)
      onPage(Array.isArray(data?.sessions) ? data.sessions : [], data)

      const pageInfo = readSessionPageInfo(data)
      if (!pageInfo.hasMoreBefore) break
      const nextUpdatedMs = Number(pageInfo.nextBeforeUpdatedMs ?? 0)
      const nextSessionId = String(pageInfo.nextBeforeSessionId ?? '').trim()
      if (!Number.isFinite(nextUpdatedMs) || nextUpdatedMs <= 0 || !nextSessionId) break
      beforeUpdatedMs = nextUpdatedMs
      beforeSessionId = nextSessionId
    }
  }

  return {
    applySessionPageInfo,
    loadMoreSessions,
    warmSessionListInBackground,
    fetchAllSessionPages
  }
}
