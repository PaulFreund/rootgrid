import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionReadGate } from '../web/src/lib/sessionReadGate.js'

test('session read gate requires a new interaction after a session becomes unread', () => {
  const gate = createSessionReadGate()

  gate.noteInteraction()
  gate.syncSessionUnread('session-1', true)

  assert.equal(gate.canMarkRead('session-1'), false)

  gate.noteInteraction()
  assert.equal(gate.canMarkRead('session-1'), true)
})

test('session read gate clears the interaction requirement once the session is read', () => {
  const gate = createSessionReadGate()

  gate.syncSessionUnread('session-1', true)
  assert.equal(gate.canMarkRead('session-1'), false)

  gate.syncSessionUnread('session-1', false)
  assert.equal(gate.canMarkRead('session-1'), true)
})

test('session read gate tracks requirements independently per session', () => {
  const gate = createSessionReadGate()

  gate.syncSessionUnread('session-1', true)
  gate.noteInteraction()
  gate.syncSessionUnread('session-2', true)

  assert.equal(gate.canMarkRead('session-1'), true)
  assert.equal(gate.canMarkRead('session-2'), false)
})
