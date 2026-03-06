import { makeEnvelope } from './envelope.js'

export class SSEManager {
  #timer

  constructor({ heartbeatMs = 30_000 } = {}) {
    this.heartbeatMs = heartbeatMs
    /** @type {Map<string, { res: import('node:http').ServerResponse, visibility: 'visible'|'hidden', all: boolean, sessionId: string|null, machineId: string|null }>} */
    this.clients = new Map()
    this.#timer = setInterval(() => this.#heartbeat(), heartbeatMs).unref?.()
  }

  /**
   * @param {{
   *   id: string,
   *   res: import('node:http').ServerResponse,
   *   visibility?: 'visible'|'hidden',
   *   all?: boolean,
   *   sessionId?: string|null,
   *   machineId?: string|null
   * }} input
   */
  addClient({ id, res, visibility = 'visible', all = false, sessionId = null, machineId = null }) {
    this.clients.set(id, {
      res,
      visibility,
      all: Boolean(all),
      sessionId: (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : null,
      machineId: (typeof machineId === 'string' && machineId.trim()) ? machineId.trim() : null
    })
    res.on('close', () => {
      this.clients.delete(id)
    })
  }

  send(envelope) {
    const data = `data: ${JSON.stringify(envelope)}\n\n`
    for (const [id, c] of this.clients.entries()) {
      if (!this.#shouldSend(c, envelope)) continue
      try {
        c.res.write(data)
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
    const data = `data: ${JSON.stringify(envelope)}\n\n`
    let delivered = 0

    for (const [id, c] of this.clients.entries()) {
      const visible = c.visibility === 'visible'
      const shouldSend = policy === 'always' || (policy === 'if-not-visible' && !visible)
      if (!shouldSend) continue
      try {
        c.res.write(data)
        delivered += 1
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

    return false
  }

  #heartbeat() {
    const hb = makeEnvelope({ type: 'heartbeat', payload: { ts: Date.now() } })
    const data = `data: ${JSON.stringify(hb)}\n\n`
    for (const [id, c] of this.clients.entries()) {
      try {
        c.res.write(data)
      } catch {
        this.clients.delete(id)
      }
    }
  }
}
