import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'

function buildStore() {
  const store = new Store({ dbPath: ':memory:' })
  store.upsertMachine({
    machineId: 'm-1',
    machineName: 'runner',
    platform: 'linux',
    capabilities: null
  })
  return store
}

test('listSessionsPage uses stable updated_ms/session_id cursors', () => {
  const store = buildStore()

  store.createSession({
    sessionId: 's-c',
    machineId: 'm-1',
    cwd: '/tmp/3',
    status: 'idle'
  })
  store.createSession({
    sessionId: 's-b',
    machineId: 'm-1',
    cwd: '/tmp/2',
    status: 'idle'
  })
  store.createSession({
    sessionId: 's-a',
    machineId: 'm-1',
    cwd: '/tmp/1',
    status: 'idle'
  })

  store.db.prepare(`UPDATE sessions SET updated_ms=? WHERE session_id=?`).run(100, 's-c')
  store.db.prepare(`UPDATE sessions SET updated_ms=? WHERE session_id=?`).run(100, 's-b')
  store.db.prepare(`UPDATE sessions SET updated_ms=? WHERE session_id=?`).run(100, 's-a')

  const page1 = store.listSessionsPage({ limit: 2 })
  assert.equal(page1.sessions.length, 2)
  assert.deepEqual(page1.sessions.map((session) => session.sessionId), ['s-c', 's-b'])
  assert.equal(page1.hasMoreBefore, true)

  const page2 = store.listSessionsPage({
    limit: 2,
    beforeUpdatedMs: page1.nextBeforeUpdatedMs,
    beforeSessionId: page1.nextBeforeSessionId
  })

  assert.equal(page2.sessions.length, 1)
  assert.equal(page2.sessions[0]?.sessionId, 's-a')
  assert.equal(page2.hasMoreBefore, false)
})
