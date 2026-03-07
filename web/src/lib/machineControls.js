export function resolveIdeSessionRequest({
  selectedSession = null,
  defaults = {}
} = {}) {
  const cwd = String(selectedSession?.cwd ?? defaults?.cwd ?? '').trim()
  if (!cwd) {
    return {
      ok: false,
      error: 'Workspace (cwd) is required.'
    }
  }

  const machineId = String(selectedSession?.machineId ?? defaults?.machineId ?? '').trim()
  return {
    ok: true,
    body: {
      cwd,
      ...(machineId ? { machineId } : {})
    }
  }
}

export function createMachineControlActions({
  apiFetch,
  defaults,
  openSettings,
  selectedSession,
  machineDisconnectWorkingId,
  machineDisconnectError,
  ideError,
  ideStarting,
  windowObj = globalThis.window
}) {
  async function disconnectMachine(machineId) {
    machineDisconnectError.value = ''
    const mid = String(machineId ?? '').trim()
    if (!mid) return false
    if (machineDisconnectWorkingId.value) return false

    machineDisconnectWorkingId.value = mid
    try {
      const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/disconnect`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        machineDisconnectError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      return true
    } finally {
      machineDisconnectWorkingId.value = null
    }
  }

  async function openVSCode() {
    ideError.value = ''
    if (ideStarting.value) return false

    const request = resolveIdeSessionRequest({
      selectedSession: selectedSession.value,
      defaults
    })
    if (!request.ok) {
      ideError.value = request.error
      if (typeof openSettings === 'function') openSettings('defaults')
      return false
    }

    ideStarting.value = true
    try {
      const res = await apiFetch('/api/ide-sessions', {
        method: 'POST',
        body: JSON.stringify(request.body)
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        ideError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }

      const data = await res.json().catch(() => null)
      const urlPath = data?.urlPath
      if (!urlPath) {
        ideError.value = 'IDE session did not return a urlPath.'
        return false
      }

      windowObj?.open?.(urlPath, '_blank', 'noopener')
      return true
    } finally {
      ideStarting.value = false
    }
  }

  return {
    disconnectMachine,
    openVSCode
  }
}
