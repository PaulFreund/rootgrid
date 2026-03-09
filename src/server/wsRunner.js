import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

import { makeEnvelope } from './envelope.js'
import { recoverAfterRunnerRestart } from './recovery.js'

const RUNNER_OUTPUT_BATCH_SIZE = 32
const RUNNER_OUTPUT_BATCH_DELAY_MS = 8

export function isPersistableRunnerMessage(msg, sessionId) {
  return Boolean(
    sessionId
    && typeof msg?.type === 'string'
    && msg.type !== 'session.uploaded'
    && msg.type !== 'session.upload.failed'
    && msg.type !== 'session.command.accepted'
    && msg.type !== 'session.command.rejected'
  )
}

export function buildPersistableRunnerEvent(msg, sessionId) {
  return {
    eventId: msg?.id,
    sessionId,
    tsMs: msg?.ts ?? Date.now(),
    type: msg?.type,
    payload: msg?.payload ?? null
  }
}

export function applyPersistedRunnerEvent(msg, result) {
  const inserted = Boolean(result?.inserted)
  const hostSeq = Number(result?.seq ?? 0)
  if (!inserted) return { inserted: false, hostSeq: null }

  if (hostSeq > 0 && msg?.type === 'session.output' && result?.payload && typeof result.payload === 'object') {
    msg.payload = result.payload
  }
  if (hostSeq > 0 && msg?.type !== 'machine.alive') {
    msg.eventSeq = hostSeq
  }
  return { inserted: true, hostSeq: hostSeq > 0 ? hostSeq : null }
}

export function createRunnerWsServer({
  config,
  store,
  sse,
  onApprovalRequest = null,
  onRunnerMessage = null,
  onRunnerDisconnect = null
}) {
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Map() // machineId -> ws

  wss.on('connection', (ws) => {
    const state = { authed: false, machineId: null }
    /** @type {Array<{ msg: any, sessionId: string }>} */
    let pendingOutputBatch = []
    let pendingOutputTimer = null

    const clearPendingOutputTimer = () => {
      if (!pendingOutputTimer) return
      try { clearTimeout(pendingOutputTimer) } catch { }
      pendingOutputTimer = null
    }

    const finalizePersistedMessage = (msg, { inserted = false, payload = null, seq = null } = {}) => {
      const applied = applyPersistedRunnerEvent(msg, { inserted, payload, seq })

      try {
        onRunnerMessage?.(msg, { machineId: state.machineId, inserted: applied.inserted })
      } catch {
      }

      if (msg.type === 'approval.request' && applied.inserted) {
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

      if (applied.inserted) sse.send(msg)
    }

    const persistRunnerMessage = (msg, sessionId) => {
      let inserted = true
      let payload = msg.payload ?? null
      let seq = null
      try {
        const res = store.appendEvent(buildPersistableRunnerEvent(msg, sessionId))
        if (res === null) inserted = false
        else seq = res
      } catch {
        try {
          if (!store.getSession(sessionId)) inserted = false
        } catch {
        }
      }
      if (inserted && Number.isFinite(Number(seq)) && msg.type === 'session.output' && payload && typeof payload === 'object') {
        const nextPayload = { ...payload }
        if (nextPayload.seq !== undefined && nextPayload.seq !== null && nextPayload.seq !== seq) nextPayload.runnerSeq = nextPayload.seq
        nextPayload.seq = seq
        payload = nextPayload
      }
      finalizePersistedMessage(msg, { inserted, payload, seq })
    }

    const flushPendingOutputBatch = () => {
      if (!pendingOutputBatch.length) return
      clearPendingOutputTimer()
      const batch = pendingOutputBatch
      pendingOutputBatch = []

      let results = null
      try {
        results = store.appendEventsBatch(batch.map(({ msg, sessionId }) => buildPersistableRunnerEvent(msg, sessionId)))
      } catch {
        results = null
      }

      if (!Array.isArray(results) || results.length !== batch.length) {
        for (const { msg, sessionId } of batch) persistRunnerMessage(msg, sessionId)
        return
      }

      for (let i = 0; i < batch.length; i++) {
        const { msg } = batch[i]
        const result = results[i] ?? { inserted: false, payload: msg.payload ?? null, seq: null }
        finalizePersistedMessage(msg, result)
      }
    }

    const queueRunnerOutput = (msg, sessionId) => {
      pendingOutputBatch.push({ msg, sessionId })
      if (pendingOutputBatch.length >= RUNNER_OUTPUT_BATCH_SIZE) {
        flushPendingOutputBatch()
        return
      }
      if (pendingOutputTimer) return
      pendingOutputTimer = setTimeout(() => {
        pendingOutputTimer = null
        flushPendingOutputBatch()
      }, RUNNER_OUTPUT_BATCH_DELAY_MS)
      try { pendingOutputTimer.unref?.() } catch { }
    }

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

        // If the runner process restarted, any in-flight turns/approvals from that
        // machine are now stale. Unstick sessions so the user can continue.
        try {
          const prev = store.getMachine(machineId)
          const prevBootId = String(prev?.capabilities?.bootId ?? '').trim()
          const nextBootId = String(capabilities?.bootId ?? '').trim()
          if (prevBootId && nextBootId && prevBootId !== nextBootId) {
            recoverAfterRunnerRestart({ store, sse, machineId, reason: 'runner restarted' })
          }
        } catch {
        }

        store.upsertMachine({ machineId, machineName, platform, capabilities })
        const machineRow = store.getMachine(machineId)

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
              payload: { machineId, connected: false, upgrade: null }
            }))
            try {
              onRunnerDisconnect?.({ machineId })
            } catch {
            }
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
          payload: {
            ...(machineRow ?? { machineId, machineName, platform, lastSeenMs: Date.now(), capabilities }),
            connected: true,
            upgrade: null
          }
        }))

        return
      }

      // Authed messages
      if (msg.type !== 'session.output') flushPendingOutputBatch()

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
      const persistable = isPersistableRunnerMessage(msg, sessionId)
      if (!persistable) {
        finalizePersistedMessage(msg, { inserted: false, payload: msg.payload ?? null, seq: null })
        return
      }

      if (msg.type === 'session.output') {
        queueRunnerOutput(msg, sessionId)
        return
      }

      persistRunnerMessage(msg, sessionId)
    })

    ws.once('close', () => {
      flushPendingOutputBatch()
      clearPendingOutputTimer()
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
