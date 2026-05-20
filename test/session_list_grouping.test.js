import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionGroupTuple,
  buildSessionListEntries,
  normalizeSessionListGroupingMode
} from '../web/src/lib/sessionListGrouping.js'

test('normalizeSessionListGroupingMode defaults to project grouping', () => {
  assert.equal(normalizeSessionListGroupingMode('flat'), 'flat')
  assert.equal(normalizeSessionListGroupingMode('PROJECT'), 'project')
  assert.equal(normalizeSessionListGroupingMode(''), 'project')
})

test('buildSessionGroupTuple always keys groups by host + project tuple', () => {
  const tuple = buildSessionGroupTuple({ sessionId: 's1' }, {
    getHostName: () => 'runner-a',
    getProjectName: () => 'alpha'
  })

  assert.equal(tuple.host, 'runner-a')
  assert.equal(tuple.project, 'alpha')
  assert.equal(tuple.label, 'runner-a · alpha')
  assert.equal(tuple.key, 'runner-a\u0000alpha')
})

test('buildSessionListEntries groups sessions by host + project and preserves newest-group order', () => {
  const sessions = [
    { sessionId: 's3', machineId: 'm2', cwd: '/work/beta', updatedMs: 300 },
    { sessionId: 's2', machineId: 'm1', cwd: '/work/alpha', updatedMs: 200 },
    { sessionId: 's1', machineId: 'm1', cwd: '/work/alpha', updatedMs: 100 }
  ]

  const entries = buildSessionListEntries(sessions, {
    groupingMode: 'project',
    getHostName: (session) => session.machineId === 'm1' ? 'runner-a' : 'runner-b',
    getProjectName: (session) => session.cwd.split('/').at(-1)
  })

  assert.deepEqual(entries.map((entry) => `${entry.kind}:${entry.key}`), [
    'group:group:runner-b\u0000beta',
    'session:s3',
    'group:group:runner-a\u0000alpha',
    'session:s2',
    'session:s1'
  ])
  assert.equal(entries[0].label, 'runner-b · beta')
})

test('buildSessionListEntries can return a flat session-only list', () => {
  const sessions = [{ sessionId: 's1' }, { sessionId: 's2' }]
  const entries = buildSessionListEntries(sessions, { groupingMode: 'flat' })
  assert.deepEqual(entries, [
    { kind: 'session', key: 's1', session: sessions[0] },
    { kind: 'session', key: 's2', session: sessions[1] }
  ])
})
