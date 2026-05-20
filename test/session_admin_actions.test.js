import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'

import { createSessionAdminActions, getMachineDeleteError } from '../web/src/lib/sessionAdminActions.js'

test('getMachineDeleteError blocks deletion for online machines only', () => {
  const machineIsOnline = (m) => Boolean(m?.connected)

  assert.equal(getMachineDeleteError({ machineId: 'm-1', connected: true }, { machineIsOnline }), 'Machine is online. Disconnect the runner before deleting.')
  assert.equal(getMachineDeleteError({ machineId: 'm-1', connected: false }, { machineIsOnline }), '')
  assert.equal(getMachineDeleteError(null, { machineIsOnline }), '')
})

test('confirmDeleteSession clears selected session via callback instead of leaving prior workspace context', async () => {
  const selectedSessionId = ref('s-1')
  const sessions = ref([{ sessionId: 's-1', cwd: '/repo', machineId: 'm-1' }])
  const archivedSessions = ref([])
  const removed = []
  const deletedSelections = []

  const actions = createSessionAdminActions({
    apiFetch: async () => ({
      ok: true,
      status: 200,
      async json() { return { ok: true } }
    }),
    machineIsOnline: () => false,
    removeMachineLocal: () => {},
    removeSessionRow: (sessionId) => removed.push(sessionId),
    onSelectedSessionDeleted: (session) => deletedSelections.push(session),
    upsertSessionRow: () => {},
    selectedSessionId,
    sessions,
    archivedSessions,
    machines: ref([]),
    archiveOpen: ref(false),
    archiveLoading: ref(false),
    archiveError: ref(''),
    deleteOpen: ref(true),
    deleteSessionId: ref('s-1'),
    deleteWorking: ref(false),
    deleteError: ref(''),
    deleteMachineOpen: ref(false),
    deleteMachineId: ref(''),
    deleteMachineWorking: ref(false),
    deleteMachineError: ref('')
  })

  await actions.confirmDeleteSession()
  assert.equal(selectedSessionId.value, null)
  assert.deepEqual(removed, ['s-1'])
  assert.equal(deletedSelections.length, 1)
  assert.equal(deletedSelections[0]?.cwd, '/repo')
})

test('confirmCleanSessionDelete creates a replacement session in the same folder before deleting the old one', async () => {
  const selectedSessionId = ref('s-1')
  const sessions = ref([{
    sessionId: 's-1',
    cwd: '/repo',
    machineId: 'm-1',
    model: 'gpt-5',
    reasoningEffort: 'high',
    serviceTier: 'pro',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  }])
  const archivedSessions = ref([])
  const removed = []
  const upserts = []
  const requests = []
  const cleanOpen = ref(true)
  const cleanSessionId = ref('s-1')
  const cleanWorking = ref(false)
  const cleanError = ref('')

  const actions = createSessionAdminActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/sessions/draft') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sessionId: 's-2',
              session: { sessionId: 's-2', cwd: '/repo', machineId: 'm-1', status: 'idle' }
            }
          }
        }
      }
      if (path === '/api/sessions/s-1') {
        return {
          ok: true,
          status: 200,
          async json() { return { ok: true } }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    machineIsOnline: () => false,
    removeMachineLocal: () => {},
    removeSessionRow: (sessionId) => removed.push(sessionId),
    onSelectedSessionDeleted: () => {},
    upsertSessionRow: (session) => upserts.push(session),
    selectedSessionId,
    sessions,
    archivedSessions,
    machines: ref([]),
    archiveOpen: ref(false),
    archiveLoading: ref(false),
    archiveError: ref(''),
    cleanOpen,
    cleanSessionId,
    cleanWorking,
    cleanError,
    deleteOpen: ref(false),
    deleteSessionId: ref(null),
    deleteWorking: ref(false),
    deleteError: ref(''),
    deleteMachineOpen: ref(false),
    deleteMachineId: ref(''),
    deleteMachineWorking: ref(false),
    deleteMachineError: ref('')
  })

  const ok = await actions.confirmCleanSessionDelete()

  assert.equal(ok, true)
  assert.equal(cleanOpen.value, false)
  assert.equal(cleanSessionId.value, null)
  assert.equal(cleanError.value, '')
  assert.equal(selectedSessionId.value, 's-2')
  assert.deepEqual(removed, ['s-1'])
  assert.equal(upserts[0]?.sessionId, 's-2')
  assert.deepEqual(requests.map((request) => request.path), ['/api/sessions/draft', '/api/sessions/s-1'])
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    cwd: '/repo',
    machineId: 'm-1',
    options: {
      model: 'gpt-5',
      reasoningEffort: 'high',
      serviceTier: 'pro',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }
  })
})

test('confirmCleanSessionArchive creates a replacement session and archives the old one', async () => {
  const selectedSessionId = ref('s-1')
  const sessions = ref([{
    sessionId: 's-1',
    cwd: '/repo',
    machineId: 'm-1',
    approvalPolicy: 'never',
    sandbox: 'workspace-write'
  }])
  const archivedSessions = ref([])
  const upserts = []
  const requests = []
  const cleanOpen = ref(true)
  const cleanSessionId = ref('s-1')
  const cleanWorking = ref(false)
  const cleanError = ref('')

  const actions = createSessionAdminActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/sessions/draft') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sessionId: 's-2',
              session: { sessionId: 's-2', cwd: '/repo', machineId: 'm-1', status: 'idle' }
            }
          }
        }
      }
      if (path === '/api/sessions/s-1/archive') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              session: { sessionId: 's-1', cwd: '/repo', machineId: 'm-1', archivedMs: 123 }
            }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    machineIsOnline: () => false,
    removeMachineLocal: () => {},
    removeSessionRow: () => {},
    onSelectedSessionDeleted: () => {},
    upsertSessionRow: (session) => upserts.push(session),
    selectedSessionId,
    sessions,
    archivedSessions,
    machines: ref([]),
    archiveOpen: ref(false),
    archiveLoading: ref(false),
    archiveError: ref(''),
    cleanOpen,
    cleanSessionId,
    cleanWorking,
    cleanError,
    deleteOpen: ref(false),
    deleteSessionId: ref(null),
    deleteWorking: ref(false),
    deleteError: ref(''),
    deleteMachineOpen: ref(false),
    deleteMachineId: ref(''),
    deleteMachineWorking: ref(false),
    deleteMachineError: ref('')
  })

  const ok = await actions.confirmCleanSessionArchive()

  assert.equal(ok, true)
  assert.equal(cleanOpen.value, false)
  assert.equal(cleanError.value, '')
  assert.equal(selectedSessionId.value, 's-2')
  assert.deepEqual(requests.map((request) => request.path), ['/api/sessions/draft', '/api/sessions/s-1/archive'])
  assert.deepEqual(upserts.map((session) => session?.sessionId), ['s-2', 's-1'])
})
