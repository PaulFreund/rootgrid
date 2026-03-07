import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendSessionRowsPage,
  bumpSessionRowToTop,
  getOrCreateSessionStore,
  removeSessionRowInList,
  removeMachineLocalState,
  replaceMachineRows,
  replaceSessionRows,
  upsertMachineRowInList,
  upsertSessionRowInList
} from '../web/src/lib/appSessionState.js'

test('getOrCreateSessionStore creates once and reuses the same entry', () => {
  const stores = new Map()
  const created = []
  const first = getOrCreateSessionStore(stores, 'session-1', () => {
    created.push('created')
    return { id: 1 }
  })
  const second = getOrCreateSessionStore(stores, 'session-1', () => ({ id: 2 }))

  assert.equal(created.length, 1)
  assert.equal(first, second)
})

test('session row helpers upsert and bump rows in place', () => {
  const rows = [
    { sessionId: 'a', title: 'A' },
    { sessionId: 'b', title: 'B' }
  ]
  const rowsById = new Map(rows.map((row) => [row.sessionId, row]))

  upsertSessionRowInList(rows, { sessionId: 'b', title: 'B updated' }, rowsById)
  upsertSessionRowInList(rows, { sessionId: 'c', title: 'C' }, rowsById)
  assert.deepEqual(rows.map((row) => row.title), ['C', 'A', 'B updated'])
  assert.equal(rowsById.get('b')?.title, 'B updated')
  assert.equal(rowsById.get('c')?.title, 'C')

  bumpSessionRowToTop(rows, 'B')
  assert.deepEqual(rows.map((row) => row.sessionId), ['c', 'a', 'b'])

  bumpSessionRowToTop(rows, 'b')
  assert.deepEqual(rows.map((row) => row.sessionId), ['b', 'c', 'a'])
})

test('registry replace/remove helpers keep array order and lookup maps in sync', () => {
  const sessions = []
  const sessionRowsById = new Map()
  const machines = []
  const machineRowsById = new Map()

  replaceSessionRows(sessions, sessionRowsById, [
    { sessionId: 's1', machineId: 'm1' },
    { sessionId: 's2', machineId: 'm2' }
  ])
  replaceMachineRows(machines, machineRowsById, [
    { machineId: 'm1', machineName: 'runner-1' },
    { machineId: 'm2', machineName: 'runner-2' }
  ])
  upsertMachineRowInList(machines, { machineId: 'm2', machineName: 'runner-2b' }, machineRowsById)
  removeSessionRowInList(sessions, 's1', sessionRowsById)

  assert.deepEqual(sessions.map((row) => row.sessionId), ['s2'])
  assert.deepEqual(machines.map((row) => row.machineName), ['runner-1', 'runner-2b'])
  assert.equal(sessionRowsById.has('s1'), false)
  assert.equal(machineRowsById.get('m2')?.machineName, 'runner-2b')
})

test('replaceSessionRows preserves existing row identity for matching ids', () => {
  const sessions = [{ sessionId: 's1', title: 'Old', preview: 'x' }]
  const sessionRowsById = new Map([['s1', sessions[0]]])
  const original = sessions[0]

  replaceSessionRows(sessions, sessionRowsById, [
    { sessionId: 's1', title: 'New' }
  ])

  assert.equal(sessions[0], original)
  assert.equal(sessions[0].title, 'New')
  assert.equal('preview' in sessions[0], false)
  assert.equal(sessionRowsById.get('s1'), original)
})

test('appendSessionRowsPage appends only older rows and preserves existing identity', () => {
  const sessions = [{ sessionId: 's2', title: 'Two' }]
  const sessionRowsById = new Map([['s2', sessions[0]]])
  const original = sessions[0]

  appendSessionRowsPage(sessions, sessionRowsById, [
    { sessionId: 's2', title: 'Two updated' },
    { sessionId: 's1', title: 'One' }
  ])

  assert.equal(sessions[0], original)
  assert.equal(sessions[0].title, 'Two updated')
  assert.deepEqual(sessions.map((row) => row.sessionId), ['s2', 's1'])
})

test('removeMachineLocalState removes machine rows, related sessions, and resets selected defaults', () => {
  const sessionRows = [
    { sessionId: 's1', machineId: 'm1' },
    { sessionId: 's2', machineId: 'm2' },
    { sessionId: 's3', machineId: 'm1' }
  ]
  const sessionStores = new Map([
    ['s1', { ok: true }],
    ['s2', { ok: true }],
    ['s3', { ok: true }]
  ])
  const tokenUsageBySessionId = new Map([
    ['s1', { total: 1 }],
    ['s2', { total: 2 }],
    ['s3', { total: 3 }]
  ])
  const sessionRowsById = new Map(sessionRows.map((row) => [row.sessionId, row]))
  const machineRows = [
    { machineId: 'm1' },
    { machineId: 'm2' }
  ]
  const machineRowsById = new Map(machineRows.map((row) => [row.machineId, row]))
  const selectedSessionId = { value: 's3' }
  const defaults = { machineId: 'm1' }
  const newThreadMachineId = { value: 'm1' }

  const changed = removeMachineLocalState({
    machineId: 'm1',
    sessionRows,
    sessionRowsById,
    selectedSessionId,
    sessionStores,
    sessionDataMaps: [tokenUsageBySessionId],
    machineRows,
    machineRowsById,
    defaults,
    newThreadMachineId,
    fallbackMachineId: 'm2'
  })

  assert.equal(changed, true)
  assert.deepEqual(sessionRows.map((row) => row.sessionId), ['s2'])
  assert.deepEqual(Array.from(sessionStores.keys()), ['s2'])
  assert.deepEqual(Array.from(tokenUsageBySessionId.keys()), ['s2'])
  assert.deepEqual(machineRows.map((row) => row.machineId), ['m2'])
  assert.equal(sessionRowsById.has('s1'), false)
  assert.equal(sessionRowsById.has('s3'), false)
  assert.equal(machineRowsById.has('m1'), false)
  assert.equal(selectedSessionId.value, null)
  assert.equal(defaults.machineId, '')
  assert.equal(newThreadMachineId.value, 'm2')
})
