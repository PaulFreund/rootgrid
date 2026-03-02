import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

import { makeEnvelope } from './envelope.js'

export function createRunnerWsServer({ config, store, sse }) {
  const wss = new WebSocketServer({ noServer: true })

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
          payload: { machineId, machineName, platform, lastSeenMs: Date.now(), capabilities }
        }))

        return
      }

      // Authed messages
      if (msg.type === 'machine.alive') {
        store.updateMachineLastSeen(state.machineId)
        return
      }
    })
  })

  return wss
}
