import test from 'node:test'
import assert from 'node:assert/strict'

import {
  basenamePath,
  createSessionStoreState,
  sessionHasUnread,
  sessionHasWorkingTurn,
  sessionHostName,
  sessionIndicator,
  sessionInitial,
  sessionListAccentClass,
  sessionListAccentTone,
  sessionListTextClass,
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
  assert.equal(a.chatScrollTop, 0)
  assert.equal(a.chatStickToBottom, true)
  assert.equal(a.workspacePaneOpen, false)
  assert.equal(a.workspacePaneTab, 'code')
})

test('session UI helpers derive labels and indicator state', () => {
  const machineNames = new Map([['machine-1', { machineName: 'runner-a', machineAlias: 'Desk' }]])
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
  assert.equal(sessionHostName(session, machineNames), 'Desk')
  assert.equal(sessionTooltip(session, machineNames), 'project — project · Desk · running')
  assert.equal(sessionHasUnread(session), true)
  assert.equal(sessionIndicator(session), 'blue')
  assert.equal(sessionListAccentTone(session), 'blue')
  assert.equal(sessionListAccentClass(session), 'bg-sky-500 text-white hover:bg-sky-500')
  assert.equal(sessionListTextClass(session), 'text-white')
  assert.equal(sessionListTextClass(session, { muted: true }), 'text-white/80')
})

test('working turns suppress unread blue until the turn finishes', () => {
  const session = {
    status: 'running',
    turnState: 'running',
    pendingApprovals: 0,
    lastSeq: 10,
    lastReadSeq: 1
  }

  assert.equal(sessionHasWorkingTurn(session), true)
  assert.equal(sessionIndicator(session), 'orange')
  assert.equal(sessionListAccentTone(session), 'default')
  assert.equal(sessionListAccentClass(session), 'hover:bg-black/[0.035]')
})

test('sessionListAccentClass prioritizes failed and approval states over unread', () => {
  assert.equal(sessionListAccentTone({
    status: 'failed',
    pendingApprovals: 0,
    lastSeq: 10,
    lastReadSeq: 1
  }), 'red')

  assert.equal(sessionListAccentClass({
    status: 'failed',
    pendingApprovals: 0,
    lastSeq: 10,
    lastReadSeq: 1
  }), 'bg-red-500 text-white hover:bg-red-500')

  assert.equal(sessionListAccentClass({
    status: 'running',
    pendingApprovals: 2,
    lastSeq: 10,
    lastReadSeq: 1
  }), 'bg-red-500 text-white hover:bg-red-500')

  assert.equal(sessionListAccentClass({
    status: 'running',
    turnState: 'running',
    pendingApprovals: 0,
    lastSeq: 10,
    lastReadSeq: 1
  }, { selected: true }), 'bg-[#d8d7ce] text-slate-900 shadow-sm ring-1 ring-black/[0.05]')

  assert.equal(sessionListAccentClass({
    status: 'idle',
    pendingApprovals: 0,
    lastSeq: 10,
    lastReadSeq: 1
  }, { selected: true }), 'bg-sky-600 text-white shadow-sm')

  assert.equal(sessionListAccentClass({
    status: 'running',
    pendingApprovals: 0,
    lastSeq: 1,
    lastReadSeq: 1
  }), 'hover:bg-black/[0.035]')

  assert.equal(sessionListTextClass({
    status: 'running',
    pendingApprovals: 0,
    lastSeq: 1,
    lastReadSeq: 1
  }, { chip: true }), 'border-black/[0.08] text-slate-500')
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
