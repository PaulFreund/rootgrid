export function markSessionRead(db, sessionId) {
  const res = db.prepare(`
    UPDATE sessions
    SET last_read_seq=last_seq
    WHERE session_id=?
  `).run(sessionId)
  return res.changes > 0
}

export function setSessionProjectLabel(db, sessionId, projectLabel) {
  const res = db.prepare(`
    UPDATE sessions
    SET project_label=?
    WHERE session_id=?
  `).run(projectLabel, sessionId)
  return res.changes > 0
}

export function setWorkspaceProjectLabelBySessionId(db, sessionId, projectLabel) {
  const target = db.prepare(`
    SELECT machine_id, cwd
    FROM sessions
    WHERE session_id=?
  `).get(sessionId)
  if (!target) return []

  const machineId = String(target.machine_id ?? '').trim()
  const cwd = String(target.cwd ?? '').trim()
  if (!machineId || !cwd) {
    setSessionProjectLabel(db, sessionId, projectLabel)
    return [sessionId]
  }

  const rows = db.prepare(`
    SELECT session_id
    FROM sessions
    WHERE machine_id=? AND cwd=?
  `).all(machineId, cwd)

  db.prepare(`
    UPDATE sessions
    SET project_label=?
    WHERE machine_id=? AND cwd=?
  `).run(projectLabel, machineId, cwd)

  return rows.map((row) => row?.session_id).filter((value) => typeof value === 'string' && value)
}

export function setSessionTitle(db, sessionId, title) {
  const nextTitle = (typeof title === 'string' && title.trim()) ? title.trim() : null
  const res = nextTitle
    ? db.prepare(`
      UPDATE sessions
      SET title=?, title_source='user'
      WHERE session_id=?
    `).run(nextTitle, sessionId)
    : db.prepare(`
      UPDATE sessions
      SET
        title = CASE WHEN preview IS NULL OR TRIM(preview)='' THEN NULL ELSE preview END,
        title_source='auto'
      WHERE session_id=?
    `).run(sessionId)
  return res.changes > 0
}

export function archiveSession(db, sessionId, { now = Date.now() } = {}) {
  const res = db.prepare(`
    UPDATE sessions
    SET archived_ms=?
    WHERE session_id=?
  `).run(now, sessionId)
  return res.changes > 0
}

export function unarchiveSession(db, sessionId) {
  const res = db.prepare(`
    UPDATE sessions
    SET archived_ms=NULL
    WHERE session_id=?
  `).run(sessionId)
  return res.changes > 0
}

export function deleteSession(db, sessionId) {
  const res = db.prepare(`DELETE FROM sessions WHERE session_id=?`).run(sessionId)
  return res.changes > 0
}
