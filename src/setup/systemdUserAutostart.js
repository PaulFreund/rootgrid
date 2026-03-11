import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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

  return { ok: true, unitPath }
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
