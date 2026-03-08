import process from 'node:process'
import { join } from 'node:path'

import { loadConfig } from '../config/loadConfig.js'
import { RootgridConfigSchema } from '../config/schema.js'
import { writeJsonFile } from '../lib/jsonFile.js'
import {
  getCurrentPackageRoot,
  getCurrentReleaseLinkPath,
  installManagedRelease,
  ROOTGRID_USER_SERVICE_NAME
} from '../lib/managedRelease.js'
import { getConfigPath } from '../lib/paths.js'
import { ROOTGRID_VERSION } from '../lib/rootgridVersion.js'
import { installLaunchdUserService, removeLaunchdUserService } from './launchdUserAutostart.js'
import { checkLaunchdUserAvailable, checkSystemdUserAvailable } from './setupChecks.js'
import { installSystemdUserService, removeSystemdUserService } from './systemdUserAutostart.js'

function isMissingConfigError(err) {
  return String(err?.message ?? '').includes('Missing config:')
}

export function chooseUserServiceMethod({
  preferredMethod = null,
  systemdAvailable = false,
  launchdAvailable = false
} = {}) {
  const preferred = String(preferredMethod ?? '').trim()
  if (preferred === 'systemd-user' && systemdAvailable) return preferred
  if (preferred === 'launchd-user' && launchdAvailable) return preferred
  if (systemdAvailable) return 'systemd-user'
  if (launchdAvailable) return 'launchd-user'
  return preferred || null
}

export async function resolveInstallUserServiceMethod(preferredMethod = null) {
  const [systemdAvailable, launchdAvailable] = await Promise.all([
    checkSystemdUserAvailable(),
    checkLaunchdUserAvailable()
  ])
  const method = chooseUserServiceMethod({ preferredMethod, systemdAvailable, launchdAvailable })
  if (!method || !((method === 'systemd-user' && systemdAvailable) || (method === 'launchd-user' && launchdAvailable))) {
    throw new Error('No supported user service manager is available on this machine')
  }
  return method
}

export async function resolveRemoveUserServiceMethod(preferredMethod = null) {
  const preferred = String(preferredMethod ?? '').trim()
  if (preferred) return preferred
  const [systemdAvailable, launchdAvailable] = await Promise.all([
    checkSystemdUserAvailable(),
    checkLaunchdUserAvailable()
  ])
  return chooseUserServiceMethod({ preferredMethod: null, systemdAvailable, launchdAvailable })
}

export function buildUserServiceInstallOptions(config, {
  execPath = process.execPath,
  env = process.env,
  currentReleasePath = getCurrentReleaseLinkPath()
} = {}) {
  return {
    description: config?.host?.enabled ? 'Rootgrid (Codex web UI + runner)' : 'Rootgrid (runner)',
    execStart: [execPath, join(currentReleasePath, 'src', 'cli.js')],
    workingDirectory: currentReleasePath,
    environment: {
      ...(env.PATH ? { PATH: env.PATH } : {}),
      ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {})
    }
  }
}

export function applyAutostartConfig(config, { enabled, method = null }) {
  return RootgridConfigSchema.parse({
    ...config,
    autostart: {
      enabled: Boolean(enabled),
      method: enabled ? String(method ?? '').trim() || null : null
    }
  })
}

export async function loadConfigIfPresent() {
  try {
    return await loadConfig()
  } catch (err) {
    if (isMissingConfigError(err)) return null
    throw err
  }
}

export async function saveConfig(config) {
  await writeJsonFile(getConfigPath(), config, { mode: 0o600 })
}

export async function installLocalManagedReleaseFromCurrentPackage({ source = 'manual-update' } = {}) {
  return await installManagedRelease({
    sourceRoot: getCurrentPackageRoot(),
    version: ROOTGRID_VERSION,
    source
  })
}

export async function installUserServiceForConfig(config, method = null) {
  const chosenMethod = method || await resolveInstallUserServiceMethod(config?.autostart?.method ?? null)
  const options = buildUserServiceInstallOptions(config)

  if (chosenMethod === 'systemd-user') {
    const result = await installSystemdUserService({
      serviceName: ROOTGRID_USER_SERVICE_NAME,
      ...options
    })
    if (!result.ok) throw new Error(result.error || 'systemd user service install failed')
    return { method: chosenMethod, unitPath: result.unitPath }
  }

  if (chosenMethod === 'launchd-user') {
    const result = await installLaunchdUserService(options)
    if (!result.ok) throw new Error(result.error || 'launchd user service install failed')
    return { method: chosenMethod, unitPath: result.unitPath }
  }

  throw new Error(`Unsupported user service method: ${chosenMethod || 'none'}`)
}

export async function removeUserService(method = null) {
  const chosenMethod = String(method ?? '').trim()
  if (!chosenMethod) throw new Error('Unable to determine which user service to remove')

  if (chosenMethod === 'systemd-user') {
    const result = await removeSystemdUserService({ serviceName: ROOTGRID_USER_SERVICE_NAME })
    if (!result.ok) throw new Error(result.error || 'systemd user service removal failed')
    return { method: chosenMethod, unitPath: result.unitPath }
  }

  if (chosenMethod === 'launchd-user') {
    const result = await removeLaunchdUserService()
    if (!result.ok) throw new Error(result.error || 'launchd user service removal failed')
    return { method: chosenMethod, unitPath: result.unitPath }
  }

  throw new Error(`Unsupported user service method: ${chosenMethod}`)
}
