import { buildSessionDraftOptions } from './newThreadDialog.js'

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
  onSelectedSessionDeleted = null,
  upsertSessionRow,
  selectedSessionId,
  sessions,
  archivedSessions,
  machines,
  archiveOpen,
  archiveLoading,
  archiveError,
  cleanOpen,
  cleanSessionId,
  cleanWorking,
  cleanError,
  deleteOpen,
  deleteSessionId,
  deleteWorking,
  deleteError,
  deleteMachineOpen,
  deleteMachineId,
  deleteMachineWorking,
  deleteMachineError
}) {
  let cleanReplacement = null

  function findSessionById(sessionId) {
    return sessions.value.find((s) => s?.sessionId === sessionId)
      ?? archivedSessions.value.find((s) => s?.sessionId === sessionId)
      ?? null
  }

  function removeSessionLocally(sessionId) {
    if (typeof removeSessionRow === 'function') removeSessionRow(sessionId)
    else {
      const liveIdx = sessions.value.findIndex((s) => s?.sessionId === sessionId)
      if (liveIdx >= 0) sessions.value.splice(liveIdx, 1)
    }
    const archivedIdx = archivedSessions.value.findIndex((s) => s?.sessionId === sessionId)
    if (archivedIdx >= 0) archivedSessions.value.splice(archivedIdx, 1)
  }

  async function requestArchiveSession(sessionId) {
    if (!sessionId) return null
    const res = await apiFetch(`/api/sessions/${sessionId}/archive`, { method: 'POST' })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
    if (data?.session) upsertSessionRow(data.session)
    if (selectedSessionId.value === sessionId) {
      selectedSessionId.value = null
    }
    return data?.session ?? null
  }

  async function archiveSessionById(sessionId) {
    if (!sessionId) return
    try {
      await requestArchiveSession(sessionId)
    } catch {
    }
  }

  async function deleteSessionById(sessionId) {
    if (!sessionId) return null
    const deletedSession = findSessionById(sessionId)
    const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      throw new Error(err?.error ?? `HTTP ${res.status}`)
    }
    if (selectedSessionId.value === sessionId) {
      try { onSelectedSessionDeleted?.(deletedSession) } catch {}
      selectedSessionId.value = null
    }
    removeSessionLocally(sessionId)
    return deletedSession
  }

  function resetCleanReplacement() {
    cleanReplacement = null
  }

  function closeCleanModal() {
    cleanOpen.value = false
    cleanError.value = ''
    cleanSessionId.value = null
    resetCleanReplacement()
  }

  function openCleanModal(sessionId) {
    cleanError.value = ''
    cleanSessionId.value = sessionId ?? selectedSessionId.value
    cleanOpen.value = true
    resetCleanReplacement()
  }

  async function ensureCleanReplacementSession(sessionId) {
    if (cleanReplacement?.sourceSessionId === sessionId && cleanReplacement?.nextSessionId) {
      selectedSessionId.value = cleanReplacement.nextSessionId
      return cleanReplacement
    }

    const sourceSession = findSessionById(sessionId)
    if (!sourceSession) throw new Error('Session not found.')

    const cwd = String(sourceSession?.cwd ?? '').trim()
    const machineId = String(sourceSession?.machineId ?? '').trim()
    if (!cwd) throw new Error('Session workspace is missing.')
    if (!machineId) throw new Error('Session machine is missing.')

    const options = buildSessionDraftOptions(sourceSession)
    const res = await apiFetch('/api/sessions/draft', {
      method: 'POST',
      body: JSON.stringify({ cwd, machineId, options })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

    const nextSession = data?.session ?? null
    if (nextSession) upsertSessionRow(nextSession)
    const nextSessionId = String(data?.sessionId ?? nextSession?.sessionId ?? '').trim()
    if (!nextSessionId) throw new Error('Missing sessionId')

    selectedSessionId.value = nextSessionId
    cleanReplacement = {
      sourceSessionId: sessionId,
      nextSessionId
    }
    return cleanReplacement
  }

  async function confirmCleanSession({ archive = false } = {}) {
    cleanError.value = ''
    const sessionId = String(cleanSessionId.value ?? selectedSessionId.value ?? '').trim()
    if (!sessionId) return false
    if (cleanWorking.value) return false

    cleanWorking.value = true
    try {
      await ensureCleanReplacementSession(sessionId)
      if (archive) await requestArchiveSession(sessionId)
      else await deleteSessionById(sessionId)
      closeCleanModal()
      return true
    } catch (err) {
      cleanError.value = String(err?.message ?? err)
      return false
    } finally {
      cleanWorking.value = false
    }
  }

  async function confirmCleanSessionDelete() {
    return await confirmCleanSession({ archive: false })
  }

  async function confirmCleanSessionArchive() {
    return await confirmCleanSession({ archive: true })
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
      await deleteSessionById(sessionId)
      deleteOpen.value = false
    } catch (err) {
      deleteError.value = String(err?.message ?? err)
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
    openCleanModal,
    closeCleanModal,
    confirmCleanSessionDelete,
    confirmCleanSessionArchive,
    openArchiveModal,
    openDeleteModal,
    confirmDeleteSession,
    openDeleteMachineModal,
    confirmDeleteMachine
  }
}
