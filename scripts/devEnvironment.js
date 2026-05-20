import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { RootgridConfigSchema } from '../src/config/schema.js'
import { readJsonFile, writeJsonFile } from '../src/lib/jsonFile.js'

export function getDefaultDevRootgridDir(env = process.env) {
  const home = String(env?.HOME ?? '').trim() || homedir()
  return join(home, '.rootgrid-dev')
}

export function getPrimaryRootgridDir(env = process.env) {
  const home = String(env?.HOME ?? '').trim() || homedir()
  return join(home, '.rootgrid')
}

export function resolveDevEnvironment({
  repoDir,
  env = process.env
} = {}) {
  void repoDir
  const sourceEnv = (env && typeof env === 'object') ? env : {}
  const existingHome = String(sourceEnv.ROOTGRID_HOME_DIR ?? '').trim()
  const rootgridHomeDir = existingHome || getDefaultDevRootgridDir(sourceEnv)

  return {
    ...sourceEnv,
    ROOTGRID_HOME_DIR: rootgridHomeDir,
    ROOTGRID_DISABLE_AUTO_MANAGED_RUNTIME: '1',
    ROOTGRID_SKIP_MANAGED_REDIRECT: '1'
  }
}

function appendDevSuffix(value, suffix = '-dev') {
  const base = String(value ?? '').trim()
  if (!base) return base
  if (base.endsWith(suffix)) return base
  return `${base}${suffix}`
}

function appendDevLabel(value) {
  const base = String(value ?? '').trim()
  if (!base) return 'Rootgrid Dev'
  if (/\(dev\)$/i.test(base)) return base
  return `${base} (dev)`
}

export function buildSeededDevConfig(input, {
  hostPortFallback = 7338
} = {}) {
  const parsed = RootgridConfigSchema.parse(input)
  const currentPort = Number(parsed?.host?.listen?.port ?? hostPortFallback)
  const nextPort = Number.isFinite(currentPort) ? (currentPort === 7337 ? 7338 : currentPort + 1) : hostPortFallback

  return RootgridConfigSchema.parse({
    ...parsed,
    autostart: {
      enabled: false,
      method: null
    },
    host: {
      ...parsed.host,
      publicUrl: null,
      trustProxy: false,
      listen: {
        ...parsed.host.listen,
        port: nextPort
      }
    },
    runner: {
      ...parsed.runner,
      machineId: appendDevSuffix(parsed.runner.machineId),
      machineName: appendDevLabel(parsed.runner.machineName)
    }
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDevConfig({
  repoDir,
  env = process.env
} = {}) {
  const devEnv = resolveDevEnvironment({ repoDir, env })
  const devConfigPath = join(devEnv.ROOTGRID_HOME_DIR, 'config.json')
  if (await exists(devConfigPath)) {
    return {
      created: false,
      configPath: devConfigPath,
      sourcePath: null
    }
  }

  const seedOverride = String(devEnv.ROOTGRID_DEV_SEED_CONFIG ?? '').trim()
  const primaryConfigPath = join(getPrimaryRootgridDir(devEnv), 'config.json')
  const sourcePath = seedOverride || ((await exists(primaryConfigPath)) ? primaryConfigPath : join(String(repoDir ?? process.cwd()), 'config.example.json'))
  const sourceConfig = await readJsonFile(sourcePath)
  const seededConfig = buildSeededDevConfig(sourceConfig)
  await writeJsonFile(devConfigPath, seededConfig, { mode: 0o600 })

  return {
    created: true,
    configPath: devConfigPath,
    sourcePath
  }
}
