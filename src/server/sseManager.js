import { makeEnvelope } from './envelope.js'

export class SSEManager {
  #timer

  constructor({ heartbeatMs = 30_000, historySize = 5_000 } = {}) {
    this.heartbeatMs = heartbeatMs
    this.historySize = Math.max(0, Number(historySize) || 0)
    this.nextSseId = 0
    /** @type {Array<{ sseId: number, envelope: any }>} */
    this.history = []
    /** @type {Map<string, { res: import('node:http').ServerResponse, visibility: 'visible'|'hidden', all: boolean, sessionId: string|null, machineId: string|null, active: boolean }>} */
    this.clients = new Map()
    this.#timer = setInterval(() => this.#heartbeat(), heartbeatMs)
    this.#timer.unref?.()
  }

  /**
   * @param {{
   *   id: string,
   *   res: import('node:http').ServerResponse,
   *   visibility?: 'visible'|'hidden',
   *   all?: boolean,
   *   sessionId?: string|null,
   *   machineId?: string|null,
   *   active?: boolean
   * }} input
   */
  addClient({ id, res, visibility = 'visible', all = false, sessionId = null, machineId = null, active = true }) {
    this.clients.set(id, {
      res,
      visibility,
      all: Boolean(all),
      sessionId: (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : null,
      machineId: (typeof machineId === 'string' && machineId.trim()) ? machineId.trim() : null,
      active: Boolean(active)
    })
    res.on('close', () => {
      this.clients.delete(id)
    })
  }

  activateClient(id, { replayAfter = null } = {}) {
    const c = this.clients.get(id)
    if (!c) return false
    if (Number.isFinite(Number(replayAfter)) && Number(replayAfter) > 0) {
      this.#replayClient(id, c, Number(replayAfter))
    }
    c.active = true
    return true
  }

  earliestReplayId() {
    if (!this.history.length) return null
    return Number(this.history[0]?.sseId ?? 0) || null
  }

  canReplayFrom(sseId) {
    const cursor = Number(sseId ?? 0)
    if (!Number.isFinite(cursor) || cursor <= 0 || !this.history.length) return false
    const earliest = this.earliestReplayId()
    const latest = Number(this.history[this.history.length - 1]?.sseId ?? 0)
    if (!Number.isFinite(earliest) || !Number.isFinite(latest) || latest <= 0) return false
    return cursor >= (earliest - 1) && cursor <= latest
  }

  close() {
    if (this.#timer) {
      try { clearInterval(this.#timer) } catch { }
      this.#timer = null
    }
    for (const [id, c] of this.clients.entries()) {
      this.clients.delete(id)
      try { c.res.end() } catch { }
    }
  }

  sendDirect({ id = null, res, envelope, recordHistory = false } = {}) {
    if (!res || !envelope) return false
    const prepared = this.#prepareEnvelope(envelope, { recordHistory })
    if (!prepared) return false
    return this.#writeOrDrop(id ?? null, { res }, this.#formatData(prepared.sseId, prepared.envelope))
  }

  send(envelope, { recordHistory = true } = {}) {
    const prepared = this.#prepareEnvelope(envelope, { recordHistory })
    if (!prepared) return
    const data = this.#formatData(prepared.sseId, prepared.envelope)
    for (const [id, c] of this.clients.entries()) {
      if (!c.active) continue
      if (!this.#shouldSend(c, envelope)) continue
      try {
        this.#writeOrDrop(id, c, data)
      } catch {
        this.clients.delete(id)
      }
    }
  }

  /**
   * Send a toast-style notification to a subset of SSE connections based on
   * visibility and a global policy.
   *
   * @param {any} envelope
   * @param {{ policy: 'always'|'never'|'if-not-visible' }} opts
   */
  sendToast(envelope, { policy }) {
    if (policy === 'never') return 0
    const prepared = this.#prepareEnvelope(envelope, { recordHistory: true })
    if (!prepared) return 0
    const data = this.#formatData(prepared.sseId, prepared.envelope)
    let delivered = 0

    for (const [id, c] of this.clients.entries()) {
      if (!c.active) continue
      const visible = c.visibility === 'visible'
      const shouldSend = policy === 'always' || (policy === 'if-not-visible' && !visible)
      if (!shouldSend) continue
      try {
        if (this.#writeOrDrop(id, c, data)) delivered += 1
      } catch {
        this.clients.delete(id)
      }
    }

    return delivered
  }

  /**
   * @param {string} id
   * @param {'visible'|'hidden'} visibility
   */
  setVisibility(id, visibility) {
    const c = this.clients.get(id)
    if (!c) return false
    c.visibility = visibility
    return true
  }

  /**
   * Update which session's verbose events (e.g. `session.output`) should be
   * delivered to a connection. Registry + small lifecycle events are always
   * broadcast; this only affects session-scoped streaming output.
   *
   * @param {string} id
   * @param {string|null} sessionId
   */
  setSessionId(id, sessionId) {
    const c = this.clients.get(id)
    if (!c) return false
    c.sessionId = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : null
    return true
  }

  /**
   * @param {string} id
   * @param {string|null} machineId
   */
  setMachineId(id, machineId) {
    const c = this.clients.get(id)
    if (!c) return false
    c.machineId = (typeof machineId === 'string' && machineId.trim()) ? machineId.trim() : null
    return true
  }

  anyVisible() {
    for (const c of this.clients.values()) {
      if (c.visibility === 'visible') return true
    }
    return false
  }

  /**
   * Whether a given session is "visible" in any connected UI.
   * Used to decide whether to deliver Web Push under the `if-not-visible` policy.
   *
   * v0 heuristic:
   * - any visible connection with `sessionId === null` counts as "global view"
   *   (session list is visible) and suppresses push for all sessions.
   * - any visible connection with `all === true` suppresses push for all sessions.
   * - any visible connection with `sessionId === <sessionId>` suppresses push for that session.
   *
   * @param {string|null} sessionId
   */
  isSessionVisible(sessionId) {
    if (!sessionId) return this.anyVisible()
    for (const c of this.clients.values()) {
      if (c.visibility !== 'visible') continue
      if (c.all) return true
      if (c.sessionId === null) return true
      if (c.sessionId === sessionId) return true
    }
    return false
  }

  #shouldSend(client, envelope) {
    const type = envelope?.type
    if (typeof type !== 'string' || !type) return false

    // Registry events are always broadcast so the UI can keep its sidebar up to date.
    if (type.startsWith('registry.')) return true

    // Debug / power-user mode.
    if (client.all) return true

    // Always deliver important session-level lifecycle events across all sessions.
    // These are small and let the UI keep status/unread/approval counts up to date
    // without receiving every session.output delta.
    if (
      type === 'approval.request'
      || type === 'approval.resolved'
      || type === 'session.status'
      || type === 'session.input'
      || type === 'turn.started'
      || type === 'turn.completed'
    ) {
      return true
    }

    const sessionId = envelope?.scope?.sessionId ?? envelope?.payload?.sessionId ?? null
    if (sessionId && client.sessionId && sessionId === client.sessionId) return true

    const machineId = envelope?.scope?.machineId ?? envelope?.payload?.machineId ?? null
    if (machineId && client.machineId && machineId === client.machineId) return true

    if (type.startsWith('terminal.pty.')) {
      return Boolean(machineId && client.machineId && machineId === client.machineId)
    }

    return false
  }

  #heartbeat() {
    const hb = makeEnvelope({ type: 'heartbeat', payload: { ts: Date.now() } })
    const prepared = this.#prepareEnvelope(hb, { recordHistory: false })
    if (!prepared) return
    const data = this.#formatData(prepared.sseId, prepared.envelope)
    for (const [id, c] of this.clients.entries()) {
      if (!c.active) continue
      try {
        this.#writeOrDrop(id, c, data)
      } catch {
        this.clients.delete(id)
      }
    }
  }

  #prepareEnvelope(envelope, { recordHistory = true } = {}) {
    if (!envelope || typeof envelope !== 'object') return null
    let sseId = Number(envelope.sseId ?? 0)
    if (!Number.isFinite(sseId) || sseId <= 0) {
      this.nextSseId += 1
      sseId = this.nextSseId
      envelope.sseId = sseId
    } else if (sseId > this.nextSseId) {
      this.nextSseId = sseId
    }

    if (recordHistory) {
      this.history.push({ sseId, envelope })
      if (this.history.length > this.historySize) {
        this.history.splice(0, this.history.length - this.historySize)
      }
    }

    return { sseId, envelope }
  }

  #formatData(sseId, envelope) {
    return `id: ${String(sseId)}\ndata: ${JSON.stringify(envelope)}\n\n`
  }

  #replayClient(id, client, replayAfter) {
    for (const entry of this.history) {
      if (entry.sseId <= replayAfter) continue
      if (!this.#shouldReplay(client, entry.envelope)) continue
      try {
        const ok = this.#writeOrDrop(id, client, this.#formatData(entry.sseId, entry.envelope))
        if (!ok) return
      } catch {
        this.clients.delete(id)
        return
      }
    }
  }

  #shouldReplay(client, envelope) {
    if (envelope?.type === 'toast') return true
    return this.#shouldSend(client, envelope)
  }

  #writeOrDrop(id, client, data) {
    const ok = client.res.write(data)
    if (ok !== false) return true
    this.clients.delete(id)
    try { client.res.end() } catch { }
    return false
  }
}
