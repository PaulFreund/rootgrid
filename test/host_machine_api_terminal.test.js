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
    fsListOnRunner: async () => ({}),
    fsReadOnRunner: async () => ({}),
    gitStatusOnRunner: async () => ({}),
    terminalSessions,
    terminalPtyStartOnRunner: async () => {
      throw new Error('start should not be called')
    },
    terminalExecOnRunner: async () => ({}),
    codexModelListOnRunner: async () => ({}),
    pendingIdeStarts: { cancel() {} },
    requestMachineUpgrade: async () => ({})
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
