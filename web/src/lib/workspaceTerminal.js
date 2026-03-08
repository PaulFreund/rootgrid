export function normalizeTerminalGeometry(cols, rows, {
  defaultCols = 80,
  defaultRows = 24,
  maxCols = 400,
  maxRows = 200
} = {}) {
  return {
    cols: Math.max(20, Math.min(maxCols, Number(cols) || defaultCols)),
    rows: Math.max(5, Math.min(maxRows, Number(rows) || defaultRows))
  }
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function appendWorkspaceTerminalOutput(current, chunk, maxChars = 400_000) {
  const next = `${String(current ?? '')}${String(chunk ?? '')}`
  return next.length <= maxChars ? next : next.slice(-maxChars)
}

export function buildWorkspaceTerminalExitNotice({ exitCode = null, signal = null } = {}) {
  const safeExitCode = toOptionalNumber(exitCode)
  const safeSignal = toOptionalNumber(signal)
  return `\r\n[process exited${safeExitCode !== null ? ` with code ${safeExitCode}` : ''}${safeSignal !== null ? ` signal ${safeSignal}` : ''}]\r\n`
}

export function createWorkspaceTerminalSession({
  terminalId = '',
  machineId = '',
  cwd = '',
  shell = '',
  cols = 80,
  rows = 24,
  outputText = '',
  outputVersion = 0,
  connected = false,
  exitCode = null,
  signal = null
} = {}) {
  return {
    terminalId: String(terminalId ?? '').trim(),
    machineId: String(machineId ?? '').trim(),
    cwd: String(cwd ?? '').trim(),
    shell: String(shell ?? '').trim(),
    cols: Number(cols) || 80,
    rows: Number(rows) || 24,
    outputText: String(outputText ?? ''),
    outputVersion: Number(outputVersion) || 0,
    outputResetVersion: 1,
    chunkText: '',
    chunkVersion: 0,
    connected: Boolean(connected),
    exitCode: toOptionalNumber(exitCode),
    signal: toOptionalNumber(signal)
  }
}

export function workspaceTerminalSessionMatchesContext(session, context) {
  const terminalId = String(session?.terminalId ?? '').trim()
  const sessionMachineId = String(session?.machineId ?? '').trim()
  const sessionCwd = String(session?.cwd ?? '').trim()
  const contextMachineId = String(context?.machineId ?? '').trim()
  const contextCwd = String(context?.cwd ?? '').trim()
  if (!terminalId || !sessionCwd || !contextCwd) return false
  return sessionMachineId === contextMachineId && sessionCwd === contextCwd
}
