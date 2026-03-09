function statusText(code) {
  const value = String(code ?? '').trim()
  if (value === 'M') return 'Modified'
  if (value === 'A') return 'Added'
  if (value === 'D') return 'Deleted'
  if (value === 'R') return 'Renamed'
  if (value === 'C') return 'Copied'
  if (value === 'U') return 'Unmerged'
  if (value === '?') return 'Untracked'
  return value || 'Changed'
}

function buildRow(entry, statusCode, side) {
  return {
    ...entry,
    side,
    statusCode,
    statusText: statusText(statusCode),
    displayPath: entry?.originalPath ? `${entry.originalPath} → ${entry.path}` : entry?.path
  }
}

export function classifyWorkspaceGitEntries(entries) {
  const staged = []
  const changes = []
  const untracked = []
  const conflicts = []

  for (const entry of Array.isArray(entries) ? entries : []) {
    const x = String(entry?.x ?? ' ').slice(0, 1) || ' '
    const y = String(entry?.y ?? ' ').slice(0, 1) || ' '
    const isConflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    if (isConflict) {
      conflicts.push(buildRow(entry, `${x}${y}`.trim() || 'U', 'conflict'))
      continue
    }
    if (x === '?' && y === '?') {
      untracked.push(buildRow(entry, '?', 'untracked'))
      continue
    }
    if (x !== ' ' && x !== '?') staged.push(buildRow(entry, x, 'staged'))
    if (y !== ' ' && y !== '?') changes.push(buildRow(entry, y, 'change'))
  }

  return { staged, changes, untracked, conflicts }
}
