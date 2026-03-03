import { Duplex } from 'node:stream'

import { TUNNEL_FRAME, decodeTunnelFrame, decodeTunnelJsonPayload, encodeTunnelFrame, encodeTunnelJsonFrame } from '../lib/tunnelProtocol.js'

class TunnelStream extends Duplex {
  /**
   * @param {{
   *   hub: TunnelHub,
   *   machineId: string,
   *   streamId: number,
   *   mode: 'http'|'tcp',
   *   idleTimeoutMs: number,
   * }} opts
   */
  constructor({ hub, machineId, streamId, mode, idleTimeoutMs }) {
    super()
    this.hub = hub
    this.machineId = machineId
    this.streamId = streamId
    this.mode = mode
    this.gotHeaders = false

    /** @type {NodeJS.Timeout|null} */
    this.headersTimer = null
    /** @type {NodeJS.Timeout|null} */
    this.idleTimer = null
    this.idleTimeoutMs = Number(idleTimeoutMs ?? 0) || 0

    this._touch()
  }

  _touch() {
    if (!this.idleTimeoutMs) return
    try { if (this.idleTimer) clearTimeout(this.idleTimer) } catch { }
    this.idleTimer = setTimeout(() => {
      try { this.destroy(new Error('tunnel idle timeout')) } catch { }
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  _read() {
    // data is pushed by TunnelHub when frames arrive
  }

  _write(chunk, _enc, cb) {
    try {
      this._touch()
      this.hub.send(this.machineId, encodeTunnelFrame(TUNNEL_FRAME.DATA, this.streamId, Buffer.from(chunk)))
      cb()
    } catch (err) {
      cb(err)
    }
  }

  _final(cb) {
    try {
      this._touch()
      this.hub.send(this.machineId, encodeTunnelFrame(TUNNEL_FRAME.END, this.streamId))
      cb()
    } catch (err) {
      cb(err)
    }
  }

  _destroy(_err, cb) {
    try {
      this.hub.send(this.machineId, encodeTunnelFrame(TUNNEL_FRAME.END, this.streamId))
    } catch {
    }
    try { if (this.headersTimer) clearTimeout(this.headersTimer) } catch { }
    try { if (this.idleTimer) clearTimeout(this.idleTimer) } catch { }
    cb()
  }

  /**
   * @param {{ statusCode: number, headers: Record<string, any> }} info
   */
  _onHeaders(info) {
    if (this.gotHeaders) return
    this.gotHeaders = true
    try { if (this.headersTimer) clearTimeout(this.headersTimer) } catch { }
    this._touch()
    this.emit('response', info)
  }
}

export class TunnelHub {
  constructor({
    maxStreamsPerMachine = 256,
    maxBufferedAmount = 16 * 1024 * 1024,
    idleTimeoutMsHttp = 5 * 60 * 1000,
    idleTimeoutMsTcp = 30 * 60 * 1000
  } = {}) {
    this.maxStreamsPerMachine = maxStreamsPerMachine
    this.maxBufferedAmount = maxBufferedAmount
    this.idleTimeoutMsHttp = idleTimeoutMsHttp
    this.idleTimeoutMsTcp = idleTimeoutMsTcp
    /** @type {Map<string, import('ws').WebSocket>} */
    this.wsByMachineId = new Map()
    /** @type {Map<number, TunnelStream>} */
    this.streams = new Map()
    /** @type {Map<string, Set<number>>} */
    this.streamIdsByMachineId = new Map()
    this.nextStreamId = 1
  }

  attachMachine(machineId, ws) {
    const prev = this.wsByMachineId.get(machineId)
    if (prev && prev !== ws) {
      // Tear down any existing streams bound to the previous tunnel connection.
      this.detachMachine(machineId, prev)
    }
    this.wsByMachineId.set(machineId, ws)
  }

  detachMachine(machineId, ws) {
    if (this.wsByMachineId.get(machineId) === ws) {
      this.wsByMachineId.delete(machineId)
    }

    // Tear down all streams for this machine.
    for (const [id, s] of this.streams.entries()) {
      if (s.machineId !== machineId) continue
      this.#deleteStream(id)
      try { s.destroy(new Error('tunnel disconnected')) } catch { }
    }
  }

  isConnected(machineId) {
    const ws = this.wsByMachineId.get(machineId)
    // ws uses numeric readyState constants; OPEN === 1
    return !!ws && ws.readyState === 1
  }

  send(machineId, data) {
    const ws = this.wsByMachineId.get(machineId)
    if (!ws || ws.readyState !== 1) throw new Error('tunnel not connected')
    if (this.maxBufferedAmount && Number(ws.bufferedAmount ?? 0) > this.maxBufferedAmount) {
      throw new Error('tunnel backpressure (bufferedAmount too high)')
    }
    ws.send(data)
  }

  /**
   * @param {string} machineId
   * @param {any} frameBuf
   */
  handleFrame(machineId, frameBuf) {
    const frame = decodeTunnelFrame(Buffer.from(frameBuf))
    if (!frame) return

    const stream = this.streams.get(frame.streamId) ?? null
    if (!stream) return
    if (stream.machineId !== machineId) return
    stream._touch()

    if (frame.type === TUNNEL_FRAME.DATA) {
      stream.push(frame.payload)
      return
    }

    if (frame.type === TUNNEL_FRAME.END) {
      stream.push(null)
      this.#deleteStream(frame.streamId)
      return
    }

    if (frame.type === TUNNEL_FRAME.ERROR) {
      const msg = Buffer.from(frame.payload).toString('utf8') || 'tunnel error'
      this.#deleteStream(frame.streamId)
      stream.destroy(new Error(msg))
      return
    }

    if (frame.type === TUNNEL_FRAME.HEADERS) {
      const info = decodeTunnelJsonPayload(frame.payload)
      if (info && typeof info === 'object') {
        stream._onHeaders({
          statusCode: Number(info.statusCode ?? 200),
          headers: info.headers ?? {}
        })
      }
    }
  }

  /**
   * Open a tunnel stream.
   *
   * For `mode: "http"`, the stream's writable side is the request body and
   * its readable side is the response body. A `response` event is emitted once.
   *
   * For `mode: "tcp"`, the stream is a raw byte stream.
   *
   * @param {{
   *   machineId: string,
   *   mode: 'http'|'tcp',
   *   host: string,
   *   port: number,
   *   method?: string,
   *   path?: string,
   *   headers?: Record<string, any>
   * }} opts
   */
  openStream({ machineId, mode, host, port, method, path, headers }) {
    if (!this.isConnected(machineId)) {
      throw new Error(`tunnel not connected for machine ${machineId}`)
    }

    const active = this.streamIdsByMachineId.get(machineId) ?? new Set()
    if (active.size >= this.maxStreamsPerMachine) {
      throw new Error('too many active tunnel streams')
    }

    const streamId = this.nextStreamId++
    const idleTimeoutMs = (mode === 'http') ? this.idleTimeoutMsHttp : this.idleTimeoutMsTcp
    const stream = new TunnelStream({ hub: this, machineId, streamId, mode, idleTimeoutMs })
    this.streams.set(streamId, stream)
    active.add(streamId)
    this.streamIdsByMachineId.set(machineId, active)

    stream.once('close', () => {
      this.#deleteStream(streamId)
    })

    const openPayload = {
      mode,
      host,
      port,
      ...(mode === 'http' ? { method, path, headers } : {})
    }
    this.send(machineId, encodeTunnelJsonFrame(TUNNEL_FRAME.OPEN, streamId, openPayload))

    if (mode === 'http') {
      stream.headersTimer = setTimeout(() => {
        try {
          stream.destroy(new Error('timeout waiting for response headers'))
        } catch {
        }
      }, 15_000)
      stream.headersTimer.unref?.()
    }

    return stream
  }

  #deleteStream(streamId) {
    const stream = this.streams.get(streamId) ?? null
    if (!stream) return
    this.streams.delete(streamId)
    const active = this.streamIdsByMachineId.get(stream.machineId)
    if (active) {
      active.delete(streamId)
      if (active.size === 0) this.streamIdsByMachineId.delete(stream.machineId)
    }
  }
}
