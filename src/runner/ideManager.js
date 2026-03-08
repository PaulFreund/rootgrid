import { spawn } from 'node:child_process'
import net from 'node:net'

import { buildIdeBasePath } from '../lib/idePaths.js'

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

let cachedCodeServerCapabilitiesPromise = null

async function readCodeServerCapabilities() {
  if (!cachedCodeServerCapabilitiesPromise) {
    cachedCodeServerCapabilitiesPromise = new Promise((resolve) => {
      const proc = spawn('code-server', ['--help'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let text = ''
      const append = (chunk) => {
        text += String(chunk ?? '')
      }
      proc.stdout?.on('data', append)
      proc.stderr?.on('data', append)
      proc.once('error', () => {
        resolve({
          supportsAbsProxyBasePath: false,
          supportsBasePath: false
        })
      })
      proc.once('exit', () => {
        resolve({
          supportsAbsProxyBasePath: text.includes('--abs-proxy-base-path'),
          supportsBasePath: text.includes('--base-path')
        })
      })
    })
  }
  return await cachedCodeServerCapabilitiesPromise
}

function appendOutputTail(current, chunk, maxChars = 4000) {
  const next = `${current}${String(chunk ?? '')}`
  return next.length <= maxChars ? next : next.slice(-maxChars)
}

function summarizeStartupOutput(stdoutText, stderrText) {
  const pieces = []
  const stderr = String(stderrText ?? '').trim()
  const stdout = String(stdoutText ?? '').trim()
  if (stderr) pieces.push(stderr)
  else if (stdout) pieces.push(stdout)
  return pieces.join('\n').trim()
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

    const basePath = buildIdeBasePath(ideId)
    const capabilities = await readCodeServerCapabilities()

    const args = [
      '--auth', 'none',
      '--bind-addr', `127.0.0.1:${port}`,
      '--disable-telemetry',
      '--disable-update-check'
    ]
    if (capabilities.supportsAbsProxyBasePath) {
      args.push('--abs-proxy-base-path', basePath)
    } else if (capabilities.supportsBasePath) {
      args.push('--base-path', basePath)
    }
    args.push(cwd)

    const proc = spawn('code-server', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let startupStdout = ''
    let startupStderr = ''
    proc.stdout?.on('data', (chunk) => {
      startupStdout = appendOutputTail(startupStdout, chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      startupStderr = appendOutputTail(startupStderr, chunk)
    })

    this.ideSessions.set(ideId, { proc, port, cwd })
    let started = false
    let failedDuringStartup = false

    proc.once('error', (err) => {
      this.ideSessions.delete(ideId)
      failedDuringStartup = true
      this.emit('ide.failed', { ideId, error: String(err?.message ?? err) })
    })

    proc.once('exit', (code, signal) => {
      this.ideSessions.delete(ideId)
      if (!started && !failedDuringStartup) {
        failedDuringStartup = true
        const detail = summarizeStartupOutput(startupStdout, startupStderr)
        const status = [`code-server exited before startup`]
        if (Number.isFinite(Number(code))) status.push(`(exit ${Number(code)})`)
        else if (signal) status.push(`(${String(signal)})`)
        this.emit('ide.failed', {
          ideId,
          error: detail ? `${status.join(' ')}: ${detail}` : status.join(' ')
        })
        return
      }
      if (!started) return
      this.emit('ide.stopped', { ideId, code, signal })
    })

    const ready = await waitForPort({ host: '127.0.0.1', port, timeoutMs: 10_000 })
    if (!ready) {
      try { proc.kill('SIGKILL') } catch { }
      this.ideSessions.delete(ideId)
      failedDuringStartup = true
      const detail = summarizeStartupOutput(startupStdout, startupStderr)
      this.emit('ide.failed', {
        ideId,
        error: detail ? `code-server failed to start: ${detail}` : 'code-server failed to start (timeout)'
      })
      return
    }

    started = true
    this.emit('ide.started', { ideId, cwd, port, basePath })
  }

  async stop({ ideId }) {
    const s = this.ideSessions.get(ideId)
    if (!s) return
    try { s.proc.kill('SIGTERM') } catch { }
    // exit handler will emit ide.stopped
  }
}
