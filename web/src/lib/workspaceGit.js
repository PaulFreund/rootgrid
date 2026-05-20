import { parseUnifiedDiff } from './unifiedDiff.js'

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

function diffFilesByPath(diffText) {
  const files = parseUnifiedDiff(String(diffText ?? ''))
  const out = new Map()
  for (const file of files) {
    if (!file || typeof file !== 'object') continue
    for (const candidate of [file.path, file.newPath, file.oldPath]) {
      const key = String(candidate ?? '').trim()
      if (!key) continue
      out.set(key, file)
    }
  }
  return out
}

function summarizeDiffFile(file) {
  let added = 0
  let removed = 0
  let hunks = 0
  for (const line of (Array.isArray(file?.lines) ? file.lines : [])) {
    if (line?.kind === 'add') added += 1
    else if (line?.kind === 'del') removed += 1
    else if (line?.kind === 'hunk') hunks += 1
  }
  return { added, removed, hunks }
}

function resolveEntryDiffFile(entry, diffIndex) {
  if (!entry || !(diffIndex instanceof Map)) return null
  const keys = [
    entry.path,
    entry.originalPath,
    entry.displayPath
  ]
  for (const candidate of keys) {
    const key = String(candidate ?? '').trim()
    if (!key) continue
    if (diffIndex.has(key)) return diffIndex.get(key)
  }
  return null
}

function buildCard(entry, diffIndex, { diffTruncated = false } = {}) {
  const diffFile = resolveEntryDiffFile(entry, diffIndex)
  const summary = summarizeDiffFile(diffFile)
  const stableId = entry?.originalPath
    ? `${entry.originalPath}->${entry.path}`
    : String(entry?.path ?? '')
  return {
    ...entry,
    id: stableId,
    diffFile,
    diffSummary: summary,
    hasDiff: Boolean(diffFile && Array.isArray(diffFile.lines) && diffFile.lines.some((line) => line?.kind === 'hunk' || line?.kind === 'add' || line?.kind === 'del' || line?.kind === 'ctx')),
    diffTruncated: Boolean(diffTruncated)
  }
}

export function buildWorkspaceGitSections(status) {
  const groups = classifyWorkspaceGitEntries(status?.entries)
  const stagedDiffIndex = diffFilesByPath(status?.stagedDiff)
  const unstagedDiffIndex = diffFilesByPath(status?.unstagedDiff)

  return [
    {
      key: 'conflicts',
      label: 'Conflicts',
      bulkAction: null,
      cards: groups.conflicts.map((entry) => buildCard(entry, null))
    },
    {
      key: 'staged',
      label: 'Staged',
      bulkAction: 'unstage',
      cards: groups.staged.map((entry) => buildCard(entry, stagedDiffIndex, {
        diffTruncated: status?.stagedDiffTruncated
      }))
    },
    {
      key: 'changes',
      label: 'Unstaged',
      bulkAction: 'stage',
      cards: groups.changes.map((entry) => buildCard(entry, unstagedDiffIndex, {
        diffTruncated: status?.unstagedDiffTruncated
      }))
    },
    {
      key: 'untracked',
      label: 'Untracked',
      bulkAction: 'stage',
      cards: groups.untracked.map((entry) => buildCard(entry, unstagedDiffIndex, {
        diffTruncated: status?.unstagedDiffTruncated
      }))
    }
  ]
}
