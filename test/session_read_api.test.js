import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'
import { buildSessionBootstrapPayload } from '../src/server/sessionReadApi.js'

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

test('buildSessionBootstrapPayload prefetches older summary pages until a user input is included', () => {
  const store = buildStore()

  for (let i = 1; i <= 6; i++) {
    store.appendEvent({
      eventId: `e-${i}`,
      sessionId: 's-1',
      tsMs: i,
      type: i === 1 ? 'session.input' : 'session.output',
      payload: i === 1
        ? { text: 'hello' }
        : { stream: 'normalized', text: `chunk-${i}` }
    })
  }

  const out = buildSessionBootstrapPayload(store, 's-1', {
    limit: 2,
    prefetchPages: 4,
    prefetchLimit: 2,
    prefetchUntilInput: true
  })

  assert.deepEqual(out.events.map((event) => event.eventId), ['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6'])
  assert.equal(out.containsInput, true)
  assert.equal(out.hasMoreBefore, false)
  assert.equal(out.nextBeforeSeq, 1)
  assert.equal(out.pagesFetched, 3)
})

