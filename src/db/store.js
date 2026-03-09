import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import crypto from 'node:crypto'

import { CREATE_SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'
import {
  machineRowToRecord,
  sessionRowToRecord
} from './storeRows.js'
import {
  listSessionsPage as listSessionsPageQuery
} from './storeSessionLists.js'
import {
  getTurnReasoningSections as getTurnReasoningSectionsQuery,
  getTurnReasoningText as getTurnReasoningTextQuery,
  getTurnSeqRange as getTurnSeqRangeQuery,
  listItemOutputEvents as listItemOutputEventsQuery,
  listSessionEvents as listSessionEventsQuery,
  listSessionEventsAfter as listSessionEventsAfterQuery,
  listSessionEventsPage as listSessionEventsPageQuery,
  listTurnsWithReasoning as listTurnsWithReasoningQuery
} from './storeEvents.js'
import {
  buildCreateSessionRow,
  buildDerivedSessionEventUpdate,
  buildUpdateSessionStatement,
  normalizeStoredEventPayload
} from './storeSessionWrites.js'
import {
  archiveSession as archiveSessionRow,
  deleteSession as deleteSessionRow,
  markSessionRead as markSessionReadRow,
  setSessionProjectLabel as setSessionProjectLabelRow,
  setSessionTitle as setSessionTitleRow,
  unarchiveSession as unarchiveSessionRow
} from './storeSessionMeta.js'
import {
  listSessionIdsByMachine as listSessionIdsByMachineQuery,
  listUploadHostPathsByMachine as listUploadHostPathsByMachineQuery,
  pruneOldData as pruneOldDataQuery
} from './storeMaintenance.js'
import {
  deleteApproval as deleteApprovalRow,
  deleteIdeSession as deleteIdeSessionRow,
  deletePushSubscription as deletePushSubscriptionRow,
  deleteQueuedPrompt as deleteQueuedPromptRow,
  deleteUpload as deleteUploadRow,
  getApproval as getApprovalRow,
  getIdeSession as getIdeSessionRow,
  getQueuedPrompt as getQueuedPromptRow,
  getUpload as getUploadRow,
  listApprovals as listApprovalsRows,
  listIdeSessions as listIdeSessionsRows,
  listPushSubscriptions as listPushSubscriptionsRows,
  listQueuedPrompts as listQueuedPromptsRows,
  listSessionUploads as listSessionUploadsRows,
  upsertApproval as upsertApprovalRow,
  upsertIdeSession as upsertIdeSessionRow,
  upsertPushSubscription as upsertPushSubscriptionRow,
  upsertQueuedPrompt as upsertQueuedPromptRow,
  upsertUpload as upsertUploadRow
} from './storeSideTables.js'

export class Store {
  /**
   * @param {{ dbPath: string }} opts
   */
  constructor({ dbPath }) {
    this.dbPath = dbPath

    if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
      const dir = dirname(dbPath)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { }

      // Best-effort: ensure the DB file exists early (avoid surprises on first open)
      // and keep permissions tight.
      try {
        const fd = openSync(dbPath, 'a', 0o600) // creates if missing (respects umask)
        closeSync(fd)
        try { chmodSync(dbPath, 0o600) } catch { }
      } catch {
      }
    }

    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')

    this.#initSchema()

    if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try { chmodSync(path, 0o600) } catch { }
      }
    }
  }

  #initSchema() {
    const current = this.db.prepare('PRAGMA user_version').get()['user_version']
    if (current === 0) {
      this.db.exec(CREATE_SCHEMA_SQL)
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return
    }

    if (current > SCHEMA_VERSION) {
      throw new Error(`DB schema mismatch: have ${current}, expected ${SCHEMA_VERSION}`)
    }

    if (current < SCHEMA_VERSION) {
      this.#migrateSchema(current, SCHEMA_VERSION)
    }
  }

  #migrateSchema(fromVersion, toVersion) {
    let v = fromVersion
    while (v < toVersion) {
      if (v === 1) {
        // v1 -> v2: session list polish (project labels, titles/previews, unread/turn/approval state)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN project_label TEXT`)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN preview TEXT`)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN turn_state TEXT NOT NULL DEFAULT 'idle'`)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN pending_approvals INTEGER NOT NULL DEFAULT 0`)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0`)
        this.db.exec(`ALTER TABLE sessions ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0`)

        // Backfill last_seq based on events.
        const rows = this.db.prepare(`
          SELECT session_id, COALESCE(MAX(seq), 0) AS max_seq
          FROM events
          GROUP BY session_id
        `).all()
        const update = this.db.prepare(`UPDATE sessions SET last_seq=?, last_read_seq=? WHERE session_id=?`)
        for (const row of rows) {
          const maxSeq = Number(row.max_seq) || 0
          update.run(maxSeq, maxSeq, row.session_id)
        }

        v = 2
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 2) {
        // v2 -> v3: persist pending approvals + IDE sessions (VS Code web viewer).
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS approvals (
            approval_id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_ms INTEGER NOT NULL,
            FOREIGN KEY(machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE,
            FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS approvals_by_session ON approvals(session_id, created_ms);

          CREATE TABLE IF NOT EXISTS ide_sessions (
            ide_id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            port INTEGER NOT NULL,
            base_path TEXT,
            created_ms INTEGER NOT NULL,
            updated_ms INTEGER NOT NULL,
            FOREIGN KEY(machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS ide_sessions_by_machine ON ide_sessions(machine_id, updated_ms);
        `)

        v = 3
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 3) {
        // v3 -> v4: Web Push subscriptions + event metadata columns for filtering.
        try { this.db.exec(`ALTER TABLE events ADD COLUMN stream TEXT`) } catch { }
        try { this.db.exec(`ALTER TABLE events ADD COLUMN item_id TEXT`) } catch { }

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS events_by_session_item ON events(session_id, item_id, seq);
          CREATE INDEX IF NOT EXISTS events_by_session_type_stream ON events(session_id, type, stream, seq);

          -- Best-effort backfill for existing rows (SQLite JSON1).
          UPDATE events
          SET stream = json_extract(payload_json, '$.stream')
          WHERE type='session.output' AND stream IS NULL;

          UPDATE events
          SET item_id = json_extract(payload_json, '$.itemId')
          WHERE item_id IS NULL;

          CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_ms INTEGER NOT NULL,
            updated_ms INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS push_subscriptions_by_updated ON push_subscriptions(updated_ms);
        `)

        v = 4
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 4) {
        // v4 -> v5: persist per-session Codex options (model/approvalPolicy/sandbox).
        try { this.db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`) } catch { }
        try { this.db.exec(`ALTER TABLE sessions ADD COLUMN approval_policy TEXT`) } catch { }
        try { this.db.exec(`ALTER TABLE sessions ADD COLUMN sandbox_mode TEXT`) } catch { }

        v = 5
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 5) {
        // v5 -> v6: session archiving + uploads table.
        try { this.db.exec(`ALTER TABLE sessions ADD COLUMN archived_ms INTEGER`) } catch { }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS uploads (
            upload_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            host_path TEXT NOT NULL,
            runner_path TEXT NOT NULL,
            created_ms INTEGER NOT NULL,
            updated_ms INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS uploads_by_session ON uploads(session_id, created_ms);
        `)

        v = 6
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 6) {
        // v6 -> v7: persist per-session reasoning effort.
        try { this.db.exec(`ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT`) } catch { }

        v = 7
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 7) {
        // v7 -> v8: add indexes for hot list queries.
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS sessions_by_archived_updated ON sessions(archived_ms, updated_ms DESC);
          CREATE INDEX IF NOT EXISTS approvals_by_created ON approvals(created_ms);
        `)

        v = 8
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      if (v === 8) {
        // v8 -> v9: persisted queued follow-up prompts.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS queued_prompts (
            prompt_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            text TEXT NOT NULL,
            attachments_json TEXT NOT NULL,
            created_ms INTEGER NOT NULL,
            updated_ms INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS queued_prompts_by_session ON queued_prompts(session_id, created_ms);
        `)

        v = 9
        this.db.exec(`PRAGMA user_version = ${v}`)
        continue
      }

      throw new Error(`No migration available: ${v} -> ${v + 1}`)
    }
  }

  upsertMachine({ machineId, machineName, platform, capabilities }) {
    const now = Date.now()
    const capabilitiesJson = capabilities ? JSON.stringify(capabilities) : null
    this.db.prepare(`
      INSERT INTO machines(machine_id, machine_name, platform, last_seen_ms, capabilities_json)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        machine_name=excluded.machine_name,
        platform=excluded.platform,
        last_seen_ms=excluded.last_seen_ms,
        capabilities_json=excluded.capabilities_json
    `).run(machineId, machineName, platform, now, capabilitiesJson)
  }

  updateMachineLastSeen(machineId) {
    const now = Date.now()
    this.db.prepare(`UPDATE machines SET last_seen_ms=? WHERE machine_id=?`).run(now, machineId)
  }

  listMachines() {
    const rows = this.db.prepare(`
      SELECT machine_id, machine_name, platform, last_seen_ms, capabilities_json
      FROM machines
      ORDER BY machine_name ASC
    `).all()
    return rows.map(machineRowToRecord)
  }

  /**
   * @param {string} machineId
   */
  getMachine(machineId) {
    const row = this.db.prepare(`
      SELECT machine_id, machine_name, platform, last_seen_ms, capabilities_json
      FROM machines
      WHERE machine_id=?
    `).get(machineId)
    return machineRowToRecord(row)
  }

  /**
   * Delete a machine (cascades to sessions/events/approvals/uploads).
   * @param {string} machineId
   */
  deleteMachine(machineId) {
    const res = this.db.prepare(`DELETE FROM machines WHERE machine_id=?`).run(machineId)
    return res.changes > 0
  }

  /**
   * @param {{
   *   sessionId: string,
   *   machineId: string,
   *   cwd: string,
   *   status: string,
   *   codexThreadId?: string|null,
   *   options?: { model?: string, reasoningEffort?: string, approvalPolicy?: string, sandbox?: string }|null
   * }} input
   */
  createSession({ sessionId, machineId, cwd, status, codexThreadId = null, options = null }) {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sessions(
        session_id,
        machine_id,
        cwd,
        project_label,
        title,
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
        approval_policy,
        sandbox_mode,
        archived_ms
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...buildCreateSessionRow({
      sessionId,
      machineId,
      cwd,
      status,
      codexThreadId,
      options,
      now
    }))
  }

  /**
   * @param {{
   *   sessionId: string,
   *   status?: string,
   *   codexThreadId?: string|null,
   *   projectLabel?: string|null,
   *   title?: string|null,
   *   preview?: string|null,
   *   turnState?: 'idle'|'running',
   *   pendingApprovals?: number,
   *   lastReadSeq?: number,
   *   model?: string|null,
   *   reasoningEffort?: string|null,
   *   approvalPolicy?: string|null,
   *   sandbox?: string|null
   * }} input
   */
  updateSession({
    sessionId,
    status,
    codexThreadId,
    projectLabel,
    title,
    preview,
    turnState,
    pendingApprovals,
    lastReadSeq,
    model,
    reasoningEffort,
    approvalPolicy,
    sandbox
  }) {
    const now = Date.now()
    const { sets, params } = buildUpdateSessionStatement({
      status,
      codexThreadId,
      projectLabel,
      title,
      preview,
      turnState,
      pendingApprovals,
      lastReadSeq,
      model,
      reasoningEffort,
      approvalPolicy,
      sandbox,
      now
    })
    params.push(sessionId)

    const stmt = this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id=?`)
    const res = stmt.run(...params)
    return res.changes > 0
  }

  /**
   * @param {string} sessionId
   */
  getSession(sessionId) {
    const row = this.db.prepare(`
      SELECT
        session_id,
        machine_id,
        cwd,
        project_label,
        title,
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
        approval_policy,
        sandbox_mode,
        archived_ms
      FROM sessions
      WHERE session_id=?
    `).get(sessionId)
    return sessionRowToRecord(row)
  }

  /**
   * @param {{ archived?: boolean|null }} [opts]
   */
  listSessions({ archived = false } = {}) {
    return this.listSessionsPage({ archived, limit: 200 }).sessions
  }

  /**
   * Cursor-paginated session listing for large registries.
   *
   * @param {{
   *   archived?: boolean|null,
   *   beforeUpdatedMs?: number|null,
   *   beforeSessionId?: string|null,
   *   limit?: number
   * }} [opts]
   */
  listSessionsPage({ archived = false, beforeUpdatedMs = null, beforeSessionId = null, limit = 200 } = {}) {
    return listSessionsPageQuery(this.db, {
      archived,
      beforeUpdatedMs,
      beforeSessionId,
      limit
    })
  }

  /**
   * @param {string} machineId
   */
  listSessionIdsByMachine(machineId) {
    return listSessionIdsByMachineQuery(this.db, machineId)
  }

  /**
   * Host paths for uploads belonging to sessions on a given machine.
   * (Useful for best-effort file cleanup before cascading deletes.)
   *
   * @param {string} machineId
   */
  listUploadHostPathsByMachine(machineId) {
    return listUploadHostPathsByMachineQuery(this.db, machineId)
  }

  /**
   * Host-only helper for durable, ordered per-session event storage.
   *
   * @param {{
   *   eventId?: string,
   *   sessionId: string,
   *   tsMs: number,
   *   type: string,
   *   payload: any
   * }} input
   */
  appendEvent({ eventId = crypto.randomUUID(), sessionId, tsMs, type, payload }) {
    const srow = this.db.prepare(`SELECT last_seq FROM sessions WHERE session_id=?`).get(sessionId)
    const lastSeq = srow ? (Number(srow.last_seq) || 0) : 0
    const seq = lastSeq + 1
    const stored = normalizeStoredEventPayload({ type, payload, seq })

    const insertRes = this.db.prepare(`
      INSERT OR IGNORE INTO events(event_id, session_id, seq, ts_ms, type, stream, item_id, payload_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, sessionId, seq, tsMs, type, stored.stream, stored.itemId, stored.payloadJson)

    // Duplicate event (same event_id). Don't double-apply derived state or bump updated_ms.
    if (insertRes.changes === 0) return null

    const { sets, params } = buildDerivedSessionEventUpdate({
      type,
      payload: stored.payload,
      tsMs,
      seq
    })

    try {
      this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id=?`).run(...params, sessionId)
    } catch {
      // best-effort
    }

    return seq
  }

  /**
   * Persist multiple events in a single transaction.
   * Intended for hot runner output bursts.
   *
   * @param {Array<{
   *   eventId?: string,
   *   sessionId: string,
   *   tsMs: number,
   *   type: string,
   *   payload: any
   * }>} events
   */
  appendEventsBatch(events) {
    const list = Array.isArray(events) ? events : []
    if (!list.length) return []

    const selectSessionStmt = this.db.prepare(`SELECT last_seq FROM sessions WHERE session_id=?`)
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO events(event_id, session_id, seq, ts_ms, type, stream, item_id, payload_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updateOutputSessionStmt = this.db.prepare(`
      UPDATE sessions
      SET updated_ms=?, last_seq=?
      WHERE session_id=?
    `)
    const updateStmtCache = new Map()
    const results = new Array(list.length)

    const getUpdateStmt = (sets) => {
      const sql = `UPDATE sessions SET ${sets.join(', ')} WHERE session_id=?`
      let stmt = updateStmtCache.get(sql)
      if (!stmt) {
        stmt = this.db.prepare(sql)
        updateStmtCache.set(sql, stmt)
      }
      return stmt
    }

    const lastSeqBySession = new Map()
    const pendingOutputBySession = new Map()

    const flushPendingOutput = (sessionId) => {
      const pending = pendingOutputBySession.get(sessionId)
      if (!pending) return
      updateOutputSessionStmt.run(pending.tsMs, pending.seq, sessionId)
      pendingOutputBySession.delete(sessionId)
    }

    this.db.exec('BEGIN')
    try {
      for (let i = 0; i < list.length; i++) {
        const input = list[i] ?? {}
        const sid = String(input.sessionId ?? '').trim()
        if (!sid) {
          results[i] = { inserted: false, seq: null, payload: input.payload ?? null }
          continue
        }

        let lastSeq = lastSeqBySession.get(sid)
        if (lastSeq === undefined) {
          const srow = selectSessionStmt.get(sid)
          if (!srow) {
            results[i] = { inserted: false, seq: null, payload: input.payload ?? null }
            continue
          }
          lastSeq = Number(srow.last_seq) || 0
          lastSeqBySession.set(sid, lastSeq)
        }

        const seq = Number(lastSeq) + 1
        const stored = normalizeStoredEventPayload({
          type: input.type,
          payload: input.payload,
          seq
        })

        const insertRes = insertStmt.run(
          input.eventId ?? crypto.randomUUID(),
          sid,
          seq,
          input.tsMs,
          input.type,
          stored.stream,
          stored.itemId,
          stored.payloadJson
        )

        if (insertRes.changes === 0) {
          results[i] = { inserted: false, seq: null, payload: stored.payload }
          continue
        }

        lastSeqBySession.set(sid, seq)
        if (input.type === 'session.output') {
          pendingOutputBySession.set(sid, {
            seq,
            tsMs: input.tsMs
          })
        } else {
          flushPendingOutput(sid)
          const { sets, params } = buildDerivedSessionEventUpdate({
            type: input.type,
            payload: stored.payload,
            tsMs: input.tsMs,
            seq
          })
          getUpdateStmt(sets).run(...params, sid)
        }

        results[i] = {
          inserted: true,
          seq,
          payload: stored.payload
        }
      }

      for (const sessionId of pendingOutputBySession.keys()) {
        flushPendingOutput(sessionId)
      }

      this.db.exec('COMMIT')
      return results
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { }
      throw err
    }
  }

  /**
   * Mark session as "read" by advancing last_read_seq to last_seq.
   * @param {string} sessionId
   */
  markSessionRead(sessionId) {
    return markSessionReadRow(this.db, sessionId)
  }

  /**
   * Set/clear a session's project label without changing its activity ordering (updated_ms).
   * @param {string} sessionId
   * @param {string|null} projectLabel
   */
  setSessionProjectLabel(sessionId, projectLabel) {
    return setSessionProjectLabelRow(this.db, sessionId, projectLabel)
  }

  /**
   * Set/clear a session's chat title without changing its activity ordering (updated_ms).
   * @param {string} sessionId
   * @param {string|null} title
   */
  setSessionTitle(sessionId, title) {
    return setSessionTitleRow(this.db, sessionId, title)
  }

  /**
   * Archive a session (hides it from the default session list).
   * Does not change updated_ms.
   * @param {string} sessionId
   */
  archiveSession(sessionId) {
    return archiveSessionRow(this.db, sessionId)
  }

  /**
   * Un-archive a session.
   * Does not change updated_ms.
   * @param {string} sessionId
   */
  unarchiveSession(sessionId) {
    return unarchiveSessionRow(this.db, sessionId)
  }

  /**
   * Delete a session (cascades to events/approvals/uploads).
   * @param {string} sessionId
   */
  deleteSession(sessionId) {
    return deleteSessionRow(this.db, sessionId)
  }

  /**
   * @param {string} sessionId
   * @param {{ limit?: number }} [opts]
   */
  listSessionEvents(sessionId, { limit = 500 } = {}) {
    return listSessionEventsQuery(this.db, sessionId, { limit })
  }

  /**
   * Paginated event listing for history scaling.
   *
   * @param {string} sessionId
   * @param {{
   *   beforeSeq?: number|null,
   *   limit?: number,
   *   mode?: 'summary'|'full'
   * }} [opts]
   */
  listSessionEventsPage(sessionId, { beforeSeq = null, limit = 200, mode = 'summary' } = {}) {
    return listSessionEventsPageQuery(this.db, sessionId, { beforeSeq, limit, mode })
  }

  /**
   * Forward-paginated event listing for reconnect/backfill flows.
   *
   * @param {string} sessionId
   * @param {{
   *   afterSeq?: number|null,
   *   limit?: number,
   *   mode?: 'summary'|'full'
   * }} [opts]
   */
  listSessionEventsAfter(sessionId, { afterSeq = null, limit = 200, mode = 'summary' } = {}) {
    return listSessionEventsAfterQuery(this.db, sessionId, { afterSeq, limit, mode })
  }

  /**
   * Paginated tool output by Codex item id.
   *
   * @param {string} sessionId
   * @param {string} itemId
   * @param {{ beforeSeq?: number|null, limit?: number }} [opts]
   */
  listItemOutputEvents(sessionId, itemId, { beforeSeq = null, limit = 500 } = {}) {
    return listItemOutputEventsQuery(this.db, sessionId, itemId, { beforeSeq, limit })
  }

  /**
   * Return turn ids that have persisted reasoning output.
   *
   * @param {string} sessionId
   * @param {string[]} turnIds
   */
  listTurnsWithReasoning(sessionId, turnIds) {
    const session = this.getSession(sessionId)
    return listTurnsWithReasoningQuery(this.db, {
      sessionId,
      turnIds,
      lastSeq: session ? Number(session.lastSeq) || null : null
    })
  }

  /**
   * Resolve a turn's seq range so clients can fetch turn-scoped details on demand
   * (e.g. reasoning text).
   *
   * @param {string} sessionId
   * @param {string} turnId
   * @returns {{ startSeq: number, endSeq: number|null }|null}
   */
  getTurnSeqRange(sessionId, turnId) {
    return getTurnSeqRangeQuery(this.db, sessionId, turnId)
  }

  /**
   * Fetch reasoning markdown text for a single turn.
   *
   * @param {string} sessionId
   * @param {string} turnId
   * @param {{ maxChars?: number }} [opts]
   */
  getTurnReasoningText(sessionId, turnId, { maxChars = 400_000 } = {}) {
    const session = this.getSession(sessionId)
    return getTurnReasoningTextQuery(this.db, {
      sessionId,
      turnId,
      lastSeq: session ? Number(session.lastSeq) || null : null,
      maxChars
    })
  }

  /**
   * Fetch reasoning markdown sections for a single turn, with a best-effort
   * ordering key (`startSeq`) so UIs can interleave them with tool calls.
   *
   * @param {string} sessionId
   * @param {string} turnId
   * @param {{ maxChars?: number, includeBody?: boolean }} [opts]
   */
  getTurnReasoningSections(sessionId, turnId, { maxChars = 400_000, includeBody = true } = {}) {
    const session = this.getSession(sessionId)
    return getTurnReasoningSectionsQuery(this.db, {
      sessionId,
      turnId,
      lastSeq: session ? Number(session.lastSeq) || null : null,
      maxChars,
      includeBody
    })
  }

  /**
   * Persist a pending approval request (so UI can recover after refresh/restart).
   *
   * @param {{
   *   approvalId: string,
   *   machineId: string,
   *   sessionId: string,
   *   kind: string,
   *   payload: any,
   *   createdMs?: number
   * }} input
   */
  upsertApproval({ approvalId, machineId, sessionId, kind, payload, createdMs = Date.now() }) {
    upsertApprovalRow(this.db, { approvalId, machineId, sessionId, kind, payload, createdMs })
  }

  /**
   * @param {string} approvalId
   */
  getApproval(approvalId) {
    return getApprovalRow(this.db, approvalId)
  }

  listApprovals() {
    return listApprovalsRows(this.db)
  }

  /**
   * @param {string} approvalId
   */
  deleteApproval(approvalId) {
    return deleteApprovalRow(this.db, approvalId)
  }

  /**
   * @param {{
   *   ideId: string,
   *   machineId: string,
   *   cwd: string,
   *   port: number,
   *   basePath?: string|null,
   *   createdMs?: number,
   * }} input
   */
  upsertIdeSession({ ideId, machineId, cwd, port, basePath = null, createdMs = Date.now() }) {
    upsertIdeSessionRow(this.db, { ideId, machineId, cwd, port, basePath, createdMs })
  }

  /**
   * @param {string} ideId
   */
  getIdeSession(ideId) {
    return getIdeSessionRow(this.db, ideId)
  }

  listIdeSessions() {
    return listIdeSessionsRows(this.db)
  }

  /**
   * @param {string} ideId
   */
  deleteIdeSession(ideId) {
    return deleteIdeSessionRow(this.db, ideId)
  }

  upsertUpload({ uploadId, sessionId, filename, mimeType, sizeBytes, hostPath, runnerPath }) {
    upsertUploadRow(this.db, { uploadId, sessionId, filename, mimeType, sizeBytes, hostPath, runnerPath })
  }

  /**
   * @param {{ sessionId: string, uploadId: string }} input
   */
  getUpload({ sessionId, uploadId }) {
    return getUploadRow(this.db, { sessionId, uploadId })
  }

  /**
   * @param {string} sessionId
   */
  listSessionUploads(sessionId) {
    return listSessionUploadsRows(this.db, sessionId)
  }

  /**
   * @param {{ sessionId: string, uploadId: string }} input
   */
  deleteUpload({ sessionId, uploadId }) {
    return deleteUploadRow(this.db, { sessionId, uploadId })
  }

  upsertQueuedPrompt({ promptId, sessionId, text = '', attachmentIds = [], createdMs = Date.now() }) {
    upsertQueuedPromptRow(this.db, { promptId, sessionId, text, attachmentIds, createdMs })
  }

  /**
   * @param {{ sessionId: string, promptId: string }} input
   */
  getQueuedPrompt({ sessionId, promptId }) {
    return getQueuedPromptRow(this.db, { sessionId, promptId })
  }

  /**
   * @param {string} sessionId
   */
  listQueuedPrompts(sessionId) {
    return listQueuedPromptsRows(this.db, sessionId)
  }

  /**
   * @param {{ sessionId: string, promptId: string }} input
   */
  deleteQueuedPrompt({ sessionId, promptId }) {
    return deleteQueuedPromptRow(this.db, { sessionId, promptId })
  }

  /**
   * Best-effort retention pruning for Rootgrid-owned data (SQLite only).
   *
   * @param {{ cutoffMs: number }} input
   */
  pruneOldData({ cutoffMs }) {
    return pruneOldDataQuery(this.db, { cutoffMs })
  }

  upsertPushSubscription({ endpoint, p256dh, auth }) {
    upsertPushSubscriptionRow(this.db, { endpoint, p256dh, auth })
  }

  deletePushSubscription(endpoint) {
    return deletePushSubscriptionRow(this.db, endpoint)
  }

  listPushSubscriptions() {
    return listPushSubscriptionsRows(this.db)
  }
}
