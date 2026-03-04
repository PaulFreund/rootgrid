import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

import { makeEnvelope } from './envelope.js'

export function createRunnerWsServer({ config, store, sse, onApprovalRequest = null, onRunnerMessage = null }) {
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Map() // machineId -> ws

  wss.on('connection', (ws) => {
    const state = { authed: false, machineId: null }

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(String(data))
      } catch {
        ws.send(JSON.stringify(makeEnvelope({ type: 'error', payload: { message: 'invalid json' } })))
        ws.close()
        return
      }

      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        ws.send(JSON.stringify(makeEnvelope({ type: 'error', payload: { message: 'invalid message' } })))
        ws.close()
        return
      }

      if (!state.authed) {
        if (msg.type !== 'hello') {
          ws.send(JSON.stringify(makeEnvelope({ type: 'error', payload: { message: 'expected hello' } })))
          ws.close()
          return
        }

        const token = msg.payload?.token
        if (!token || token !== config.host.auth.runnerToken) {
          ws.send(JSON.stringify(makeEnvelope({ type: 'error', payload: { message: 'unauthorized' } })))
          ws.close()
          return
        }

        const machine = msg.payload?.machine ?? {}
        const machineId = machine.id ?? crypto.randomUUID()
        const machineName = machine.name ?? 'unknown'
        const platform = machine.platform ?? 'linux'
        const capabilities = machine.capabilities ?? null

        state.authed = true
        state.machineId = machineId

        store.upsertMachine({ machineId, machineName, platform, capabilities })

        // Ensure at most one active WS per machineId (prevents duplicate event streams).
        const prev = connections.get(machineId)
        if (prev && prev !== ws) {
          try {
            prev.close(4000, 'replaced by a new connection')
          } catch {
          }
        }
        connections.set(machineId, ws)
        ws.once('close', () => {
          const active = connections.get(machineId) === ws
          if (active) connections.delete(machineId)
          if (active) {
            // Notify UI that the runner disconnected (ephemeral connection status).
            sse.send(makeEnvelope({
              type: 'registry.machine.upsert',
              scope: { machineId },
              payload: { machineId, connected: false }
            }))
          }
        })

        ws.send(JSON.stringify(makeEnvelope({
          type: 'welcome',
          payload: {
            hostId: 'local',
            protocolVersion: 1,
            ...(machine.id ? {} : { assigned: { machineId } })
          }
        })))

        // Notify UI via SSE
        sse.send(makeEnvelope({
          type: 'registry.machine.upsert',
          scope: { machineId },
          payload: { machineId, machineName, platform, lastSeenMs: Date.now(), capabilities, connected: true }
        }))

        return
      }

      // Authed messages
      if (msg.type === 'machine.alive') {
        const now = Date.now()
        store.updateMachineLastSeen(state.machineId)
        // Keep the UI's machine "online" indicator fresh.
        sse.send(makeEnvelope({
          type: 'registry.machine.upsert',
          scope: { machineId: state.machineId },
          payload: { machineId: state.machineId, lastSeenMs: now, connected: true }
        }))
        if (typeof msg.seq === 'number') {
          try {
            ws.send(JSON.stringify(makeEnvelope({
              type: 'ack',
              scope: { machineId: state.machineId },
              payload: { seq: msg.seq }
            })))
          } catch {
          }
        }
        return
      }

      // Persist session-scoped events
      const sessionId = msg.scope?.sessionId ?? msg.payload?.sessionId ?? null
      let inserted = true
      let hostSeq = null
      const persistable = sessionId
        && typeof msg.type === 'string'
        && msg.type !== 'session.uploaded'
        && msg.type !== 'session.upload.failed'

      if (persistable) {
        try {
          const res = store.appendEvent({
            eventId: msg.id,
            sessionId,
            tsMs: msg.ts ?? Date.now(),
            type: msg.type,
            payload: msg.payload ?? null
          })
          if (res === null) inserted = false
          else hostSeq = res
        } catch {
          // If the session no longer exists (deleted/retention-pruned), drop the event.
          try {
            if (!store.getSession(sessionId)) {
              inserted = false
            } else {
              // best-effort in v0
              inserted = true
            }
          } catch {
            inserted = true
          }
        }
      } else {
        inserted = false
      }

      // Allow host-specific side effects (IDE session bookkeeping, toast notifications, etc.)
      // after we know whether this event was newly persisted/deduped.
      try {
        onRunnerMessage?.(msg, { machineId: state.machineId, inserted })
      } catch {
      }

      if (msg.type === 'approval.request' && inserted) {
        try {
          onApprovalRequest?.(msg, { machineId: state.machineId })
        } catch {
        }
      }

      if (typeof msg.seq === 'number') {
        try {
          ws.send(JSON.stringify(makeEnvelope({
            type: 'ack',
            scope: { machineId: state.machineId },
            payload: { seq: msg.seq }
          })))
        } catch {
        }
      }

      // Broadcast to all UI clients (skip duplicates where we detected an already-persisted eventId).
      // For control-plane-only messages we also skip broadcasting.
      if (inserted) {
        // Keep SSE + API history consistent: use the host's durable event seq as the
        // session.output chunk sequence (runner seq may reset across restarts).
        if (hostSeq && msg.type === 'session.output' && msg.payload && typeof msg.payload === 'object') {
          const p = { ...msg.payload }
          if (p.seq !== undefined && p.seq !== null && p.seq !== hostSeq) p.runnerSeq = p.seq
          p.seq = hostSeq
          msg.payload = p
        }
        sse.send(msg)
      }
    })
  })

  function sendToMachine(machineId, envelope) {
    const ws = connections.get(machineId)
    // ws uses numeric readyState constants; OPEN === 1
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(envelope))
      return true
    } catch {
      connections.delete(machineId)
      return false
    }
  }

  function listConnectedMachineIds() {
    return Array.from(connections.keys())
  }

  function disconnectMachine(machineId, { code = 4001, reason = 'disconnected by host' } = {}) {
    const ws = connections.get(machineId)
    if (!ws) return false
    try { ws.close(code, reason) } catch { }
    return true
  }

  return { wss, sendToMachine, listConnectedMachineIds, disconnectMachine }
}
