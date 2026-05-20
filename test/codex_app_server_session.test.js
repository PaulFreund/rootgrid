import test from 'node:test'
import assert from 'node:assert/strict'

import { CodexAppServerSession } from '../src/runner/sessions/CodexAppServerSession.js'

test('CodexAppServerSession surfaces turn-start compatibility retries as session errors', async () => {
  const emitted = []
  const turnStartParams = []
  const session = new CodexAppServerSession({
    sessionId: 'session-1',
    cwd: '/repo',
    options: {
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      reasoningEffort: 'xhigh',
      serviceTier: 'fast'
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
        turnStartParams.push(params)
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
  assert.ok(turnStartParams.some((params) => params?.serviceTier === 'fast' || params?.service_tier === 'fast'))
  assert.ok(emitted.some((entry) => {
    return entry.type === 'session.error' &&
      entry.payload?.willRetry === true &&
      entry.payload?.message === 'Retrying turn start with Codex compatibility fallback' &&
      String(entry.payload?.details ?? '').includes('expected internally tagged enum SandboxPolicy')
  }))
})

test('CodexAppServerSession reports Codex auth failures from stderr', () => {
  const emitted = []
  const issues = []
  const session = new CodexAppServerSession({
    sessionId: 'session-auth-1',
    cwd: '/repo',
    options: null,
    emit: (type, payload) => emitted.push({ type, payload }),
    onAuthIssue: (issue) => issues.push(issue)
  })

  session.rpc.onStderr?.(`
2026-03-15T10:39:38.916725Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {
  "error": {
    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",
    "code": "refresh_token_reused"
  }
}
`)

  assert.equal(issues[0]?.code, 'refresh_token_reused')
  assert.match(issues[0]?.message ?? '', /log out and sign in again/i)
  assert.equal(emitted.some((entry) => {
    return entry.type === 'session.error'
      && entry.payload?.code === 'refresh_token_reused'
      && /log out and sign in again/i.test(String(entry.payload?.message ?? ''))
  }), true)
})
