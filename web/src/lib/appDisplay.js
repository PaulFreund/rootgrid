export function buildRecentWorkspaces(sessions, machineId, getLabel) {
  const mid = String(machineId ?? '').trim()
  const rows = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => !s?.archivedMs && (!mid || s.machineId === mid))
    .slice()
    .sort((a, b) => Number(b?.updatedMs ?? 0) - Number(a?.updatedMs ?? 0))

  const seen = new Set()
  const out = []
  for (const s of rows) {
    const cwd = String(s?.cwd ?? '').trim()
    if (!cwd || seen.has(cwd)) continue
    seen.add(cwd)
    out.push({ cwd, label: typeof getLabel === 'function' ? getLabel(s) : cwd })
    if (out.length >= 10) break
  }
  return out
}

export function machineLastSessionUsedMs(sessions, machineId) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return 0
  let latest = 0
  for (const session of (Array.isArray(sessions) ? sessions : [])) {
    if (String(session?.machineId ?? '').trim() !== mid) continue
    const candidate = Math.max(
      Number(session?.updatedMs ?? 0),
      Number(session?.createdMs ?? 0)
    )
    if (Number.isFinite(candidate) && candidate > latest) latest = candidate
  }
  return latest
}

export function sortMachinesForSettings(machines, sessions, nowMs = Date.now()) {
  return (Array.isArray(machines) ? machines : [])
    .slice()
    .sort((a, b) => {
      const aUsedMs = machineLastSessionUsedMs(sessions, a?.machineId)
      const bUsedMs = machineLastSessionUsedMs(sessions, b?.machineId)
      if (aUsedMs !== bUsedMs) return bUsedMs - aUsedMs
      const ao = machineIsOnline(nowMs, a) ? 1 : 0
      const bo = machineIsOnline(nowMs, b) ? 1 : 0
      if (ao !== bo) return bo - ao
      return Number(b?.lastSeenMs ?? 0) - Number(a?.lastSeenMs ?? 0)
    })
}

export function machineDisplayName(machine) {
  const alias = String(machine?.machineAlias ?? '').trim()
  if (alias) return alias
  const name = String(machine?.machineName ?? '').trim()
  if (name) return name
  const machineId = String(machine?.machineId ?? '').trim()
  return machineId ? machineId.slice(0, 8) : 'unknown'
}

export function indicatorDotClass(color) {
  if (color === 'red') return 'bg-red-500'
  if (color === 'orange') return 'bg-amber-500'
  if (color === 'blue') return 'bg-sky-500'
  return 'bg-emerald-500'
}

export function statusChipClass(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'failed') return 'border-red-500/20 bg-red-500/10 text-red-200'
  if (s === 'exited') return 'border-slate-700/60 bg-slate-200/5 text-slate-300'
  if (s === 'starting') return 'border-amber-500/20 bg-amber-500/10 text-amber-200'
  if (s === 'stopping') return 'border-slate-700/60 bg-slate-200/5 text-slate-300'
  return 'border-slate-800 bg-slate-950/60 text-slate-400'
}

export function toastBorderClass(level) {
  const l = String(level ?? '')
  if (l === 'error') return 'border-red-200 bg-red-50'
  if (l === 'warning') return 'border-amber-200 bg-amber-50'
  if (l === 'success') return 'border-emerald-200 bg-emerald-50'
  return 'border-slate-200 bg-white'
}

export function formatAgo(nowMs, ts) {
  const ms = Number(ts ?? 0)
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown'
  const delta = Math.max(0, Number(nowMs ?? Date.now()) - ms)
  if (delta < 5_000) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export function formatAgeShort(nowMs, ts) {
  const ms = Number(ts ?? 0)
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const delta = Math.max(0, Number(nowMs ?? Date.now()) - ms)
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 14) return `${day}d`
  const wk = Math.floor(day / 7)
  if (wk < 9) return `${wk}w`
  const mo = Math.floor(day / 30)
  if (mo < 24) return `${mo}mo`
  const yr = Math.floor(day / 365)
  return `${yr}y`
}

export function formatCompactInt(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function normalizeRateLimitWindow(limit) {
  if (!limit || typeof limit !== 'object') return null
  const usedRaw = Number(limit?.used_percent ?? limit?.usedPercent ?? NaN)
  const windowRaw = Number(
    limit?.window_minutes
    ?? limit?.windowMinutes
    ?? limit?.window_duration_mins
    ?? limit?.windowDurationMins
    ?? NaN
  )
  const resetRaw = Number(limit?.resets_at ?? limit?.resetsAt ?? NaN)

  const usedPercent = Number.isFinite(usedRaw)
    ? Math.max(0, Math.min(100, usedRaw))
    : null
  const windowMinutes = Number.isFinite(windowRaw) && windowRaw > 0
    ? Math.round(windowRaw)
    : null
  const resetsAtMs = Number.isFinite(resetRaw) && resetRaw > 0
    ? Math.round(resetRaw * 1000)
    : null

  if (usedPercent === null && windowMinutes === null && resetsAtMs === null) return null
  return { usedPercent, windowMinutes, resetsAtMs }
}

function normalizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null
  const limitId = String(rateLimits?.limit_id ?? rateLimits?.limitId ?? '').trim() || null
  const limitName = String(rateLimits?.limit_name ?? rateLimits?.limitName ?? '').trim() || null
  const planType = String(rateLimits?.plan_type ?? rateLimits?.planType ?? '').trim() || null
  const creditsRaw = Number(rateLimits?.credits ?? NaN)
  const credits = Number.isFinite(creditsRaw) ? creditsRaw : null
  const primary = normalizeRateLimitWindow(rateLimits?.primary)
  const secondary = normalizeRateLimitWindow(rateLimits?.secondary)
  if (!limitId && !limitName && !planType && credits === null && !primary && !secondary) return null
  return {
    ...(limitId ? { limitId } : {}),
    ...(limitName ? { limitName } : {}),
    ...(planType ? { planType } : {}),
    ...(credits !== null ? { credits } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {})
  }
}

export function normalizeTokenUsage(payload) {
  if (!payload || typeof payload !== 'object') return null
  const rateLimits = normalizeRateLimits(
    payload?.rateLimits
    ?? payload?.rate_limits
    ?? payload?.tokenUsage?.rateLimits
    ?? payload?.tokenUsage?.rate_limits
  )

  const v2 = payload.tokenUsage
  if (v2 && typeof v2 === 'object') {
    const lastTotal = Number(v2?.last?.totalTokens ?? NaN)
    const totalTotal = Number(v2?.total?.totalTokens ?? NaN)
    const ctx = (v2?.modelContextWindow === null || v2?.modelContextWindow === undefined) ? null : Number(v2.modelContextWindow)
    if (Number.isFinite(lastTotal) || Number.isFinite(totalTotal)) {
      return {
        kind: 'v2',
        lastTotalTokens: Number.isFinite(lastTotal) ? lastTotal : null,
        totalTotalTokens: Number.isFinite(totalTotal) ? totalTotal : null,
        modelContextWindow: Number.isFinite(ctx) ? ctx : null,
        ...(rateLimits ? { rateLimits } : {})
      }
    }
  }

  const info = payload.info
  if (info && typeof info === 'object') {
    const lastTotal = Number(info?.last_token_usage?.total_tokens ?? info?.last_token_usage?.totalTokens ?? NaN)
    const totalTotal = Number(info?.total_token_usage?.total_tokens ?? info?.total_token_usage?.totalTokens ?? NaN)
    const ctx = (info?.model_context_window === null || info?.model_context_window === undefined)
      ? (info?.modelContextWindow ?? null)
      : info.model_context_window
    const ctxNum = (ctx === null || ctx === undefined) ? null : Number(ctx)
    if (Number.isFinite(lastTotal) || Number.isFinite(totalTotal)) {
      return {
        kind: 'v1',
        lastTotalTokens: Number.isFinite(lastTotal) ? lastTotal : null,
        totalTotalTokens: Number.isFinite(totalTotal) ? totalTotal : null,
        modelContextWindow: Number.isFinite(ctxNum) ? ctxNum : null,
        ...(rateLimits ? { rateLimits } : {})
      }
    }
  }

  if (rateLimits) {
    return {
      kind: 'rateLimits',
      rateLimits
    }
  }

  return null
}

export function updateTokenUsageMap(map, sessionId, payload) {
  if (!sessionId || !map?.set) return false
  const norm = normalizeTokenUsage(payload)
  if (!norm) return false
  const prev = map.get(sessionId)
  const merged = {
    ...((prev && typeof prev === 'object') ? prev : {}),
    ...norm
  }
  if (
    norm.kind === 'rateLimits'
    && prev
    && typeof prev === 'object'
    && typeof prev.kind === 'string'
    && prev.kind !== 'rateLimits'
  ) {
    merged.kind = prev.kind
  }
  map.set(sessionId, merged)
  return true
}

export function buildContextUsageSummary(usage) {
  if (!usage || typeof usage !== 'object') return null
  const totalRaw = Number(usage?.totalTotalTokens ?? NaN)
  const lastRaw = Number(usage?.lastTotalTokens ?? NaN)
  const windowRaw = Number(usage?.modelContextWindow ?? NaN)
  const totalTokens = Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : null
  const lastTokens = Number.isFinite(lastRaw) && lastRaw >= 0 ? lastRaw : null
  const modelContextWindow = Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : null
  if (totalTokens === null && lastTokens === null) return null
  const primaryTokens = lastTokens ?? totalTokens
  const percent = (primaryTokens !== null && modelContextWindow)
    ? Math.max(0, Math.min(100, (primaryTokens / modelContextWindow) * 100))
    : null
  return {
    usedTokens: primaryTokens,
    usedLabel: formatCompactInt(primaryTokens),
    totalTokens,
    totalLabel: totalTokens !== null ? formatCompactInt(totalTokens) : null,
    lastTokens,
    lastLabel: lastTokens !== null ? formatCompactInt(lastTokens) : null,
    modelContextWindow,
    windowLabel: modelContextWindow !== null ? formatCompactInt(modelContextWindow) : null,
    percent,
    percentLabel: percent !== null ? `${Math.round(percent)}% full` : '',
    usageLabel: modelContextWindow !== null
      ? `${formatCompactInt(primaryTokens)} / ${formatCompactInt(modelContextWindow)} tokens used`
      : `${formatCompactInt(primaryTokens)} tokens used`
  }
}

function formatRateLimitWindowLabel(windowMinutes, { fallback = 'Limit' } = {}) {
  const minutes = Number(windowMinutes ?? NaN)
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback
  if (minutes >= 7 * 24 * 60 && minutes % (7 * 24 * 60) === 0) {
    const weeks = Math.round(minutes / (7 * 24 * 60))
    return weeks === 1 ? 'Weekly' : `${weeks}w`
  }
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) {
    return `${Math.round(minutes / (24 * 60))}d`
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${Math.round(minutes / 60)}h`
  }
  return `${Math.round(minutes)}m`
}

function formatRateLimitResetLabel(resetAtMs, nowMs = Date.now()) {
  const reset = Number(resetAtMs ?? NaN)
  if (!Number.isFinite(reset) || reset <= 0) return '—'
  const now = new Date(Number(nowMs ?? Date.now()))
  const next = new Date(reset)
  if (
    now.getFullYear() === next.getFullYear()
    && now.getMonth() === next.getMonth()
    && now.getDate() === next.getDate()
  ) {
    return next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return next.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function buildRateLimitEntry(limit, { fallbackLabel, nowMs }) {
  if (!limit || typeof limit !== 'object') return null
  const usedPercent = Number(limit?.usedPercent ?? NaN)
  const remainingPercent = Number.isFinite(usedPercent)
    ? Math.max(0, Math.min(100, 100 - usedPercent))
    : null
  const windowMinutes = Number(limit?.windowMinutes ?? NaN)
  const resetAtMs = Number(limit?.resetsAtMs ?? NaN)
  return {
    label: formatRateLimitWindowLabel(windowMinutes, { fallback: fallbackLabel }),
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    remainingPercent,
    remainingLabel: remainingPercent !== null ? `${Math.round(remainingPercent)}%` : '—',
    resetAtMs: Number.isFinite(resetAtMs) && resetAtMs > 0 ? resetAtMs : null,
    resetLabel: formatRateLimitResetLabel(resetAtMs, nowMs)
  }
}

export function buildRateLimitSummary(usage, nowMs = Date.now()) {
  const limits = usage?.rateLimits
  if (!limits || typeof limits !== 'object') return null
  const items = [
    buildRateLimitEntry(limits?.primary, { fallbackLabel: 'Primary', nowMs }),
    buildRateLimitEntry(limits?.secondary, { fallbackLabel: 'Secondary', nowMs })
  ].filter(Boolean)
  if (!items.length) return null
  return {
    items,
    planType: String(limits?.planType ?? '').trim() || null,
    limitName: String(limits?.limitName ?? '').trim() || null,
    limitId: String(limits?.limitId ?? '').trim() || null
  }
}

export function machineIsOnline(nowMs, machine) {
  if (typeof machine?.connected === 'boolean') return machine.connected
  const last = Number(machine?.lastSeenMs ?? 0)
  if (!Number.isFinite(last) || last <= 0) return false
  return (Number(nowMs ?? Date.now()) - last) < 45_000
}

export function machineShowLastSeen(nowMs, machine) {
  if (!machine || machineIsOnline(nowMs, machine)) return false
  const last = Number(machine?.lastSeenMs ?? 0)
  if (!Number.isFinite(last) || last <= 0) return false
  return (Number(nowMs ?? Date.now()) - last) >= 5 * 60_000
}

export function machineStatusLabel(nowMs, machine) {
  if (!machine) return ''
  if (machineIsOnline(nowMs, machine)) return 'online'
  if (machineShowLastSeen(nowMs, machine)) return `last seen ${formatAgo(nowMs, machine.lastSeenMs)}`
  return 'offline'
}

export function machineRootgridVersion(machine) {
  const value = machine?.capabilities?.rootgridVersion
  const text = String(value ?? '').trim()
  return text || null
}

export function machineHasUnknownVersion(machine, hostVersion) {
  const runnerVersion = machineRootgridVersion(machine)
  const host = String(hostVersion ?? '').trim()
  return Boolean(host && machine && !runnerVersion)
}

export function machineHasVersionMismatch(machine, hostVersion) {
  const runnerVersion = machineRootgridVersion(machine)
  const host = String(hostVersion ?? '').trim()
  return Boolean(runnerVersion && host && runnerVersion !== host)
}

export function machineSupportsWebUpgrade(machine) {
  return Boolean(machine?.capabilities?.upgrade?.enabled)
}

export function machineSupportsToolManagement(machine) {
  return Boolean(machine?.capabilities?.tools?.enabled)
}

export function machineSupportsToolAuth(machine) {
  return Boolean(machine?.capabilities?.tools?.enabled && machine?.capabilities?.tools?.auth)
}

export function countMachineWorkingSessions(sessions, machineId) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return 0
  let count = 0
  for (const session of (Array.isArray(sessions) ? sessions : [])) {
    if (String(session?.machineId ?? '').trim() !== mid) continue
    if (session?.turnState === 'running' || session?.status === 'starting') count += 1
  }
  return count
}

export function machineUpgradeStatusText(machine) {
  const state = String(machine?.upgrade?.state ?? '').trim()
  if (!state) return ''
  const message = String(machine?.upgrade?.message ?? '').trim()
  if (state === 'starting') return 'Preparing upgrade…'
  if (state === 'receiving') return 'Receiving release bundle…'
  if (state === 'installing') return 'Installing release…'
  if (state === 'updating') return 'Updating runner…'
  if (state === 'restarting') return 'Restarting runner…'
  if (state === 'failed') return message ? `Upgrade failed: ${message}` : 'Upgrade failed.'
  return message || state
}

export function planStatusKey(status) {
  return String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

export function planStepIsCompleted(step) {
  return planStatusKey(step?.status) === 'completed'
}

export function finalizeCompletedPlan(plan, turnStatus) {
  const steps = Array.isArray(plan) ? plan : null
  if (!steps?.length) return steps
  if (planStatusKey(turnStatus) !== 'completed') return steps

  let hasInProgress = false
  for (const step of steps) {
    const key = planStatusKey(step?.status)
    if (key === 'completed') continue
    if (key === 'inprogress') {
      hasInProgress = true
      continue
    }
    return steps
  }
  if (!hasInProgress) return steps

  return steps.map((step) => (
    planStatusKey(step?.status) === 'inprogress'
      ? { ...step, status: 'completed' }
      : step
  ))
}
