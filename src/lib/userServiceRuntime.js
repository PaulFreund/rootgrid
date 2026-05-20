import { spawn } from 'node:child_process'

import { ROOTGRID_LAUNCHD_LABEL, ROOTGRID_USER_SERVICE_NAME } from './managedRelease.js'

export function dispatchUserServiceRestart(method) {
  const value = String(method ?? '').trim()
  if (value === 'systemd-user') {
    const proc = spawn('systemctl', ['--user', 'restart', `${ROOTGRID_USER_SERVICE_NAME}.service`], {
      stdio: 'ignore',
      detached: true
    })
    proc.unref()
    return true
  }

  if (value === 'launchd-user') {
    const uid = process.getuid?.()
    if (!Number.isFinite(uid)) throw new Error('launchd restart requires a numeric user id')
    const proc = spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${ROOTGRID_LAUNCHD_LABEL}`], {
      stdio: 'ignore',
      detached: true
    })
    proc.unref()
    return true
  }

  throw new Error(`unsupported autostart method: ${value || 'none'}`)
}
