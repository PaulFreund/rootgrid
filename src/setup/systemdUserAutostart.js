import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { userInfo } from 'node:os'
import { join } from 'node:path'

function systemdQuote(value) {
  // systemd unit escaping uses its own parser. Quoting is the safest approach.
  const s = String(value ?? '')
  const escaped = s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `"${escaped}"`
}

function formatExecStart(execStart) {
  if (Array.isArray(execStart)) {
    return execStart.map((a) => systemdQuote(a)).join(' ')
  }
  return String(execStart ?? '').trim()
}

function runCommandCapture(command, args, { timeoutMs = 10_000, maxBytes = 128 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { }
      resolve({ ok: false, code: null, signal: 'SIGKILL', timedOut: true, stdout, stderr })
    }, timeoutMs)

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, timedOut: false, stdout, stderr })
    })

    child.stdout?.on('data', (buf) => {
      if (stdout.length >= maxBytes) return
      stdout += String(buf).slice(0, maxBytes - stdout.length)
    })
    child.stderr?.on('data', (buf) => {
      if (stderr.length >= maxBytes) return
      stderr += String(buf).slice(0, maxBytes - stderr.length)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, signal, timedOut: false, stdout, stderr })
    })
  })
}

function runCommandInteractive(command, args, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.on('error', () => resolve({ ok: false, code: null, signal: null, timedOut: false, stdout: '', stderr: '' }))
    child.on('exit', (code, signal) => {
      resolve({ ok: code === 0, code, signal, timedOut: false, stdout: '', stderr: '' })
    })
  })
}

function shQuote(value) {
  return `'${String(value ?? '').replaceAll('\'', `'\"'\"'`)}'`
}

function getDefaultUserName() {
  try {
    return String(userInfo().username ?? '').trim()
  } catch {
    return ''
  }
}

export function parseSystemdUserLingerValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'yes') return true
  if (normalized === 'no') return false
  return null
}

export function buildEnableSystemdUserLingerCommand(username = null) {
  const user = String(username ?? '').trim()
  return user
    ? `sudo loginctl enable-linger ${shQuote(user)}`
    : 'sudo loginctl enable-linger "$USER"'
}

export async function getSystemdUserLingerStatus({
  username = getDefaultUserName(),
  runCapture = runCommandCapture
} = {}) {
  const user = String(username ?? '').trim()
  const command = buildEnableSystemdUserLingerCommand(user)
  if (!user) {
    return {
      supported: false,
      enabled: null,
      username: null,
      command,
      error: 'unable to determine current username'
    }
  }

  const result = await runCapture('loginctl', ['show-user', user, '-p', 'Linger', '--value'])
  if (!result.ok) {
    return {
      supported: false,
      enabled: null,
      username: user,
      command,
      error: result.stderr || result.stdout || 'loginctl show-user failed'
    }
  }

  const enabled = parseSystemdUserLingerValue(result.stdout)
  return {
    supported: enabled !== null,
    enabled,
    username: user,
    command,
    error: enabled === null ? `unexpected loginctl linger value: ${String(result.stdout ?? '').trim()}` : ''
  }
}

export async function enableSystemdUserLinger({
  username = getDefaultUserName(),
  interactive = false,
  runCapture = runCommandCapture,
  runInteractive = runCommandInteractive
} = {}) {
  const user = String(username ?? '').trim()
  const command = buildEnableSystemdUserLingerCommand(user)
  if (!user) {
    return {
      ok: false,
      username: null,
      command,
      error: 'unable to determine current username'
    }
  }

  const needsSudo = typeof process.getuid === 'function' && process.getuid() !== 0
  const runner = interactive ? runInteractive : runCapture
  const invoke = needsSudo
    ? ['sudo', interactive ? ['loginctl', 'enable-linger', user] : ['-n', 'loginctl', 'enable-linger', user]]
    : ['loginctl', ['enable-linger', user]]
  const result = await runner(invoke[0], invoke[1])

  return {
    ok: result.ok,
    username: user,
    command,
    error: result.ok ? '' : (result.stderr || result.stdout || 'loginctl enable-linger failed')
  }
}

export async function ensureSystemdUserLinger({
  username = getDefaultUserName(),
  interactive = false,
  runCapture = runCommandCapture,
  runInteractive = runCommandInteractive
} = {}) {
  const before = await getSystemdUserLingerStatus({ username, runCapture })
  if (!before.supported || before.enabled !== false) {
    return {
      supported: before.supported,
      enabled: before.enabled,
      username: before.username,
      command: before.command,
      changed: false,
      error: before.error
    }
  }

  const enable = await enableSystemdUserLinger({
    username: before.username,
    interactive,
    runCapture,
    runInteractive
  })
  const after = await getSystemdUserLingerStatus({ username: before.username, runCapture })
  return {
    supported: after.supported,
    enabled: after.enabled,
    username: after.username,
    command: after.command,
    changed: Boolean(enable.ok && after.enabled === true),
    error: (after.enabled === true) ? '' : (enable.error || after.error)
  }
}

export function getSystemdUserUnitPath({ serviceName }) {
  return join(homedir(), '.config', 'systemd', 'user', `${serviceName}.service`)
}

export function buildSystemdUserUnit({
  execStart,
  description = 'Rootgrid',
  workingDirectory = null,
  environment = null
}) {
  const envLines = []
  if (environment && typeof environment === 'object') {
    for (const [k, v] of Object.entries(environment)) {
      if (!k) continue
      if (v === undefined) continue
      envLines.push(`Environment=${systemdQuote(`${k}=${v}`)}`)
    }
  }

  return [
    '[Unit]',
    `Description=${description}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    ...(workingDirectory ? [`WorkingDirectory=${workingDirectory}`] : []),
    ...envLines,
    `ExecStart=${formatExecStart(execStart)}`,
    'Restart=always',
    'RestartSec=1',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

/**
 * Best-effort systemd --user autostart.
 *
 * @param {{
 *   serviceName: string,
 *   execStart: string | string[],
 *   description?: string,
 *   workingDirectory?: string|null,
 *   environment?: Record<string, string|undefined>|null,
 * }} opts
 */
export async function installSystemdUserService({
  serviceName,
  execStart,
  description = 'Rootgrid',
  workingDirectory = null,
  environment = null
}) {
  const unitPath = getSystemdUserUnitPath({ serviceName })
  await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
  const unit = buildSystemdUserUnit({
    execStart,
    description,
    workingDirectory,
    environment
  })

  await writeFile(unitPath, unit, { mode: 0o644 })

  const reload = await runCommandCapture('systemctl', ['--user', 'daemon-reload'])
  if (!reload.ok) {
    return { ok: false, step: 'daemon-reload', unitPath, error: reload.stderr || reload.stdout || 'systemctl daemon-reload failed' }
  }

  const enable = await runCommandCapture('systemctl', ['--user', 'enable', '--now', `${serviceName}.service`])
  if (!enable.ok) {
    return { ok: false, step: 'enable', unitPath, error: enable.stderr || enable.stdout || 'systemctl enable failed' }
  }

  const restart = await runCommandCapture('systemctl', ['--user', 'restart', `${serviceName}.service`])
  if (!restart.ok) {
    return { ok: false, step: 'restart', unitPath, error: restart.stderr || restart.stdout || 'systemctl restart failed' }
  }

  const linger = await ensureSystemdUserLinger({ interactive: false }).catch(() => null)
  return { ok: true, unitPath, linger }
}

export async function removeSystemdUserService({ serviceName }) {
  const unitPath = getSystemdUserUnitPath({ serviceName })

  await runCommandCapture('systemctl', ['--user', 'disable', '--now', `${serviceName}.service`]).catch(() => {})
  await rm(unitPath, { force: true }).catch(() => {})

  const reload = await runCommandCapture('systemctl', ['--user', 'daemon-reload'])
  if (!reload.ok) {
    return { ok: false, step: 'daemon-reload', unitPath, error: reload.stderr || reload.stdout || 'systemctl daemon-reload failed' }
  }

  await runCommandCapture('systemctl', ['--user', 'reset-failed', `${serviceName}.service`]).catch(() => {})
  return { ok: true, unitPath }
}
