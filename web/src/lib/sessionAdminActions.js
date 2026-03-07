export function getMachineDeleteError(machine, { machineIsOnline }) {
  if (machine && machineIsOnline(machine)) {
    return 'Machine is online. Disconnect the runner before deleting.'
  }
  return ''
}

export function createSessionAdminActions({
  apiFetch,
  fetchAllSessionPages = null,
  machineIsOnline,
  machineRowsById = null,
  removeMachineLocal,
  removeSessionRow = null,
  upsertSessionRow,
  selectedSessionId,
  sessions,
  archivedSessions,
  machines,
  archiveOpen,
  archiveLoading,
  archiveError,
  deleteOpen,
  deleteSessionId,
  deleteWorking,
  deleteError,
  deleteMachineOpen,
  deleteMachineId,
  deleteMachineWorking,
  deleteMachineError
}) {
  async function archiveSessionById(sessionId) {
    if (!sessionId) return
    const res = await apiFetch(`/api/sessions/${sessionId}/archive`, { method: 'POST' })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    if (data?.session) upsertSessionRow(data.session)
    if (selectedSessionId.value === sessionId) {
      selectedSessionId.value = null
    }
  }

  async function archiveCurrentSession() {
    return await archiveSessionById(selectedSessionId.value)
  }

  async function unarchiveSessionById(sessionId) {
    if (!sessionId) return
    const res = await apiFetch(`/api/sessions/${sessionId}/unarchive`, { method: 'POST' })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    if (data?.session) upsertSessionRow(data.session)
  }

  async function unarchiveFromArchiveModal(sessionId) {
    await unarchiveSessionById(sessionId)
    const idx = archivedSessions.value.findIndex((s) => s?.sessionId === sessionId)
    if (idx >= 0) archivedSessions.value.splice(idx, 1)
  }

  async function loadArchivedSessions() {
    archiveError.value = ''
    archiveLoading.value = true
    try {
      if (typeof fetchAllSessionPages === 'function') {
        const rows = []
        await fetchAllSessionPages({
          archived: true,
          limit: 200,
          onPage: (sessionsPage) => {
            rows.push(...sessionsPage)
          }
        })
        archivedSessions.value = rows
        return
      }

      const res = await apiFetch('/api/sessions?archived=1')
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        archiveError.value = err?.error ?? `HTTP ${res.status}`
        return
      }
      const data = await res.json().catch(() => null)
      archivedSessions.value = Array.isArray(data?.sessions) ? data.sessions : []
    } catch (err) {
      archiveError.value = String(err?.message ?? err)
    } finally {
      archiveLoading.value = false
    }
  }

  function openArchiveModal() {
    archiveOpen.value = true
    loadArchivedSessions().catch(() => {})
  }

  function openDeleteModal(sessionId) {
    deleteError.value = ''
    deleteSessionId.value = sessionId ?? selectedSessionId.value
    deleteOpen.value = true
  }

  async function confirmDeleteSession() {
    deleteError.value = ''
    const sessionId = deleteSessionId.value
    if (!sessionId) return
    if (deleteWorking.value) return
    deleteWorking.value = true
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        deleteError.value = err?.error ?? `HTTP ${res.status}`
        return
      }
      deleteOpen.value = false
      if (selectedSessionId.value === sessionId) selectedSessionId.value = null
      if (typeof removeSessionRow === 'function') removeSessionRow(sessionId)
      else {
        const liveIdx = sessions.value.findIndex((s) => s?.sessionId === sessionId)
        if (liveIdx >= 0) sessions.value.splice(liveIdx, 1)
      }
      const idx = archivedSessions.value.findIndex((s) => s?.sessionId === sessionId)
      if (idx >= 0) archivedSessions.value.splice(idx, 1)
    } finally {
      deleteWorking.value = false
    }
  }

  function openDeleteMachineModal(machineId) {
    deleteMachineError.value = ''
    deleteMachineId.value = machineId
    deleteMachineOpen.value = true
  }

  async function confirmDeleteMachine() {
    deleteMachineError.value = ''
    const machineId = String(deleteMachineId.value ?? '').trim()
    if (!machineId) return
    if (deleteMachineWorking.value) return

    const machine = machineRowsById?.get?.(machineId) ?? machines.value.find((row) => row?.machineId === machineId) ?? null
    const err = getMachineDeleteError(machine, { machineIsOnline })
    if (err) {
      deleteMachineError.value = err
      return
    }

    deleteMachineWorking.value = true
    try {
      const res = await apiFetch(`/api/machines/${encodeURIComponent(machineId)}`, { method: 'DELETE' })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        deleteMachineError.value = errData?.error ?? `HTTP ${res.status}`
        return
      }
      deleteMachineOpen.value = false
      removeMachineLocal(machineId)
    } finally {
      deleteMachineWorking.value = false
    }
  }

  return {
    archiveSessionById,
    archiveCurrentSession,
    unarchiveSessionById,
    unarchiveFromArchiveModal,
    loadArchivedSessions,
    openArchiveModal,
    openDeleteModal,
    confirmDeleteSession,
    openDeleteMachineModal,
    confirmDeleteMachine
  }
}
