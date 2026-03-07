import {
  approvalRowToRecord,
  ideSessionRowToRecord,
  pushSubscriptionRowToRecord,
  uploadRowToRecord
} from './storeRows.js'

export function upsertApproval(db, { approvalId, machineId, sessionId, kind, payload, createdMs = Date.now() }) {
  const payloadJson = JSON.stringify(payload ?? null)
  db.prepare(`
    INSERT INTO approvals(approval_id, machine_id, session_id, kind, payload_json, created_ms)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(approval_id) DO UPDATE SET
      machine_id=excluded.machine_id,
      session_id=excluded.session_id,
      kind=excluded.kind,
      payload_json=excluded.payload_json
  `).run(approvalId, machineId, sessionId, kind, payloadJson, createdMs)
}

export function getApproval(db, approvalId) {
  const row = db.prepare(`
    SELECT approval_id, machine_id, session_id, kind, payload_json, created_ms
    FROM approvals
    WHERE approval_id=?
  `).get(approvalId)
  return approvalRowToRecord(row)
}

export function listApprovals(db) {
  const rows = db.prepare(`
    SELECT approval_id, machine_id, session_id, kind, payload_json, created_ms
    FROM approvals
    ORDER BY created_ms ASC
    LIMIT 500
  `).all()
  return rows.map(approvalRowToRecord)
}

export function deleteApproval(db, approvalId) {
  const res = db.prepare(`DELETE FROM approvals WHERE approval_id=?`).run(approvalId)
  return res.changes > 0
}

export function upsertIdeSession(db, { ideId, machineId, cwd, port, basePath = null, createdMs = Date.now(), now = Date.now() }) {
  db.prepare(`
    INSERT INTO ide_sessions(ide_id, machine_id, cwd, port, base_path, created_ms, updated_ms)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ide_id) DO UPDATE SET
      machine_id=excluded.machine_id,
      cwd=excluded.cwd,
      port=excluded.port,
      base_path=excluded.base_path,
      updated_ms=excluded.updated_ms
  `).run(ideId, machineId, cwd, port, basePath, createdMs, now)
}

export function getIdeSession(db, ideId) {
  const row = db.prepare(`
    SELECT ide_id, machine_id, cwd, port, base_path, created_ms, updated_ms
    FROM ide_sessions
    WHERE ide_id=?
  `).get(ideId)
  return ideSessionRowToRecord(row)
}

export function listIdeSessions(db) {
  const rows = db.prepare(`
    SELECT ide_id, machine_id, cwd, port, base_path, created_ms, updated_ms
    FROM ide_sessions
    ORDER BY updated_ms DESC
    LIMIT 200
  `).all()
  return rows.map(ideSessionRowToRecord)
}

export function deleteIdeSession(db, ideId) {
  const res = db.prepare(`DELETE FROM ide_sessions WHERE ide_id=?`).run(ideId)
  return res.changes > 0
}

export function upsertUpload(db, { uploadId, sessionId, filename, mimeType, sizeBytes, hostPath, runnerPath, now = Date.now() }) {
  db.prepare(`
    INSERT INTO uploads(
      upload_id,
      session_id,
      filename,
      mime_type,
      size_bytes,
      host_path,
      runner_path,
      created_ms,
      updated_ms
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(upload_id) DO UPDATE SET
      filename=excluded.filename,
      mime_type=excluded.mime_type,
      size_bytes=excluded.size_bytes,
      host_path=excluded.host_path,
      runner_path=excluded.runner_path,
      updated_ms=excluded.updated_ms
  `).run(uploadId, sessionId, filename, mimeType, sizeBytes, hostPath, runnerPath, now, now)
}

export function getUpload(db, { sessionId, uploadId }) {
  const row = db.prepare(`
    SELECT upload_id, session_id, filename, mime_type, size_bytes, host_path, runner_path, created_ms, updated_ms
    FROM uploads
    WHERE upload_id=? AND session_id=?
  `).get(uploadId, sessionId)
  return uploadRowToRecord(row)
}

export function listSessionUploads(db, sessionId) {
  const rows = db.prepare(`
    SELECT upload_id, filename, mime_type, size_bytes, host_path, runner_path, created_ms, updated_ms
    FROM uploads
    WHERE session_id=?
    ORDER BY created_ms DESC
    LIMIT 500
  `).all(sessionId)
  return rows.map((row) => uploadRowToRecord(row, sessionId))
}

export function deleteUpload(db, { sessionId, uploadId }) {
  const res = db.prepare(`
    DELETE FROM uploads
    WHERE upload_id=? AND session_id=?
  `).run(uploadId, sessionId)
  return res.changes > 0
}

export function upsertPushSubscription(db, { endpoint, p256dh, auth, now = Date.now() }) {
  db.prepare(`
    INSERT INTO push_subscriptions(endpoint, p256dh, auth, created_ms, updated_ms)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh=excluded.p256dh,
      auth=excluded.auth,
      updated_ms=excluded.updated_ms
  `).run(endpoint, p256dh, auth, now, now)
}

export function deletePushSubscription(db, endpoint) {
  const res = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).run(endpoint)
  return res.changes > 0
}

export function listPushSubscriptions(db) {
  const rows = db.prepare(`
    SELECT endpoint, p256dh, auth, created_ms, updated_ms
    FROM push_subscriptions
    ORDER BY updated_ms DESC
    LIMIT 2000
  `).all()
  return rows.map(pushSubscriptionRowToRecord)
}
