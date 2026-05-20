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
  const terminalSessions = new Map()
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
    pendingMachineTools: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineToolUpgrades: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineToolAuth: { resolve() {}, reject() {}, rejectByMachine() {} },
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
    pendingTerminalStarts: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingTerminalExecs: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingModelLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingIdeStarts: { resolve() {}, reject() {}, rejectByMachine() {} },
    terminalSessions,
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

test('terminal PTY replies resolve start requests and forward output and exit over SSE', () => {
  const started = []
  const sseEvents = []
  const terminalSessions = new Map()
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
    pendingMachineTools: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineToolUpgrades: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineToolAuth: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineUpgrades: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineUpgradeTransfers: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingFsLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingFsReads: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingGitStatuses: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingTerminalStarts: {
      resolve(key, value) {
        started.push([key, value])
      },
      reject() {},
      rejectByMachine() {}
    },
    pendingTerminalExecs: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingModelLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingIdeStarts: { resolve() {}, reject() {}, rejectByMachine() {} },
    terminalSessions,
    httpError(status, message) {
      const err = new Error(message)
      err.statusCode = status
      return err
    }
  })

  handlers.onRunnerMessage({
    type: 'terminal.pty.start.result',
    payload: {
      requestId: 'term-start-1',
      ok: true,
      terminalId: 'terminal-1',
      cwd: '/tmp/workspace',
      shell: '/bin/bash',
      cols: 120,
      rows: 40
    }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'terminal.pty.output',
    payload: {
      terminalId: 'terminal-1',
      data: 'hello\n'
    }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'terminal.pty.exit',
    payload: {
      terminalId: 'terminal-1',
      exitCode: 0,
      signal: null
    }
  }, { machineId: 'machine-1', inserted: false })

  assert.deepEqual(started, [[
    'term-start-1',
    {
      requestId: 'term-start-1',
      ok: true,
      terminalId: 'terminal-1',
      cwd: '/tmp/workspace',
      shell: '/bin/bash',
      cols: 120,
      rows: 40
    }
  ]])
  assert.equal(terminalSessions.has('terminal-1'), true)
  assert.equal(terminalSessions.get('terminal-1')?.connected, false)
  assert.match(terminalSessions.get('terminal-1')?.outputText ?? '', /hello/)
  assert.match(terminalSessions.get('terminal-1')?.outputText ?? '', /\[process exited/)
  assert.equal(sseEvents.length, 2)
  assert.equal(sseEvents[0]?.type, 'terminal.pty.output')
  assert.deepEqual(sseEvents[0]?.scope, { machineId: 'machine-1', terminalId: 'terminal-1' })
  assert.equal(sseEvents[0]?.payload?.data, 'hello\n')
  assert.equal(sseEvents[1]?.type, 'terminal.pty.exit')
  assert.equal(sseEvents[1]?.payload?.exitCode, 0)
})

test('runner tool replies resolve pending tool requests', () => {
  const toolReads = []
  const toolUpgrades = []
  const toolAuth = []
  const handlers = createHostRunnerEventHandlers({
    config: { notifications: { sseToasts: 'never', webPush: 'never' } },
    store: {
      getSession() {
        return null
      }
    },
    sse: {
      send() {},
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
    pendingMachineTools: {
      resolve(key, value) {
        toolReads.push([key, value])
      },
      reject() {},
      rejectByMachine() {}
    },
    pendingMachineToolUpgrades: {
      resolve(key, value) {
        toolUpgrades.push([key, value])
      },
      reject() {},
      rejectByMachine() {}
    },
    pendingMachineToolAuth: {
      resolve(key, value) {
        toolAuth.push([key, value])
      },
      reject() {},
      rejectByMachine() {}
    },
    pendingMachineUpgrades: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingMachineUpgradeTransfers: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingFsLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingFsReads: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingGitStatuses: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingTerminalStarts: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingTerminalExecs: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingModelLists: { resolve() {}, reject() {}, rejectByMachine() {} },
    pendingIdeStarts: { resolve() {}, reject() {}, rejectByMachine() {} },
    terminalSessions: new Map(),
    httpError(status, message) {
      const err = new Error(message)
      err.statusCode = status
      return err
    }
  })

  handlers.onRunnerMessage({
    type: 'machine.tools.result',
    payload: {
      requestId: 'tools-1',
      ok: true,
      tools: {
        codex: { id: 'codex', version: 'codex-cli 1.2.3' }
      }
    }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'machine.tools.upgrade.result',
    payload: {
      requestId: 'tool-upgrade-1',
      ok: true,
      tool: { id: 'codex', version: 'codex-cli 9.9.9' },
      message: 'Codex is now codex-cli 9.9.9.'
    }
  }, { machineId: 'machine-1', inserted: false })

  handlers.onRunnerMessage({
    type: 'machine.tools.auth.result',
    payload: {
      requestId: 'tool-auth-1',
      ok: true,
      tool: { id: 'codex', auth: { status: 'authenticated', provider: 'ChatGPT' } },
      message: 'Codex sign-in state was refreshed.'
    }
  }, { machineId: 'machine-1', inserted: false })

  assert.equal(toolReads[0]?.[0], 'tools-1')
  assert.equal(toolReads[0]?.[1]?.tools?.codex?.version, 'codex-cli 1.2.3')
  assert.equal(toolUpgrades[0]?.[0], 'tool-upgrade-1')
  assert.equal(toolUpgrades[0]?.[1]?.tool?.version, 'codex-cli 9.9.9')
  assert.equal(toolAuth[0]?.[0], 'tool-auth-1')
  assert.equal(toolAuth[0]?.[1]?.tool?.auth?.provider, 'ChatGPT')
})
