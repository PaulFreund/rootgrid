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
