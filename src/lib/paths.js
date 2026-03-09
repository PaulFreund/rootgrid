import { homedir } from 'node:os'
import { join } from 'node:path'

export function getRootgridDir() {
  const override = String(process.env.ROOTGRID_HOME_DIR ?? '').trim()
  if (override) return override
  return join(homedir(), '.rootgrid')
}

export function getConfigPath() {
  return join(getRootgridDir(), 'config.json')
}

export function getDbPath() {
  return join(getRootgridDir(), 'rootgrid.db')
}

export function getSecretKeyPath() {
  return join(getRootgridDir(), 'secret.key')
}

export function getVapidKeysPath() {
  return join(getRootgridDir(), 'vapid.json')
}

export function getUploadsDir() {
  return join(getRootgridDir(), 'uploads')
}

export function getRunnerUploadsDir(machineId = 'default') {
  const segment = String(machineId ?? 'default').replace(/[/\\]/g, '_').trim() || 'default'
  return join(getUploadsDir(), 'runner', segment)
}

export function getCodexDebugDir() {
  return join(getRootgridDir(), 'debug', 'codex')
}

export function getReleasesDir() {
  return join(getRootgridDir(), 'releases')
}

export function getCurrentReleaseLinkPath() {
  return join(getRootgridDir(), 'current')
}

export function getRootgridTmpDir() {
  return join(getRootgridDir(), 'tmp')
}

export function getReleaseBundlesDir() {
  return join(getRootgridTmpDir(), 'bundles')
}

export function getReleaseTransfersDir() {
  return join(getRootgridTmpDir(), 'releases')
}
