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

export function applyWorkspaceTerminalInputModifiers(text, {
  ctrl = false,
  alt = false,
  shift = false,
  meta = false
} = {}) {
  const raw = String(text ?? '')
  if (!raw) return ''

  let next = raw
  if (shift && raw.length === 1) next = raw.toUpperCase()
  if (ctrl) {
    const first = next.slice(0, 1)
    const lower = first.toLowerCase()
    let ctrlChar = first
    if (lower >= 'a' && lower <= 'z') {
      ctrlChar = String.fromCharCode(lower.charCodeAt(0) - 96)
    } else if (first === ' ') {
      ctrlChar = '\x00'
    } else if (first === '@') {
      ctrlChar = '\x00'
    } else if (first === '[') {
      ctrlChar = '\x1b'
    } else if (first === '\\') {
      ctrlChar = '\x1c'
    } else if (first === ']') {
      ctrlChar = '\x1d'
    } else if (first === '^') {
      ctrlChar = '\x1e'
    } else if (first === '_') {
      ctrlChar = '\x1f'
    } else if (first === '?') {
      ctrlChar = '\x7f'
    }
    next = `${ctrlChar}${next.slice(1)}`
  }

  if (alt || meta) next = `\x1b${next}`
  return next
}

const MOBILE_TERMINAL_ACTION_INPUTS = Object.freeze({
  esc: '\x1b',
  tab: '\t',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  ins: '\x1b[2~',
  del: '\x1b[3~',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  prtscr: '\x1b[25~',
  scrolllock: '\x1b[26~',
  pause: '\x1b[28~',
  menu: '\x1b[29~'
})

function hasSequenceModifiers({ ctrl = false, alt = false, shift = false, meta = false } = {}) {
  return Boolean(ctrl || alt || shift || meta)
}

function xtermModifierCode({ ctrl = false, alt = false, shift = false, meta = false } = {}) {
  return 1 + (shift ? 1 : 0) + ((alt || meta) ? 2 : 0) + (ctrl ? 4 : 0)
}

function applyModifiersToTerminalAction(base, action, modifiers = {}) {
  if (!base) return ''
  if (!hasSequenceModifiers(modifiers)) return base

  if (
    action === 'tab'
    && modifiers.shift
    && !modifiers.ctrl
    && !modifiers.alt
    && !modifiers.meta
  ) {
    return '\x1b[Z'
  }

  if (base === '\r') {
    return applyWorkspaceTerminalInputModifiers(base, modifiers)
  }

  const modifierCode = xtermModifierCode(modifiers)
  if (/^\x1b\[[A-DF-H]$/.test(base)) {
    return `${base.slice(0, -1)}1;${modifierCode}${base.slice(-1)}`
  }
  if (/^\x1b\[\d+~$/.test(base)) {
    return base.replace(/^(\x1b\[\d+)(~)$/, `$1;${modifierCode}$2`)
  }
  return applyWorkspaceTerminalInputModifiers(base, modifiers)
}

export function resolveMobileTerminalActionInput(actionId, modifiers = {}) {
  const action = String(actionId ?? '').trim().toLowerCase()
  if (!action) return ''
  if (Object.prototype.hasOwnProperty.call(MOBILE_TERMINAL_ACTION_INPUTS, action)) {
    return applyModifiersToTerminalAction(MOBILE_TERMINAL_ACTION_INPUTS[action], action, modifiers)
  }
  if (action.startsWith('ctrl+')) {
    return applyWorkspaceTerminalInputModifiers(action.slice(5), {
      ...modifiers,
      ctrl: true
    })
  }
  return ''
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
