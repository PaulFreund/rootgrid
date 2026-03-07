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

export function setSessionTitle(db, sessionId, title) {
  const res = db.prepare(`
    UPDATE sessions
    SET title=?
    WHERE session_id=?
  `).run(title, sessionId)
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
