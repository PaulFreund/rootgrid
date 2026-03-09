import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createHostSystemApi } from '../src/server/hostSystemApi.js'

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = new Map()
    this.writes = []
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value)
  }

  write(chunk) {
    this.writes.push(String(chunk))
    return true
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk)
    this.emit('close')
  }
}

test('host system SSE resume uses lightweight registry.hello when replay buffer can cover the gap', async () => {
  let machineCalls = 0
  let sessionCalls = 0
  let approvalCalls = 0
  const sent = []
  let activated = null

  const api = createHostSystemApi({
    auth: {
      requireAuth() { return true }
    },
    store: {
      listMachines() {
        machineCalls += 1
        return []
      },
      listSessionsPage() {
        sessionCalls += 1
        return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null }
      },
      listApprovals() {
        approvalCalls += 1
        return []
      }
    },
    runnerWs: {
      listConnectedMachineIds() {
        return []
      }
    },
    sse: {
      canReplayFrom(id) {
        return Number(id) === 41
      },
      addClient() {},
      sendDirect(payload) {
        sent.push(payload)
        return true
      },
      activateClient(id, opts) {
        activated = { id, ...opts }
        return true
      }
    },
    push: null,
    config: {},
    readJsonBody: async () => ({}),
    json() {}
  })

  const req = {
    method: 'GET',
    headers: {}
  }
  const res = new FakeResponse()
  const url = new URL('http://127.0.0.1/api/events?visibility=visible&resume=1&lastEventId=41')

  const handled = await api.handle(req, res, url, [])
  assert.equal(handled, true)
  assert.equal(sent[0]?.envelope?.type, 'registry.hello')
  assert.equal(sent[0]?.envelope?.payload?.resumed, true)
  assert.equal(machineCalls, 0)
  assert.equal(sessionCalls, 0)
  assert.equal(approvalCalls, 0)
  assert.equal(activated?.replayAfter, 41)
})

test('host system SSE falls back to full registry.snapshot when lightweight resume is unavailable', async () => {
  const sent = []

  const api = createHostSystemApi({
    auth: {
      requireAuth() { return true }
    },
    store: {
      listMachines() {
        return [{ machineId: 'm-1', machineName: 'runner' }]
      },
      listSessionsPage() {
        return {
          sessions: [{ sessionId: 's-1', machineId: 'm-1' }],
          hasMoreBefore: true,
          nextBeforeUpdatedMs: 123,
          nextBeforeSessionId: 's-1'
        }
      },
      listApprovals() {
        return [{ payload: { approvalId: 'a-1' } }]
      },
      deletePushSubscription() {}
    },
    runnerWs: {
      listConnectedMachineIds() {
        return ['m-1']
      }
    },
    sse: {
      canReplayFrom() {
        return false
      },
      addClient() {},
      sendDirect(payload) {
        sent.push(payload)
        return true
      },
      activateClient() {
        return true
      }
    },
    push: null,
    config: {},
    readJsonBody: async () => ({}),
    json() {}
  })

  const req = {
    method: 'GET',
    headers: {}
  }
  const res = new FakeResponse()
  const url = new URL('http://127.0.0.1/api/events?visibility=visible&resume=1&lastEventId=41')

  const handled = await api.handle(req, res, url, [])
  assert.equal(handled, true)
  assert.equal(sent[0]?.envelope?.type, 'registry.snapshot')
  assert.equal(sent[0]?.envelope?.payload?.machines?.[0]?.connected, true)
  assert.equal(sent[0]?.envelope?.payload?.sessions?.[0]?.sessionId, 's-1')
  assert.equal(sent[0]?.envelope?.payload?.sessionsHasMore, true)
  assert.equal(sent[0]?.envelope?.payload?.sessionsNextBeforeUpdatedMs, 123)
  assert.equal(sent[0]?.envelope?.payload?.sessionsNextBeforeSessionId, 's-1')
  assert.equal(sent[0]?.envelope?.payload?.approvals?.[0]?.approvalId, 'a-1')
})

test('host system exposes authenticated runner install bootstrap payloads', async () => {
  const api = createHostSystemApi({
    auth: {
      requireAuth() { return true }
    },
    store: {
      listMachines() { return [] },
      listSessionsPage() { return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null } },
      listApprovals() { return [] }
    },
    runnerWs: {
      listConnectedMachineIds() {
        return []
      }
    },
    sse: {
      canReplayFrom() { return false },
      addClient() {},
      sendDirect() { return true },
      activateClient() { return true }
    },
    push: null,
    config: {},
    runnerInstall: {
      async createBootstrap() {
        return {
          installToken: 'install-token',
          expiresAtMs: 1234,
          baseUrl: 'https://rootgrid.example.test',
          installUrl: 'https://rootgrid.example.test/api/install/runner.sh?installToken=install-token',
          installCommand: "curl -fsSL 'https://rootgrid.example.test/api/install/runner.sh?installToken=install-token' | bash",
          version: '0.0.1',
          releaseId: 'rootgrid-0.0.1-test'
        }
      }
    },
    readJsonBody: async () => ({}),
    json(res, code, payload) {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.payload = payload
      res.end()
    }
  })

  const req = {
    method: 'POST',
    headers: {}
  }
  const res = new FakeResponse()
  const url = new URL('http://127.0.0.1/api/install/runner-bootstrap')

  const handled = await api.handle(req, res, url, [])
  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload?.installToken, 'install-token')
  assert.match(res.payload?.installCommand ?? '', /curl -fsSL/)
})

test('host system serves a runner bootstrap shell script by install token', async () => {
  const api = createHostSystemApi({
    auth: {
      requireAuth() { return true }
    },
    store: {
      listMachines() { return [] },
      listSessionsPage() { return { sessions: [], hasMoreBefore: false, nextBeforeUpdatedMs: null, nextBeforeSessionId: null } },
      listApprovals() { return [] }
    },
    runnerWs: {
      listConnectedMachineIds() {
        return []
      }
    },
    sse: {
      canReplayFrom() { return false },
      addClient() {},
      sendDirect() { return true },
      activateClient() { return true }
    },
    push: null,
    config: {},
    runnerInstall: {
      async renderInstallScript(_req, installToken) {
        if (installToken !== 'ok') return null
        return '#!/usr/bin/env bash\necho rootgrid\n'
      }
    },
    readJsonBody: async () => ({}),
    json() {}
  })

  const req = {
    method: 'GET',
    headers: {}
  }
  const res = new FakeResponse()
  const url = new URL('http://127.0.0.1/api/install/runner.sh?installToken=ok')

  const handled = await api.handle(req, res, url, [])
  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.get('content-type'), 'text/x-shellscript; charset=utf-8')
  assert.equal(res.writes.join(''), '#!/usr/bin/env bash\necho rootgrid\n')
})
