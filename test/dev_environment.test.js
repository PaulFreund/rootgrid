import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readJsonFile } from '../src/lib/jsonFile.js'
import {
  buildSeededDevConfig,
  ensureDevConfig,
  resolveDevEnvironment
} from '../scripts/devEnvironment.js'

test('resolveDevEnvironment isolates npm run dev into a home-level dev Rootgrid directory by default', () => {
  const env = resolveDevEnvironment({
    repoDir: '/tmp/rootgrid-repo',
    env: {
      HOME: '/tmp/home'
    }
  })

  assert.equal(env.ROOTGRID_HOME_DIR, '/tmp/home/.rootgrid-dev')
  assert.equal(env.ROOTGRID_DISABLE_AUTO_MANAGED_RUNTIME, '1')
  assert.equal(env.ROOTGRID_SKIP_MANAGED_REDIRECT, '1')
})

test('resolveDevEnvironment preserves an explicit ROOTGRID_HOME_DIR override', () => {
  const env = resolveDevEnvironment({
    repoDir: '/tmp/rootgrid-repo',
    env: {
      ROOTGRID_HOME_DIR: '/tmp/custom-rootgrid-home'
    }
  })

  assert.equal(env.ROOTGRID_HOME_DIR, '/tmp/custom-rootgrid-home')
})

test('buildSeededDevConfig disables autostart and isolates machine/host identity for dev', () => {
  const config = buildSeededDevConfig({
    version: 1,
    retentionDays: 30,
    notifications: {
      sseToasts: 'if-not-visible',
      webPush: 'if-not-visible',
      sound: false
    },
    debug: {
      codexRawCapture: {
        enabled: false,
        dir: null
      }
    },
    autostart: {
      enabled: true,
      method: 'systemd-user'
    },
    runner: {
      enabled: true,
      machineId: 'machine-1',
      machineName: 'Laptop'
    },
    host: {
      enabled: true,
      listen: {
        host: '127.0.0.1',
        port: 7337
      },
      publicUrl: 'https://example.test',
      trustProxy: true,
      auth: {
        clientToken: 'aaaaaaaaaaaaaaaa',
        runnerToken: 'bbbbbbbbbbbbbbbb'
      }
    },
    upstream: {
      enabled: true,
      url: 'https://rootgrid.example.test',
      runnerToken: 'cccccccccccccccc'
    }
  })

  assert.deepEqual(config.autostart, {
    enabled: false,
    method: null
  })
  assert.equal(config.host.listen.port, 7338)
  assert.equal(config.host.publicUrl, null)
  assert.equal(config.host.trustProxy, false)
  assert.equal(config.runner.machineId, 'machine-1-dev')
  assert.equal(config.runner.machineName, 'Laptop (dev)')
})

test('ensureDevConfig seeds a repo-local dev config from the primary Rootgrid config when missing', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'rootgrid-dev-repo-'))
  const primaryHome = await mkdtemp(join(tmpdir(), 'rootgrid-home-'))
  const primaryConfigPath = join(primaryHome, '.rootgrid', 'config.json')

  const primaryConfig = {
    version: 1,
    retentionDays: 30,
    notifications: {
      sseToasts: 'if-not-visible',
      webPush: 'if-not-visible',
      sound: false
    },
    debug: {
      codexRawCapture: {
        enabled: false,
        dir: null
      }
    },
    autostart: {
      enabled: true,
      method: 'systemd-user'
    },
    runner: {
      enabled: true,
      machineId: 'machine-2',
      machineName: 'Desktop'
    },
    host: {
      enabled: true,
      listen: {
        host: '127.0.0.1',
        port: 7444
      },
      publicUrl: null,
      trustProxy: false,
      auth: {
        clientToken: 'dddddddddddddddd',
        runnerToken: 'eeeeeeeeeeeeeeee'
      }
    },
    upstream: {
      enabled: false,
      url: null,
      runnerToken: null
    }
  }

  const { writeJsonFile } = await import('../src/lib/jsonFile.js')
  await writeJsonFile(primaryConfigPath, primaryConfig)

  const result = await ensureDevConfig({
    repoDir,
    env: {
      HOME: primaryHome
    }
  })

  assert.equal(result.created, true)
  assert.equal(result.sourcePath, primaryConfigPath)
  const seeded = await readJsonFile(result.configPath)
  assert.equal(seeded.autostart.enabled, false)
  assert.equal(seeded.host.listen.port, 7445)
  assert.equal(seeded.runner.machineId, 'machine-2-dev')
  assert.equal(seeded.runner.machineName, 'Desktop (dev)')
})
