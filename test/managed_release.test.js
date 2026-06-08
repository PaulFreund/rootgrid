import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createManagedReleaseBundle,
  installManagedRelease,
  installManagedReleaseFromBundle,
  pruneStaleManagedReleaseArtifacts,
  switchCurrentRelease
} from '../src/lib/managedRelease.js'

async function createFakeSourceRoot(baseDir, version = '1.2.3') {
  const root = join(baseDir, 'source')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'zod'), { recursive: true })
  await mkdir(join(root, 'web', 'dist'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'rootgrid', version }, null, 2))
  await writeFile(join(root, 'src', 'cli.js'), 'console.log("hello")\n')
  await writeFile(join(root, 'node_modules', 'zod', 'package.json'), '{"name":"zod"}\n')
  await writeFile(join(root, 'web', 'dist', 'index.html'), '<html></html>\n')
  return root
}

function isolateRootgridEnv(t, rootgridHome) {
  const previousHome = process.env.ROOTGRID_HOME_DIR
  const previousRuntime = process.env.ROOTGRID_RUNTIME_DIR
  const previousInstall = process.env.ROOTGRID_INSTALL_DIR
  process.env.ROOTGRID_HOME_DIR = rootgridHome
  process.env.ROOTGRID_RUNTIME_DIR = rootgridHome
  process.env.ROOTGRID_INSTALL_DIR = rootgridHome
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROOTGRID_HOME_DIR
    else process.env.ROOTGRID_HOME_DIR = previousHome
    if (previousRuntime === undefined) delete process.env.ROOTGRID_RUNTIME_DIR
    else process.env.ROOTGRID_RUNTIME_DIR = previousRuntime
    if (previousInstall === undefined) delete process.env.ROOTGRID_INSTALL_DIR
    else process.env.ROOTGRID_INSTALL_DIR = previousInstall
  })
}

test('installManagedReleaseFromBundle switches current to the bundled release', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-managed-release-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const rootgridHome = join(base, 'home', '.rootgrid')
  isolateRootgridEnv(t, rootgridHome)

  await mkdir(join(rootgridHome, 'releases'), { recursive: true })
  const currentRelease = join(rootgridHome, 'releases', 'current-old')
  await mkdir(join(currentRelease, 'src'), { recursive: true })
  await writeFile(join(currentRelease, 'src', 'cli.js'), 'console.log("old")\n')
  await switchCurrentRelease(currentRelease)

  const sourceRoot = await createFakeSourceRoot(base, '2.0.0')
  const bundle = await createManagedReleaseBundle({
    sourceRoot,
    version: '2.0.0',
    outDir: join(base, 'bundles'),
    source: 'test'
  })

  const installed = await installManagedReleaseFromBundle({
    archivePath: bundle.bundlePath,
    keep: 2,
    bundleSha256: bundle.sha256
  })

  assert.equal(installed.manifest.version, '2.0.0')
  const manifest = JSON.parse(await readFile(join(rootgridHome, 'current', 'release.json'), 'utf8'))
  assert.equal(manifest.version, '2.0.0')
  assert.equal(manifest.bundleSha256, bundle.sha256)
})

test('installManagedRelease prunes older local managed releases', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-managed-local-release-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const rootgridHome = join(base, 'home', '.rootgrid')
  isolateRootgridEnv(t, rootgridHome)

  const sourceRoot = await createFakeSourceRoot(base, '4.0.0')
  await mkdir(join(rootgridHome, 'releases'), { recursive: true })
  for (const [releaseId, createdAtMs] of [
    ['rootgrid-old-1', 1000],
    ['rootgrid-old-2', 2000],
    ['rootgrid-old-3', 3000]
  ]) {
    const releaseDir = join(rootgridHome, 'releases', releaseId)
    await mkdir(releaseDir, { recursive: true })
    await writeFile(join(releaseDir, 'release.json'), `${JSON.stringify({ releaseId, version: 'old', createdAtMs })}\n`)
  }

  const installed = await installManagedRelease({
    sourceRoot,
    version: '4.0.0',
    releaseId: 'rootgrid-current',
    source: 'test',
    keep: 2
  })

  const entries = await readdir(join(rootgridHome, 'releases'))
  assert.ok(entries.includes('rootgrid-current'))
  assert.ok(entries.includes('rootgrid-old-3'))
  assert.ok(entries.includes('rootgrid-old-2'))
  assert.ok(!entries.includes('rootgrid-old-1'))
  assert.equal(installed.manifest.releaseId, 'rootgrid-current')
})

test('createManagedReleaseBundle prunes stale cached bundles', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-managed-bundles-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const sourceRoot = await createFakeSourceRoot(base, '3.0.0')
  const bundlesDir = join(base, 'bundles')
  const oldOne = await createManagedReleaseBundle({
    sourceRoot,
    version: '3.0.0',
    releaseId: 'rootgrid-test-old-1',
    outDir: bundlesDir,
    source: 'test',
    keepBundles: 50
  })
  const oldTwo = await createManagedReleaseBundle({
    sourceRoot,
    version: '3.0.0',
    releaseId: 'rootgrid-test-old-2',
    outDir: bundlesDir,
    source: 'test',
    keepBundles: 50
  })
  const oldThree = await createManagedReleaseBundle({
    sourceRoot,
    version: '3.0.0',
    releaseId: 'rootgrid-test-old-3',
    outDir: bundlesDir,
    source: 'test',
    keepBundles: 50
  })

  const nowSeconds = Math.floor(Date.now() / 1000)
  await utimes(oldOne.bundlePath, nowSeconds - 30, nowSeconds - 30)
  await utimes(oldTwo.bundlePath, nowSeconds - 20, nowSeconds - 20)
  await utimes(oldThree.bundlePath, nowSeconds - 10, nowSeconds - 10)
  await mkdir(join(bundlesDir, `${oldOne.releaseId}.manifest`), { recursive: true })
  await writeFile(join(bundlesDir, `${oldOne.releaseId}.manifest`, 'release.json'), '{}\n')
  await writeFile(join(bundlesDir, 'notes.txt'), 'not a bundle\n')

  const current = await createManagedReleaseBundle({
    sourceRoot,
    version: '3.0.1',
    releaseId: 'rootgrid-test-current',
    outDir: bundlesDir,
    source: 'test',
    keepBundles: 2
  })

  const entries = await readdir(bundlesDir)
  assert.deepEqual(entries.filter((name) => name.endsWith('.tgz')).sort(), [
    `${current.releaseId}.tgz`,
    `${oldThree.releaseId}.tgz`
  ].sort())
  assert.ok(entries.includes('notes.txt'))
  assert.ok(!entries.includes(`${oldOne.releaseId}.manifest`))
})

test('pruneStaleManagedReleaseArtifacts removes stale update leftovers only', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-managed-stale-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const rootgridHome = join(base, 'home', '.rootgrid')
  isolateRootgridEnv(t, rootgridHome)

  const nowMs = 10_000_000_000
  const oldSeconds = (nowMs - 3 * 60 * 60 * 1000) / 1000
  const freshSeconds = (nowMs - 10 * 60 * 1000) / 1000
  const releasesDir = join(rootgridHome, 'releases')
  const transfersDir = join(rootgridHome, 'tmp', 'releases')
  const bundlesDir = join(rootgridHome, 'tmp', 'bundles')
  await mkdir(join(releasesDir, '.pending-old'), { recursive: true })
  await mkdir(join(releasesDir, '.pending-fresh'), { recursive: true })
  await mkdir(join(rootgridHome, 'current.tmp-old'), { recursive: true })
  await symlink(join(releasesDir, 'target'), join(rootgridHome, 'current.tmp-fresh'))
  await mkdir(join(transfersDir, 'host-update-old'), { recursive: true })
  await mkdir(join(transfersDir, 'host-update-fresh'), { recursive: true })
  await writeFile(join(transfersDir, 'old.tgz'), 'old\n')
  await writeFile(join(transfersDir, 'fresh.tgz'), 'fresh\n')
  await mkdir(join(bundlesDir, 'old.manifest'), { recursive: true })
  await mkdir(join(bundlesDir, 'fresh.manifest'), { recursive: true })

  for (const path of [
    join(releasesDir, '.pending-old'),
    join(rootgridHome, 'current.tmp-old'),
    join(transfersDir, 'host-update-old'),
    join(transfersDir, 'old.tgz'),
    join(bundlesDir, 'old.manifest')
  ]) {
    await utimes(path, oldSeconds, oldSeconds)
  }
  for (const path of [
    join(releasesDir, '.pending-fresh'),
    join(rootgridHome, 'current.tmp-fresh'),
    join(transfersDir, 'host-update-fresh'),
    join(transfersDir, 'fresh.tgz'),
    join(bundlesDir, 'fresh.manifest')
  ]) {
    await utimes(path, freshSeconds, freshSeconds).catch(() => {})
  }

  const result = await pruneStaleManagedReleaseArtifacts({
    staleAgeMs: 60 * 60 * 1000,
    nowMs
  })

  assert.deepEqual(result, {
    pendingReleaseDirsDeleted: 1,
    currentTempPathsDeleted: 1,
    transferDirsDeleted: 1,
    transferArchivesDeleted: 1,
    bundleManifestDirsDeleted: 1
  })

  assert.deepEqual((await readdir(releasesDir)).sort(), ['.pending-fresh'])
  assert.deepEqual((await readdir(transfersDir)).sort(), ['fresh.tgz', 'host-update-fresh'])
  assert.deepEqual((await readdir(bundlesDir)).sort(), ['fresh.manifest'])
  assert.deepEqual((await readdir(rootgridHome)).filter((name) => name.startsWith('current.tmp-')), ['current.tmp-fresh'])
})
