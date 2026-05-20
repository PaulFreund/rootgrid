function mapPrunedSessionRow(row) {
  return {
    sessionId: row.session_id,
    machineId: row.machine_id
  }
}

export function listSessionIdsByMachine(db, machineId) {
  const rows = db.prepare(`
    SELECT session_id
    FROM sessions
    WHERE machine_id=?
  `).all(machineId)
  return rows.map((row) => row.session_id)
}

export function listUploadHostPathsByMachine(db, machineId) {
  const rows = db.prepare(`
    SELECT u.host_path AS host_path
    FROM uploads u
    JOIN sessions s ON s.session_id = u.session_id
    WHERE s.machine_id=?
  `).all(machineId)
  return rows.map((row) => row.host_path)
}

export function collectUploadHostPathsForSessionIds(db, sessionIds, { batchSize = 900 } = {}) {
  const ids = Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : []
  const out = []
  if (!ids.length) return out

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT host_path
      FROM uploads
      WHERE session_id IN (${placeholders})
    `).all(...batch)
    for (const row of rows) {
      if (row?.host_path) out.push(String(row.host_path))
    }
  }

  return out
}

export function pruneOldData(db, { cutoffMs }) {
  const oldSessionRows = db.prepare(`
    SELECT session_id, machine_id
    FROM sessions
    WHERE updated_ms < ?
  `).all(cutoffMs)

  const oldSessions = oldSessionRows.map((row) => row.session_id)
  const prunedSessions = oldSessionRows.map(mapPrunedSessionRow)
  const uploadHostPaths = collectUploadHostPathsForSessionIds(db, oldSessions)

  const sessionsDeleted = db.prepare(`DELETE FROM sessions WHERE updated_ms < ?`).run(cutoffMs).changes
  const machinesDeleted = db.prepare(`
    DELETE FROM machines
    WHERE last_seen_ms < ?
      AND machine_id NOT IN (SELECT DISTINCT machine_id FROM sessions)
  `).run(cutoffMs).changes
  const ideSessionsDeleted = db.prepare(`DELETE FROM ide_sessions WHERE updated_ms < ?`).run(cutoffMs).changes

  return { sessionsDeleted, machinesDeleted, ideSessionsDeleted, uploadHostPaths, prunedSessions }
}
