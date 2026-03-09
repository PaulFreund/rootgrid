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
  machineUpgradeWorkingId = { value: null },
  machineUpgradeError = { value: '' },
  appSettings = null,
  ideError,
  ideStarting,
  onIdeSessionStarted = null,
  windowObj = globalThis.window
}) {
  function closeIdeWindow(win) {
    try { win?.close?.() } catch {}
  }

  function openPendingIdeWindow() {
    if (typeof onIdeSessionStarted === 'function') return null
    const opened = windowObj?.open?.('', '_blank')
    if (!opened) return null
    try {
      const doc = opened.document
      if (doc) {
        doc.title = 'Opening Rootgrid IDE…'
        if (doc.body) {
          doc.body.innerHTML = '<div style="font: 14px system-ui, sans-serif; color: #475569; padding: 24px;">Opening workspace…</div>'
        }
      }
    } catch {
    }
    return opened
  }

  function navigateIdeWindow(win, ideSession) {
    const path = String(ideSession?.urlPath ?? '').trim()
    if (!path) return false
    if (typeof onIdeSessionStarted === 'function') {
      onIdeSessionStarted({
        ...ideSession,
        urlPath: path
      })
      return true
    }
    if (!win) {
      windowObj?.open?.(path, '_blank', 'noopener')
      return true
    }
    try {
      win.location?.replace?.(path)
    } catch {
      try {
        win.location.href = path
      } catch {
        return false
      }
    }
    try { win.opener = null } catch {}
    return true
  }

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

  async function upgradeMachine(machineId) {
    machineUpgradeError.value = ''
    const mid = String(machineId ?? '').trim()
    if (!mid) return false
    if (machineUpgradeWorkingId.value) return false

    machineUpgradeWorkingId.value = mid
    try {
      const hostVersion = String(appSettings?.appVersion ?? '').trim() || null
      const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/upgrade`, {
        method: 'POST',
        body: JSON.stringify(hostVersion ? { hostVersion } : {})
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        machineUpgradeError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      return true
    } finally {
      machineUpgradeWorkingId.value = null
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
      if (typeof openSettings === 'function') openSettings('machines')
      return false
    }

    const pendingWindow = openPendingIdeWindow()
    ideStarting.value = true
    try {
      const res = await apiFetch('/api/ide-sessions', {
        method: 'POST',
        body: JSON.stringify(request.body)
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        ideError.value = err?.error ?? `HTTP ${res.status}`
        closeIdeWindow(pendingWindow)
        return false
      }

      const data = await res.json().catch(() => null)
      const urlPath = data?.urlPath
      if (!urlPath) {
        ideError.value = 'IDE session did not return a urlPath.'
        closeIdeWindow(pendingWindow)
        return false
      }

      navigateIdeWindow(pendingWindow, {
        ideId: data?.ideId ?? null,
        urlPath,
        cwd: request.body.cwd,
        machineId: request.body.machineId ?? null
      })
      return true
    } catch (err) {
      ideError.value = String(err?.message ?? err)
      closeIdeWindow(pendingWindow)
      return false
    } finally {
      ideStarting.value = false
    }
  }

  async function stopVSCode(ideId) {
    const id = String(ideId ?? '').trim()
    if (!id) return false
    try {
      const res = await apiFetch(`/api/ide-sessions/${encodeURIComponent(id)}/stop`, {
        method: 'POST'
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        ideError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      return true
    } catch (err) {
      ideError.value = String(err?.message ?? err)
      return false
    }
  }

  return {
    disconnectMachine,
    upgradeMachine,
    openVSCode,
    stopVSCode
  }
}
