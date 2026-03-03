import { spawn } from 'node:child_process'
import net from 'node:net'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForPort({ host, port, timeoutMs = 10_000 }) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host, port })
        const cleanup = () => {
          try { sock.destroy() } catch { }
        }
        sock.once('connect', () => {
          cleanup()
          resolve()
        })
        sock.once('error', (err) => {
          cleanup()
          reject(err)
        })
      })
      return true
    } catch {
      if (Date.now() - start > timeoutMs) return false
      await sleep(200)
    }
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = (addr && typeof addr === 'object') ? addr.port : null
      srv.close(() => resolve(port))
    })
  })
}

export class RunnerIdeManager {
  /**
   * @param {{
   *   machineId: string,
   *   emit: (type: string, payload: any) => void
   * }} opts
   */
  constructor({ machineId, emit }) {
    this.machineId = machineId
    this.emit = emit
    /** @type {Map<string, { proc: import('node:child_process').ChildProcess, port: number, cwd: string }>} */
    this.ideSessions = new Map()
  }

  async start({ ideId, cwd }) {
    if (!ideId || typeof ideId !== 'string') throw new Error('ideId required')
    if (!cwd || typeof cwd !== 'string') throw new Error('cwd required')
    if (this.ideSessions.has(ideId)) return

    const port = await getFreePort()
    if (!port) throw new Error('failed to allocate port')

    const basePath = `/vscode/${ideId}`

    const args = [
      '--auth', 'none',
      '--bind-addr', `127.0.0.1:${port}`,
      '--disable-telemetry',
      '--disable-update-check',
      '--base-path', basePath,
      cwd
    ]

    const proc = spawn('code-server', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore']
    })

    this.ideSessions.set(ideId, { proc, port, cwd })

    proc.once('error', (err) => {
      this.ideSessions.delete(ideId)
      this.emit('ide.failed', { ideId, error: String(err?.message ?? err) })
    })

    proc.once('exit', (code, signal) => {
      this.ideSessions.delete(ideId)
      this.emit('ide.stopped', { ideId, code, signal })
    })

    const ready = await waitForPort({ host: '127.0.0.1', port, timeoutMs: 10_000 })
    if (!ready) {
      try { proc.kill('SIGKILL') } catch { }
      this.ideSessions.delete(ideId)
      this.emit('ide.failed', { ideId, error: 'code-server failed to start (timeout)' })
      return
    }

    this.emit('ide.started', { ideId, cwd, port, basePath })
  }

  async stop({ ideId }) {
    const s = this.ideSessions.get(ideId)
    if (!s) return
    try { s.proc.kill('SIGTERM') } catch { }
    // exit handler will emit ide.stopped
  }
}
