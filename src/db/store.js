import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import crypto from 'node:crypto'

import { CREATE_SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

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
    return rows.map((r) => ({
      machineId: r.machine_id,
      machineName: r.machine_name,
      platform: r.platform,
      lastSeenMs: r.last_seen_ms,
      capabilities: r.capabilities_json ? JSON.parse(r.capabilities_json) : null
    }))
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
    if (!row) return null
    return {
      machineId: row.machine_id,
      machineName: row.machine_name,
      platform: row.platform,
      lastSeenMs: row.last_seen_ms,
      capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : null
    }
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
    const model = (typeof options?.model === 'string' && options.model.trim()) ? options.model.trim() : null
    const reasoningEffort = (typeof options?.reasoningEffort === 'string' && options.reasoningEffort.trim())
      ? options.reasoningEffort.trim()
      : null
    const approvalPolicy = (typeof options?.approvalPolicy === 'string' && options.approvalPolicy.trim())
      ? options.approvalPolicy.trim()
      : null
    const sandboxMode = (typeof options?.sandbox === 'string' && options.sandbox.trim()) ? options.sandbox.trim() : null
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
    `).run(sessionId, machineId, cwd, null, null, null, status, 'idle', 0, 0, 0, now, now, codexThreadId, model, reasoningEffort, approvalPolicy, sandboxMode, null)
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

    const sets = []
    const params = []

    if (status !== undefined) { sets.push('status=?'); params.push(status) }
    if (codexThreadId !== undefined) { sets.push('codex_thread_id=?'); params.push(codexThreadId) }
    if (projectLabel !== undefined) { sets.push('project_label=?'); params.push(projectLabel) }
    if (title !== undefined) { sets.push('title=?'); params.push(title) }
    if (preview !== undefined) { sets.push('preview=?'); params.push(preview) }
    if (turnState !== undefined) { sets.push('turn_state=?'); params.push(turnState) }
    if (pendingApprovals !== undefined) { sets.push('pending_approvals=?'); params.push(pendingApprovals) }
    if (lastReadSeq !== undefined) { sets.push('last_read_seq=?'); params.push(lastReadSeq) }
    if (model !== undefined) { sets.push('model=?'); params.push(model) }
    if (reasoningEffort !== undefined) { sets.push('reasoning_effort=?'); params.push(reasoningEffort) }
    if (approvalPolicy !== undefined) { sets.push('approval_policy=?'); params.push(approvalPolicy) }
    if (sandbox !== undefined) { sets.push('sandbox_mode=?'); params.push(sandbox) }

    sets.push('updated_ms=?')
    params.push(now)
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
    if (!row) return null
    return {
      sessionId: row.session_id,
      machineId: row.machine_id,
      cwd: row.cwd,
      projectLabel: row.project_label ?? null,
      title: row.title ?? null,
      preview: row.preview ?? null,
      status: row.status,
      turnState: row.turn_state,
      pendingApprovals: row.pending_approvals,
      lastSeq: row.last_seq,
      lastReadSeq: row.last_read_seq,
      createdMs: row.created_ms,
      updatedMs: row.updated_ms,
      codexThreadId: row.codex_thread_id ?? null,
      model: row.model ?? null,
      reasoningEffort: row.reasoning_effort ?? null,
      approvalPolicy: row.approval_policy ?? null,
      sandbox: row.sandbox_mode ?? null,
      archivedMs: row.archived_ms ?? null
    }
  }

  /**
   * @param {{ archived?: boolean|null }} [opts]
   */
  listSessions({ archived = false } = {}) {
    const clauses = []
    if (archived === true) clauses.push('archived_ms IS NOT NULL')
    else if (archived === false) clauses.push('archived_ms IS NULL')
    const rows = this.db.prepare(`
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
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_ms DESC
      LIMIT 200
    `).all()
    return rows.map((row) => ({
      sessionId: row.session_id,
      machineId: row.machine_id,
      cwd: row.cwd,
      projectLabel: row.project_label ?? null,
      title: row.title ?? null,
      preview: row.preview ?? null,
      status: row.status,
      turnState: row.turn_state,
      pendingApprovals: row.pending_approvals,
      lastSeq: row.last_seq,
      lastReadSeq: row.last_read_seq,
      createdMs: row.created_ms,
      updatedMs: row.updated_ms,
      codexThreadId: row.codex_thread_id ?? null,
      model: row.model ?? null,
      reasoningEffort: row.reasoning_effort ?? null,
      approvalPolicy: row.approval_policy ?? null,
      sandbox: row.sandbox_mode ?? null,
      archivedMs: row.archived_ms ?? null
    }))
  }

  /**
   * @param {string} machineId
   */
  listSessionIdsByMachine(machineId) {
    const rows = this.db.prepare(`
      SELECT session_id
      FROM sessions
      WHERE machine_id=?
    `).all(machineId)
    return rows.map((r) => r.session_id)
  }

  /**
   * Host paths for uploads belonging to sessions on a given machine.
   * (Useful for best-effort file cleanup before cascading deletes.)
   *
   * @param {string} machineId
   */
  listUploadHostPathsByMachine(machineId) {
    const rows = this.db.prepare(`
      SELECT u.host_path AS host_path
      FROM uploads u
      JOIN sessions s ON s.session_id = u.session_id
      WHERE s.machine_id=?
    `).all(machineId)
    return rows.map((r) => r.host_path)
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

    // Ensure `session.output.payload.seq` is monotonic/durable (host-controlled),
    // even if the runner restarts and its local seq counter resets.
    let payloadToStore = payload ?? null
    if (type === 'session.output' && payloadToStore && typeof payloadToStore === 'object') {
      const p = { ...payloadToStore }
      if (p.seq !== undefined && p.seq !== null && p.seq !== seq) {
        // Preserve runner-provided ordering info for debugging.
        p.runnerSeq = p.seq
      }
      p.seq = seq
      payloadToStore = p
    }

    const payloadJson = JSON.stringify(payloadToStore)
    const stream = (type === 'session.output' && typeof payloadToStore?.stream === 'string') ? payloadToStore.stream : null
    const itemId = (typeof payloadToStore?.itemId === 'string' && payloadToStore.itemId) ? payloadToStore.itemId : null

    const insertRes = this.db.prepare(`
      INSERT OR IGNORE INTO events(event_id, session_id, seq, ts_ms, type, stream, item_id, payload_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, sessionId, seq, tsMs, type, stream, itemId, payloadJson)

    // Duplicate event (same event_id). Don't double-apply derived state or bump updated_ms.
    if (insertRes.changes === 0) return null

    // Update derived session metadata used by the UI session list.
    const sets = ['updated_ms=?', 'last_seq=?']
    const params = [tsMs, seq]

    const textSnippet = (input) => {
      const t = String(input ?? '').replace(/\s+/g, ' ').trim()
      if (!t) return null
      return t.length > 160 ? `${t.slice(0, 157)}…` : t
    }

    if (type === 'session.input') {
      const text = textSnippet(payload?.text)
      if (text) {
        sets.push('preview=?')
        params.push(text)
      }
      if (payload?.isInitial && text) {
        sets.push(`title = CASE WHEN title IS NULL OR title='' THEN ? ELSE title END`)
        params.push(text)
      }
    }

    if (type === 'turn.started') {
      sets.push('turn_state=?')
      params.push('running')
    }

    if (type === 'turn.completed') {
      sets.push('turn_state=?')
      params.push('idle')
      const preview = textSnippet(payload?.preview)
      if (preview) {
        sets.push('preview=?')
        params.push(preview)
      }
    }

    if (type === 'approval.request') {
      sets.push('pending_approvals = pending_approvals + 1')
    }

    if (type === 'approval.resolved') {
      sets.push('pending_approvals = MAX(pending_approvals - 1, 0)')
    }

    if (type === 'session.status') {
      const status = payload?.status
      if (status && typeof status === 'string') {
        sets.push('status=?')
        params.push(status)
        if (status === 'stopping' || status === 'exited' || status === 'failed') {
          sets.push('turn_state=?')
          params.push('idle')
        }
      }
      const threadId = payload?.codexThreadId
      if (threadId && typeof threadId === 'string') {
        sets.push('codex_thread_id=?')
        params.push(threadId)
      }
    }

    try {
      this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id=?`).run(...params, sessionId)
    } catch {
      // best-effort
    }

    return seq
  }

  /**
   * Mark session as "read" by advancing last_read_seq to last_seq.
   * @param {string} sessionId
   */
  markSessionRead(sessionId) {
    const res = this.db.prepare(`
      UPDATE sessions
      SET last_read_seq=last_seq
      WHERE session_id=?
    `).run(sessionId)
    return res.changes > 0
  }

  /**
   * Set/clear a session's project label without changing its activity ordering (updated_ms).
   * @param {string} sessionId
   * @param {string|null} projectLabel
   */
  setSessionProjectLabel(sessionId, projectLabel) {
    const res = this.db.prepare(`
      UPDATE sessions
      SET project_label=?
      WHERE session_id=?
    `).run(projectLabel, sessionId)
    return res.changes > 0
  }

  /**
   * Set/clear a session's chat title without changing its activity ordering (updated_ms).
   * @param {string} sessionId
   * @param {string|null} title
   */
  setSessionTitle(sessionId, title) {
    const res = this.db.prepare(`
      UPDATE sessions
      SET title=?
      WHERE session_id=?
    `).run(title, sessionId)
    return res.changes > 0
  }

  /**
   * Archive a session (hides it from the default session list).
   * Does not change updated_ms.
   * @param {string} sessionId
   */
  archiveSession(sessionId) {
    const now = Date.now()
    const res = this.db.prepare(`
      UPDATE sessions
      SET archived_ms=?
      WHERE session_id=?
    `).run(now, sessionId)
    return res.changes > 0
  }

  /**
   * Un-archive a session.
   * Does not change updated_ms.
   * @param {string} sessionId
   */
  unarchiveSession(sessionId) {
    const res = this.db.prepare(`
      UPDATE sessions
      SET archived_ms=NULL
      WHERE session_id=?
    `).run(sessionId)
    return res.changes > 0
  }

  /**
   * Delete a session (cascades to events/approvals/uploads).
   * @param {string} sessionId
   */
  deleteSession(sessionId) {
    const res = this.db.prepare(`DELETE FROM sessions WHERE session_id=?`).run(sessionId)
    return res.changes > 0
  }

  /**
   * @param {string} sessionId
   * @param {{ limit?: number }} [opts]
   */
  listSessionEvents(sessionId, { limit = 500 } = {}) {
    const rows = this.db.prepare(`
      SELECT event_id, seq, ts_ms, type, payload_json
      FROM events
      WHERE session_id=?
      ORDER BY seq DESC
      LIMIT ?
    `).all(sessionId, limit)

    // Return oldest-first for easier playback.
    return rows.reverse().map((row) => ({
      eventId: row.event_id,
      seq: row.seq,
      tsMs: row.ts_ms,
      type: row.type,
      payload: JSON.parse(row.payload_json)
    }))
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
    const lim = Math.max(1, Math.min(2000, Number(limit) || 200))
    const params = [sessionId]
    const clauses = ['session_id=?']

    if (Number.isFinite(Number(beforeSeq)) && Number(beforeSeq) > 0) {
      clauses.push('seq < ?')
      params.push(Number(beforeSeq))
    }

    if (mode === 'summary') {
      // "Big events" view: keep assistant text (normalized) + reasoning, but drop tool stdout/stderr streams.
      // We still keep un-attributed stderr (item_id IS NULL) since it's often important for users to see.
      clauses.push(`(type != 'session.output' OR stream IN ('normalized','reasoning') OR ((stream = 'stderr' OR stream = 'stdout') AND item_id IS NULL))`)
    }

    const rows = this.db.prepare(`
      SELECT event_id, seq, ts_ms, type, payload_json
      FROM events
      WHERE ${clauses.join(' AND ')}
      ORDER BY seq DESC
      LIMIT ?
    `).all(...params, lim)

    const events = rows.reverse().map((row) => ({
      eventId: row.event_id,
      seq: row.seq,
      tsMs: row.ts_ms,
      type: row.type,
      payload: JSON.parse(row.payload_json)
    }))

    const oldestSeq = events.length ? Number(events[0].seq) : null
    let hasMoreBefore = false
    if (oldestSeq) {
      const params2 = [sessionId, oldestSeq]
      const clauses2 = ['session_id=?', 'seq < ?']
      if (mode === 'summary') {
        clauses2.push(`(type != 'session.output' OR stream IN ('normalized','reasoning') OR ((stream = 'stderr' OR stream = 'stdout') AND item_id IS NULL))`)
      }
      const row = this.db.prepare(`
        SELECT 1 AS ok
        FROM events
        WHERE ${clauses2.join(' AND ')}
        LIMIT 1
      `).get(...params2)
      hasMoreBefore = Boolean(row?.ok)
    }

    return { events, hasMoreBefore, oldestSeq }
  }

  /**
   * Paginated tool output by Codex item id.
   *
   * @param {string} sessionId
   * @param {string} itemId
   * @param {{ beforeSeq?: number|null, limit?: number }} [opts]
   */
  listItemOutputEvents(sessionId, itemId, { beforeSeq = null, limit = 500 } = {}) {
    const lim = Math.max(1, Math.min(5000, Number(limit) || 500))
    const params = [sessionId, itemId]
    const clauses = [`session_id=?`, `type='session.output'`, `item_id=?`]

    if (Number.isFinite(Number(beforeSeq)) && Number(beforeSeq) > 0) {
      clauses.push('seq < ?')
      params.push(Number(beforeSeq))
    }

    const rows = this.db.prepare(`
      SELECT event_id, seq, ts_ms, type, payload_json
      FROM events
      WHERE ${clauses.join(' AND ')}
      ORDER BY seq DESC
      LIMIT ?
    `).all(...params, lim)

    const events = rows.reverse().map((row) => ({
      eventId: row.event_id,
      seq: row.seq,
      tsMs: row.ts_ms,
      type: row.type,
      payload: JSON.parse(row.payload_json)
    }))

    const oldestSeq = events.length ? Number(events[0].seq) : null
    let hasMoreBefore = false
    if (oldestSeq) {
      const row = this.db.prepare(`
        SELECT 1 AS ok
        FROM events
        WHERE session_id=? AND type='session.output' AND item_id=? AND seq < ?
        LIMIT 1
      `).get(sessionId, itemId, oldestSeq)
      hasMoreBefore = Boolean(row?.ok)
    }

    return { events, hasMoreBefore, oldestSeq }
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
    const payloadJson = JSON.stringify(payload ?? null)
    this.db.prepare(`
      INSERT INTO approvals(approval_id, machine_id, session_id, kind, payload_json, created_ms)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET
        machine_id=excluded.machine_id,
        session_id=excluded.session_id,
        kind=excluded.kind,
        payload_json=excluded.payload_json
    `).run(approvalId, machineId, sessionId, kind, payloadJson, createdMs)
  }

  /**
   * @param {string} approvalId
   */
  getApproval(approvalId) {
    const row = this.db.prepare(`
      SELECT approval_id, machine_id, session_id, kind, payload_json, created_ms
      FROM approvals
      WHERE approval_id=?
    `).get(approvalId)
    if (!row) return null
    return {
      approvalId: row.approval_id,
      machineId: row.machine_id,
      sessionId: row.session_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      createdMs: row.created_ms
    }
  }

  listApprovals() {
    const rows = this.db.prepare(`
      SELECT approval_id, machine_id, session_id, kind, payload_json, created_ms
      FROM approvals
      ORDER BY created_ms ASC
      LIMIT 500
    `).all()
    return rows.map((row) => ({
      approvalId: row.approval_id,
      machineId: row.machine_id,
      sessionId: row.session_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      createdMs: row.created_ms
    }))
  }

  /**
   * @param {string} approvalId
   */
  deleteApproval(approvalId) {
    const res = this.db.prepare(`DELETE FROM approvals WHERE approval_id=?`).run(approvalId)
    return res.changes > 0
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
    const now = Date.now()
    this.db.prepare(`
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

  /**
   * @param {string} ideId
   */
  getIdeSession(ideId) {
    const row = this.db.prepare(`
      SELECT ide_id, machine_id, cwd, port, base_path, created_ms, updated_ms
      FROM ide_sessions
      WHERE ide_id=?
    `).get(ideId)
    if (!row) return null
    return {
      ideId: row.ide_id,
      machineId: row.machine_id,
      cwd: row.cwd,
      port: row.port,
      basePath: row.base_path ?? null,
      createdMs: row.created_ms,
      updatedMs: row.updated_ms
    }
  }

  listIdeSessions() {
    const rows = this.db.prepare(`
      SELECT ide_id, machine_id, cwd, port, base_path, created_ms, updated_ms
      FROM ide_sessions
      ORDER BY updated_ms DESC
      LIMIT 200
    `).all()
    return rows.map((row) => ({
      ideId: row.ide_id,
      machineId: row.machine_id,
      cwd: row.cwd,
      port: row.port,
      basePath: row.base_path ?? null,
      createdMs: row.created_ms,
      updatedMs: row.updated_ms
    }))
  }

  /**
   * @param {string} ideId
   */
  deleteIdeSession(ideId) {
    const res = this.db.prepare(`DELETE FROM ide_sessions WHERE ide_id=?`).run(ideId)
    return res.changes > 0
  }

  upsertUpload({ uploadId, sessionId, filename, mimeType, sizeBytes, hostPath, runnerPath }) {
    const now = Date.now()
    this.db.prepare(`
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

  /**
   * @param {{ sessionId: string, uploadId: string }} input
   */
  getUpload({ sessionId, uploadId }) {
    const row = this.db.prepare(`
      SELECT upload_id, session_id, filename, mime_type, size_bytes, host_path, runner_path, created_ms, updated_ms
      FROM uploads
      WHERE upload_id=? AND session_id=?
    `).get(uploadId, sessionId)
    if (!row) return null
    return {
      uploadId: row.upload_id,
      sessionId: row.session_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      hostPath: row.host_path,
      runnerPath: row.runner_path,
      createdMs: row.created_ms,
      updatedMs: row.updated_ms
    }
  }

  /**
   * @param {string} sessionId
   */
  listSessionUploads(sessionId) {
    const rows = this.db.prepare(`
      SELECT upload_id, filename, mime_type, size_bytes, host_path, runner_path, created_ms, updated_ms
      FROM uploads
      WHERE session_id=?
      ORDER BY created_ms DESC
      LIMIT 500
    `).all(sessionId)
    return rows.map((r) => ({
      uploadId: r.upload_id,
      sessionId,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      hostPath: r.host_path,
      runnerPath: r.runner_path,
      createdMs: r.created_ms,
      updatedMs: r.updated_ms
    }))
  }

  /**
   * @param {{ sessionId: string, uploadId: string }} input
   */
  deleteUpload({ sessionId, uploadId }) {
    const res = this.db.prepare(`
      DELETE FROM uploads
      WHERE upload_id=? AND session_id=?
    `).run(uploadId, sessionId)
    return res.changes > 0
  }

  /**
   * Best-effort retention pruning for Rootgrid-owned data (SQLite only).
   *
   * @param {{ cutoffMs: number }} input
   */
  pruneOldData({ cutoffMs }) {
    const oldSessionRows = this.db.prepare(`
      SELECT session_id, machine_id
      FROM sessions
      WHERE updated_ms < ?
    `).all(cutoffMs)

    const oldSessions = oldSessionRows.map((r) => r.session_id)
    const prunedSessions = oldSessionRows.map((r) => ({
      sessionId: r.session_id,
      machineId: r.machine_id
    }))

    const uploadHostPaths = []
    if (oldSessions.length) {
      const batchSize = 900
      for (let i = 0; i < oldSessions.length; i += batchSize) {
        const batch = oldSessions.slice(i, i + batchSize)
        const placeholders = batch.map(() => '?').join(',')
        const rows = this.db.prepare(`
          SELECT host_path
          FROM uploads
          WHERE session_id IN (${placeholders})
        `).all(...batch)
        for (const row of rows) {
          if (row?.host_path) uploadHostPaths.push(String(row.host_path))
        }
      }
    }

    const sessionsDeleted = this.db.prepare(`DELETE FROM sessions WHERE updated_ms < ?`).run(cutoffMs).changes
    const machinesDeleted = this.db.prepare(`
      DELETE FROM machines
      WHERE last_seen_ms < ?
        AND machine_id NOT IN (SELECT DISTINCT machine_id FROM sessions)
    `).run(cutoffMs).changes

    const ideSessionsDeleted = this.db.prepare(`DELETE FROM ide_sessions WHERE updated_ms < ?`).run(cutoffMs).changes

    return { sessionsDeleted, machinesDeleted, ideSessionsDeleted, uploadHostPaths, prunedSessions }
  }

  upsertPushSubscription({ endpoint, p256dh, auth }) {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO push_subscriptions(endpoint, p256dh, auth, created_ms, updated_ms)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh=excluded.p256dh,
        auth=excluded.auth,
        updated_ms=excluded.updated_ms
    `).run(endpoint, p256dh, auth, now, now)
  }

  deletePushSubscription(endpoint) {
    const res = this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).run(endpoint)
    return res.changes > 0
  }

  listPushSubscriptions() {
    const rows = this.db.prepare(`
      SELECT endpoint, p256dh, auth, created_ms, updated_ms
      FROM push_subscriptions
      ORDER BY updated_ms DESC
      LIMIT 2000
    `).all()
    return rows.map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      createdMs: r.created_ms,
      updatedMs: r.updated_ms
    }))
  }
}
