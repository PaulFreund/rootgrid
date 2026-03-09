import test from 'node:test'
import assert from 'node:assert/strict'

import { createHostMachineApi } from '../src/server/hostMachineApi.js'

function createJsonRecorder() {
  return {
    statusCode: null,
    body: null,
    json(res, status, body) {
      res.statusCode = status
      res.body = body
    }
  }
}

function createApi(overrides = {}) {
  const terminalSessions = overrides.terminalSessions ?? new Map()
  const sent = []
  const jsonRecorder = createJsonRecorder()
  const api = createHostMachineApi({
    auth: {
      requireAuth() {
        return true
      }
    },
    store: {
      listMachines() { return [] },
      getMachine() { return null },
      listSessionIdsByMachine() { return [] },
      listUploadHostPathsByMachine() { return [] },
      deleteMachine() { return false },
      deleteIdeSession() {}
    },
    sse: {
      send() {}
    },
    runnerWs: {
      listConnectedMachineIds() {
        return ['machine-1']
      },
      sendToMachine(machineId, envelope) {
        sent.push([machineId, envelope])
        return true
      },
      disconnectMachine() {
        return true
      }
    },
    approvals: new Map(),
    ideSessions: new Map(),
    makeEnvelope({ type, scope = null, payload = null }) {
      return { type, scope, payload }
    },
    json: jsonRecorder.json,
    readJsonBody: async () => overrides.body ?? null,
    pickMachineId(machineId) {
      return machineId || 'machine-1'
    },
    fsListOnRunner: overrides.fsListOnRunner ?? (async () => ({})),
    fsReadOnRunner: overrides.fsReadOnRunner ?? (async () => ({})),
    gitStatusOnRunner: overrides.gitStatusOnRunner ?? (async () => ({})),
    gitStageOnRunner: overrides.gitStageOnRunner ?? (async () => ({})),
    gitUnstageOnRunner: overrides.gitUnstageOnRunner ?? (async () => ({})),
    gitSwitchBranchOnRunner: overrides.gitSwitchBranchOnRunner ?? (async () => ({})),
    gitCreateBranchOnRunner: overrides.gitCreateBranchOnRunner ?? (async () => ({})),
    terminalSessions,
    terminalPtyStartOnRunner: overrides.terminalPtyStartOnRunner ?? (async () => {
      throw new Error('start should not be called')
    }),
    terminalExecOnRunner: overrides.terminalExecOnRunner ?? (async () => ({})),
    codexModelListOnRunner: overrides.codexModelListOnRunner ?? (async () => ({})),
    pendingIdeStarts: { cancel() {} },
    requestMachineUpgrade: overrides.requestMachineUpgrade ?? (async () => ({}))
  })
  return {
    api,
    sent,
    terminalSessions,
    jsonRecorder
  }
}

test('terminal session POST reuses matching sessions and returns buffered output', async () => {
  const terminalSessions = new Map([[
    'terminal-1',
    {
      terminalId: 'terminal-1',
      machineId: 'machine-1',
      cwd: '/tmp/workspace',
      shell: '/bin/bash',
      cols: 80,
      rows: 24,
      connected: true,
      outputText: 'hello world',
      outputVersion: 2,
      createdAtMs: 1,
      updatedAtMs: 2
    }
  ]])
  const { api, sent } = createApi({
    terminalSessions,
    body: {
      machineId: 'machine-1',
      cwd: '/tmp/workspace',
      cols: 120,
      rows: 40
    }
  })
  const res = {}

  const handled = await api.handle(
    { method: 'POST' },
    res,
    new URL('http://rootgrid.local/api/terminal/sessions'),
    ['api', 'terminal', 'sessions']
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.terminalId, 'terminal-1')
  assert.equal(res.body?.reused, true)
  assert.equal(res.body?.outputText, 'hello world')
  assert.equal(res.body?.connected, true)
  assert.deepEqual(sent, [[
    'machine-1',
    {
      type: 'terminal.pty.resize',
      scope: { machineId: 'machine-1' },
      payload: {
        terminalId: 'terminal-1',
        cols: 120,
        rows: 40
      }
    }
  ]])
  assert.equal(res.body?.cols, 120)
  assert.equal(res.body?.rows, 40)
})

test('terminal input rejects disconnected sessions without sending runner traffic', async () => {
  const terminalSessions = new Map([[
    'terminal-2',
    {
      terminalId: 'terminal-2',
      machineId: 'machine-1',
      cwd: '/tmp/workspace',
      connected: false,
      cols: 80,
      rows: 24
    }
  ]])
  const { api, sent } = createApi({
    terminalSessions,
    body: {
      data: 'ls\n'
    }
  })
  const res = {}

  const handled = await api.handle(
    { method: 'POST' },
    res,
    new URL('http://rootgrid.local/api/terminal/sessions/terminal-2/input'),
    ['api', 'terminal', 'sessions', 'terminal-2', 'input']
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 409)
  assert.equal(res.body?.error, 'terminal not connected')
  assert.deepEqual(sent, [])
})

test('machine alias PATCH persists alias and emits updated machine row', async () => {
  const sent = []
  const jsonRecorder = createJsonRecorder()
  let machineAlias = 'Desk'
  const api = createHostMachineApi({
    auth: {
      requireAuth() {
        return true
      }
    },
    store: {
      listMachines() { return [] },
      getMachine(machineId) {
        if (machineId !== 'machine-1') return null
        return {
          machineId: 'machine-1',
          machineName: 'runner-a',
          machineAlias,
          platform: 'linux',
          lastSeenMs: 123,
          capabilities: null
        }
      },
      setMachineAlias(machineId, alias) {
        assert.equal(machineId, 'machine-1')
        assert.equal(alias, 'Laptop')
        machineAlias = alias
        return true
      },
      listSessionIdsByMachine() { return [] },
      listUploadHostPathsByMachine() { return [] },
      deleteMachine() { return false },
      deleteIdeSession() {}
    },
    sse: {
      send(envelope) {
        sent.push(envelope)
      }
    },
    runnerWs: {
      listConnectedMachineIds() {
        return ['machine-1']
      },
      sendToMachine() {
        return true
      },
      disconnectMachine() {
        return true
      }
    },
    approvals: new Map(),
    ideSessions: new Map(),
    makeEnvelope({ type, scope = null, payload = null }) {
      return { type, scope, payload }
    },
    json: jsonRecorder.json,
    readJsonBody: async () => ({ alias: 'Laptop' }),
    pickMachineId(machineId) {
      return machineId || 'machine-1'
    },
    fsListOnRunner: async () => ({}),
    fsReadOnRunner: async () => ({}),
    gitStatusOnRunner: async () => ({}),
    terminalSessions: new Map(),
    terminalPtyStartOnRunner: async () => ({}),
    terminalExecOnRunner: async () => ({}),
    codexModelListOnRunner: async () => ({}),
    pendingIdeStarts: { cancel() {} },
    requestMachineUpgrade: async () => ({})
  })
  const res = {}

  const handled = await api.handle(
    { method: 'PATCH' },
    res,
    new URL('http://rootgrid.local/api/machines/machine-1'),
    ['api', 'machines', 'machine-1']
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.machine?.machineAlias, 'Laptop')
  assert.deepEqual(sent[0], {
    type: 'registry.machine.upsert',
    scope: { machineId: 'machine-1' },
    payload: {
      machineId: 'machine-1',
      machineName: 'runner-a',
      machineAlias: 'Laptop',
      platform: 'linux',
      lastSeenMs: 123,
      capabilities: null,
      connected: true
    }
  })
})

test('IDE start forwards trusted origins from external base url and request origin', async () => {
  const sent = []
  const jsonRecorder = createJsonRecorder()
  let resolveStart
  const startedP = new Promise((resolve) => {
    resolveStart = resolve
  })
  const api = createHostMachineApi({
    auth: {
      requireAuth() {
        return true
      }
    },
    getExternalBaseUrl() {
      return 'https://rootgrid.example.test'
    },
    store: {
      listMachines() { return [] }
    },
    sse: { send() {} },
    runnerWs: {
      listConnectedMachineIds() {
        return ['machine-1']
      },
      sendToMachine(machineId, envelope) {
        sent.push({ machineId, envelope })
        queueMicrotask(() => resolveStart?.())
        return true
      },
      disconnectMachine() {
        return true
      }
    },
    approvals: new Map(),
    ideSessions: new Map(),
    makeEnvelope({ type, scope = null, payload = null }) {
      return { type, scope, payload }
    },
    json: jsonRecorder.json,
    readJsonBody: async () => ({ cwd: '/tmp/workspace', machineId: 'machine-1' }),
    pickMachineId(machineId) {
      return machineId || 'machine-1'
    },
    fsListOnRunner: async () => ({}),
    fsReadOnRunner: async () => ({}),
    gitStatusOnRunner: async () => ({}),
    gitStageOnRunner: async () => ({}),
    gitUnstageOnRunner: async () => ({}),
    gitSwitchBranchOnRunner: async () => ({}),
    gitCreateBranchOnRunner: async () => ({}),
    terminalSessions: new Map(),
    terminalPtyStartOnRunner: async () => ({}),
    terminalExecOnRunner: async () => ({}),
    codexModelListOnRunner: async () => ({}),
    pendingIdeStarts: {
      create() {
        return startedP
      },
      cancel() {}
    },
    requestMachineUpgrade: async () => ({})
  })
  const res = {}

  const handled = await api.handle(
    {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7337',
        origin: 'http://127.0.0.1:5173'
      }
    },
    res,
    new URL('http://rootgrid.local/api/ide-sessions'),
    ['api', 'ide-sessions']
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].envelope.type, 'ide.start')
  assert.deepEqual(sent[0].envelope.payload.trustedOrigins.sort(), [
    '127.0.0.1:5173',
    '127.0.0.1:7337',
    'rootgrid.example.test'
  ])
})

test('git stage route forwards requested paths to the runner', async () => {
  let request = null
  const { api } = createApi({
    body: {
      machineId: 'machine-1',
      cwd: '/tmp/workspace',
      paths: ['src/index.js', 'README.md']
    },
    gitStageOnRunner: async (payload) => {
      request = payload
      return { ok: true, staged: payload.paths }
    }
  })
  const res = {}

  const handled = await api.handle(
    { method: 'POST' },
    res,
    new URL('http://rootgrid.local/api/git/stage'),
    ['api', 'git', 'stage']
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(request, {
    machineId: 'machine-1',
    cwd: '/tmp/workspace',
    paths: ['src/index.js', 'README.md']
  })
})

test('git branch create route forwards branch name to the runner', async () => {
  let request = null
  const { api } = createApi({
    body: {
      machineId: 'machine-1',
      cwd: '/tmp/workspace',
      branch: 'feature/demo'
    },
    gitCreateBranchOnRunner: async (payload) => {
      request = payload
      return { ok: true, branch: payload.branch }
    }
  })
  const res = {}

  const handled = await api.handle(
    { method: 'POST' },
    res,
    new URL('http://rootgrid.local/api/git/branch/create'),
    ['api', 'git', 'branch', 'create']
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(request, {
    machineId: 'machine-1',
    cwd: '/tmp/workspace',
    branch: 'feature/demo'
  })
})
