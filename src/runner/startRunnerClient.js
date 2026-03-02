import crypto from 'node:crypto'
import { hostname, platform as osPlatform } from 'node:os'

import WebSocket from 'ws'

function toWsBaseUrl(input) {
  const u = new URL(input)
  if (u.protocol === 'http:') u.protocol = 'ws:'
  if (u.protocol === 'https:') u.protocol = 'wss:'
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`Unsupported upstream URL protocol for runner WS: ${u.protocol}`)
  }
  return u.toString().replace(/\/+$/, '')
}

function detectPlatform() {
  // v0 coarse platform tags as documented
  if (process.env.WSL_DISTRO_NAME) return 'wsl'
  const p = osPlatform()
  if (p === 'darwin') return 'darwin'
  return 'linux'
}

function makeEnvelope({ type, payload }) {
  return { v: 1, type, ts: Date.now(), id: crypto.randomUUID(), scope: null, payload }
}

export async function startRunnerClient({ url, token, machineId, machineName }) {
  if (!token) throw new Error('Runner token missing')

  const wsUrl = `${toWsBaseUrl(url)}/v1/runner/ws`

  let attempt = 0

  const connect = () => {
    attempt += 1
    const ws = new WebSocket(wsUrl)

    ws.on('open', () => {
      attempt = 0
      ws.send(JSON.stringify(makeEnvelope({
        type: 'hello',
        payload: {
          token,
          machine: {
            id: machineId,
            name: machineName || hostname(),
            platform: detectPlatform(),
            capabilities: {}
          }
        }
      })))
    })

    const aliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(makeEnvelope({ type: 'machine.alive', payload: { machineId } })))
    }, 20_000)
    aliveTimer.unref?.()

    const cleanup = () => clearInterval(aliveTimer)

    ws.on('message', () => {
      // v0: ignore welcome payload; future: handle assigned machineId and resume tokens.
    })

    ws.on('close', () => {
      cleanup()
      const backoffMs = Math.min(30_000, 250 * Math.pow(2, attempt))
      setTimeout(connect, backoffMs).unref?.()
    })

    ws.on('error', () => {
      // close handler will do reconnect
    })
  }

  connect()
}

