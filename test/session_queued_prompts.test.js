import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applySessionQueuedPrompts,
  refreshSessionQueuedPrompts
} from '../web/src/lib/sessionQueuedPrompts.js'

test('applySessionQueuedPrompts replaces queue contents and clears queueSending', () => {
  const store = {
    queuedPrompts: [{ promptId: 'old-1' }],
    queueSending: true
  }

  assert.equal(applySessionQueuedPrompts(store, [{ promptId: 'new-1' }]), true)
  assert.deepEqual(store.queuedPrompts, [{ promptId: 'new-1' }])
  assert.equal(store.queueSending, false)
})

test('refreshSessionQueuedPrompts reloads the selected session queue from the API', async () => {
  const store = {
    queuedPrompts: [{ promptId: 'old-1' }],
    queueSending: true
  }
  const stores = new Map([['session-1', store]])
  const upserts = []

  const ok = await refreshSessionQueuedPrompts({
    sessionId: 'session-1',
    apiFetch: async (path) => {
      assert.equal(path, '/api/sessions/session-1')
      return {
        ok: true,
        async json() {
          return {
            session: { sessionId: 'session-1', title: 'Fresh state' },
            queuedPrompts: [{ promptId: 'fresh-1', text: 'later' }]
          }
        }
      }
    },
    getSessionStore: (sessionId) => stores.get(sessionId),
    upsertSessionRow: (row) => upserts.push(row),
    shouldApply: (sessionId) => sessionId === 'session-1'
  })

  assert.equal(ok, true)
  assert.deepEqual(upserts, [{ sessionId: 'session-1', title: 'Fresh state' }])
  assert.deepEqual(store.queuedPrompts, [{ promptId: 'fresh-1', text: 'later' }])
  assert.equal(store.queueSending, false)
})

test('refreshSessionQueuedPrompts skips stale responses when shouldApply rejects them', async () => {
  const store = {
    queuedPrompts: [{ promptId: 'old-1' }],
    queueSending: true
  }

  const ok = await refreshSessionQueuedPrompts({
    sessionId: 'session-1',
    apiFetch: async () => ({
      ok: true,
      async json() {
        return {
          session: { sessionId: 'session-1', title: 'Fresh state' },
          queuedPrompts: []
        }
      }
    }),
    getSessionStore: () => store,
    shouldApply: () => false
  })

  assert.equal(ok, false)
  assert.deepEqual(store.queuedPrompts, [{ promptId: 'old-1' }])
  assert.equal(store.queueSending, true)
})
