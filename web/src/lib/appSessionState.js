export function getOrCreateSessionStore(sessionStores, sessionId, createStoreState, wrap = (value) => value) {
  let store = sessionStores.get(sessionId)
  if (!store) {
    store = wrap(createStoreState())
    sessionStores.set(sessionId, store)
  }
  return store
}

function replaceRegistryRows(rows, rowsById, nextRows, key) {
  const nextList = Array.isArray(nextRows) ? nextRows : []
  const existingById = rowsById?.get ? rowsById : new Map(rows.map((row) => [String(row?.[key] ?? '').trim(), row]))
  const normalized = []

  for (const row of nextList) {
    const rowId = String(row?.[key] ?? '').trim()
    if (!rowId) continue
    const existing = existingById.get(rowId)
    if (existing && existing !== row && row && typeof row === 'object') {
      for (const k of Object.keys(existing)) {
        if (!(k in row)) delete existing[k]
      }
      Object.assign(existing, row)
      normalized.push(existing)
    } else {
      normalized.push(row)
    }
  }

  rows.splice(0, rows.length, ...normalized)
  if (!rowsById?.clear) return true
  rowsById.clear()
  for (const row of rows) {
    const rowId = String(row?.[key] ?? '').trim()
    if (!rowId) continue
    rowsById.set(rowId, row)
  }
  return true
}

function upsertRegistryRow(rows, rowsById, value, key) {
  const rowId = String(value?.[key] ?? '').trim()
  if (!rowId) return false
  const idx = rows.findIndex((row) => String(row?.[key] ?? '') === rowId)
  if (idx >= 0) {
    const current = rows[idx]
    if (current && typeof current === 'object' && value && typeof value === 'object') {
      Object.assign(current, value)
      rowsById?.set?.(rowId, current)
    } else {
      rows[idx] = value
      rowsById?.set?.(rowId, value)
    }
  } else {
    rows.unshift(value)
    rowsById?.set?.(rowId, value)
  }
  return true
}

function removeRegistryRow(rows, rowsById, rowId, key) {
  const id = String(rowId ?? '').trim()
  if (!id) return false
  const idx = rows.findIndex((row) => String(row?.[key] ?? '') === id)
  if (idx < 0) return false
  rows.splice(idx, 1)
  rowsById?.delete?.(id)
  return true
}

export function replaceSessionRows(sessionRows, sessionRowsById, nextRows) {
  return replaceRegistryRows(sessionRows, sessionRowsById, nextRows, 'sessionId')
}

export function appendSessionRowsPage(sessionRows, sessionRowsById, nextRows) {
  const list = Array.isArray(nextRows) ? nextRows : []
  for (const row of list) {
    const rowId = String(row?.sessionId ?? '').trim()
    if (!rowId) continue
    const existing = sessionRowsById?.get?.(rowId) ?? sessionRows.find((entry) => String(entry?.sessionId ?? '').trim() === rowId)
    if (existing && existing !== row && row && typeof row === 'object') {
      for (const key of Object.keys(existing)) {
        if (!(key in row)) delete existing[key]
      }
      Object.assign(existing, row)
      continue
    }
    sessionRows.push(row)
    sessionRowsById?.set?.(rowId, row)
  }
  return true
}

export function replaceMachineRows(machineRows, machineRowsById, nextRows) {
  return replaceRegistryRows(machineRows, machineRowsById, nextRows, 'machineId')
}

export function upsertSessionRowInList(sessionRows, value, sessionRowsById = null) {
  return upsertRegistryRow(sessionRows, sessionRowsById, value, 'sessionId')
}

export function upsertMachineRowInList(machineRows, value, machineRowsById = null) {
  return upsertRegistryRow(machineRows, machineRowsById, value, 'machineId')
}

export function removeSessionRowInList(sessionRows, sessionId, sessionRowsById = null) {
  return removeRegistryRow(sessionRows, sessionRowsById, sessionId, 'sessionId')
}

export function removeMachineRowInList(machineRows, machineId, machineRowsById = null) {
  return removeRegistryRow(machineRows, machineRowsById, machineId, 'machineId')
}

export function bumpSessionRowToTop(sessionRows, sessionId) {
  const idx = sessionRows.findIndex((s) => s.sessionId === sessionId)
  if (idx <= 0) return false
  const [row] = sessionRows.splice(idx, 1)
  sessionRows.unshift(row)
  return true
}

export function removeMachineLocalState({
  machineId,
  sessionRows,
  sessionRowsById = null,
  selectedSessionId,
  sessionStores,
  sessionDataMaps = [],
  machineRows,
  machineRowsById = null,
  defaults,
  newThreadMachineId,
  fallbackMachineId = ''
}) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return false

  for (let i = sessionRows.length - 1; i >= 0; i--) {
    const row = sessionRows[i]
    if (row?.machineId !== mid) continue
    const sid = row?.sessionId
    sessionRows.splice(i, 1)
    if (sid) {
      sessionRowsById?.delete?.(sid)
      if (selectedSessionId?.value === sid) selectedSessionId.value = null
      try { sessionStores.delete(sid) } catch {}
      for (const map of sessionDataMaps) {
        try { map?.delete?.(sid) } catch {}
      }
    }
  }

  removeMachineRowInList(machineRows, mid, machineRowsById)

  if (defaults?.machineId === mid) defaults.machineId = ''
  if (newThreadMachineId?.value === mid) newThreadMachineId.value = fallbackMachineId || ''
  return true
}
