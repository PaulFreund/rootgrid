import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'
import {
  archiveSession,
  deleteSession,
  markSessionRead,
  setSessionProjectLabel,
  setSessionTitle,
  unarchiveSession
} from '../src/db/storeSessionMeta.js'

function buildStore() {
  const store = new Store({ dbPath: ':memory:' })
  store.upsertMachine({
    machineId: 'm-1',
    machineName: 'runner',
    platform: 'linux',
    capabilities: null
  })
  store.createSession({
    sessionId: 's-1',
    machineId: 'm-1',
    cwd: '/tmp',
    status: 'idle'
  })
  return store
}

test('storeSessionMeta helpers update session metadata fields in place', () => {
  const store = buildStore()

  store.appendEvent({
    eventId: 'e-1',
    sessionId: 's-1',
    tsMs: 1,
    type: 'session.input',
    payload: { text: 'hello' }
  })

  assert.equal(markSessionRead(store.db, 's-1'), true)
  assert.equal(setSessionProjectLabel(store.db, 's-1', 'Project X'), true)
  assert.equal(setSessionTitle(store.db, 's-1', 'Thread Title'), true)

  const session = store.getSession('s-1')
  assert.equal(session?.lastReadSeq, session?.lastSeq)
  assert.equal(session?.projectLabel, 'Project X')
  assert.equal(session?.title, 'Thread Title')
})

test('archive/unarchive/delete session helpers change visibility and existence', () => {
  const store = buildStore()

  assert.equal(archiveSession(store.db, 's-1', { now: 1234 }), true)
  assert.equal(store.getSession('s-1')?.archivedMs, 1234)

  assert.equal(unarchiveSession(store.db, 's-1'), true)
  assert.equal(store.getSession('s-1')?.archivedMs, null)

  assert.equal(deleteSession(store.db, 's-1'), true)
  assert.equal(store.getSession('s-1'), null)
})
