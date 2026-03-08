import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildApprovalNotificationPayload,
  buildNotificationKey,
  buildSessionFailedNotificationPayload,
  buildSessionLabel,
  buildTurnCompletedNotificationPayload,
  createHostRunnerEventHandlers
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

test('runner upgrade replies resolve pending requests and broadcast machine upgrade state', () => {
  const resolved = []
  const rejected = []
  const transferResolved = []
  const transferRejected = []
  const sseEvents = []
  const handlers = createHostRunnerEventHandlers({
    config: { notifications: { sseToasts: 'never', webPush: 'never' } },
    store: {
      getSession() {
        return null
      }
    },
    sse: {
      send(envelope) {
        sseEvents.push(envelope)
      },
      sendToast() {},
      isSessionVisible() {
        return false
      }
    },
    push: null,
    approvals: new Map(),
    ideSessions: new Map(),
    makeEnvelope: ({ type, scope = null, payload = null }) => ({ type, scope, payload }),
    getUploadService: () => ({ handleRunnerMessage() { return false }, handleRunnerDisconnect() {} }),
    pendingRunnerCommands: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineUpgrades: {
      resolve(key, value) {
        resolved.push([key, value])
      },
      reject(key, err) {
        rejected.push([key, String(err?.message ?? err)])
      },
      rejectByMachine() {}
    },
    pendingMachineUpgradeTransfers: {
      resolve(key, value) {
        transferResolved.push([key, value])
      },
      reject(key, err) {
        transferRejected.push([key, String(err?.message ?? err)])
      },
      rejectByMachine() {}
    },
    pendingFsLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingFsReads: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingGitStatuses: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingTerminalExecs: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingModelLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingIdeStarts: { resolve() {}, reject() {}, rejectByMachine() {} },
    httpError(status, message) {
      const err = new Error(message)
      err.statusCode = status
      return err
    }
  })

  handlers.onRunnerMessage({
    type: 'machine.upgrade.accepted',
    payload: { requestId: 'req-1', machineId: 'machine-1' }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'machine.upgrade.state',
    payload: { machineId: 'machine-1', state: 'updating' }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'machine.upgrade.rejected',
    payload: { requestId: 'req-2', error: 'disabled' }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'machine.upgrade.bundle.received',
    payload: { requestId: 'req-1', machineId: 'machine-1', releaseId: 'release-1' }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'machine.upgrade.bundle.failed',
    payload: { requestId: 'req-3', error: 'checksum mismatch' }
  }, { machineId: 'machine-1', inserted: false })

  assert.deepEqual(resolved, [['req-1', { requestId: 'req-1', machineId: 'machine-1' }]])
  assert.deepEqual(rejected, [['req-2', 'disabled']])
  assert.deepEqual(transferResolved, [['req-1', { requestId: 'req-1', machineId: 'machine-1', releaseId: 'release-1' }]])
  assert.deepEqual(transferRejected, [['req-3', 'checksum mismatch']])
  assert.equal(sseEvents.length, 1)
  assert.equal(sseEvents[0]?.type, 'registry.machine.upsert')
  assert.deepEqual(sseEvents[0]?.scope, { machineId: 'machine-1' })
  assert.equal(sseEvents[0]?.payload?.machineId, 'machine-1')
  assert.equal(sseEvents[0]?.payload?.upgrade?.state, 'updating')
  assert.equal(typeof sseEvents[0]?.payload?.upgrade?.updatedAtMs, 'number')
})
