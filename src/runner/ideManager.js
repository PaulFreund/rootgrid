import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

import { buildIdeBasePath } from '../lib/idePaths.js'
import { getRootgridTmpDir } from '../lib/paths.js'

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
let cachedCodeServerCommandPromise = null

export function buildCodeServerEnv(baseEnv = process.env) {
  const env = { ...(baseEnv ?? {}) }
  delete env.VSCODE_IPC_HOOK_CLI
  delete env.CODE_SERVER_SESSION_SOCKET
  return env
}

export function listCodeServerCommandCandidates(baseEnv = process.env) {
  const env = buildCodeServerEnv(baseEnv)
  const values = [
    env.ROOTGRID_CODE_SERVER_BIN,
    env.CODE_SERVER_BIN
  ]
  const pathEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  for (const dir of pathEntries) values.push(join(dir, 'code-server'))
  const home = String(env.HOME ?? homedir() ?? '').trim()
  if (home) values.push(join(home, '.local', 'bin', 'code-server'))
  values.push('/usr/local/bin/code-server')
  values.push('/usr/bin/code-server')
  values.push('/opt/homebrew/bin/code-server')
  values.push('/home/linuxbrew/.linuxbrew/bin/code-server')

  const seen = new Set()
  const out = []
  for (const raw of values) {
    const candidate = String(raw ?? '').trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    out.push(candidate)
  }
  return out
}

async function resolveCodeServerCommand(baseEnv = process.env) {
  if (!cachedCodeServerCommandPromise) {
    cachedCodeServerCommandPromise = (async () => {
      const candidates = listCodeServerCommandCandidates(baseEnv)
      for (const candidate of candidates) {
        if (!candidate) continue
        if (!isAbsolute(candidate)) continue
        try {
          await access(candidate, fsConstants.X_OK)
          return {
            command: candidate,
            candidates
          }
        } catch {
        }
      }
      return {
        command: null,
        candidates
      }
    })()
  }
  return await cachedCodeServerCommandPromise
}

async function readCodeServerCapabilities() {
  if (!cachedCodeServerCapabilitiesPromise) {
    cachedCodeServerCapabilitiesPromise = (async () => {
      const resolved = await resolveCodeServerCommand(process.env)
      if (!resolved.command) {
        return {
          command: null,
          candidates: resolved.candidates,
          supportsAbsProxyBasePath: false,
          supportsBasePath: false
        }
      }
      return await new Promise((resolve) => {
        const proc = spawn(resolved.command, ['--help'], {
          env: buildCodeServerEnv(process.env),
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
            command: resolved.command,
            candidates: resolved.candidates,
            supportsAbsProxyBasePath: false,
            supportsBasePath: false
          })
        })
        proc.once('exit', () => {
          resolve({
            command: resolved.command,
            candidates: resolved.candidates,
            supportsAbsProxyBasePath: text.includes('--abs-proxy-base-path'),
            supportsBasePath: text.includes('--base-path')
          })
        })
      })
    })()
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

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').trim() || 'default'
}

export function buildCodeServerLaunchSpec({ ideId, machineId, port, cwd, capabilities = {} } = {}) {
  const safeIdeId = sanitizePathSegment(ideId)
  const safeMachineId = sanitizePathSegment(machineId)
  const basePath = buildIdeBasePath(ideId)
  const runtimeDir = join(getRootgridTmpDir(), 'ide', safeMachineId, safeIdeId)
  const userDataDir = join(runtimeDir, 'user-data')
  const trustedOrigins = Array.isArray(capabilities?.trustedOrigins)
    ? capabilities.trustedOrigins
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
    : []
  const args = [
    '--auth', 'none',
    '--bind-addr', `127.0.0.1:${port}`,
    '--disable-telemetry',
    '--disable-update-check',
    '--ignore-last-opened',
    '--user-data-dir', userDataDir
  ]
  if (capabilities.supportsAbsProxyBasePath) {
    args.push('--abs-proxy-base-path', basePath)
  } else if (capabilities.supportsBasePath) {
    args.push('--base-path', basePath)
  }
  for (const origin of trustedOrigins) {
    args.push('--trusted-origins', origin)
  }
  args.push(cwd)
  return {
    args,
    basePath,
    runtimeDir,
    userDataDir
  }
}

async function cleanupRuntimeDir(runtimeDir) {
  const path = String(runtimeDir ?? '').trim()
  if (!path) return
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
  }
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

  async start({ ideId, cwd, trustedOrigins = [] }) {
    if (!ideId || typeof ideId !== 'string') throw new Error('ideId required')
    if (!cwd || typeof cwd !== 'string') throw new Error('cwd required')
    if (this.ideSessions.has(ideId)) return

    const port = await getFreePort()
    if (!port) throw new Error('failed to allocate port')

    const capabilities = await readCodeServerCapabilities()
    if (!capabilities?.command) {
      const tried = Array.isArray(capabilities?.candidates) ? capabilities.candidates : []
      const detail = tried.length ? ` Tried: ${tried.join(', ')}` : ''
      throw new Error(`code-server not found.${detail} Set ROOTGRID_CODE_SERVER_BIN or install code-server on the runner host.`)
    }
    const spec = buildCodeServerLaunchSpec({
      ideId,
      machineId: this.machineId,
      port,
      cwd,
      capabilities: {
        ...capabilities,
        trustedOrigins
      }
    })
    await mkdir(spec.userDataDir, { recursive: true })

    const proc = spawn(capabilities.command, spec.args, {
      cwd,
      env: buildCodeServerEnv(process.env),
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

    this.ideSessions.set(ideId, { proc, port, cwd, runtimeDir: spec.runtimeDir })
    let started = false
    let failedDuringStartup = false
    let startupExit = null

    proc.once('error', (err) => {
      this.ideSessions.delete(ideId)
      cleanupRuntimeDir(spec.runtimeDir)
      failedDuringStartup = true
      this.emit('ide.failed', { ideId, error: String(err?.message ?? err) })
    })

    proc.once('exit', (code, signal) => {
      if (!started && !failedDuringStartup) {
        startupExit = { code, signal }
        return
      }
      this.ideSessions.delete(ideId)
      cleanupRuntimeDir(spec.runtimeDir)
      if (!started) return
      this.emit('ide.stopped', { ideId, code, signal })
    })

    const ready = await waitForPort({ host: '127.0.0.1', port, timeoutMs: 10_000 })
    if (!ready) {
      try { proc.kill('SIGKILL') } catch { }
      this.ideSessions.delete(ideId)
      cleanupRuntimeDir(spec.runtimeDir)
      failedDuringStartup = true
      const detail = summarizeStartupOutput(startupStdout, startupStderr)
      const status = startupExit
        ? [
            'code-server exited before startup',
            Number.isFinite(Number(startupExit.code))
              ? `(exit ${Number(startupExit.code)})`
              : (startupExit.signal ? `(${String(startupExit.signal)})` : '')
          ].filter(Boolean).join(' ')
        : 'code-server failed to start (timeout)'
      this.emit('ide.failed', {
        ideId,
        error: detail ? `${status}: ${detail}` : status
      })
      return
    }

    started = true
    this.emit('ide.started', { ideId, cwd, port, basePath: spec.basePath })
  }

  async stop({ ideId }) {
    const s = this.ideSessions.get(ideId)
    if (!s) return
    try { s.proc.kill('SIGTERM') } catch { }
    // exit handler will emit ide.stopped
  }
}
