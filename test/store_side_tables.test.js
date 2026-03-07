import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'
import {
  deleteApproval,
  deleteIdeSession,
  deletePushSubscription,
  deleteUpload,
  getApproval,
  getIdeSession,
  getUpload,
  listApprovals,
  listIdeSessions,
  listPushSubscriptions,
  listSessionUploads,
  upsertApproval,
  upsertIdeSession,
  upsertPushSubscription,
  upsertUpload
} from '../src/db/storeSideTables.js'

function buildStore() {
  const store = new Store({ dbPath: ':memory:' })
  store.upsertMachine({
    machineId: 'm-1',
    machineName: 'runner',
    platform: 'linux',
    capabilities: null
  })
  store.createSession({
    sessionId: 's-1',
    machineId: 'm-1',
    cwd: '/tmp',
    status: 'idle'
  })
  return store
}

test('storeSideTables approval and IDE helpers persist and load rows', () => {
  const store = buildStore()

  upsertApproval(store.db, {
    approvalId: 'a-1',
    machineId: 'm-1',
    sessionId: 's-1',
    kind: 'command',
    payload: { reason: 'run' },
    createdMs: 10
  })
  upsertIdeSession(store.db, {
    ideId: 'ide-1',
    machineId: 'm-1',
    cwd: '/tmp',
    port: 7331,
    basePath: '/code/',
    createdMs: 20,
    now: 21
  })

  assert.deepEqual(getApproval(store.db, 'a-1'), {
    approvalId: 'a-1',
    machineId: 'm-1',
    sessionId: 's-1',
    kind: 'command',
    payload: { reason: 'run' },
    createdMs: 10
  })
  assert.equal(listApprovals(store.db).length, 1)

  assert.deepEqual(getIdeSession(store.db, 'ide-1'), {
    ideId: 'ide-1',
    machineId: 'm-1',
    cwd: '/tmp',
    port: 7331,
    basePath: '/code/',
    createdMs: 20,
    updatedMs: 21
  })
  assert.equal(listIdeSessions(store.db).length, 1)

  assert.equal(deleteApproval(store.db, 'a-1'), true)
  assert.equal(deleteIdeSession(store.db, 'ide-1'), true)
  assert.equal(listApprovals(store.db).length, 0)
  assert.equal(listIdeSessions(store.db).length, 0)
})

test('storeSideTables upload and push helpers persist and delete rows', () => {
  const store = buildStore()

  upsertUpload(store.db, {
    uploadId: 'u-1',
    sessionId: 's-1',
    filename: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    hostPath: '/host/note.txt',
    runnerPath: '/runner/note.txt',
    now: 30
  })
  upsertPushSubscription(store.db, {
    endpoint: 'https://push.example.test/sub-1',
    p256dh: 'p256dh',
    auth: 'auth',
    now: 40
  })

  assert.deepEqual(getUpload(store.db, { sessionId: 's-1', uploadId: 'u-1' }), {
    uploadId: 'u-1',
    sessionId: 's-1',
    filename: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    hostPath: '/host/note.txt',
    runnerPath: '/runner/note.txt',
    createdMs: 30,
    updatedMs: 30
  })
  assert.equal(listSessionUploads(store.db, 's-1').length, 1)

  assert.deepEqual(listPushSubscriptions(store.db), [{
    endpoint: 'https://push.example.test/sub-1',
    p256dh: 'p256dh',
    auth: 'auth',
    createdMs: 40,
    updatedMs: 40
  }])

  assert.equal(deleteUpload(store.db, { sessionId: 's-1', uploadId: 'u-1' }), true)
  assert.equal(deletePushSubscription(store.db, 'https://push.example.test/sub-1'), true)
  assert.equal(listSessionUploads(store.db, 's-1').length, 0)
  assert.equal(listPushSubscriptions(store.db).length, 0)
})
