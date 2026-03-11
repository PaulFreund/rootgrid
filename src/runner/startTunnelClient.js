import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { hostname, platform as osPlatform } from 'node:os'

import WebSocket from 'ws'

import { TUNNEL_FRAME, decodeTunnelFrame, decodeTunnelJsonPayload, encodeTunnelFrame, encodeTunnelJsonFrame } from '../lib/tunnelProtocol.js'

function toWsBaseUrl(input) {
  const u = new URL(input)
  if (u.protocol === 'http:') u.protocol = 'ws:'
  if (u.protocol === 'https:') u.protocol = 'wss:'
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`Unsupported upstream URL protocol for tunnel WS: ${u.protocol}`)
  }
  return u.toString().replace(/\/+$/, '')
}

function detectPlatform() {
  if (process.env.WSL_DISTRO_NAME) return 'wsl'
  const p = osPlatform()
  if (p === 'darwin') return 'darwin'
  return 'linux'
}

function makeEnvelope({ type, scope = null, payload = null }) {
  return { v: 1, type, ts: Date.now(), id: crypto.randomUUID(), scope, payload }
}

/**
 * Runner-side tunnel client.
 *
 * - host opens per-stream connections (http or tcp) to runner-local targets (e.g. code-server).
 * - data is exchanged using binary tunnel frames.
 */
export async function startTunnelClient({ url, token, machineId, machineName }) {
  if (!token) throw new Error('Runner token missing')

  const wsUrl = `${toWsBaseUrl(url)}/v1/tunnel`

  const maxStreams = 512
  const maxBufferedAmount = 16 * 1024 * 1024

  let attempt = 0
  /** @type {WebSocket|null} */
  let wsRef = null

  /** @type {Map<number, any>} */
  const streams = new Map()

  const sendFrame = (buf) => {
    const ws = wsRef
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (maxBufferedAmount && Number(ws.bufferedAmount ?? 0) > maxBufferedAmount) {
      try { ws.close() } catch { }
      return false
    }
    try {
      ws.send(buf)
      return true
    } catch {
      return false
    }
  }

  const cleanupStream = (streamId) => {
    const s = streams.get(streamId)
    if (!s) return
    streams.delete(streamId)
    try { s.req?.destroy?.() } catch { }
    try { s.socket?.destroy?.() } catch { }
  }

  const handleOpen = (streamId, open) => {
    if (streams.size >= maxStreams) {
      sendFrame(encodeTunnelFrame(TUNNEL_FRAME.ERROR, streamId, Buffer.from('too many streams', 'utf8')))
      return
    }

    const mode = open?.mode
    const host = open?.host
    const port = Number(open?.port)

    if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
      sendFrame(encodeTunnelFrame(TUNNEL_FRAME.ERROR, streamId, Buffer.from('invalid target', 'utf8')))
      return
    }

    if (mode === 'tcp') {
      const socket = net.connect({ host, port }, () => {
        // ready
      })

      streams.set(streamId, { mode: 'tcp', socket })

      socket.on('data', (chunk) => {
        sendFrame(encodeTunnelFrame(TUNNEL_FRAME.DATA, streamId, Buffer.from(chunk)))
      })
      socket.on('end', () => {
        sendFrame(encodeTunnelFrame(TUNNEL_FRAME.END, streamId))
        cleanupStream(streamId)
      })
      socket.on('error', (err) => {
        sendFrame(encodeTunnelFrame(TUNNEL_FRAME.ERROR, streamId, Buffer.from(String(err?.message ?? err), 'utf8')))
        cleanupStream(streamId)
      })

      return
    }

    if (mode === 'http') {
      const method = open?.method ?? 'GET'
      const path = open?.path ?? '/'
      const headers = (open?.headers && typeof open.headers === 'object') ? open.headers : {}

      // Ensure host header points to the local target.
      headers.host = `${host}:${port}`

      const req = http.request({ host, port, method, path, headers }, (res) => {
        const resHeaders = res.headers ?? {}
        sendFrame(encodeTunnelJsonFrame(TUNNEL_FRAME.HEADERS, streamId, {
          statusCode: res.statusCode ?? 200,
          headers: resHeaders
        }))

        res.on('data', (chunk) => {
          sendFrame(encodeTunnelFrame(TUNNEL_FRAME.DATA, streamId, Buffer.from(chunk)))
        })
        res.on('end', () => {
          sendFrame(encodeTunnelFrame(TUNNEL_FRAME.END, streamId))
          cleanupStream(streamId)
        })
        res.on('close', () => {
          // If the response is terminated early, make sure the host sees an END.
          if (!streams.has(streamId)) return
          sendFrame(encodeTunnelFrame(TUNNEL_FRAME.END, streamId))
          cleanupStream(streamId)
        })
      })

      req.on('error', (err) => {
        sendFrame(encodeTunnelFrame(TUNNEL_FRAME.ERROR, streamId, Buffer.from(String(err?.message ?? err), 'utf8')))
        cleanupStream(streamId)
      })

      streams.set(streamId, { mode: 'http', req })
      return
    }

    sendFrame(encodeTunnelFrame(TUNNEL_FRAME.ERROR, streamId, Buffer.from('unknown mode', 'utf8')))
  }

  const handleData = (streamId, payload) => {
    const s = streams.get(streamId)
    if (!s) return
    if (s.mode === 'tcp') {
      try { s.socket.write(payload) } catch { }
      return
    }
    if (s.mode === 'http') {
      try { s.req.write(payload) } catch { }
    }
  }

  const handleEnd = (streamId) => {
    const s = streams.get(streamId)
    if (!s) return
    if (s.mode === 'tcp') {
      try { s.socket.end() } catch { }
      return
    }
    if (s.mode === 'http') {
      try { s.req.end() } catch { }
    }
  }

  const connect = () => {
    attempt += 1
    const ws = new WebSocket(wsUrl)
    wsRef = ws

    ws.on('open', () => {
      attempt = 0
      ws.send(JSON.stringify(makeEnvelope({
        type: 'hello',
        scope: { machineId },
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

    ws.on('message', (data) => {
      if (!Buffer.isBuffer(data)) {
        // welcome/error (json)
        return
      }

      const frame = decodeTunnelFrame(data)
      if (!frame) return

      if (frame.type === TUNNEL_FRAME.OPEN) {
        const open = decodeTunnelJsonPayload(frame.payload)
        handleOpen(frame.streamId, open)
        return
      }

      if (frame.type === TUNNEL_FRAME.DATA) return handleData(frame.streamId, frame.payload)
      if (frame.type === TUNNEL_FRAME.END) return handleEnd(frame.streamId)
      if (frame.type === TUNNEL_FRAME.ERROR) {
        cleanupStream(frame.streamId)
      }
    })

    ws.on('close', () => {
      for (const id of Array.from(streams.keys())) cleanupStream(id)
      const backoffMs = Math.min(30_000, 250 * Math.pow(2, attempt))
      setTimeout(connect, backoffMs)
    })

    ws.on('error', () => {
      // close handler will do reconnect
    })
  }

  connect()
}
