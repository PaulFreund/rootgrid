import test from 'node:test'
import assert from 'node:assert/strict'

import {
  basenamePath,
  createSessionStoreState,
  sessionHostName,
  sessionIndicator,
  sessionInitial,
  sessionListTitle,
  sessionProject,
  sessionTooltip,
  upsertById
} from '../web/src/lib/sessionUi.js'

test('createSessionStoreState returns fresh mutable containers', () => {
  const a = createSessionStoreState()
  const b = createSessionStoreState()

  a.turnHasReasoningLive.add('turn-1')
  a.toolExpanded.set('item-1', true)

  assert.equal(b.turnHasReasoningLive.size, 0)
  assert.equal(b.toolExpanded.size, 0)
  assert.deepEqual(a.events, [])
  assert.deepEqual(b.events, [])
  assert.equal(a.historyLoaded, false)
  assert.equal(a.lastLoadedSeq, 0)
})

test('session UI helpers derive labels and indicator state', () => {
  const machineNames = new Map([['machine-1', { machineName: 'runner-a' }]])
  const session = {
    sessionId: 'session-12345678',
    machineId: 'machine-1',
    cwd: '/work/project',
    status: 'running',
    title: '',
    preview: 'hello',
    lastSeq: 3,
    lastReadSeq: 1
  }

  assert.equal(basenamePath('/work/project/'), 'project')
  assert.equal(sessionProject(session), 'project')
  assert.equal(sessionListTitle(session), 'project')
  assert.equal(sessionInitial(session), 'P')
  assert.equal(sessionHostName(session, machineNames), 'runner-a')
  assert.equal(sessionTooltip(session, machineNames), 'project — project · runner-a · running')
  assert.equal(sessionIndicator(session), 'blue')
})

test('upsertById updates matching items in place by key', () => {
  const rows = [{ sessionId: 'a', title: 'old' }]
  upsertById(rows, 'sessionId', { sessionId: 'a', status: 'running' })
  upsertById(rows, 'sessionId', { sessionId: 'b', title: 'new' })

  assert.deepEqual(rows, [
    { sessionId: 'a', title: 'old', status: 'running' },
    { sessionId: 'b', title: 'new' }
  ])
})
