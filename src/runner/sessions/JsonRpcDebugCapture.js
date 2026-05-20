import { chmodSync, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

import { getCodexDebugDir } from '../../lib/paths.js'

function safeFileStamp(tsMs) {
  return new Date(tsMs).toISOString().replace(/[:.]/g, '-')
}

function safePathToken(input) {
  const token = String(input ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_')
  if (!token) return 'session'
  return token.slice(0, 120)
}

export function classifyRpcMessage(message) {
  if (!message || typeof message !== 'object') return 'unknown'
  if (message.id !== undefined && message.method === undefined) return 'response'
  if (message.method && message.id !== undefined) return 'request'
  if (message.method) return 'notification'
  return 'unknown'
}

function defaultCaptureDir(input) {
  const raw = (typeof input === 'string' && input.trim()) ? input.trim() : getCodexDebugDir()
  return resolve(raw)
}

export class JsonRpcDebugCapture {
  /**
   * @param {{
   *   sessionId: string,
   *   cwd?: string,
   *   command?: string,
   *   args?: string[],
   *   dir?: string|null,
   * }} opts
   */
  constructor({ sessionId, cwd, command = 'codex', args = [], dir = null }) {
    this.sessionId = sessionId
    this.cwd = cwd ?? null
    this.command = command
    this.args = Array.isArray(args) ? args : []
    this.dir = defaultCaptureDir(dir)
    this.filePath = join(this.dir, `${safeFileStamp(Date.now())}-${safePathToken(sessionId)}.jsonl`)
    this.stream = null
    this.started = false
    this.disabled = false
  }

  async start() {
    if (this.started || this.disabled) return
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      try { chmodSync(this.dir, 0o700) } catch { }
      const stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8', mode: 0o600 })
      stream.on('error', () => {
        this.disabled = true
        this.stream = null
      })
      this.stream = stream
      this.started = true
      this.record({
        channel: 'capture',
        event: 'start',
        sessionId: this.sessionId,
        cwd: this.cwd,
        command: this.command,
        args: this.args,
        filePath: this.filePath
      })
    } catch {
      this.disabled = true
      this.stream = null
    }
  }

  record(entry) {
    if (this.disabled || !this.stream) return
    const row = {
      ts: Date.now(),
      isoTs: new Date().toISOString(),
      sessionId: this.sessionId,
      ...entry
    }
    try {
      this.stream.write(`${JSON.stringify(row)}\n`)
    } catch {
      this.disabled = true
      try { this.stream.destroy() } catch { }
      this.stream = null
    }
  }

  recordOutbound(message, raw) {
    this.record({
      channel: 'rpc',
      direction: 'out',
      kind: classifyRpcMessage(message),
      raw,
      message
    })
  }

  recordIncoming(raw, message = null) {
    this.record({
      channel: 'rpc',
      direction: 'in',
      kind: message ? classifyRpcMessage(message) : 'invalid-json',
      raw,
      ...(message ? { message } : {})
    })
  }

  recordStderr(text) {
    this.record({
      channel: 'stderr',
      text: String(text ?? '')
    })
  }

  recordProcess(event, payload = null) {
    this.record({
      channel: 'process',
      event,
      ...(payload && typeof payload === 'object' ? payload : {})
    })
  }

  async close() {
    const stream = this.stream
    this.stream = null
    if (!stream) return
    await new Promise((resolve) => {
      try {
        stream.end(resolve)
      } catch {
        resolve()
      }
    })
  }
}
