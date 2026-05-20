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
  machineUpgradeWorkingIds = null,
  machineUpgradeWorkingId = { value: null },
  machineUpgradeError = { value: '' },
  appSettings = null,
  ideError,
  ideStarting,
  getMachineLabel = null,
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

  function getUpgradeWorkingIds() {
    if (machineUpgradeWorkingIds && typeof machineUpgradeWorkingIds === 'object' && 'value' in machineUpgradeWorkingIds) {
      if (!Array.isArray(machineUpgradeWorkingIds.value)) machineUpgradeWorkingIds.value = []
      return machineUpgradeWorkingIds.value
    }
    const current = String(machineUpgradeWorkingId?.value ?? '').trim()
    return current ? [current] : []
  }

  function setMachineUpgradeWorking(machineId, working) {
    const mid = String(machineId ?? '').trim()
    if (!mid) return
    if (machineUpgradeWorkingIds && typeof machineUpgradeWorkingIds === 'object' && 'value' in machineUpgradeWorkingIds) {
      const current = getUpgradeWorkingIds()
      if (working) {
        if (!current.includes(mid)) machineUpgradeWorkingIds.value = [...current, mid]
        return
      }
      if (current.includes(mid)) machineUpgradeWorkingIds.value = current.filter((value) => value !== mid)
      return
    }
    if (working) {
      machineUpgradeWorkingId.value = mid
      return
    }
    if (String(machineUpgradeWorkingId?.value ?? '').trim() === mid) machineUpgradeWorkingId.value = null
  }

  function machineUpgradeIsWorking(machineId) {
    const mid = String(machineId ?? '').trim()
    return Boolean(mid && getUpgradeWorkingIds().includes(mid))
  }

  function machineUpgradeLabel(machineId) {
    const mid = String(machineId ?? '').trim()
    if (!mid) return ''
    if (typeof getMachineLabel === 'function') {
      const label = String(getMachineLabel(mid) ?? '').trim()
      if (label) return label
    }
    return mid
  }

  async function requestMachineUpgrade(machineId, { surfaceError = true } = {}) {
    const mid = String(machineId ?? '').trim()
    if (!mid) return { ok: false, skipped: true, machineId: mid }
    if (machineUpgradeIsWorking(mid)) return { ok: false, skipped: true, machineId: mid }

    setMachineUpgradeWorking(mid, true)
    try {
      const hostVersion = String(appSettings?.appVersion ?? '').trim() || null
      const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/upgrade`, {
        method: 'POST',
        body: JSON.stringify(hostVersion ? { hostVersion } : {})
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        const message = err?.error ?? `HTTP ${res.status}`
        if (surfaceError) machineUpgradeError.value = message
        return { ok: false, machineId: mid, label: machineUpgradeLabel(mid), error: message }
      }
      return { ok: true, machineId: mid, label: machineUpgradeLabel(mid) }
    } finally {
      setMachineUpgradeWorking(mid, false)
    }
  }

  async function upgradeMachine(machineId) {
    machineUpgradeError.value = ''
    const result = await requestMachineUpgrade(machineId, { surfaceError: true })
    return result.ok
  }

  async function upgradeMachines(machineIds) {
    machineUpgradeError.value = ''
    const ids = Array.from(new Set(
      (Array.isArray(machineIds) ? machineIds : [])
        .map((machineId) => String(machineId ?? '').trim())
        .filter(Boolean)
    ))
    if (!ids.length) return false
    const results = await Promise.all(ids.map((machineId) => requestMachineUpgrade(machineId, { surfaceError: false })))
    const failures = results.filter((result) => !result?.ok && !result?.skipped)
    if (failures.length) {
      machineUpgradeError.value = failures
        .map((result) => `${result?.label || result?.machineId}: ${result?.error || 'upgrade failed'}`)
        .join('  ')
    }
    return failures.length === 0
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
    upgradeMachines,
    openVSCode,
    stopVSCode
  }
}
