import process from 'node:process'

import * as nodePty from 'node-pty'

import { resolveWorkspaceListPath } from './runnerWorkspaceApi.js'

function pickShell() {
  const fromEnv = String(process.env.SHELL ?? '').trim()
  if (fromEnv) return fromEnv
  if (process.platform === 'darwin') return '/bin/zsh'
  return '/bin/bash'
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

export class RunnerTerminalManager {
  constructor({
    machineId,
    emit,
    createPty = (file, args, options) => nodePty.spawn(file, args, options)
  }) {
    this.machineId = machineId
    this.emit = emit
    this.createPty = createPty
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
    const resolvedCwd = resolveWorkspaceListPath(cwd)
    if (!id) throw new Error('terminalId is required')
    if (this.terminals.has(id)) throw new Error('terminal already exists')

    const size = normalizeTerminalSize(cols, rows)
    const shell = pickShell()
    const env = {
      ...process.env,
      TERM: 'xterm-256color'
    }

    const pty = this.createPty(shell, [], {
      name: 'xterm-256color',
      cwd: resolvedCwd,
      env,
      cols: size.cols,
      rows: size.rows
    })

    const record = {
      terminalId: id,
      cwd: resolvedCwd,
      shell,
      cols: size.cols,
      rows: size.rows,
      pty
    }
    this.terminals.set(id, record)

    pty.onData?.((data) => {
      this.#emit('terminal.pty.output', {
        terminalId: id,
        data: String(data ?? '')
      })
    })

    pty.onExit?.((event = {}) => {
      const current = this.terminals.get(id)
      if (current?.pty === pty) this.terminals.delete(id)
      this.#emit('terminal.pty.exit', {
        terminalId: id,
        exitCode: Number.isFinite(Number(event?.exitCode)) ? Number(event.exitCode) : null,
        signal: Number.isFinite(Number(event?.signal)) ? Number(event.signal) : null
      })
    })

    this.#emit('terminal.pty.start.result', {
      requestId,
      ok: true,
      terminalId: id,
      cwd: resolvedCwd,
      shell,
      cols: size.cols,
      rows: size.rows
    })
  }

  input({ terminalId, data }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) throw new Error('terminal not found')
    record.pty.write(String(data ?? ''))
  }

  resize({ terminalId, cols, rows }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) throw new Error('terminal not found')
    const size = normalizeTerminalSize(cols, rows)
    record.cols = size.cols
    record.rows = size.rows
    record.pty.resize(size.cols, size.rows)
  }

  close({ terminalId }) {
    const id = String(terminalId ?? '').trim()
    const record = this.terminals.get(id)
    if (!record) return false
    this.terminals.delete(id)
    try { record.pty.kill() } catch {}
    return true
  }

  closeAll() {
    for (const terminalId of Array.from(this.terminals.keys())) {
      this.close({ terminalId })
    }
  }
}
