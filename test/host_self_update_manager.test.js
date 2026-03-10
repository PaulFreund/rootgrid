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
    sanitizeRepoUrlForDisplay('https://token@example.com/org/rootgrid.git'),
    'https://example.com/org/rootgrid.git'
  )
  assert.equal(sanitizeRepoUrlForDisplay(null), 'origin')
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
  }, {
    packageRoot: '/repo/rootgrid'
  })

  assert.equal(out.enabled, true)
  assert.equal(out.repo, 'origin')
  assert.equal(out.branch, 'main')
  assert.equal(out.workdir, '/repo/rootgrid')
  assert.equal(out.installCommand, 'npm ci')
  assert.equal(out.buildCommand, 'npm run build')
  assert.equal(out.restartMode, 'exit')
})

test('host self-update manager blocks while sessions are running', async () => {
  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
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
    }
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

test('host self-update manager runs fetch/build steps and schedules restart exit', async () => {
  const calls = []
  let exitCode = null
  let timerFn = null

  const manager = createHostSelfUpdateManager({
    config: {
      host: {
        selfUpdate: {
          enabled: true,
          repoUrl: 'https://token@example.com/org/rootgrid.git',
          branch: 'release',
          workdir: '/srv/rootgrid',
          installCommand: 'npm ci',
          buildCommand: 'npm run build',
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
      if (command === 'git' && args.includes('status')) return { ok: true, stdout: '', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
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
  assert.equal(result?.selfUpdate?.awaitingRestart, true)

  const scheduled = manager.scheduleExit()
  assert.equal(scheduled, true)

  const gitCalls = calls
    .filter((entry) => entry.command === 'git')
    .map((entry) => entry.args.join(' '))
  assert.deepEqual(gitCalls, [
    '-C /srv/rootgrid rev-parse --is-inside-work-tree',
    '-C /srv/rootgrid status --porcelain --untracked-files=no',
    '-C /srv/rootgrid fetch --depth 1 https://token@example.com/org/rootgrid.git release',
    '-C /srv/rootgrid checkout release',
    '-C /srv/rootgrid merge --ff-only FETCH_HEAD'
  ])

  const shellCalls = calls
    .filter((entry) => entry.command === '/bin/sh')
    .map((entry) => ({
      args: entry.args.join(' '),
      detached: entry.opts.detached === true,
      wait: entry.opts.wait !== false
    }))
  assert.deepEqual(shellCalls, [
    { args: '-lc npm ci', detached: false, wait: true },
    { args: '-lc npm run build', detached: false, wait: true },
    { args: '-lc docker restart rootgrid', detached: true, wait: false }
  ])

  assert.equal(typeof timerFn, 'function')
  timerFn()
  assert.equal(exitCode, 0)
})
