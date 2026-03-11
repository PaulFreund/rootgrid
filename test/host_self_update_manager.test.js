import test from 'node:test'
import assert from 'node:assert/strict'

import {
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
  assert.equal(out.mode, 'github-release')
  assert.equal(out.repo, '—')
  assert.equal(out.branch, 'main')
  assert.equal(out.channelTag, 'branch-main')
  assert.equal(out.assetName, 'rootgrid-managed-release.tgz')
  assert.equal(out.keepReleases, 3)
  assert.equal(out.restartMode, 'exit')
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

test('host self-update manager downloads a GitHub release bundle, installs it, and schedules restart exit', async () => {
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
    isManagedRuntime: async () => true,
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

  assert.equal(typeof timerFn, 'function')
  timerFn()
  assert.equal(exitCode, 0)
})
