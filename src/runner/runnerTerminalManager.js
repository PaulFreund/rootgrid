import process from 'node:process'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkspaceListPath } from './runnerWorkspaceApi.js'

const TERMINAL_INFO_TIMEOUT_MS = 1_500
const TERMINAL_OUTPUT_FLUSH_MS = 8

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function pickShell() {
  const fromEnv = String(process.env.SHELL ?? '').trim()
  if (fromEnv) return fromEnv
  if (process.platform === 'darwin') return '/bin/zsh'
  return '/bin/bash'
}

function shellQuotePosix(value) {
  const text = String(value ?? '')
  return `'${text.replaceAll("'", `'\"'\"'`)}'`
}

export function normalizeTerminalSize(cols, rows, {
  defaultCols = 80,
  defaultRows = 24,
  maxCols = 400,
  maxRows = 200
} = {}) {
  const nextCols = Math.max(20, Math.min(maxCols, Number(cols) || defaultCols))
  const nextRows = Math.max(5, Math.min(maxRows, Number(rows) || defaultRows))
  return {
    cols: nextCols,
    rows: nextRows
  }
}

export function appendTerminalOutput(current, chunk, maxChars = 400_000) {
  const next = `${String(current ?? '')}${String(chunk ?? '')}`
  return next.length <= maxChars ? next : next.slice(-maxChars)
}

export function buildScriptSpawnSpec({
  shell,
  cwd,
  cols,
  rows,
  infoPath = null,
  platform = process.platform
}) {
  const safeShell = String(shell ?? '').trim() || pickShell()
  const safeCwd = resolveWorkspaceListPath(cwd)
  const size = normalizeTerminalSize(cols, rows)
  const commandParts = []
  if (typeof infoPath === 'string' && infoPath.trim()) {
    commandParts.push(`printf '%s %s\\n' "$$" "$(tty)" > ${shellQuotePosix(infoPath.trim())}`)
  }
  commandParts.push(`stty cols ${size.cols} rows ${size.rows} >/dev/null 2>&1 || true`)
  commandParts.push(`exec ${shellQuotePosix(safeShell)} -i`)
  const command = commandParts.join('; ')
  if (platform === 'darwin') {
    return {
      file: 'script',
      args: ['-q', '/dev/null', '/bin/sh', '-lc', command],
      cwd: safeCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(size.cols),
        LINES: String(size.rows)
      },
      shell: safeShell,
      cols: size.cols,
      rows: size.rows
    }
  }
  return {
    file: 'script',
    args: ['-qefc', command, '/dev/null'],
    cwd: safeCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLUMNS: String(size.cols),
      LINES: String(size.rows)
    },
    shell: safeShell,
    cols: size.cols,
    rows: size.rows
  }
}

export function buildTerminalResizeSpec({
  ttyPath,
  cols,
  rows,
  platform = process.platform
}) {
  const safeTtyPath = String(ttyPath ?? '').trim()
  if (!safeTtyPath) throw new Error('ttyPath is required')
  const size = normalizeTerminalSize(cols, rows)
  return {
    file: 'stty',
    args: (platform === 'darwin')
      ? ['cols', String(size.cols), 'rows', String(size.rows), '-f', safeTtyPath]
      : ['cols', String(size.cols), 'rows', String(size.rows), '-F', safeTtyPath],
    cols: size.cols,
    rows: size.rows
  }
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    let done = false
    const onSpawn = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }
    const onError = (err) => {
      if (done) return
      done = true
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      child.off?.('spawn', onSpawn)
      child.off?.('error', onError)
    }
    child.once?.('spawn', onSpawn)
    child.once?.('error', onError)
  })
}

function parseTerminalInfo(text) {
  const [pidText = '', ttyPath = ''] = String(text ?? '').trim().split(/\s+/, 2)
  const shellPid = Number(pidText)
  if (!Number.isFinite(shellPid) || !ttyPath) return null
  return {
    shellPid,
    ttyPath: String(ttyPath)
  }
}

async function waitForTerminalInfo(infoPath, {
  timeoutMs = TERMINAL_INFO_TIMEOUT_MS,
  pollMs = 25,
  readTextFile = (path) => readFile(path, 'utf8')
} = {}) {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const parsed = parseTerminalInfo(await readTextFile(infoPath))
      if (parsed) return parsed
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return null
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      cleanup()
      resolve(code)
    }
    const cleanup = () => {
      child.off?.('exit', onExit)
      child.off?.('error', onError)
    }
    const onExit = (code) => finish(code)
    const onError = () => finish(null)
    child.once?.('exit', onExit)
    child.once?.('error', onError)
  })
}

export class RunnerTerminalManager {
  constructor({
    machineId,
    emit,
    spawnProcess = (file, args, options) => spawn(file, args, options),
    platform = process.platform,
    signalProcess = (pid, signal) => process.kill(pid, signal),
    makeTempDir = (prefix) => mkdtemp(prefix),
    removePath = (path) => rm(path, { recursive: true, force: true }),
    readTextFile = (path) => readFile(path, 'utf8')
  }) {
    this.machineId = machineId
    this.emit = emit
    this.spawnProcess = spawnProcess
    this.platform = platform
    this.signalProcess = signalProcess
    this.makeTempDir = makeTempDir
    this.removePath = removePath
    this.readTextFile = readTextFile
    this.terminals = new Map()
  }

  #emit(type, payload) {
    this.emit(type, {
      machineId: this.machineId,
      ...(payload ?? {})
    }, { track: false })
  }

  #queueOutput(record, data) {
    const chunk = String(data ?? '')
    if (!chunk) return
    record.pendingOutput = `${String(record.pendingOutput ?? '')}${chunk}`
    if (record.outputFlushTimer) return
    record.outputFlushTimer = setTimeout(() => {
      this.#flushOutput(record)
    }, TERMINAL_OUTPUT_FLUSH_MS)
  }

  #flushOutput(record) {
    if (record.outputFlushTimer) {
      try { clearTimeout(record.outputFlushTimer) } catch {}
      record.outputFlushTimer = null
    }
    const data = String(record.pendingOutput ?? '')
    record.pendingOutput = ''
    if (!data) return
    this.#emit('terminal.pty.output', {
      terminalId: record.terminalId,
      data
    })
  }

  async #cleanupRecord(record) {
    if (!record) return
    this.#flushOutput(record)
    if (record.infoDir) {
      try { await this.removePath(record.infoDir) } catch {}
      record.infoDir = ''
    }
    record.infoPath = ''
  }

  async #ensureTerminalInfo(record) {
    if (!record?.infoPath) return null
    if (record.shellPid && record.ttyPath) return {
      shellPid: record.shellPid,
      ttyPath: record.ttyPath
    }
    if (record.infoPromise) return record.infoPromise
    record.infoPromise = waitForTerminalInfo(record.infoPath, {
      readTextFile: this.readTextFile
    }).then(async (info) => {
      if (!info) return null
      record.shellPid = info.shellPid
      record.ttyPath = info.ttyPath
      if (record.pendingResize) {
        const pending = record.pendingResize
        record.pendingResize = null
        await this.#applyResize(record, pending)
      }
      return info
    }).finally(() => {
      record.infoPromise = null
    })
    return record.infoPromise
  }

  async #applyResize(record, size) {
    if (!record) return false
    const nextSize = normalizeTerminalSize(size?.cols, size?.rows)
    record.cols = nextSize.cols
    record.rows = nextSize.rows
    if (!record.shellPid || !record.ttyPath) {
      record.pendingResize = nextSize
      this.#ensureTerminalInfo(record).catch(() => {})
      return false
    }
    try {
      const spec = buildTerminalResizeSpec({
        ttyPath: record.ttyPath,
        cols: nextSize.cols,
        rows: nextSize.rows,
        platform: this.platform
      })
      const child = this.spawnProcess(spec.file, spec.args, { stdio: 'ignore' })
      const exitCode = await waitForChildExit(child)
      if (Number(exitCode) === 0) {
        try { this.signalProcess(record.shellPid, 'SIGWINCH') } catch {}
        return true
      }
    } catch {
    }
    return false
  }

  async start({ requestId, terminalId, cwd, cols, rows }) {
    const id = String(terminalId ?? '').trim()
    if (!id) throw new Error('terminalId is required')
    if (this.terminals.has(id)) throw new Error('terminal already exists')

    const infoDir = await this.makeTempDir(join(tmpdir(), 'rootgrid-terminal-'))
    const infoPath = join(infoDir, 'info.txt')
    let child = null
    let spec = null
    try {
      spec = buildScriptSpawnSpec({
        shell: pickShell(),
        cwd,
        cols,
        rows,
        infoPath,
        platform: this.platform
      })
      child = this.spawnProcess(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      await waitForChildSpawn(child)
    } catch (err) {
      try { await this.removePath(infoDir) } catch {}
      throw err
    }

    const record = {
      terminalId: id,
      cwd: spec.cwd,
      shell: spec.shell,
      cols: spec.cols,
      rows: spec.rows,
      child,
      infoDir,
      infoPath,
      shellPid: null,
      ttyPath: '',
      infoPromise: null,
      pendingResize: null,
      pendingOutput: '',
      outputFlushTimer: null
    }
    this.terminals.set(id, record)
    this.#ensureTerminalInfo(record).catch(() => {})

    child.stdout?.on?.('data', (data) => {
      this.#queueOutput(record, data)
    })

    child.stderr?.on?.('data', (data) => {
      this.#queueOutput(record, data)
    })

    child.on?.('exit', async (code, signal) => {
      const current = this.terminals.get(id)
      if (current?.child === child) this.terminals.delete(id)
      this.#flushOutput(record)
      this.#emit('terminal.pty.exit', {
        terminalId: id,
        exitCode: toOptionalNumber(code),
        signal: toOptionalNumber(signal)
      })
      await this.#cleanupRecord(record)
    })

    child.on?.('error', async (err) => {
      const current = this.terminals.get(id)
      if (current?.child === child) this.terminals.delete(id)
      this.#queueOutput(record, `[rootgrid] terminal error: ${String(err?.message ?? err)}\r\n`)
      this.#flushOutput(record)
      this.#emit('terminal.pty.exit', {
        terminalId: id,
        exitCode: null,
        signal: null
      })
      await this.#cleanupRecord(record)
    })

    this.#emit('terminal.pty.start.result', {
      requestId,
      ok: true,
      terminalId: id,
      cwd: spec.cwd,
      shell: spec.shell,
      cols: spec.cols,
      rows: spec.rows
    })
  }

  input({ terminalId, data }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) throw new Error('terminal not found')
    record.child.stdin?.write?.(String(data ?? ''))
  }

  resize({ terminalId, cols, rows }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) throw new Error('terminal not found')
    const size = normalizeTerminalSize(cols, rows)
    this.#applyResize(record, size).catch(() => {})
  }

  close({ terminalId }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) return false
    this.terminals.delete(id)
    try { record.child.kill('SIGHUP') } catch {}
    this.#cleanupRecord(record).catch(() => {})
    return true
  }

  closeAll() {
    for (const terminalId of Array.from(this.terminals.keys())) {
      this.close({ terminalId })
    }
  }
}
