import crypto from 'node:crypto'

import { WebSocketServer } from 'ws'

import { makeEnvelope } from './envelope.js'

/**
 * Runner tunnel server (host side). Runners connect to `WS /v1/tunnel` and then
 * exchange binary tunnel frames for per-stream proxying.
 *
 * @param {{
 *   config: any,
 *   hub: import('./tunnelHub.js').TunnelHub
 * }} opts
 */
export function createTunnelWsServer({ config, hub }) {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws) => {
    const state = { authed: false, machineId: null }

    ws.on('message', (data) => {
      // First message must be a JSON hello.
      if (!state.authed) {
        let msg
        try {
          msg = JSON.parse(String(data))
        } catch {
          ws.close()
          return
        }

        if (!msg || typeof msg.type !== 'string' || msg.type !== 'hello') {
          ws.close()
          return
        }

        const token = msg.payload?.token
        if (!token || token !== config.host.auth.runnerToken) {
          ws.send(JSON.stringify(makeEnvelope({ type: 'error', payload: { message: 'unauthorized' } })))
          ws.close()
          return
        }

        const machineId = msg.payload?.machine?.id ?? msg.scope?.machineId ?? null
        if (!machineId) {
          ws.send(JSON.stringify(makeEnvelope({ type: 'error', payload: { message: 'missing machineId' } })))
          ws.close()
          return
        }

        state.authed = true
        state.machineId = machineId

        hub.attachMachine(machineId, ws)
        ws.once('close', () => hub.detachMachine(machineId, ws))

        ws.send(JSON.stringify(makeEnvelope({
          type: 'welcome',
          payload: { hostId: 'local', protocolVersion: 1, id: crypto.randomUUID() }
        })))

        return
      }

      if (!state.machineId) return

      // Binary frames only after auth.
      if (Buffer.isBuffer(data)) {
        hub.handleFrame(state.machineId, data)
      }
    })
  })

  return { wss }
}

