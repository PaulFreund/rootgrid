export const TERMINAL_OUTPUT_MAX_CHARS = 400_000

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function appendTerminalSessionOutput(current, chunk, maxChars = TERMINAL_OUTPUT_MAX_CHARS) {
  const next = `${String(current ?? '')}${String(chunk ?? '')}`
  return next.length <= maxChars ? next : next.slice(-maxChars)
}

export function buildTerminalExitNotice({ exitCode = null, signal = null, disconnected = false } = {}) {
  if (disconnected) return '\r\n[terminal disconnected]\r\n'
  const safeExitCode = toOptionalNumber(exitCode)
  const safeSignal = toOptionalNumber(signal)
  return `\r\n[process exited${safeExitCode !== null ? ` with code ${safeExitCode}` : ''}${safeSignal !== null ? ` signal ${safeSignal}` : ''}]\r\n`
}

export function createTerminalSessionRecord({
  terminalId,
  machineId,
  cwd = '',
  shell = '',
  cols = 80,
  rows = 24,
  createdAtMs = Date.now(),
  connected = true,
  outputText = '',
  outputVersion = 0,
  exitCode = null,
  signal = null,
  updatedAtMs = createdAtMs
} = {}) {
  return {
    terminalId: String(terminalId ?? '').trim(),
    machineId: String(machineId ?? '').trim(),
    cwd: String(cwd ?? '').trim(),
    shell: String(shell ?? '').trim(),
    cols: Number(cols) || 80,
    rows: Number(rows) || 24,
    createdAtMs: Number(createdAtMs) || Date.now(),
    connected: Boolean(connected),
    outputText: String(outputText ?? ''),
    outputVersion: Number(outputVersion) || 0,
    exitCode: toOptionalNumber(exitCode),
    signal: toOptionalNumber(signal),
    updatedAtMs: Number(updatedAtMs) || Date.now()
  }
}

export function applyTerminalStart(record, {
  terminalId,
  machineId,
  cwd = '',
  shell = '',
  cols = 80,
  rows = 24
} = {}) {
  const now = Date.now()
  const base = record ?? createTerminalSessionRecord({
    terminalId,
    machineId,
    cwd,
    shell,
    cols,
    rows,
    createdAtMs: now,
    updatedAtMs: now
  })
  base.terminalId = String(terminalId ?? base.terminalId ?? '').trim()
  base.machineId = String(machineId ?? base.machineId ?? '').trim()
  base.cwd = String(cwd ?? base.cwd ?? '').trim()
  base.shell = String(shell ?? base.shell ?? '').trim()
  base.cols = Number(cols) || base.cols || 80
  base.rows = Number(rows) || base.rows || 24
  base.connected = true
  base.exitCode = null
  base.signal = null
  base.updatedAtMs = now
  return base
}

export function appendTerminalOutputRecord(record, data) {
  const base = record ?? createTerminalSessionRecord({})
  base.outputText = appendTerminalSessionOutput(base.outputText, data)
  base.outputVersion = Number(base.outputVersion ?? 0) + 1
  base.updatedAtMs = Date.now()
  return base
}

export function applyTerminalExit(record, {
  exitCode = null,
  signal = null,
  disconnected = false,
  appendNotice = true
} = {}) {
  const base = record ?? createTerminalSessionRecord({})
  base.connected = false
  base.exitCode = toOptionalNumber(exitCode)
  base.signal = toOptionalNumber(signal)
  if (appendNotice) appendTerminalOutputRecord(base, buildTerminalExitNotice({ exitCode, signal, disconnected }))
  else base.updatedAtMs = Date.now()
  return base
}

export function findReusableTerminalSession(terminalSessions, { machineId = '', cwd = '' } = {}) {
  const safeMachineId = String(machineId ?? '').trim()
  const safeCwd = String(cwd ?? '').trim()
  if (!safeMachineId || !safeCwd) return null
  let best = null
  for (const terminal of terminalSessions.values()) {
    if (!terminal) continue
    if (String(terminal.machineId ?? '').trim() !== safeMachineId) continue
    if (String(terminal.cwd ?? '').trim() !== safeCwd) continue
    if (!best) {
      best = terminal
      continue
    }
    if (Boolean(terminal.connected) !== Boolean(best.connected)) {
      if (terminal.connected) best = terminal
      continue
    }
    if (Number(terminal.updatedAtMs ?? 0) > Number(best.updatedAtMs ?? 0)) {
      best = terminal
    }
  }
  return best
}

export function listMatchingTerminalIds(terminalSessions, { machineId = '', cwd = '' } = {}) {
  const safeMachineId = String(machineId ?? '').trim()
  const safeCwd = String(cwd ?? '').trim()
  const out = []
  for (const [terminalId, terminal] of terminalSessions.entries()) {
    if (!terminal) continue
    if (safeMachineId && String(terminal.machineId ?? '').trim() !== safeMachineId) continue
    if (safeCwd && String(terminal.cwd ?? '').trim() !== safeCwd) continue
    out.push(String(terminalId))
  }
  return out
}

export function serializeTerminalSession(record, extra = null) {
  const base = createTerminalSessionRecord(record ?? {})
  return {
    terminalId: base.terminalId,
    machineId: base.machineId,
    cwd: base.cwd,
    shell: base.shell,
    cols: base.cols,
    rows: base.rows,
    connected: base.connected,
    outputText: base.outputText,
    outputVersion: base.outputVersion,
    exitCode: base.exitCode,
    signal: base.signal,
    createdAtMs: base.createdAtMs,
    updatedAtMs: base.updatedAtMs,
    ...(extra && typeof extra === 'object' ? extra : {})
  }
}
