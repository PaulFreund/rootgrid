import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createManagedReleaseBundle,
  installManagedReleaseFromBundle,
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

test('installManagedReleaseFromBundle switches current to the bundled release', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-managed-release-'))
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

  const sourceRoot = await createFakeSourceRoot(base, '2.0.0')
  const bundle = await createManagedReleaseBundle({
    sourceRoot,
    version: '2.0.0',
    outDir: join(base, 'bundles'),
    source: 'test'
  })

  const installed = await installManagedReleaseFromBundle({
    archivePath: bundle.bundlePath,
    keep: 2
  })

  assert.equal(installed.manifest.version, '2.0.0')
  const manifest = JSON.parse(await readFile(join(rootgridHome, 'current', 'release.json'), 'utf8'))
  assert.equal(manifest.version, '2.0.0')
})
