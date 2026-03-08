import process from 'node:process'
import { spawn } from 'node:child_process'

import { resolveWorkspaceListPath } from './runnerWorkspaceApi.js'

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
  platform = process.platform
}) {
  const safeShell = String(shell ?? '').trim() || pickShell()
  const safeCwd = resolveWorkspaceListPath(cwd)
  const size = normalizeTerminalSize(cols, rows)
  const command = `stty cols ${size.cols} rows ${size.rows} >/dev/null 2>&1 || true; exec ${shellQuotePosix(safeShell)} -i`
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

export class RunnerTerminalManager {
  constructor({
    machineId,
    emit,
    spawnProcess = (file, args, options) => spawn(file, args, options),
    platform = process.platform
  }) {
    this.machineId = machineId
    this.emit = emit
    this.spawnProcess = spawnProcess
    this.platform = platform
    this.terminals = new Map()
  }

  #emit(type, payload) {
    this.emit(type, {
      machineId: this.machineId,
      ...(payload ?? {})
    }, { track: false })
  }

  async start({ requestId, terminalId, cwd, cols, rows }) {
    const id = String(terminalId ?? '').trim()
    if (!id) throw new Error('terminalId is required')
    if (this.terminals.has(id)) throw new Error('terminal already exists')

    const spec = buildScriptSpawnSpec({
      shell: pickShell(),
      cwd,
      cols,
      rows,
      platform: this.platform
    })
    const child = this.spawnProcess(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    await waitForChildSpawn(child)

    const record = {
      terminalId: id,
      cwd: spec.cwd,
      shell: spec.shell,
      cols: spec.cols,
      rows: spec.rows,
      child
    }
    this.terminals.set(id, record)

    child.stdout?.on?.('data', (data) => {
      this.#emit('terminal.pty.output', {
        terminalId: id,
        data: String(data ?? '')
      })
    })

    child.stderr?.on?.('data', (data) => {
      this.#emit('terminal.pty.output', {
        terminalId: id,
        data: String(data ?? '')
      })
    })

    child.on?.('exit', (code, signal) => {
      const current = this.terminals.get(id)
      if (current?.child === child) this.terminals.delete(id)
      this.#emit('terminal.pty.exit', {
        terminalId: id,
        exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: Number.isFinite(Number(signal)) ? Number(signal) : null
      })
    })

    child.on?.('error', (err) => {
      const current = this.terminals.get(id)
      if (current?.child === child) this.terminals.delete(id)
      this.#emit('terminal.pty.output', {
        terminalId: id,
        data: `[rootgrid] terminal error: ${String(err?.message ?? err)}\r\n`
      })
      this.#emit('terminal.pty.exit', {
        terminalId: id,
        exitCode: null,
        signal: null
      })
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
    record.cols = size.cols
    record.rows = size.rows
  }

  close({ terminalId }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) return false
    this.terminals.delete(id)
    try { record.child.kill('SIGHUP') } catch {}
    return true
  }

  closeAll() {
    for (const terminalId of Array.from(this.terminals.keys())) {
      this.close({ terminalId })
    }
  }
}
