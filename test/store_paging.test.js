import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'

test('Store.listSessionEventsAfter pages forward from a durable seq', () => {
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

  store.appendEvent({
    eventId: 'e-1',
    sessionId: 's-1',
    tsMs: 1,
    type: 'session.input',
    payload: { sessionId: 's-1', text: 'hello' }
  })
  store.appendEvent({
    eventId: 'e-2',
    sessionId: 's-1',
    tsMs: 2,
    type: 'session.output',
    payload: { sessionId: 's-1', stream: 'normalized', text: 'world' }
  })
  store.appendEvent({
    eventId: 'e-3',
    sessionId: 's-1',
    tsMs: 3,
    type: 'turn.completed',
    payload: { sessionId: 's-1', status: 'completed' }
  })

  const page1 = store.listSessionEventsAfter('s-1', { afterSeq: 1, limit: 1, mode: 'full' })
  assert.deepEqual(page1.events.map((e) => e.seq), [2])
  assert.equal(page1.hasMoreAfter, true)
  assert.equal(page1.newestSeq, 2)

  const page2 = store.listSessionEventsAfter('s-1', { afterSeq: page1.newestSeq, limit: 10, mode: 'full' })
  assert.deepEqual(page2.events.map((e) => e.seq), [3])
  assert.equal(page2.hasMoreAfter, false)
  assert.equal(page2.newestSeq, 3)
})
