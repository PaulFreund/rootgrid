import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildApprovalNotificationPayload,
  buildNotificationKey,
  buildSessionFailedNotificationPayload,
  buildSessionLabel,
  buildTurnCompletedNotificationPayload
} from '../src/server/hostRunnerEvents.js'

test('buildSessionLabel prefers project label before cwd basename and session id fallback', () => {
  assert.equal(buildSessionLabel({
    sessionId: 'session-12345678',
    session: { projectLabel: 'Important project', cwd: '/tmp/workspace' }
  }), 'Important project')

  assert.equal(buildSessionLabel({
    sessionId: 'session-12345678',
    session: { cwd: '/tmp/workspace' }
  }), 'workspace')

  assert.equal(buildSessionLabel({
    sessionId: 'session-12345678'
  }), 'session-')
})

test('runner event notification helpers build approval, turn, and failure payloads', () => {
  assert.deepEqual(buildApprovalNotificationPayload({
    label: 'repo',
    sessionId: 'session-1',
    approval: {
      approvalId: 'approval-1',
      kind: 'command',
      command: 'npm test',
      grantRoot: '/tmp/repo'
    }
  }), {
    level: 'error',
    title: 'Approval required',
    message: 'repo · command\nnpm test\nGrant: /tmp/repo',
    notificationKey: 'approval:approval-1'
  })

  assert.deepEqual(buildTurnCompletedNotificationPayload({
    label: 'repo',
    sessionId: 'session-1',
    turn: {
      turnId: 'turn-1',
      status: 'completed',
      preview: 'Finished the task'
    }
  }), {
    level: 'success',
    title: 'Ready',
    message: 'repo\nFinished the task',
    notificationKey: 'turn:session-1:turn-1'
  })

  assert.equal(buildTurnCompletedNotificationPayload({
    label: 'repo',
    turn: { status: 'interrupted' }
  }), null)

  assert.deepEqual(buildSessionFailedNotificationPayload({
    label: 'repo',
    sessionId: 'session-1',
    sessionStatus: {
      status: 'failed',
      error: 'boom'
    }
  }), {
    level: 'error',
    title: 'Session failed',
    message: 'repo\nboom',
    notificationKey: 'session.failed:session-1'
  })
})

test('buildNotificationKey prefers stable ids for approval and turn notifications', () => {
  assert.equal(buildNotificationKey({
    type: 'approval.request',
    sessionId: 'session-1',
    approvalId: 'approval-1'
  }), 'approval:approval-1')

  assert.equal(buildNotificationKey({
    type: 'turn.completed',
    sessionId: 'session-1',
    turnId: 'turn-1'
  }), 'turn:session-1:turn-1')

  assert.equal(buildNotificationKey({
    type: 'session.failed',
    sessionId: 'session-1'
  }), 'session.failed:session-1')
})
