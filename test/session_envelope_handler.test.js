import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionEnvelopeHandler } from '../web/src/lib/sessionEnvelopeHandler.js'
import {
  removeSessionRowInList,
  replaceMachineRows,
  replaceSessionRows,
  upsertMachineRowInList,
  upsertSessionRowInList
} from '../web/src/lib/appSessionState.js'

test('session envelope handler keeps registry maps in sync for snapshot/update/delete events', () => {
  const machines = { value: [] }
  const sessions = { value: [] }
  const machineRowsById = new Map()
  const sessionRowsById = new Map()
  const approvalQueue = { value: [] }
  const approvalIds = new Set()
  const hasSnapshot = { value: false }
  const selectedSessionId = { value: 's-1' }
  const sseConnectionId = { value: null }
  const sessionStores = new Map([
    ['s-1', { lastRealtimeSeqSeen: 2, loadingBefore: false, pendingAfter: [], currentTurnId: null, turnHasReasoningLive: new Set(), messageViewVersion: 0 }]
  ])
  const backfills = []
  const snapshotPageInfo = []
  let postVisibilityCalls = 0
  const toasts = { value: [] }
  const tokenUpdates = []
  const addedEvents = []

  const handleEnvelope = createSessionEnvelopeHandler({
    currentVisibility: () => 'visible',
    notificationPermission: { value: 'default' },
    showBrowserToast: () => false,
    toasts,
    scheduleDismissToast: () => {},
    sseConnectionId,
    replaceMachineRows: (rows) => replaceMachineRows(machines.value, machineRowsById, rows),
    replaceSessionRows: (rows) => replaceSessionRows(sessions.value, sessionRowsById, rows),
    applySessionPageInfo: (payload) => snapshotPageInfo.push(payload),
    sessionRowsById,
    approvalQueue,
    approvalIds,
    hasSnapshot,
    schedulePostVisibility: () => { postVisibilityCalls += 1 },
    selectedSessionId,
    sessionStores,
    backfillSessionAfter: (sessionId, { afterSeq }) => {
      backfills.push({ sessionId, afterSeq })
      return Promise.resolve()
    },
    upsertMachineRow: (row) => upsertMachineRowInList(machines.value, row, machineRowsById),
    removeMachineLocal: () => {},
    removeSessionRow: (sessionId) => removeSessionRowInList(sessions.value, sessionId, sessionRowsById),
    upsertSessionRow: (row) => upsertSessionRowInList(sessions.value, row, sessionRowsById),
    getSessionStore: (sessionId) => sessionStores.get(sessionId),
    stickToBottom: { value: false },
    scheduleMarkRead: () => {},
    bumpSessionToTop: () => {},
    updateTokenUsage: (sessionId, payload) => tokenUpdates.push({ sessionId, payload }),
    appendToolOutput: () => {},
    addSessionEvent: (sessionId, event) => {
      addedEvents.push({ sessionId, event })
    }
  })

  handleEnvelope({
    type: 'registry.snapshot',
    payload: {
      connectionId: 'conn-1',
      machines: [{ machineId: 'm-1', machineName: 'runner-a' }],
      sessions: [{ sessionId: 's-1', machineId: 'm-1', lastSeq: 5 }],
      sessionsHasMore: true,
      sessionsNextBeforeUpdatedMs: 4,
      sessionsNextBeforeSessionId: 's-1',
      approvals: []
    }
  })

  assert.equal(hasSnapshot.value, true)
  assert.equal(sseConnectionId.value, 'conn-1')
  assert.equal(machineRowsById.get('m-1')?.machineName, 'runner-a')
  assert.equal(sessionRowsById.get('s-1')?.lastSeq, 5)
  assert.equal(snapshotPageInfo.length, 1)
  assert.equal(postVisibilityCalls, 1)
  assert.deepEqual(backfills, [{ sessionId: 's-1', afterSeq: 2 }])

  handleEnvelope({
    type: 'registry.machine.upsert',
    payload: { machineId: 'm-1', machineName: 'runner-b' }
  })
  assert.equal(machineRowsById.get('m-1')?.machineName, 'runner-b')

  handleEnvelope({
    type: 'approval.request',
    scope: { sessionId: 's-1' },
    payload: { approvalId: 'a-1' }
  })
  handleEnvelope({
    type: 'approval.request',
    scope: { sessionId: 's-1' },
    payload: { approvalId: 'a-1' }
  })
  assert.equal(approvalQueue.value.length, 1)
  assert.equal(approvalIds.has('a-1'), true)

  handleEnvelope({
    type: 'approval.resolved',
    scope: { sessionId: 's-1' },
    payload: { approvalId: 'a-1' }
  })
  assert.equal(approvalQueue.value.length, 0)
  assert.equal(approvalIds.has('a-1'), false)

  handleEnvelope({
    type: 'token.count',
    scope: { sessionId: 's-1' },
    payload: { total: 123 }
  })
  assert.deepEqual(tokenUpdates, [{ sessionId: 's-1', payload: { total: 123 } }])

  sessionStores.get('s-1').loadingBefore = true
  sessionStores.get('s-1').pendingAfter = []

  handleEnvelope({
    id: 'out-1',
    ts: 10,
    type: 'session.output',
    scope: { sessionId: 's-1' },
    payload: { stream: 'normalized', text: 'hel' }
  })
  handleEnvelope({
    id: 'out-2',
    ts: 11,
    type: 'session.output',
    scope: { sessionId: 's-1' },
    payload: { stream: 'normalized', text: 'lo' }
  })
  assert.equal(sessionStores.get('s-1').pendingAfter.length, 1)
  assert.equal(sessionStores.get('s-1').pendingAfter[0].payload.text, 'hello')

  sessionStores.get('s-1').loadingBefore = false
  handleEnvelope({
    id: 'turn-1',
    ts: 11.5,
    type: 'turn.started',
    scope: { sessionId: 's-1' },
    payload: { turnId: 'turn-live' }
  })
  handleEnvelope({
    id: 'reason-1',
    ts: 12,
    type: 'session.output',
    scope: { sessionId: 's-1' },
    payload: { stream: 'reasoning', text: 'inspect files' }
  })
  assert.equal(sessionStores.get('s-1').turnHasReasoningLive.has('turn-live'), true)

  handleEnvelope({
    type: 'session.queuedPrompts.updated',
    scope: { sessionId: 's-1' },
    payload: {
      sessionId: 's-1',
      queuedPrompts: [{ id: 'qp-1', promptId: 'qp-1', text: 'later', attachments: [] }]
    }
  })
  assert.equal(sessionStores.get('s-1').queuedPrompts?.length ?? 0, 1)
  assert.equal(sessionStores.get('s-1').queueSending, false)

  handleEnvelope({
    type: 'registry.session.delete',
    payload: { sessionId: 's-1' }
  })
  assert.equal(sessionRowsById.has('s-1'), false)
  assert.equal(selectedSessionId.value, null)

  handleEnvelope({
    type: 'registry.hello',
    payload: { connectionId: 'conn-2', resumed: true }
  })
  assert.equal(sseConnectionId.value, 'conn-2')
  assert.equal(postVisibilityCalls, 2)

  handleEnvelope({
    id: 'toast-1',
    type: 'toast',
    payload: { title: 'One', message: 'Only once' }
  })
  handleEnvelope({
    id: 'toast-1',
    type: 'toast',
    payload: { title: 'One', message: 'Only once' }
  })
  handleEnvelope({
    id: 'toast-2',
    type: 'toast',
    payload: { title: 'One', message: 'Only once', notificationKey: 'turn:s-1:t-1' }
  })
  handleEnvelope({
    id: 'toast-3',
    type: 'toast',
    payload: { title: 'One', message: 'Only once', notificationKey: 'turn:s-1:t-1' }
  })
  assert.equal(toasts.value.length, 2)
  assert.ok(addedEvents.some(({ event }) => event.type === 'session.output' && event.payload?.stream === 'reasoning'))
})
