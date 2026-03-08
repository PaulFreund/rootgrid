export function normalizeSessionListGroupingMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'flat' ? 'flat' : 'project'
}

export function buildSessionGroupTuple(session, {
  getHostName,
  getProjectName
} = {}) {
  const host = String(typeof getHostName === 'function' ? getHostName(session) : (session?.machineId ?? 'unknown')).trim() || 'unknown'
  const project = String(typeof getProjectName === 'function' ? getProjectName(session) : (session?.projectLabel ?? session?.cwd ?? 'unknown')).trim() || 'unknown'
  return {
    host,
    project,
    key: `${host}\u0000${project}`,
    label: `${host} · ${project}`
  }
}

export function buildSessionListEntries(sessions, {
  groupingMode = 'project',
  getHostName,
  getProjectName
} = {}) {
  const rows = Array.isArray(sessions) ? sessions : []
  const mode = normalizeSessionListGroupingMode(groupingMode)
  if (mode === 'flat') {
    return rows.map((session) => ({
      kind: 'session',
      key: String(session?.sessionId ?? ''),
      session
    }))
  }

  const groups = new Map()
  const order = []

  for (const session of rows) {
    const tuple = buildSessionGroupTuple(session, { getHostName, getProjectName })
    let group = groups.get(tuple.key)
    if (!group) {
      group = {
        kind: 'group',
        key: `group:${tuple.key}`,
        groupKey: tuple.key,
        host: tuple.host,
        project: tuple.project,
        label: tuple.label,
        sessions: []
      }
      groups.set(tuple.key, group)
      order.push(tuple.key)
    }
    group.sessions.push(session)
  }

  const out = []
  for (const groupKey of order) {
    const group = groups.get(groupKey)
    if (!group) continue
    out.push({
      kind: 'group',
      key: group.key,
      groupKey: group.groupKey,
      host: group.host,
      project: group.project,
      label: group.label
    })
    for (const session of group.sessions) {
      out.push({
        kind: 'session',
        key: String(session?.sessionId ?? ''),
        groupKey: group.groupKey,
        session
      })
    }
  }
  return out
}
