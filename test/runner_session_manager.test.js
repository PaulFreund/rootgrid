import test from 'node:test'
import assert from 'node:assert/strict'

import { RunnerSessionManager } from '../src/runner/sessionManager.js'

function createHarness({ tools, createSession = null } = {}) {
  const envelopes = []
  const manager = new RunnerSessionManager({
    machineId: 'machine-1',
    send: (envelope) => {
      envelopes.push(envelope)
      return true
    },
    tools,
    createSession,
    makeEnvelope: ({ type, scope, payload, track = true }) => ({ type, scope, payload, track })
  })
  return { manager, envelopes }
}

test('runner session manager reports missing Codex before starting a session', async () => {
  const { manager, envelopes } = createHarness({
    tools: {
      async getPublicState() {
        return {
          codex: {
            id: 'codex',
            label: 'Codex',
            installed: false,
            path: '/root/.rootgrid/tools/codex/npm-global/bin/codex'
          }
        }
      }
    }
  })

  await manager.handleHostEnvelope({
    type: 'session.start',
    payload: {
      requestId: 'req-1',
      sessionId: 'session-1',
      cwd: '/repo',
      prompt: 'hello'
    }
  })

  assert.deepEqual(envelopes.map((env) => env.type), [
    'session.command.accepted',
    'session.error',
    'session.status'
  ])
  assert.equal(envelopes[1]?.payload?.code, 'codex_missing')
  assert.match(String(envelopes[1]?.payload?.details ?? ''), /Configured Codex binary is missing/i)
  assert.equal(
    envelopes[2]?.payload?.error,
    'Codex is not installed on this runner. Open Settings > Machines and install managed Codex first.'
  )
})

test('runner session manager reports missing Codex before resuming a session', async () => {
  const { manager, envelopes } = createHarness({
    tools: {
      async getPublicState() {
        return {
          codex: {
            id: 'codex',
            label: 'Codex',
            installed: false,
            path: null
          }
        }
      }
    }
  })

  await manager.handleHostEnvelope({
    type: 'session.send',
    payload: {
      requestId: 'req-2',
      sessionId: 'session-2',
      cwd: '/repo',
      text: 'follow up'
    }
  })

  assert.deepEqual(envelopes.map((env) => env.type), [
    'session.command.accepted',
    'session.error',
    'session.status'
  ])
  assert.equal(envelopes[1]?.payload?.code, 'codex_missing')
  assert.equal(
    envelopes[2]?.payload?.error,
    'Codex is not installed on this runner. Open Settings > Machines and install managed Codex first.'
  )
})

test('runner session manager normalizes Codex ENOENT startup failures', async () => {
  let refreshes = 0
  const { manager, envelopes } = createHarness({
    tools: {
      async getPublicState() {
        return {
          codex: {
            id: 'codex',
            label: 'Codex',
            installed: true,
            path: '/root/.rootgrid/tools/codex/npm-global/bin/codex'
          }
        }
      },
      async refreshAll() {
        refreshes += 1
      }
    },
    createSession() {
      return {
        async start() {
          const err = new Error('spawn /root/.rootgrid/tools/codex/npm-global/bin/codex ENOENT')
          err.code = 'ENOENT'
          throw err
        }
      }
    }
  })

  await manager.handleHostEnvelope({
    type: 'session.start',
    payload: {
      requestId: 'req-3',
      sessionId: 'session-3',
      cwd: '/repo',
      prompt: 'hello'
    }
  })

  assert.equal(refreshes, 1)
  assert.deepEqual(envelopes.map((env) => env.type), [
    'session.command.accepted',
    'session.error',
    'session.status'
  ])
  assert.equal(envelopes[1]?.payload?.code, 'codex_missing')
  assert.match(String(envelopes[1]?.payload?.details ?? ''), /spawn .*codex.*ENOENT/i)
  assert.equal(
    envelopes[2]?.payload?.error,
    'Codex is not installed on this runner. Open Settings > Machines and install managed Codex first.'
  )
})
