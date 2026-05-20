import { sessionRowToRecord } from './storeRows.js'

const SESSION_SELECT_SQL = `
  SELECT
    session_id,
    machine_id,
    cwd,
    project_label,
    title,
    title_source,
    preview,
    status,
    turn_state,
    pending_approvals,
    last_seq,
    last_read_seq,
    created_ms,
    updated_ms,
    codex_thread_id,
    model,
    reasoning_effort,
    service_tier,
    approval_policy,
    sandbox_mode,
    archived_ms
  FROM sessions
`

function clampLimit(limit, fallback, max) {
  return Math.max(1, Math.min(max, Number(limit) || fallback))
}

function buildArchivedClause(archived) {
  if (archived === true) return 'archived_ms IS NOT NULL'
  if (archived === false) return 'archived_ms IS NULL'
  return null
}

export function listSessionsPage(db, {
  archived = false,
  beforeUpdatedMs = null,
  beforeSessionId = null,
  limit = 200
} = {}) {
  const lim = clampLimit(limit, 200, 500)
  const clauses = []
  const params = []

  const archivedClause = buildArchivedClause(archived)
  if (archivedClause) clauses.push(archivedClause)

  const beforeUpdated = Number(beforeUpdatedMs)
  const beforeSession = String(beforeSessionId ?? '').trim()
  if (Number.isFinite(beforeUpdated) && beforeUpdated > 0) {
    clauses.push('(updated_ms < ? OR (updated_ms = ? AND session_id < ?))')
    params.push(beforeUpdated, beforeUpdated, beforeSession || '\uffff')
  }

  const rows = db.prepare(`
    ${SESSION_SELECT_SQL}
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_ms DESC, session_id DESC
    LIMIT ?
  `).all(...params, lim + 1)

  const hasMoreBefore = rows.length > lim
  const pageRows = hasMoreBefore ? rows.slice(0, lim) : rows
  const sessions = pageRows.map(sessionRowToRecord)
  const oldest = pageRows.length ? pageRows[pageRows.length - 1] : null

  return {
    sessions,
    hasMoreBefore,
    nextBeforeUpdatedMs: oldest ? Number(oldest.updated_ms) || null : null,
    nextBeforeSessionId: oldest?.session_id ?? null
  }
}
