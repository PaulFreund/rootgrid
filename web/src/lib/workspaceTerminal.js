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

export function appendWorkspaceTerminalOutput(current, chunk, maxChars = 400_000) {
  const next = `${String(current ?? '')}${String(chunk ?? '')}`
  return next.length <= maxChars ? next : next.slice(-maxChars)
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
