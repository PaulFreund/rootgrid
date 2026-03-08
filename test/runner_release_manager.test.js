import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createManagedReleaseBundle, switchCurrentRelease } from '../src/lib/managedRelease.js'
import { RunnerReleaseManager } from '../src/runner/runnerReleaseManager.js'

async function waitFor(check, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

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

test('runner release manager installs a received bundle and emits restart state', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-release-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const rootgridHome = join(base, 'home', '.rootgrid')
  const previousHome = process.env.ROOTGRID_HOME_DIR
  process.env.ROOTGRID_HOME_DIR = rootgridHome
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROOTGRID_HOME_DIR
    else process.env.ROOTGRID_HOME_DIR = previousHome
  })
  await mkdir(join(rootgridHome, 'releases'), { recursive: true })
  const currentRelease = join(rootgridHome, 'releases', 'current-old')
  await mkdir(join(currentRelease, 'src'), { recursive: true })
  await writeFile(join(currentRelease, 'src', 'cli.js'), 'console.log("old")\n')
  await switchCurrentRelease(currentRelease)

  const sourceRoot = await createFakeSourceRoot(base, '9.9.9')
  const bundle = await createManagedReleaseBundle({
    sourceRoot,
    version: '9.9.9',
    outDir: join(base, 'bundles'),
    source: 'test'
  })

  const events = []
  const restartCalls = []
  const manager = new RunnerReleaseManager({
    machineId: 'machine-1',
    autostart: { enabled: true, method: 'systemd-user' },
    upgrade: { enabled: true, keepReleases: 2 },
    restartService(method) {
      restartCalls.push(method)
      return true
    },
    emit(type, payload) {
      events.push({ type, payload })
    }
  })

  const originalArgv1 = process.argv[1]
  process.argv[1] = join(currentRelease, 'src', 'cli.js')
  t.after(() => {
    process.argv[1] = originalArgv1
  })

  const data = await readFile(bundle.bundlePath)
  await manager.begin({
    requestId: 'req-1',
    releaseId: bundle.releaseId,
    version: bundle.version,
    sha256: bundle.sha256,
    sizeBytes: bundle.sizeBytes
  })
  await manager.chunk({
    requestId: 'req-1',
    chunkBase64: data.toString('base64')
  })
  await manager.end({ requestId: 'req-1' })

  await waitFor(async () => {
    const raw = await readFile(join(rootgridHome, 'current', 'release.json'), 'utf8').catch(() => null)
    return raw ? JSON.parse(raw) : null
  })

  const manifest = JSON.parse(await readFile(join(rootgridHome, 'current', 'release.json'), 'utf8'))
  assert.equal(manifest.version, '9.9.9')
  assert.deepEqual(restartCalls, ['systemd-user'])
  assert.deepEqual(events.map((entry) => entry.type), [
    'machine.upgrade.state',
    'machine.upgrade.state',
    'machine.upgrade.state',
    'machine.upgrade.bundle.received',
    'machine.upgrade.state'
  ])
})
