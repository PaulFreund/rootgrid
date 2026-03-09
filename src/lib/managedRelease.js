import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  getCurrentReleaseLinkPath,
  getReleaseBundlesDir,
  getReleaseTransfersDir,
  getReleasesDir,
  getRootgridDir
} from './paths.js'

export const ROOTGRID_USER_SERVICE_NAME = 'rootgrid'
export const ROOTGRID_LAUNCHD_LABEL = 'dev.rootgrid.rootgrid'
export const RELEASE_MANIFEST_FILENAME = 'release.json'
export const RUNTIME_COPY_ENTRIES = Object.freeze([
  'src',
  'package.json',
  'node_modules',
  join('web', 'dist')
])

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

export function getCurrentPackageRoot() {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

export function buildReleaseId(version = '0.0.0') {
  const safeVersion = String(version ?? '0.0.0').trim() || '0.0.0'
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return `rootgrid-${safeVersion}-${stamp}-${crypto.randomUUID().slice(0, 8)}`
}

export function buildReleaseManifest({
  releaseId,
  version,
  createdAtMs = Date.now(),
  source = 'local',
  platform = process.platform,
  arch = process.arch,
  node = process.versions.node
}) {
  return {
    releaseId,
    version,
    createdAtMs,
    source,
    platform,
    arch,
    node
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function writeReleaseManifest(releaseDir, manifest) {
  await writeFile(join(releaseDir, RELEASE_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
}

export async function readReleaseManifest(releaseDir) {
  const raw = await readFile(join(releaseDir, RELEASE_MANIFEST_FILENAME), 'utf8')
  return JSON.parse(raw)
}

export async function stageManagedRelease({
  sourceRoot = getCurrentPackageRoot(),
  releaseDir,
  manifest
}) {
  if (!releaseDir) throw new Error('releaseDir is required')
  const root = resolve(sourceRoot)

  await rm(releaseDir, { recursive: true, force: true })
  await mkdir(releaseDir, { recursive: true, mode: 0o700 })

  for (const entry of RUNTIME_COPY_ENTRIES) {
    const from = join(root, entry)
    if (!(await pathExists(from))) continue
    const to = join(releaseDir, entry)
    await mkdir(join(to, '..'), { recursive: true, mode: 0o700 })
    await cp(from, to, {
      recursive: true,
      preserveTimestamps: true,
      force: true
    })
  }

  if (manifest) await writeReleaseManifest(releaseDir, manifest)
  return releaseDir
}

export async function switchCurrentRelease(releaseDir, { rootgridDir = getRootgridDir() } = {}) {
  const currentPath = getCurrentReleaseLinkPath()
  const tempPath = `${currentPath}.tmp-${crypto.randomUUID()}`
  const target = resolve(releaseDir)

  await mkdir(rootgridDir, { recursive: true, mode: 0o700 })
  await rm(tempPath, { recursive: true, force: true })
  await symlink(target, tempPath)
  await rename(tempPath, currentPath)
  return currentPath
}

export async function installManagedRelease({
  sourceRoot = getCurrentPackageRoot(),
  version = '0.0.0',
  releaseId = buildReleaseId(version),
  rootgridDir = getRootgridDir(),
  source = 'local'
}) {
  const releasesDir = getReleasesDir()
  const releaseDir = join(releasesDir, releaseId)
  const manifest = buildReleaseManifest({ releaseId, version, source })
  await mkdir(releasesDir, { recursive: true, mode: 0o700 })
  await stageManagedRelease({ sourceRoot, releaseDir, manifest })
  await switchCurrentRelease(releaseDir, { rootgridDir })
  return { releaseDir, manifest }
}

function runCommand(command, args, { cwd = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`${command} timed out`))
    }, timeoutMs)

    child.stdout?.on('data', (buf) => {
      stdout += String(buf)
    })
    child.stderr?.on('data', (buf) => {
      stderr += String(buf)
    })

    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code=${code} signal=${signal}`))
    })
  })
}

export async function hashFileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function createManagedReleaseBundle({
  sourceRoot = getCurrentPackageRoot(),
  version = '0.0.0',
  releaseId = buildReleaseId(version),
  outDir = getReleaseBundlesDir(),
  source = 'host'
}) {
  const bundlePath = join(outDir, `${releaseId}.tgz`)
  const manifestDir = join(outDir, `${releaseId}.manifest`)
  const manifestPath = join(manifestDir, RELEASE_MANIFEST_FILENAME)
  const manifest = buildReleaseManifest({ releaseId, version, source })

  await mkdir(outDir, { recursive: true, mode: 0o700 })
  await rm(manifestDir, { recursive: true, force: true })
  await rm(bundlePath, { force: true })

  try {
    await mkdir(manifestDir, { recursive: true, mode: 0o700 })
    await writeReleaseManifest(manifestDir, manifest)

    const entries = []
    for (const entry of RUNTIME_COPY_ENTRIES) {
      if (await pathExists(join(sourceRoot, entry))) entries.push(entry)
    }
    await runCommand(
      'tar',
      ['-czf', bundlePath, '-C', sourceRoot, ...entries, '-C', manifestDir, RELEASE_MANIFEST_FILENAME],
      { cwd: outDir, timeoutMs: 5 * 60_000 }
    )
    const sha256 = await hashFileSha256(bundlePath)
    const info = await stat(bundlePath)
    return {
      bundlePath,
      filename: basename(bundlePath),
      releaseId,
      version,
      sizeBytes: info.size,
      sha256,
      manifest
    }
  } finally {
    await rm(manifestDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function extractManagedReleaseBundle({ archivePath, targetDir }) {
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true, mode: 0o700 })
  await runCommand('tar', ['-xzf', archivePath, '-C', targetDir])
  return await readReleaseManifest(targetDir)
}

export async function pruneOldManagedReleases({
  keep = 3,
  rootgridDir = getRootgridDir(),
  excludeReleaseIds = []
} = {}) {
  const releasesDir = getReleasesDir()
  const exclude = new Set((Array.isArray(excludeReleaseIds) ? excludeReleaseIds : []).map((value) => String(value ?? '').trim()).filter(Boolean))

  let currentReal = null
  try {
    currentReal = await realpath(getCurrentReleaseLinkPath())
  } catch {
  }

  let entries = []
  try {
    entries = await readdir(releasesDir, { withFileTypes: true })
  } catch {
    return 0
  }

  const manifests = []
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) continue
    const releaseId = String(ent.name ?? '').trim()
    if (!releaseId) continue
    const releaseDir = join(releasesDir, releaseId)
    if (exclude.has(releaseId)) continue
    if (currentReal && resolve(releaseDir) === currentReal) continue
    try {
      const manifest = await readReleaseManifest(releaseDir)
      manifests.push({
        releaseId,
        releaseDir,
        createdAtMs: Number(manifest?.createdAtMs ?? 0) || 0
      })
    } catch {
    }
  }

  manifests.sort((a, b) => b.createdAtMs - a.createdAtMs)
  const remove = manifests.slice(Math.max(0, Number(keep) || 0))
  for (const row of remove) {
    await rm(row.releaseDir, { recursive: true, force: true }).catch(() => {})
  }
  return remove.length
}

export async function getManagedReleaseCliPath() {
  const target = join(getCurrentReleaseLinkPath(), 'src', 'cli.js')
  try {
    await access(target)
    return target
  } catch {
    return null
  }
}

export async function isCurrentProcessUsingManagedRelease() {
  const currentCli = await getManagedReleaseCliPath()
  if (!currentCli) return false
  const currentArgv = trimText(process.argv?.[1])
  if (!currentArgv) return false
  try {
    const [a, b] = await Promise.all([realpath(currentArgv), realpath(currentCli)])
    return a === b
  } catch {
    return false
  }
}

export {
  getReleaseBundlesDir,
  getReleaseTransfersDir,
  getReleasesDir,
  getCurrentReleaseLinkPath
}
