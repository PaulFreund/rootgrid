function machineToolKey(machineId, toolId) {
  const mid = String(machineId ?? '').trim()
  const tid = String(toolId ?? '').trim()
  return (mid && tid) ? `${mid}:${tid}` : ''
}

function setField(target, key, value) {
  if (!target || typeof target !== 'object') return
  target[String(key ?? '')] = value
}

function normalizeTools(payload) {
  if (!payload || typeof payload !== 'object') return {}
  return payload
}

export function createMachineToolActions({
  apiFetch,
  machineToolsByMachineId,
  machineToolsLoadingByMachineId,
  machineToolsErrorByMachineId,
  machineToolUpgradeWorking,
  machineToolUpgradeError,
  machineToolUpgradeStatus,
  machineToolAuthWorking,
  machineToolAuthError,
  machineToolAuthStatus
}) {
  async function loadMachineTools(machineId, { force = false } = {}) {
    const mid = String(machineId ?? '').trim()
    if (!mid) return null
    if (machineToolsLoadingByMachineId?.[mid]) return machineToolsByMachineId?.[mid] ?? null
    if (!force && machineToolsByMachineId?.[mid] && typeof machineToolsByMachineId[mid] === 'object') {
      return machineToolsByMachineId[mid]
    }

    setField(machineToolsErrorByMachineId, mid, '')
    setField(machineToolsLoadingByMachineId, mid, true)
    try {
      const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/tools`)
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setField(machineToolsErrorByMachineId, mid, err?.error ?? `HTTP ${res.status}`)
        return null
      }

      const data = await res.json().catch(() => null)
      const tools = normalizeTools(data?.tools)
      setField(machineToolsByMachineId, mid, tools)
      return tools
    } catch (err) {
      setField(machineToolsErrorByMachineId, mid, String(err?.message ?? err))
      return null
    } finally {
      setField(machineToolsLoadingByMachineId, mid, false)
    }
  }

  async function loadMachineToolsForMachines(machineIds, { force = false } = {}) {
    const ids = Array.from(new Set(
      (Array.isArray(machineIds) ? machineIds : [])
        .map((machineId) => String(machineId ?? '').trim())
        .filter(Boolean)
    ))
    if (!ids.length) return []
    return await Promise.all(ids.map((machineId) => loadMachineTools(machineId, { force })))
  }

  async function upgradeMachineTool(machineId, toolId) {
    const mid = String(machineId ?? '').trim()
    const tid = String(toolId ?? '').trim()
    const key = machineToolKey(mid, tid)
    if (!key) return false
    if (machineToolUpgradeWorking?.[key]) return false

    setField(machineToolUpgradeError, key, '')
    setField(machineToolUpgradeStatus, key, '')
    setField(machineToolUpgradeWorking, key, true)
    try {
      const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/tools/${encodeURIComponent(tid)}/upgrade`, {
        method: 'POST',
        body: JSON.stringify({})
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setField(machineToolUpgradeError, key, err?.error ?? `HTTP ${res.status}`)
        return false
      }

      const data = await res.json().catch(() => null)
      if (data?.tools && typeof data.tools === 'object') {
        setField(machineToolsByMachineId, mid, data.tools)
      } else {
        await loadMachineTools(mid, { force: true }).catch(() => {})
      }
      setField(machineToolUpgradeStatus, key, String(data?.message ?? 'Runner tool updated.'))
      setField(machineToolsErrorByMachineId, mid, '')
      return true
    } catch (err) {
      setField(machineToolUpgradeError, key, String(err?.message ?? err))
      return false
    } finally {
      setField(machineToolUpgradeWorking, key, false)
    }
  }

  async function authMachineTool(machineId, toolId, action, input = null) {
    const mid = String(machineId ?? '').trim()
    const tid = String(toolId ?? '').trim()
    const safeAction = String(action ?? '').trim()
    const key = machineToolKey(mid, tid)
    if (!key || !safeAction) return false
    if (machineToolAuthWorking?.[key]) return false

    setField(machineToolAuthError, key, '')
    setField(machineToolAuthStatus, key, '')
    setField(machineToolAuthWorking, key, true)
    try {
      const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}/tools/${encodeURIComponent(tid)}/auth`, {
        method: 'POST',
        body: JSON.stringify({
          action: safeAction,
          ...(input && typeof input === 'object' ? { input } : {})
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        setField(machineToolAuthError, key, err?.error ?? `HTTP ${res.status}`)
        return false
      }

      const data = await res.json().catch(() => null)
      if (data?.tools && typeof data.tools === 'object') {
        setField(machineToolsByMachineId, mid, data.tools)
      } else {
        await loadMachineTools(mid, { force: true }).catch(() => {})
      }
      setField(machineToolAuthStatus, key, String(data?.message ?? 'Runner tool authentication updated.'))
      setField(machineToolsErrorByMachineId, mid, '')
      return true
    } catch (err) {
      setField(machineToolAuthError, key, String(err?.message ?? err))
      return false
    } finally {
      setField(machineToolAuthWorking, key, false)
    }
  }

  return {
    loadMachineTools,
    loadMachineToolsForMachines,
    upgradeMachineTool,
    authMachineTool
  }
}
