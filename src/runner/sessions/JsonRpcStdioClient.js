import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Minimal JSON-RPC-ish client for Codex `app-server`.
 *
 * Notes:
 * - Codex omits the `"jsonrpc":"2.0"` field on the wire; we follow that.
 * - Messages are JSON objects delimited by newlines (JSONL).
 */
export class JsonRpcStdioClient {
  /**
   * @param {{
   *   command: string,
   *   args: string[],
   *   cwd?: string,
   *   env?: Record<string,string|undefined>,
   *   onNotification?: (msg: { method: string, params: any }) => void,
   *   onRequest?: (msg: { id: string|number, method: string, params: any }) => Promise<any>,
   *   onStderr?: (chunk: string) => void,
   *   onExit?: (info: { code: number|null, signal: NodeJS.Signals|null }) => void,
   *   debugCapture?: import('./JsonRpcDebugCapture.js').JsonRpcDebugCapture | null,
   * }} opts
   */
  constructor({
    command,
    args,
    cwd,
    env,
    onNotification = () => {},
    onRequest = async () => null,
    onStderr = () => {},
    onExit = () => {},
    debugCapture = null
  }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.onStderr = onStderr
    this.onExit = onExit
    this.debugCapture = debugCapture

    this.nextId = 1
    /** @type {Map<number, { resolve: (v:any)=>void, reject: (e:any)=>void }>} */
    this.pending = new Map()

    this.proc = null
    this.rl = null
  }

  async start() {
    if (this.proc) return
    await this.debugCapture?.start?.()

    const proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc
    this.debugCapture?.recordProcess('spawn', {
      pid: proc.pid ?? null,
      command: this.command,
      args: this.args,
      cwd: this.cwd ?? null
    })

    proc.on('exit', (code, signal) => {
      this.debugCapture?.recordProcess('exit', { code, signal })
      this.onExit({ code, signal })
      for (const { reject } of this.pending.values()) {
        reject(new Error(`app-server exited (code=${code}, signal=${signal})`))
      }
      this.pending.clear()
      void this.debugCapture?.close?.()
    })

    proc.on('error', (err) => {
      this.debugCapture?.recordProcess('error', {
        message: String(err?.message ?? err)
      })
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      void this.debugCapture?.close?.()
    })

    proc.stderr?.on('data', (buf) => {
      const text = String(buf)
      this.debugCapture?.recordStderr(text)
      try {
        this.onStderr(text)
      } catch {
      }
    })

    const rl = createInterface({ input: proc.stdout })
    this.rl = rl
    rl.on('line', (line) => this.#onLine(line))
  }

  /**
   * @param {string} line
   */
  async #onLine(line) {
    const raw = String(line ?? '').trim()
    if (!raw) return

    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      this.debugCapture?.recordIncoming(raw, null)
      return
    }
    this.debugCapture?.recordIncoming(raw, msg)
    if (!msg || typeof msg !== 'object') return

    // Response to our outgoing request
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      if (msg.error) p.reject(new Error(msg.error?.message ?? 'json-rpc error'))
      else p.resolve(msg.result)
      return
    }

    // Server → client request (expects a response)
    if (msg.method && msg.id !== undefined) {
      try {
        const result = await this.onRequest({ id: msg.id, method: msg.method, params: msg.params ?? null })
        this.sendResponse(msg.id, result)
      } catch (err) {
        this.sendError(msg.id, -32000, String(err?.message ?? err))
      }
      return
    }

    // Notification
    if (msg.method && msg.id === undefined) {
      try {
        this.onNotification({ method: msg.method, params: msg.params ?? null })
      } catch {
      }
    }
  }

  /**
   * @param {any} msg
   */
  #write(msg) {
    if (!this.proc?.stdin) throw new Error('app-server not started')
    const raw = JSON.stringify(msg)
    this.debugCapture?.recordOutbound(msg, raw)
    this.proc.stdin.write(`${raw}\n`)
  }

  /**
   * @param {string} method
   * @param {any} [params]
   */
  sendNotification(method, params) {
    this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  /**
   * @param {string} method
   * @param {any} [params]
   */
  sendRequest(method, params) {
    const id = this.nextId++
    this.#write({ id, method, ...(params === undefined ? {} : { params }) })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  /**
   * @param {string|number} id
   * @param {any} result
   */
  sendResponse(id, result) {
    this.#write({ id, result })
  }

  /**
   * @param {string|number} id
   * @param {number} code
   * @param {string} message
   */
  sendError(id, code, message) {
    this.#write({ id, error: { code, message } })
  }

  stop({ signal = 'SIGTERM' } = {}) {
    try {
      this.proc?.kill(signal)
    } catch {
    }
  }
}
