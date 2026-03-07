import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'
import {
  collectUploadHostPathsForSessionIds,
  listSessionIdsByMachine,
  listUploadHostPathsByMachine,
  pruneOldData
} from '../src/db/storeMaintenance.js'

function buildStore() {
  const store = new Store({ dbPath: ':memory:' })
  store.upsertMachine({
    machineId: 'm-old',
    machineName: 'old runner',
    platform: 'linux',
    capabilities: null
  })
  store.upsertMachine({
    machineId: 'm-new',
    machineName: 'new runner',
    platform: 'linux',
    capabilities: null
  })
  store.createSession({
    sessionId: 's-old',
    machineId: 'm-old',
    cwd: '/old',
    status: 'idle'
  })
  store.createSession({
    sessionId: 's-new',
    machineId: 'm-new',
    cwd: '/new',
    status: 'idle'
  })
  return store
}

test('storeMaintenance helpers list related session/upload paths and prune old data', () => {
  const store = buildStore()

  store.upsertUpload({
    uploadId: 'u-old',
    sessionId: 's-old',
    filename: 'old.txt',
    mimeType: 'text/plain',
    sizeBytes: 1,
    hostPath: '/uploads/old.txt',
    runnerPath: '/runner/old.txt'
  })
  store.upsertUpload({
    uploadId: 'u-new',
    sessionId: 's-new',
    filename: 'new.txt',
    mimeType: 'text/plain',
    sizeBytes: 1,
    hostPath: '/uploads/new.txt',
    runnerPath: '/runner/new.txt'
  })
  store.upsertIdeSession({
    ideId: 'ide-old',
    machineId: 'm-old',
    cwd: '/old',
    port: 7331
  })

  store.db.prepare(`UPDATE sessions SET updated_ms=? WHERE session_id='s-old'`).run(10)
  store.db.prepare(`UPDATE sessions SET updated_ms=? WHERE session_id='s-new'`).run(10_000)
  store.db.prepare(`UPDATE machines SET last_seen_ms=? WHERE machine_id='m-old'`).run(10)
  store.db.prepare(`UPDATE machines SET last_seen_ms=? WHERE machine_id='m-new'`).run(10_000)
  store.db.prepare(`UPDATE ide_sessions SET updated_ms=? WHERE ide_id='ide-old'`).run(10)

  assert.deepEqual(listSessionIdsByMachine(store.db, 'm-old'), ['s-old'])
  assert.deepEqual(listUploadHostPathsByMachine(store.db, 'm-old'), ['/uploads/old.txt'])
  assert.deepEqual(collectUploadHostPathsForSessionIds(store.db, ['s-old', 's-new']).sort(), [
    '/uploads/new.txt',
    '/uploads/old.txt'
  ])

  const pruned = pruneOldData(store.db, { cutoffMs: 100 })
  assert.deepEqual(pruned, {
    sessionsDeleted: 1,
    machinesDeleted: 1,
    ideSessionsDeleted: 0,
    uploadHostPaths: ['/uploads/old.txt'],
    prunedSessions: [{ sessionId: 's-old', machineId: 'm-old' }]
  })

  assert.equal(store.getSession('s-old'), null)
  assert.equal(store.getSession('s-new')?.sessionId, 's-new')
  assert.equal(store.getIdeSession('ide-old'), null)
})
