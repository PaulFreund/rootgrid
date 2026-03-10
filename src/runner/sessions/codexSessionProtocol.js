function uniqStrings(values) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const next = value.trim()
    if (!next || seen.has(next)) continue
    seen.add(next)
    out.push(next)
  }
  return out
}

function dedupeJsonObjects(list) {
  const out = []
  const seen = new Set()
  for (const entry of (Array.isArray(list) ? list : [])) {
    const key = JSON.stringify(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

export function safeString(value) {
  return (typeof value === 'string' && value.trim()) ? value : null
}

export function approvalPolicyCandidates(input) {
  if (!input) return []
  const raw = String(input).trim()
  if (!raw) return []

  const variants = {
    untrusted: ['untrusted', 'unlessTrusted'],
    unlessTrusted: ['untrusted', 'unlessTrusted'],
    'on-request': ['on-request', 'onRequest'],
    onRequest: ['on-request', 'onRequest'],
    'on-failure': ['on-failure', 'onFailure'],
    onFailure: ['on-failure', 'onFailure'],
    never: ['never'],
    reject: ['reject']
  }

  return uniqStrings(variants[raw] ?? [raw])
}

export function sandboxCandidates(input) {
  if (!input) return []
  const raw = String(input).trim()
  if (!raw) return []

  const out = []
  if (raw === 'read-only') out.push('readOnly')
  if (raw === 'workspace-write') out.push('workspaceWrite')
  if (raw === 'danger-full-access') out.push('dangerFullAccess')

  if (raw === 'readOnly' || raw === 'workspaceWrite' || raw === 'dangerFullAccess' || raw === 'externalSandbox') out.push(raw)
  if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') out.push(raw)

  return uniqStrings(out)
}

export function sandboxPolicyCandidates(input, cwd) {
  const modes = sandboxCandidates(input)

  const toType = (mode) => {
    if (mode === 'read-only') return 'readOnly'
    if (mode === 'workspace-write') return 'workspaceWrite'
    if (mode === 'danger-full-access') return 'dangerFullAccess'
    if (mode === 'readOnly' || mode === 'workspaceWrite' || mode === 'dangerFullAccess' || mode === 'externalSandbox') return mode
    return null
  }

  const out = []
  for (const mode of modes) {
    const type = toType(mode)
    if (!type) continue
    if (type === 'workspaceWrite' && typeof cwd === 'string' && cwd) {
      out.push({ type, writableRoots: [cwd] })
    }
    out.push({ type })
  }
  for (const mode of modes) out.push(mode)

  return dedupeJsonObjects(out)
}

export function reasoningEffortCandidates(input) {
  if (!input) return []
  const raw = String(input).trim()
  if (!raw) return []

  const norm = raw.toLowerCase().replace(/[\s_]+/g, '-')
  const out = []

  if (norm === 'none' || norm === 'minimal' || norm === 'low' || norm === 'medium' || norm === 'high') {
    out.push(norm)
    out.push(norm.toUpperCase().slice(0, 1) + norm.slice(1))
  } else if (norm === 'xhigh' || norm === 'x-high' || norm === 'extra-high' || norm === 'extrahigh') {
    out.push('xhigh')
    out.push('xHigh')
    out.push('x_high')
    out.push('x-high')
    out.push('extra-high')
    out.push('extraHigh')
    out.push('extra_high')
  } else {
    out.push(raw)
    if (norm !== raw) out.push(norm)
  }

  return uniqStrings(out)
}

export function reasoningParamObjects(effort) {
  const next = safeString(effort)
  if (!next) return []
  return [
    { effort: next },
    { reasoningEffort: next },
    { reasoning_effort: next },
    { reasoning: { effort: next } },
    { reasoning: next }
  ]
}

function pushParamVariants(out, base, reasoningEfforts) {
  const efforts = Array.isArray(reasoningEfforts) ? reasoningEfforts : []
  if (efforts.length) {
    for (const effort of efforts) {
      for (const params of reasoningParamObjects(effort)) out.push({ ...base, ...params })
    }
  }
  out.push(base)
}

export function buildResumeThreadAttempts({
  threadId,
  cwd,
  model = null,
  approvalPolicies = [],
  sandboxes = [],
  reasoningEfforts = []
}) {
  const approvalVals = approvalPolicies.length ? approvalPolicies : [null]
  const sandboxVals = sandboxes.length ? sandboxes : [null]
  const out = []

  for (const approvalPolicy of approvalVals) {
    for (const sandbox of sandboxVals) {
      const common = {
        cwd,
        ...(model ? { model } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandbox ? { sandbox } : {})
      }
      pushParamVariants(out, { threadId, ...common }, reasoningEfforts)
      pushParamVariants(out, { id: threadId, ...common }, reasoningEfforts)
    }
  }

  return dedupeJsonObjects(out)
}

export function buildStartThreadAttempts({
  cwd,
  model = null,
  approvalPolicies = [],
  sandboxes = [],
  reasoningEfforts = []
}) {
  const approvalVals = approvalPolicies.length ? approvalPolicies : [null]
  const sandboxVals = sandboxes.length ? sandboxes : [null]
  const out = []

  for (const approvalPolicy of approvalVals) {
    for (const sandbox of sandboxVals) {
      pushParamVariants(out, {
        ...(model ? { model } : {}),
        cwd,
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandbox ? { sandbox } : {})
      }, reasoningEfforts)
    }
  }

  return dedupeJsonObjects(out)
}

export function buildStartTurnAttempts({
  threadId,
  cwd,
  input,
  model = null,
  approvalPolicies = [],
  sandboxes = [],
  sandboxPolicies = [],
  reasoningEfforts = []
}) {
  const base = {
    threadId,
    cwd,
    input: Array.isArray(input) ? input : []
  }
  const approvalVals = approvalPolicies.length ? approvalPolicies : [null]
  const sandboxPolicyVals = sandboxPolicies.length
    ? [
        ...sandboxPolicies.filter((value) => value && typeof value === 'object'),
        ...sandboxPolicies.filter((value) => typeof value === 'string' && value.trim())
      ]
    : [null]
  const sandboxVals = sandboxes.length ? sandboxes : [null]
  const out = []

  for (const approvalPolicy of approvalVals) {
    for (const sandboxPolicy of sandboxPolicyVals) {
      pushParamVariants(out, {
        ...base,
        ...(model ? { model } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandboxPolicy ? { sandboxPolicy } : {})
      }, reasoningEfforts)
    }
    for (const sandbox of sandboxVals) {
      pushParamVariants(out, {
        ...base,
        ...(model ? { model } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandbox ? { sandbox } : {})
      }, reasoningEfforts)
    }
  }

  pushParamVariants(out, {
    ...base,
    ...(model ? { model } : {})
  }, reasoningEfforts)

  return dedupeJsonObjects(out)
}

export function tryExtractDeltaText(params) {
  const candidates = [
    params?.delta,
    params?.textDelta,
    params?.outputDelta,
    params?.chunk,
    params?.text
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.text === 'string' && candidate.text.length > 0) return candidate.text
      if (typeof candidate.delta === 'string' && candidate.delta.length > 0) return candidate.delta
      if (typeof candidate.value === 'string' && candidate.value.length > 0) return candidate.value
    }
  }
  return null
}

export function tryExtractAgentMessageText(item) {
  if (!item || typeof item !== 'object') return null
  const content = item.content ?? item.message ?? item.text ?? null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (typeof part === 'string') parts.push(part)
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') parts.push(part.text)
        else if (typeof part.content === 'string') parts.push(part.content)
        else if (typeof part.value === 'string') parts.push(part.value)
      }
    }
    const joined = parts.join('')
    return joined || null
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return null
}

export function tryExtractReasoningText(item) {
  if (!item || typeof item !== 'object') return null
  const summary = item.summary ?? item.summary_text ?? item.summaryText ?? null
  if (Array.isArray(summary)) {
    const joined = summary.filter((value) => typeof value === 'string' && value.length > 0).join('\n')
    if (joined) return joined
  }

  const content = item.content ?? null
  if (Array.isArray(content)) {
    const joined = content.filter((value) => typeof value === 'string' && value.length > 0).join('')
    if (joined) return joined
  }

  return tryExtractAgentMessageText(item)
}

export function tryExtractPlanText(item) {
  if (!item || typeof item !== 'object') return null
  const text = safeString(item.text)
  return text || tryExtractAgentMessageText(item)
}

export function normalizeAgentMessagePhase(value) {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase().replace(/[\s_-]/g, '')
  if (!normalized) return null
  if (normalized === 'commentary') return 'commentary'
  if (normalized === 'finalanswer') return 'final_answer'
  return normalized
}

export function normalizeItemType(value) {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase().replace(/[\s_-]/g, '')
  return normalized || null
}

export function minimizeFileChanges(changes) {
  if (!Array.isArray(changes)) return null
  const out = []
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue
    const path = safeString(change.path)
    const kind = safeString(change.kind)
    if (!path) continue
    out.push({ path, ...(kind ? { kind } : {}) })
  }
  return out
}
