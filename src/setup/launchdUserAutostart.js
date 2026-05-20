import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ROOTGRID_LAUNCHD_LABEL } from '../lib/managedRelease.js'

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function runCommandCapture(command, args, { timeoutMs = 10_000, maxBytes = 128 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
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

export function getLaunchdUserPlistPath({ label = ROOTGRID_LAUNCHD_LABEL } = {}) {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

export async function installLaunchdUserService({
  label = ROOTGRID_LAUNCHD_LABEL,
  execStart,
  workingDirectory = null,
  environment = null
}) {
  const uid = process.getuid?.()
  if (!Number.isFinite(uid)) {
    return { ok: false, step: 'uid', unitPath: getLaunchdUserPlistPath({ label }), error: 'launchd requires a numeric user id' }
  }

  const unitPath = getLaunchdUserPlistPath({ label })
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true, mode: 0o755 })

  const args = Array.isArray(execStart) ? execStart : [String(execStart ?? '')]
  const envEntries = (environment && typeof environment === 'object')
    ? Object.entries(environment).filter(([key, value]) => key && value !== undefined)
    : []

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    '  </array>',
    ...(workingDirectory ? [`  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>`] : []),
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    ...(envEntries.length
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...envEntries.flatMap(([key, value]) => [
            `    <key>${xmlEscape(key)}</key>`,
            `    <string>${xmlEscape(String(value))}</string>`
          ]),
          '  </dict>'
        ]
      : []),
    '</dict>',
    '</plist>',
    ''
  ].join('\n')

  await writeFile(unitPath, plist, { mode: 0o644 })

  await runCommandCapture('launchctl', ['bootout', `gui/${uid}`, unitPath]).catch(() => {})
  const bootstrap = await runCommandCapture('launchctl', ['bootstrap', `gui/${uid}`, unitPath])
  if (!bootstrap.ok) {
    return { ok: false, step: 'bootstrap', unitPath, error: bootstrap.stderr || bootstrap.stdout || 'launchctl bootstrap failed' }
  }

  await runCommandCapture('launchctl', ['enable', `gui/${uid}/${label}`]).catch(() => {})
  const kickstart = await runCommandCapture('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`])
  if (!kickstart.ok) {
    return { ok: false, step: 'kickstart', unitPath, error: kickstart.stderr || kickstart.stdout || 'launchctl kickstart failed' }
  }

  return { ok: true, unitPath }
}

export async function removeLaunchdUserService({ label = ROOTGRID_LAUNCHD_LABEL } = {}) {
  const uid = process.getuid?.()
  const unitPath = getLaunchdUserPlistPath({ label })
  if (!Number.isFinite(uid)) {
    return { ok: false, step: 'uid', unitPath, error: 'launchd requires a numeric user id' }
  }

  await runCommandCapture('launchctl', ['bootout', `gui/${uid}`, unitPath]).catch(() => {})
  await runCommandCapture('launchctl', ['disable', `gui/${uid}/${label}`]).catch(() => {})
  await rm(unitPath, { force: true }).catch(() => {})
  return { ok: true, unitPath }
}
