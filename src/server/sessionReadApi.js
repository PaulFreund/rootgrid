import { createReadStream } from 'node:fs'

function clampPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(1, Math.min(max, parsed))
}

function hasSessionInput(events) {
  return Array.isArray(events) && events.some((event) => event?.type === 'session.input')
}

function collectTurnIds(events) {
  const out = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    const turnId = String(event?.payload?.turnId ?? '').trim()
    if (!turnId) continue
    if (event?.type === 'turn.started' || event?.type === 'turn.completed') out.add(turnId)
  }
  return Array.from(out)
}

function buildReasoningTurnHints(store, sessionId, events) {
  const turnIds = collectTurnIds(events)
  if (!turnIds.length) return []
  try {
    return store.listTurnsWithReasoning(sessionId, turnIds)
  } catch {
    return []
  }
}

export function buildSessionBootstrapPayload(
  store,
  sessionId,
  {
    limit = 800,
    prefetchPages = 2,
    prefetchLimit = 800,
    prefetchUntilInput = true
  } = {}
) {
  const pageLimit = clampPositiveInt(limit, 800, 2000)
  const warmPages = clampPositiveInt(prefetchPages, 2, 6)
  const warmLimit = clampPositiveInt(prefetchLimit, pageLimit, 2000)

  let page = store.listSessionEventsPage(sessionId, {
    limit: pageLimit,
    mode: 'summary'
  })

  let events = Array.isArray(page?.events) ? [...page.events] : []
  let hasMoreBefore = Boolean(page?.hasMoreBefore)
  let nextBeforeSeq = page?.oldestSeq ?? null
  let pagesFetched = 1

  if (prefetchUntilInput) {
    for (let i = 0; i < warmPages; i++) {
      if (hasSessionInput(events) || !hasMoreBefore || !nextBeforeSeq) break
      page = store.listSessionEventsPage(sessionId, {
        beforeSeq: nextBeforeSeq,
        limit: warmLimit,
        mode: 'summary'
      })
      const older = Array.isArray(page?.events) ? page.events : []
      if (!older.length) break
      events = older.concat(events)
      hasMoreBefore = Boolean(page?.hasMoreBefore)
      nextBeforeSeq = page?.oldestSeq ?? nextBeforeSeq
      pagesFetched += 1
    }
  }

  return {
    events,
    hasMoreBefore,
    nextBeforeSeq,
    reasoningTurnIds: buildReasoningTurnHints(store, sessionId, events),
    containsInput: hasSessionInput(events),
    pagesFetched
  }
}

export function createSessionReadApi({
  auth,
  store,
  json,
  uploadService,
  listQueuedPromptPayloads = () => [],
  getSessionOr404
}) {
  const { isImageMimeType } = uploadService

  return {
    async handle(req, res, url, parts) {
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const archivedRaw = url.searchParams.get('archived')
        const archived = (archivedRaw === '1' || archivedRaw === 'true')
          ? true
          : (archivedRaw === 'all' ? null : false)
        const limit = clampPositiveInt(url.searchParams.get('limit'), 200, 500)
        const beforeUpdatedMsRaw = url.searchParams.get('beforeUpdatedMs')
        const beforeUpdatedMs = beforeUpdatedMsRaw ? Number.parseInt(String(beforeUpdatedMsRaw), 10) : null
        const beforeSessionId = url.searchParams.get('beforeSessionId')
        const page = store.listSessionsPage({
          archived,
          limit,
          beforeUpdatedMs: Number.isFinite(beforeUpdatedMs) && beforeUpdatedMs > 0 ? beforeUpdatedMs : null,
          beforeSessionId: beforeSessionId || null
        })
        json(res, 200, page)
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true
        const includeBootstrap = url.searchParams.get('bootstrap') === '1'
        const includeEvents = url.searchParams.get('events') === '1'
        if (includeBootstrap) {
          const limit = clampPositiveInt(url.searchParams.get('limit'), 800, 2000)
          const prefetchPages = clampPositiveInt(url.searchParams.get('prefetchPages'), 2, 6)
          const prefetchLimit = clampPositiveInt(url.searchParams.get('prefetchLimit'), limit, 2000)
          const prefetchUntilInput = url.searchParams.get('prefetchUntilInput') !== '0'
          json(res, 200, {
            session,
            queuedPrompts: listQueuedPromptPayloads(sessionId),
            ...buildSessionBootstrapPayload(store, sessionId, {
              limit,
              prefetchPages,
              prefetchLimit,
              prefetchUntilInput
            })
          })
          return true
        }
        json(res, 200, {
          session,
          queuedPrompts: listQueuedPromptPayloads(sessionId),
          ...(includeEvents ? { events: store.listSessionEvents(sessionId, { limit: 500 }) } : {})
        })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'events' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        if (!getSessionOr404(res, sessionId)) return true

        const mode = (url.searchParams.get('mode') === 'full') ? 'full' : 'summary'
        const beforeSeqRaw = url.searchParams.get('beforeSeq')
        const afterSeqRaw = url.searchParams.get('afterSeq')
        const limitRaw = url.searchParams.get('limit')
        const beforeSeq = beforeSeqRaw ? Number.parseInt(String(beforeSeqRaw), 10) : null
        const afterSeq = afterSeqRaw ? Number.parseInt(String(afterSeqRaw), 10) : null
        const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : 200

        if (Number.isFinite(beforeSeq) && Number.isFinite(afterSeq)) {
          json(res, 400, { error: 'beforeSeq and afterSeq cannot be combined' })
          return true
        }

        if (Number.isFinite(afterSeq) && afterSeq >= 0) {
          const page = store.listSessionEventsAfter(sessionId, {
            afterSeq,
            limit: (Number.isFinite(limit) && limit > 0) ? limit : 200,
            mode
          })
          json(res, 200, {
            events: page.events,
            hasMoreAfter: page.hasMoreAfter,
            nextAfterSeq: page.newestSeq,
            reasoningTurnIds: buildReasoningTurnHints(store, sessionId, page.events)
          })
          return true
        }

        const page = store.listSessionEventsPage(sessionId, {
          beforeSeq: (Number.isFinite(beforeSeq) && beforeSeq > 0) ? beforeSeq : null,
          limit: (Number.isFinite(limit) && limit > 0) ? limit : 200,
          mode
        })
        json(res, 200, {
          events: page.events,
          hasMoreBefore: page.hasMoreBefore,
          nextBeforeSeq: page.oldestSeq,
          reasoningTurnIds: buildReasoningTurnHints(store, sessionId, page.events)
        })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'turns' && parts[4] && parts[5] === 'reasoning' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const turnId = parts[4]
        if (!getSessionOr404(res, sessionId)) return true

        const maxCharsRaw = url.searchParams.get('maxChars')
        const metaOnly = url.searchParams.get('meta') === '1'
        const maxChars = maxCharsRaw ? Number.parseInt(String(maxCharsRaw), 10) : 400_000

        const out = store.getTurnReasoningSections(sessionId, turnId, {
          maxChars,
          includeBody: !metaOnly
        })
        if (!out) {
          json(res, 404, { error: 'not found' })
          return true
        }
        json(res, 200, out)
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'items' && parts[4] && parts[5] === 'output' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const itemId = parts[4]
        if (!getSessionOr404(res, sessionId)) return true

        const beforeSeqRaw = url.searchParams.get('beforeSeq')
        const limitRaw = url.searchParams.get('limit')
        const beforeSeq = beforeSeqRaw ? Number.parseInt(String(beforeSeqRaw), 10) : null
        const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : 500

        const page = store.listItemOutputEvents(sessionId, itemId, {
          beforeSeq: (Number.isFinite(beforeSeq) && beforeSeq > 0) ? beforeSeq : null,
          limit: (Number.isFinite(limit) && limit > 0) ? limit : 500
        })
        json(res, 200, {
          events: page.events,
          hasMoreBefore: page.hasMoreBefore,
          nextBeforeSeq: page.oldestSeq
        })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'uploads' && parts[4] && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const uploadId = parts[4]
        if (!getSessionOr404(res, sessionId)) return true

        let upload = null
        try {
          upload = store.getUpload({ sessionId, uploadId })
        } catch {
        }
        if (!upload) {
          json(res, 404, { error: 'not found' })
          return true
        }

        res.statusCode = 200
        res.setHeader('Content-Type', upload.mimeType || 'application/octet-stream')
        const disp = isImageMimeType(upload.mimeType) ? 'inline' : 'attachment'
        res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(upload.filename)}"`)

        const stream = createReadStream(upload.hostPath)
        stream.on('error', () => {
          try { res.statusCode = 404 } catch { }
          try { res.end() } catch { }
        })
        stream.pipe(res)
        return true
      }

      return false
    }
  }
}
