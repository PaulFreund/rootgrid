import { homedir } from 'node:os'
import { join } from 'node:path'

export function getRootgridDataDir() {
  const override = String(process.env.ROOTGRID_HOME_DIR ?? '').trim()
  if (override) return override
  return join(homedir(), '.rootgrid')
}

export function getRootgridRuntimeDir() {
  const override = String(process.env.ROOTGRID_RUNTIME_DIR ?? '').trim()
  if (override) return override
  const legacyInstallDir = String(process.env.ROOTGRID_INSTALL_DIR ?? '').trim()
  if (legacyInstallDir) return legacyInstallDir
  return getRootgridDataDir()
}

export function getRootgridDir() {
  return getRootgridDataDir()
}

export function getConfigPath() {
  return join(getRootgridDataDir(), 'config.json')
}

export function getDbPath() {
  return join(getRootgridDataDir(), 'rootgrid.db')
}

export function getSecretKeyPath() {
  return join(getRootgridDataDir(), 'secret.key')
}

export function getVapidKeysPath() {
  return join(getRootgridDataDir(), 'vapid.json')
}

export function getUploadsDir() {
  return join(getRootgridDataDir(), 'uploads')
}

export function getRunnerUploadsDir(machineId = 'default') {
  const segment = String(machineId ?? 'default').replace(/[/\\]/g, '_').trim() || 'default'
  return join(getUploadsDir(), 'runner', segment)
}

export function getCodexDebugDir() {
  return join(getRootgridDataDir(), 'debug', 'codex')
}

export function getReleasesDir() {
  return join(getRootgridRuntimeDir(), 'releases')
}

export function getCurrentReleaseLinkPath() {
  return join(getRootgridRuntimeDir(), 'current')
}

export function getRootgridTmpDir() {
  return join(getRootgridRuntimeDir(), 'tmp')
}

export function getReleaseBundlesDir() {
  return join(getRootgridTmpDir(), 'bundles')
}

export function getReleaseTransfersDir() {
  return join(getRootgridTmpDir(), 'releases')
}
