import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildApprovalRequestEvent,
  buildUserInputRequestEvent,
  isApprovalRequestMethod,
  isUserInputRequestMethod
} from '../src/runner/sessions/codexSessionRequests.js'

test('request method helpers classify approval and user-input methods', () => {
  assert.equal(isApprovalRequestMethod('item/commandExecution/requestApproval'), true)
  assert.equal(isApprovalRequestMethod('item/fileChange/requestApproval'), true)
  assert.equal(isApprovalRequestMethod('item/tool/requestUserInput'), false)

  assert.equal(isUserInputRequestMethod('item/tool/requestUserInput'), true)
  assert.equal(isUserInputRequestMethod('tool/requestUserInput'), true)
  assert.equal(isUserInputRequestMethod('item/tool/call'), false)
})

test('request payload builders normalize approval and user-input events', () => {
  assert.deepEqual(buildApprovalRequestEvent({
    approvalId: 'approval-1',
    sessionId: 'session-1',
    cwd: '/repo',
    method: 'item/commandExecution/requestApproval',
    params: {
      itemId: 'tool-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      reason: 'Need permission',
      command: 'rm -rf',
      grantRoot: '/repo',
      availableDecisions: ['accept', 'decline']
    }
  }), {
    approvalId: 'approval-1',
    sessionId: 'session-1',
    kind: 'command',
    itemId: 'tool-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    reason: 'Need permission',
    command: 'rm -rf',
    cwd: '/repo',
    grantRoot: '/repo',
    availableDecisions: ['accept', 'decline']
  })

  assert.deepEqual(buildUserInputRequestEvent({
    approvalId: 'approval-2',
    sessionId: 'session-1',
    cwd: '/repo',
    params: {
      itemId: 'tool-2',
      questions: [{ id: 'env', prompt: 'Environment?' }]
    }
  }), {
    approvalId: 'approval-2',
    sessionId: 'session-1',
    kind: 'userInput',
    itemId: 'tool-2',
    questions: [{ id: 'env', prompt: 'Environment?' }],
    cwd: '/repo'
  })
})
