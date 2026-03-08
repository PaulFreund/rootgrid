import crypto from 'node:crypto'
import { hostname, platform as osPlatform } from 'node:os'

import WebSocket from 'ws'

import { RunnerSessionManager } from './sessionManager.js'
import { OutboxSpool } from './outboxSpool.js'

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

function makeEnvelope({ type, scope = null, payload = null }) {
  return { v: 1, type, ts: Date.now(), id: crypto.randomUUID(), scope, payload }
}

export async function startRunnerClient({ url, token, machineId, machineName, debug = null }) {
  if (!token) throw new Error('Runner token missing')

  const wsUrl = `${toWsBaseUrl(url)}/v1/runner/ws`

  const spool = new OutboxSpool({ machineId })
  const runnerBootId = crypto.randomUUID()
  const runnerStartedAtMs = Date.now()

  let attempt = 0
  /** @type {WebSocket|null} */
  let wsRef = null

  /** @type {Map<number, any>} */
  const pending = new Map() // seq -> envelope

  const loaded = await spool.load().catch(() => ({ lastAckSeq: 0, pending: new Map(), maxSeq: 0 }))

  let sendSeq = Math.max(Number(loaded?.maxSeq ?? 0) || 0, Number(loaded?.lastAckSeq ?? 0) || 0)
  let lastAckSeq = Number(loaded?.lastAckSeq ?? 0) || 0

  for (const [seq, env] of (loaded?.pending ?? new Map()).entries()) {
    pending.set(Number(seq), env)
  }

  function makeTrackedEnvelope({ type, scope = null, payload = null, track = true }) {
    const env = makeEnvelope({ type, scope, payload })
    if (track) {
      sendSeq += 1
      env.seq = sendSeq
      pending.set(sendSeq, env)
      spool.append(env)
    }
    return env
  }

  const flushPending = () => {
    const ws = wsRef
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const seqs = Array.from(pending.keys()).sort((a, b) => a - b)
    for (const seq of seqs) {
      const env = pending.get(seq)
      if (!env) continue
      try {
        ws.send(JSON.stringify(env))
      } catch {
        return
      }
    }
  }

  const onAck = (seq) => {
    const n = Number(seq)
    if (!Number.isFinite(n)) return
    if (n <= lastAckSeq) return
    lastAckSeq = n
    for (const k of Array.from(pending.keys())) {
      if (k <= lastAckSeq) pending.delete(k)
    }
    spool.ack(lastAckSeq)
  }

  const sendToHost = (envelope) => {
    const ws = wsRef
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(envelope))
      return true
    } catch {
      return false
    }
  }

  const sessions = new RunnerSessionManager({
    machineId,
    send: sendToHost,
    debug,
    makeEnvelope: makeTrackedEnvelope
  })

  const connect = () => {
    attempt += 1
    const ws = new WebSocket(wsUrl)
    wsRef = ws

    ws.on('open', () => {
      attempt = 0
      ws.send(JSON.stringify(makeTrackedEnvelope({
        type: 'hello',
        scope: { machineId },
        payload: {
          token,
          machine: {
            id: machineId,
            name: machineName || hostname(),
            platform: detectPlatform(),
            capabilities: { bootId: runnerBootId, startedAtMs: runnerStartedAtMs }
          }
        },
        track: false
      })))

      flushPending()
    })

    const aliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(makeTrackedEnvelope({ type: 'machine.alive', payload: { machineId }, track: false })))
    }, 20_000)
    aliveTimer.unref?.()

    const cleanup = () => clearInterval(aliveTimer)

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
      if (msg.type === 'welcome' || msg.type === 'error') return
      if (msg.type === 'ack') {
        onAck(msg.payload?.seq)
        return
      }
      sessions.handleHostEnvelope(msg)
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
