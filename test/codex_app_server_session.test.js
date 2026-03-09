import test from 'node:test'
import assert from 'node:assert/strict'

import { CodexAppServerSession } from '../src/runner/sessions/CodexAppServerSession.js'

test('CodexAppServerSession surfaces turn-start compatibility retries as session errors', async () => {
  const emitted = []
  const session = new CodexAppServerSession({
    sessionId: 'session-1',
    cwd: '/repo',
    options: {
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      reasoningEffort: 'xhigh'
    },
    emit: (type, payload) => emitted.push({ type, payload })
  })

  let turnStartAttempts = 0
  session.rpc = {
    start: async () => {},
    sendNotification: () => {},
    stop: () => {},
    sendRequest: async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        turnStartAttempts += 1
        if (turnStartAttempts === 1) {
          throw new Error('Invalid request: invalid type: string "dangerFullAccess", expected internally tagged enum SandboxPolicy')
        }
        return { ok: true, params }
      }
      throw new Error(`unexpected request: ${method}`)
    }
  }

  await session.start('hello')

  assert.equal(turnStartAttempts, 2)
  assert.ok(emitted.some((entry) => {
    return entry.type === 'session.error' &&
      entry.payload?.willRetry === true &&
      entry.payload?.message === 'Retrying turn start with Codex compatibility fallback' &&
      String(entry.payload?.details ?? '').includes('expected internally tagged enum SandboxPolicy')
  }))
})

