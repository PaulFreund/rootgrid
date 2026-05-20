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
  store.createSession({
    sessionId: 's-1',
    machineId: 'm-1',
    cwd: '/tmp',
    status: 'idle'
  })
  return store
}

test('appendEventsBatch persists output bursts in order and preserves runner seq metadata', () => {
  const store = buildStore()

  const results = store.appendEventsBatch([
    {
      eventId: 'e-1',
      sessionId: 's-1',
      tsMs: 10,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'hel', seq: 7 }
    },
    {
      eventId: 'e-2',
      sessionId: 's-1',
      tsMs: 11,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'lo', seq: 8 }
    }
  ])

  assert.deepEqual(results.map((row) => row?.seq), [1, 2])
  assert.deepEqual(results.map((row) => row?.payload?.seq), [1, 2])
  assert.deepEqual(results.map((row) => row?.payload?.runnerSeq), [7, 8])

  const session = store.getSession('s-1')
  assert.equal(session?.lastSeq, 2)
  assert.equal(session?.updatedMs, 11)

  const events = store.listSessionEvents('s-1', { limit: 10 })
  assert.deepEqual(events.map((event) => event.seq), [1, 2])
  assert.deepEqual(events.map((event) => event.payload?.seq), [1, 2])
  assert.deepEqual(events.map((event) => event.payload?.runnerSeq), [7, 8])
})

test('appendEventsBatch does not create seq gaps when duplicate event ids are ignored', () => {
  const store = buildStore()

  const results = store.appendEventsBatch([
    {
      eventId: 'dup-1',
      sessionId: 's-1',
      tsMs: 1,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'a' }
    },
    {
      eventId: 'dup-1',
      sessionId: 's-1',
      tsMs: 2,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'b' }
    },
    {
      eventId: 'dup-2',
      sessionId: 's-1',
      tsMs: 3,
      type: 'turn.completed',
      payload: { turnId: 'turn-1', status: 'completed' }
    }
  ])

  assert.deepEqual(results.map((row) => row?.inserted), [true, false, true])
  assert.deepEqual(results.map((row) => row?.seq), [1, null, 2])

  const session = store.getSession('s-1')
  assert.equal(session?.lastSeq, 2)
  assert.equal(session?.turnState, 'idle')

  const events = store.listSessionEvents('s-1', { limit: 10 })
  assert.deepEqual(events.map((event) => event.eventId), ['dup-1', 'dup-2'])
  assert.deepEqual(events.map((event) => event.seq), [1, 2])
})
