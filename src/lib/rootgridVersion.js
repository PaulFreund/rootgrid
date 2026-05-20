import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

export function getRootgridPackageRoot() {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

export function readPackageVersion({
  packageRoot = getRootgridPackageRoot(),
  readFile = (path) => readFileSync(path, 'utf8')
} = {}) {
  try {
    const raw = readFile(resolve(packageRoot, 'package.json'))
    const parsed = JSON.parse(raw)
    return trimText(parsed?.version) ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function readManagedReleaseVersion({
  packageRoot = getRootgridPackageRoot(),
  readFile = (path) => readFileSync(path, 'utf8')
} = {}) {
  try {
    const raw = readFile(resolve(packageRoot, 'release.json'))
    const parsed = JSON.parse(raw)
    return trimText(parsed?.version)
  } catch {
    return null
  }
}

export function readGitCommitSuffix({
  packageRoot = getRootgridPackageRoot(),
  spawn = spawnSync
} = {}) {
  try {
    const result = spawn('git', ['-C', packageRoot, 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (Number(result?.status) !== 0) return null
    const sha = trimText(result?.stdout)
    return sha ? `g${sha}` : null
  } catch {
    return null
  }
}

export function deriveRootgridVersion({
  packageRoot = getRootgridPackageRoot(),
  readFile = (path) => readFileSync(path, 'utf8'),
  spawn = spawnSync
} = {}) {
  const releaseVersion = readManagedReleaseVersion({ packageRoot, readFile })
  if (releaseVersion) return releaseVersion

  const packageVersion = readPackageVersion({ packageRoot, readFile })
  const gitSuffix = readGitCommitSuffix({ packageRoot, spawn })
  if (!gitSuffix) return packageVersion
  if (packageVersion.includes(`+${gitSuffix}`) || packageVersion.endsWith(gitSuffix)) return packageVersion
  return `${packageVersion}+${gitSuffix}`
}

export const ROOTGRID_VERSION = deriveRootgridVersion()
