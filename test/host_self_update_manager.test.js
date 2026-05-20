import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  buildHostSelfRestartSpec,
  buildHostSelfUpdatePublicState,
  countWorkingHostSessions,
  createHostSelfUpdateManager,
  sanitizeRepoUrlForDisplay
} from '../src/server/hostSelfUpdateManager.js'

test('sanitizeRepoUrlForDisplay strips embedded credentials', () => {
  assert.equal(
    sanitizeRepoUrlForDisplay('https://token@github.com/org/rootgrid.git'),
    'org/rootgrid'
  )
  assert.equal(sanitizeRepoUrlForDisplay(null), '—')
})

test('countWorkingHostSessions counts running and starting sessions across pages', () => {
  const pages = [
    {
      sessions: [
        { sessionId: 's-1', updatedMs: 20 },
        { sessionId: 's-2', updatedMs: 10 }
      ],
      hasMoreBefore: true,
      nextBeforeUpdatedMs: 10,
      nextBeforeSessionId: 's-2'
    },
    {
      sessions: [
        { sessionId: 's-3', updatedMs: 5 }
      ],
      hasMoreBefore: false,
      nextBeforeUpdatedMs: null,
      nextBeforeSessionId: null
    }
  ]
  let pageIdx = 0
  const store = {
    listSessionsPage() {
      return pages[pageIdx++] ?? { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
    },
    getSession(sessionId) {
      if (sessionId === 's-1') return { turnState: 'running' }
      if (sessionId === 's-2') return { status: 'starting' }
      return { status: 'completed' }
    }
  }

  assert.equal(countWorkingHostSessions(store), 2)
})

test('buildHostSelfUpdatePublicState falls back to package root and defaults', () => {
  const out = buildHostSelfUpdatePublicState({
    host: {
      selfUpdate: {
        enabled: true
      }
    }
  })

  assert.equal(out.enabled, true)
  assert.equal(out.configured, false)
  assert.equal(out.mode, 'github-release')
  assert.equal(out.repo, '—')
  assert.equal(out.branch, 'main')
  assert.equal(out.channelTag, 'branch-main')
  assert.equal(out.assetName, 'rootgrid-managed-release.tgz')
  assert.equal(out.keepReleases, 3)
  assert.equal(out.restartMode, 'self')
})

test('buildHostSelfUpdatePublicState uses environment GitHub settings when config leaves them empty', () => {
  const out = buildHostSelfUpdatePublicState({
    host: {
      selfUpdate: {
        enabled: true,
        repo: null,
        branch: '',
        accessToken: null
      }
    }
  }, {
    env: {
      ROOTGRID_GITHUB_REPO: 'PaulFreund/rootgrid',
      ROOTGRID_GITHUB_BRANCH: 'stable',
      ROOTGRID_GITHUB_TOKEN: 'github-token'
    }
  })

  assert.equal(out.enabled, true)
  assert.equal(out.configured, true)
  assert.equal(out.repo, 'PaulFreund/rootgrid')
  assert.equal(out.branch, 'stable')
})

test('buildHostSelfUpdatePublicState lets environment self-update settings override config values', () => {
  const out = buildHostSelfUpdatePublicState({
    host: {
      selfUpdate: {
        enabled: false,
        repo: 'config-owner/config-repo',
        branch: 'config-branch',
        accessToken: 'config-token',
        assetName: 'config-release.tgz',
        keepReleases: 2,
        restartCommand: 'systemctl restart rootgrid'
      }
    }
  }, {
    env: {
      ROOTGRID_ENABLE_HOST_SELF_UPDATE: '1',
      ROOTGRID_GITHUB_REPO: 'env-owner/env-repo',
      ROOTGRID_GITHUB_BRANCH: 'env-branch',
      ROOTGRID_GITHUB_TOKEN: 'env-token',
      ROOTGRID_GITHUB_ASSET_NAME: 'env-release.tgz',
      ROOTGRID_HOST_KEEP_RELEASES: '7',
      ROOTGRID_HOST_RESTART_COMMAND: 'docker restart rootgrid'
    }
  })

  assert.equal(out.enabled, true)
  assert.equal(out.configured, true)
  assert.equal(out.repo, 'env-owner/env-repo')
  assert.equal(out.branch, 'env-branch')
  assert.equal(out.assetName, 'env-release.tgz')
  assert.equal(out.keepReleases, 7)
  assert.equal(out.restartMode, 'command')
})

test('buildHostSelfUpdatePublicState exposes installed and latest host release comparison', () => {
  const out = buildHostSelfUpdatePublicState({
    host: {
      selfUpdate: {
        enabled: true,
        repo: 'org/rootgrid',
        branch: 'main'
      }
    }
  }, {
    installed: {
      version: '1.2.3+g1111111',
      versionHash: 'g1111111',
      releaseId: 'rootgrid-1.2.3-test',
      bundleSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    },
    state: {
      latestInfo: {
        version: '1.2.4+g2222222',
        releaseId: 'rootgrid-1.2.4-test',
        bundleSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        releaseName: 'Branch channel: main'
      },
      latestCheckedAtMs: 1234
    }
  })

  assert.equal(out.installed.version, '1.2.3+g1111111')
  assert.equal(out.installed.releaseId, 'rootgrid-1.2.3-test')
  assert.equal(out.latest.version, '1.2.4+g2222222')
  assert.equal(out.latest.releaseId, 'rootgrid-1.2.4-test')
  assert.equal(out.latest.releaseName, 'Branch channel: main')
  assert.equal(out.latest.checkedAtMs, 1234)
  assert.equal(out.updateAvailable, true)
  assert.equal(out.upToDate, false)
})

test('buildHostSelfUpdatePublicState infers versions from release ids when version fields are missing', () => {
  const out = buildHostSelfUpdatePublicState({
    host: {
      selfUpdate: {
        enabled: true,
        repo: 'org/rootgrid',
        branch: 'main'
      }
    }
  }, {
    installed: {
      version: null,
      releaseId: 'rootgrid-1.2.3-2026-03-15T10-00-00Z-abcd1234',
      bundleSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    },
    state: {
      latestInfo: {
        version: null,
        releaseId: 'rootgrid-1.2.4-2026-03-15T11-00-00Z-abcd5678',
        bundleSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      },
      latestCheckedAtMs: 1234
    }
  })

  assert.equal(out.installed.version, '1.2.3')
  assert.equal(out.latest.version, '1.2.4')
  assert.equal(out.updateAvailable, true)
})

test('buildHostSelfRestartSpec targets the managed release CLI with the current node args', () => {
  const out = buildHostSelfRestartSpec({
    execPath: '/usr/bin/node',
    execArgv: ['--trace-warnings'],
    argv: ['/usr/bin/node', '/home/test/.rootgrid/current/src/cli.js'],
    env: { PATH: '/usr/bin', ROOTGRID_HOME_DIR: '/home/test/.rootgrid' },
    managedCliPath: '/home/test/.rootgrid/current/src/cli.js'
  })

  assert.equal(out.execPath, '/usr/bin/node')
  assert.deepEqual(out.args, [
    '/usr/bin/node',
    '--trace-warnings',
    '/home/test/.rootgrid/current/src/cli.js'
  ])
  assert.equal(out.env.PATH, '/usr/bin')
  assert.equal(out.env.ROOTGRID_HOME_DIR, '/home/test/.rootgrid')
  assert.equal(out.env.ROOTGRID_SKIP_MANAGED_REDIRECT, '1')
})

test('host self-update manager blocks while sessions are running', async () => {
  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repo: 'org/rootgrid',
          branch: 'main'
        }
      }
    },
    store: {
      listSessionsPage() {
        return {
          sessions: [{ sessionId: 's-1', updatedMs: 1 }],
          hasMoreBefore: false,
          nextBeforeUpdatedMs: null,
          nextBeforeSessionId: null
        }
      },
      getSession() {
        return { turnState: 'running' }
      }
    },
    packageRoot: '/repo/rootgrid',
    runCommand: async () => {
      throw new Error('runCommand should not be called when update is locked')
    },
    async fetchLatestReleaseInfo() {
      return null
    },
    isManagedRuntime: async () => true
  })

  await assert.rejects(
    () => manager.start(),
    (err) => {
      assert.equal(err?.statusCode, 409)
      assert.equal(err?.activeSessionCount, 1)
      return true
    }
  )
})

test('host self-update manager requires the host to run from the managed runtime', async () => {
  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repo: 'org/rootgrid',
          branch: 'main'
        }
      }
    },
    store: {
      listSessionsPage() {
        return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
      },
      getSession() {
        return null
      }
    },
    async fetchLatestReleaseInfo() {
      return null
    },
    isManagedRuntime: async () => false
  })

  await assert.rejects(
    () => manager.start(),
    (err) => {
      assert.equal(err?.statusCode, 409)
      assert.match(String(err?.message ?? ''), /managed host install/i)
      return true
    }
  )
})

test('host self-update manager includes latest GitHub release metadata in public state', async () => {
  let latestCalls = 0
  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repo: 'org/rootgrid',
          branch: 'stable',
          assetName: 'rootgrid-managed-release.tgz'
        }
      }
    },
    store: {
      listSessionsPage() {
        return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
      },
      getSession() {
        return null
      }
    },
    async fetchLatestReleaseInfo() {
      latestCalls += 1
      return {
        repo: 'org/rootgrid',
        branch: 'stable',
        tag: 'branch-stable',
        releaseName: 'Branch channel: stable',
        releaseId: 'rootgrid-9.9.9-test',
        version: '9.9.9+gabcdef123456',
        bundleSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        publishedAtMs: 1000
      }
    }
  })

  const out = await manager.getPublicState()

  assert.equal(latestCalls, 1)
  assert.equal(out.latest.version, '9.9.9+gabcdef123456')
  assert.equal(out.latest.releaseId, 'rootgrid-9.9.9-test')
  assert.equal(out.latest.bundleSha256, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
  assert.equal(out.latest.releaseName, 'Branch channel: stable')
})

test('host self-update manager downloads a GitHub release bundle, installs it, and re-execs the managed runtime by default', async () => {
  const execCalls = []
  let timerFn = null
  let archivePath = null

  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repo: 'https://github.com/org/rootgrid.git',
          branch: 'release',
          accessToken: 'github-token',
          assetName: 'rootgrid-managed-release.tgz',
          keepReleases: 5,
          restartCommand: null
        }
      }
    },
    store: {
      listSessionsPage() {
        return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
      },
      getSession() {
        return null
      }
    },
    async fetchLatestReleaseInfo() {
      return null
    },
    isManagedRuntime: async () => true,
    getTransferDir() {
      return tmpdir()
    },
    async getManagedCliPath() {
      return '/home/test/.rootgrid/current/src/cli.js'
    },
    async downloadReleaseBundle(input) {
      archivePath = input.outPath
      return {
        repo: 'org/rootgrid',
        branch: 'release',
        tag: 'branch-release',
        releaseName: 'Branch channel: release',
        assetName: 'rootgrid-managed-release.tgz',
        expectedSha256: 'abc123'
      }
    },
    async hashFile(path) {
      assert.equal(path, archivePath)
      return 'abc123'
    },
    async installReleaseBundle(input) {
      assert.equal(input.archivePath, archivePath)
      assert.equal(input.keep, 5)
      return {
        manifest: {
          releaseId: 'rootgrid-1.2.3-test',
          version: '1.2.3'
        }
      }
    },
    execProcess(execPath, args, env) {
      execCalls.push({ execPath, args, env })
    },
    setTimer(fn) {
      timerFn = fn
      return 1
    }
  })

  const result = await manager.start()
  assert.equal(result?.ok, true)
  assert.equal(result?.releaseId, 'rootgrid-1.2.3-test')
  assert.equal(result?.version, '1.2.3')
  assert.equal(result?.selfUpdate?.awaitingRestart, true)
  assert.equal(result?.selfUpdate?.restartMode, 'self')
  assert.equal(result?.message, 'Host update succeeded. Rootgrid is restarting.')

  const scheduled = manager.scheduleExit()
  assert.equal(scheduled, true)
  assert.equal(typeof timerFn, 'function')

  await timerFn()
  assert.equal(execCalls.length, 1)
  assert.equal(execCalls[0]?.execPath, process.execPath)
  assert.ok(execCalls[0]?.args?.includes('/home/test/.rootgrid/current/src/cli.js'))
  assert.equal(execCalls[0]?.env?.ROOTGRID_SKIP_MANAGED_REDIRECT, '1')
})

test('host self-update manager creates the transfer directory before mkdtemp', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-host-self-update-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const transferRoot = join(base, 'missing', 'releases')
  let archivePath = null

  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repo: 'https://github.com/org/rootgrid.git',
          branch: 'release',
          assetName: 'rootgrid-managed-release.tgz'
        }
      }
    },
    store: {
      listSessionsPage() {
        return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
      },
      getSession() {
        return null
      }
    },
    async fetchLatestReleaseInfo() {
      return null
    },
    isManagedRuntime: async () => true,
    getTransferDir() {
      return transferRoot
    },
    async downloadReleaseBundle(input) {
      archivePath = input.outPath
      return {
        repo: 'org/rootgrid',
        branch: 'release',
        tag: 'branch-release',
        assetName: 'rootgrid-managed-release.tgz',
        expectedSha256: null
      }
    },
    async hashFile(path) {
      assert.equal(path, archivePath)
      return 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    },
    async installReleaseBundle(input) {
      assert.equal(input.archivePath, archivePath)
      assert.equal(input.bundleSha256, 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
      return {
        manifest: {
          releaseId: 'rootgrid-1.2.3-test',
          version: '1.2.3'
        }
      }
    }
  })

  const result = await manager.start()
  assert.equal(result?.ok, true)
  assert.ok(String(dirname(archivePath ?? '')).startsWith(transferRoot))
  await access(transferRoot)
})

test('host self-update manager runs the configured restart command before exit when requested', async () => {
  const calls = []
  let exitCode = null
  let timerFn = null
  let archivePath = null

  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repo: 'https://github.com/org/rootgrid.git',
          branch: 'release',
          accessToken: 'github-token',
          assetName: 'rootgrid-managed-release.tgz',
          keepReleases: 5,
          restartCommand: 'docker restart rootgrid'
        }
      }
    },
    store: {
      listSessionsPage() {
        return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
      },
      getSession() {
        return null
      }
    },
    runCommand: async (command, args = [], opts = {}) => {
      calls.push({ command, args, opts })
      return { ok: true, stdout: '', stderr: '' }
    },
    async fetchLatestReleaseInfo() {
      return null
    },
    isManagedRuntime: async () => true,
    getTransferDir() {
      return tmpdir()
    },
    async downloadReleaseBundle(input) {
      archivePath = input.outPath
      calls.push({ type: 'download', input })
      return {
        repo: 'org/rootgrid',
        branch: 'release',
        tag: 'branch-release',
        releaseName: 'Branch channel: release',
        assetName: 'rootgrid-managed-release.tgz',
        expectedSha256: 'abc123'
      }
    },
    async hashFile(path) {
      calls.push({ type: 'hash', path })
      return 'abc123'
    },
    async installReleaseBundle(input) {
      calls.push({ type: 'install', input })
      return {
        manifest: {
          releaseId: 'rootgrid-1.2.3-test',
          version: '1.2.3'
        }
      }
    },
    exitProcess(code) {
      exitCode = code
    },
    setTimer(fn) {
      timerFn = fn
      return 1
    }
  })

  const result = await manager.start()
  assert.equal(result?.ok, true)
  assert.equal(result?.releaseId, 'rootgrid-1.2.3-test')
  assert.equal(result?.version, '1.2.3')
  assert.equal(result?.selfUpdate?.awaitingRestart, true)
  assert.equal(result?.selfUpdate?.restartMode, 'command')

  const scheduled = manager.scheduleExit()
  assert.equal(scheduled, true)

  const downloadCall = calls.find((entry) => entry.type === 'download')
  assert.equal(downloadCall?.input?.repoSpec, 'https://github.com/org/rootgrid.git')
  assert.equal(downloadCall?.input?.branch, 'release')
  assert.equal(downloadCall?.input?.accessToken, 'github-token')
  assert.equal(downloadCall?.input?.assetName, 'rootgrid-managed-release.tgz')
  assert.equal(downloadCall?.input?.outPath, archivePath)

  const hashCall = calls.find((entry) => entry.type === 'hash')
  assert.equal(hashCall?.path, archivePath)

  const installCall = calls.find((entry) => entry.type === 'install')
  assert.equal(installCall?.input?.archivePath, archivePath)
  assert.equal(installCall?.input?.keep, 5)

  assert.equal(typeof timerFn, 'function')
  await timerFn()
  const shellCalls = calls
    .filter((entry) => entry.command === '/bin/sh')
    .map((entry) => ({
      args: entry.args.join(' '),
      detached: entry.opts.detached === true,
      wait: entry.opts.wait !== false
    }))
  assert.deepEqual(shellCalls, [
    { args: '-lc docker restart rootgrid', detached: true, wait: false }
  ])
  assert.equal(exitCode, 0)
})
