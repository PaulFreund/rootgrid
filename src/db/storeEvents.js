import { collectReasoningSegments, parseReasoningSectionsWithStart } from './storeReasoning.js'
import { SUMMARY_SESSION_EVENTS_WHERE, eventRowToRecord } from './storeRows.js'

const EVENT_SELECT_SQL = `
  SELECT event_id, seq, ts_ms, type, payload_json
  FROM events
`

function clampLimit(limit, fallback, max) {
  return Math.max(1, Math.min(max, Number(limit) || fallback))
}

function buildSessionEventFilter({ sessionId, beforeSeq = null, afterSeq = null, mode = 'summary' } = {}) {
  const params = [sessionId]
  const clauses = ['session_id=?']

  if (Number.isFinite(Number(beforeSeq)) && Number(beforeSeq) > 0) {
    clauses.push('seq < ?')
    params.push(Number(beforeSeq))
  }

  if (Number.isFinite(Number(afterSeq)) && Number(afterSeq) >= 0) {
    clauses.push('seq > ?')
    params.push(Number(afterSeq))
  }

  if (mode === 'summary') clauses.push(SUMMARY_SESSION_EVENTS_WHERE)
  return { clauses, params }
}

function buildReasoningSections(parsedSections, segments, fallbackStartSeq) {
  let segIdx = 0
  return (Array.isArray(parsedSections) ? parsedSections : []).map((section, idx) => {
    const startIndex = Number(section?.startIndex) || 0
    while (segIdx < segments.length && startIndex >= segments[segIdx].end) segIdx += 1
    const seg = segments[segIdx] ?? null
    const inside = seg && startIndex >= seg.start && startIndex < seg.end
    const startSeq = inside && Number.isFinite(Number(seg.seq)) ? Number(seg.seq) : fallbackStartSeq
    const tsMs = inside && Number.isFinite(Number(seg.tsMs)) ? Number(seg.tsMs) : null
    return {
      id: `r-${idx + 1}`,
      title: section.title,
      body: section.body,
      startSeq,
      ...(tsMs ? { tsMs } : {})
    }
  })
}

export function listSessionEvents(db, sessionId, { limit = 500 } = {}) {
  const rows = db.prepare(`
    ${EVENT_SELECT_SQL}
    WHERE session_id=?
    ORDER BY seq DESC
    LIMIT ?
  `).all(sessionId, limit)
  return rows.reverse().map(eventRowToRecord)
}

export function listSessionEventsPage(db, sessionId, { beforeSeq = null, limit = 200, mode = 'summary' } = {}) {
  const lim = clampLimit(limit, 200, 2000)
  const { clauses, params } = buildSessionEventFilter({ sessionId, beforeSeq, mode })
  const rows = db.prepare(`
    ${EVENT_SELECT_SQL}
    WHERE ${clauses.join(' AND ')}
    ORDER BY seq DESC
    LIMIT ?
  `).all(...params, lim + 1)

  const hasMoreBefore = rows.length > lim
  const pageRows = hasMoreBefore ? rows.slice(0, lim) : rows
  const events = pageRows.reverse().map(eventRowToRecord)
  const oldestSeq = events.length ? Number(events[0].seq) : null

  return { events, hasMoreBefore, oldestSeq }
}

export function listSessionEventsAfter(db, sessionId, { afterSeq = null, limit = 200, mode = 'summary' } = {}) {
  const lim = clampLimit(limit, 200, 2000)
  const { clauses, params } = buildSessionEventFilter({ sessionId, afterSeq, mode })
  const rows = db.prepare(`
    ${EVENT_SELECT_SQL}
    WHERE ${clauses.join(' AND ')}
    ORDER BY seq ASC
    LIMIT ?
  `).all(...params, lim + 1)

  const hasMoreAfter = rows.length > lim
  const pageRows = hasMoreAfter ? rows.slice(0, lim) : rows
  const events = pageRows.map(eventRowToRecord)
  const newestSeq = events.length ? Number(events[events.length - 1].seq) : (Number(afterSeq) || 0)

  return { events, hasMoreAfter, newestSeq }
}

export function listItemOutputEvents(db, sessionId, itemId, { beforeSeq = null, limit = 500 } = {}) {
  const lim = clampLimit(limit, 500, 5000)
  const params = [sessionId, itemId]
  const clauses = [`session_id=?`, `type='session.output'`, `item_id=?`]

  if (Number.isFinite(Number(beforeSeq)) && Number(beforeSeq) > 0) {
    clauses.push('seq < ?')
    params.push(Number(beforeSeq))
  }

  const rows = db.prepare(`
    ${EVENT_SELECT_SQL}
    WHERE ${clauses.join(' AND ')}
    ORDER BY seq DESC
    LIMIT ?
  `).all(...params, lim + 1)

  const hasMoreBefore = rows.length > lim
  const pageRows = hasMoreBefore ? rows.slice(0, lim) : rows
  const events = pageRows.reverse().map(eventRowToRecord)
  const oldestSeq = events.length ? Number(events[0].seq) : null

  return { events, hasMoreBefore, oldestSeq }
}

export function getTurnSeqRange(db, sessionId, turnId) {
  const tid = String(turnId ?? '').trim()
  if (!tid) return null

  const started = db.prepare(`
    SELECT seq
    FROM events
    WHERE session_id=? AND type='turn.started' AND json_extract(payload_json, '$.turnId')=?
    ORDER BY seq ASC
    LIMIT 1
  `).get(sessionId, tid)
  if (!started) return null

  const startSeq = Number(started.seq) || 0
  if (!startSeq) return null

  const completed = db.prepare(`
    SELECT seq
    FROM events
    WHERE session_id=? AND type='turn.completed' AND json_extract(payload_json, '$.turnId')=?
    ORDER BY seq DESC
    LIMIT 1
  `).get(sessionId, tid)

  return {
    startSeq,
    endSeq: completed ? (Number(completed.seq) || null) : null
  }
}

export function getTurnReasoningText(db, { sessionId, turnId, lastSeq = null, maxChars = 400_000 } = {}) {
  const range = getTurnSeqRange(db, sessionId, turnId)
  if (!range) return null

  const endSeq = range.endSeq ?? (Number(lastSeq) || null)
  if (!endSeq) return { turnId: String(turnId), startSeq: range.startSeq, endSeq: null, text: '', truncated: false }

  const rows = db.prepare(`
    SELECT payload_json
    FROM events
    WHERE session_id=? AND type='session.output' AND stream='reasoning' AND seq >= ? AND seq <= ?
    ORDER BY seq ASC
  `).all(sessionId, range.startSeq, endSeq)
  const { text, truncated } = collectReasoningSegments(rows, { maxChars })

  return {
    turnId: String(turnId),
    startSeq: range.startSeq,
    endSeq,
    text,
    truncated
  }
}

export function getTurnReasoningSections(db, { sessionId, turnId, lastSeq = null, maxChars = 400_000 } = {}) {
  const range = getTurnSeqRange(db, sessionId, turnId)
  if (!range) return null

  const endSeq = range.endSeq ?? (Number(lastSeq) || null)
  if (!endSeq) {
    return { turnId: String(turnId), startSeq: range.startSeq, endSeq: null, truncated: false, sections: [] }
  }

  const rows = db.prepare(`
    SELECT seq, ts_ms, payload_json
    FROM events
    WHERE session_id=? AND type='session.output' AND stream='reasoning' AND seq >= ? AND seq <= ?
    ORDER BY seq ASC
  `).all(sessionId, range.startSeq, endSeq)
  const { text, truncated, segments } = collectReasoningSegments(rows, { maxChars })
  const parsed = parseReasoningSectionsWithStart(text)

  return {
    turnId: String(turnId),
    startSeq: range.startSeq,
    endSeq,
    truncated,
    sections: buildReasoningSections(parsed, segments, range.startSeq)
  }
}
