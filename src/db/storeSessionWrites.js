import { summarizeTextSnippet } from './storeRows.js'

function trimStringOrNull(value) {
  return (typeof value === 'string' && value.trim()) ? value.trim() : null
}

export function normalizeSessionOptionValues(options = null) {
  return {
    model: trimStringOrNull(options?.model),
    reasoningEffort: trimStringOrNull(options?.reasoningEffort),
    approvalPolicy: trimStringOrNull(options?.approvalPolicy),
    sandbox: trimStringOrNull(options?.sandbox)
  }
}

export function buildCreateSessionRow({
  sessionId,
  machineId,
  cwd,
  status,
  codexThreadId = null,
  options = null,
  now
}) {
  const normalized = normalizeSessionOptionValues(options)
  return [
    sessionId,
    machineId,
    cwd,
    null,
    null,
    null,
    status,
    'idle',
    0,
    0,
    0,
    now,
    now,
    codexThreadId,
    normalized.model,
    normalized.reasoningEffort,
    normalized.approvalPolicy,
    normalized.sandbox,
    null
  ]
}

export function buildUpdateSessionStatement({
  status,
  codexThreadId,
  projectLabel,
  title,
  preview,
  turnState,
  pendingApprovals,
  lastReadSeq,
  model,
  reasoningEffort,
  approvalPolicy,
  sandbox,
  now
}) {
  const sets = []
  const params = []

  if (status !== undefined) { sets.push('status=?'); params.push(status) }
  if (codexThreadId !== undefined) { sets.push('codex_thread_id=?'); params.push(codexThreadId) }
  if (projectLabel !== undefined) { sets.push('project_label=?'); params.push(projectLabel) }
  if (title !== undefined) { sets.push('title=?'); params.push(title) }
  if (preview !== undefined) { sets.push('preview=?'); params.push(preview) }
  if (turnState !== undefined) { sets.push('turn_state=?'); params.push(turnState) }
  if (pendingApprovals !== undefined) { sets.push('pending_approvals=?'); params.push(pendingApprovals) }
  if (lastReadSeq !== undefined) { sets.push('last_read_seq=?'); params.push(lastReadSeq) }
  if (model !== undefined) { sets.push('model=?'); params.push(model) }
  if (reasoningEffort !== undefined) { sets.push('reasoning_effort=?'); params.push(reasoningEffort) }
  if (approvalPolicy !== undefined) { sets.push('approval_policy=?'); params.push(approvalPolicy) }
  if (sandbox !== undefined) { sets.push('sandbox_mode=?'); params.push(sandbox) }

  sets.push('updated_ms=?')
  params.push(now)

  return { sets, params }
}

export function normalizeStoredEventPayload({ type, payload, seq }) {
  let payloadToStore = payload ?? null
  if (type === 'session.output' && payloadToStore && typeof payloadToStore === 'object') {
    const next = { ...payloadToStore }
    if (next.seq !== undefined && next.seq !== null && next.seq !== seq) next.runnerSeq = next.seq
    next.seq = seq
    payloadToStore = next
  }

  return {
    payload: payloadToStore,
    payloadJson: JSON.stringify(payloadToStore),
    stream: (type === 'session.output' && typeof payloadToStore?.stream === 'string') ? payloadToStore.stream : null,
    itemId: (typeof payloadToStore?.itemId === 'string' && payloadToStore.itemId) ? payloadToStore.itemId : null
  }
}

export function buildDerivedSessionEventUpdate({ type, payload, tsMs, seq }) {
  const sets = ['updated_ms=?', 'last_seq=?']
  const params = [tsMs, seq]

  if (type === 'session.input') {
    const text = summarizeTextSnippet(payload?.text)
    if (text) {
      sets.push('preview=?')
      params.push(text)
    }
    if (payload?.isInitial && text) {
      sets.push(`title = CASE WHEN title IS NULL OR title='' THEN ? ELSE title END`)
      params.push(text)
    }
  }

  if (type === 'turn.started') {
    sets.push('turn_state=?')
    params.push('running')
  }

  if (type === 'turn.completed') {
    sets.push('turn_state=?')
    params.push('idle')
    const preview = summarizeTextSnippet(payload?.preview)
    if (preview) {
      sets.push('preview=?')
      params.push(preview)
    }
  }

  if (type === 'approval.request') sets.push('pending_approvals = pending_approvals + 1')
  if (type === 'approval.resolved') sets.push('pending_approvals = MAX(pending_approvals - 1, 0)')

  if (type === 'session.status') {
    const status = payload?.status
    if (status && typeof status === 'string') {
      sets.push('status=?')
      params.push(status)
      if (status === 'stopping' || status === 'exited' || status === 'failed') {
        sets.push('turn_state=?')
        params.push('idle')
      }
    }
    const threadId = payload?.codexThreadId
    if (threadId && typeof threadId === 'string') {
      sets.push('codex_thread_id=?')
      params.push(threadId)
    }
  }

  return { sets, params }
}
