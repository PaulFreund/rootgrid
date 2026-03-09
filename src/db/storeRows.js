export const SUMMARY_SESSION_EVENTS_WHERE = `(type != 'session.output' OR stream IN ('normalized', 'commentary') OR ((stream = 'stderr' OR stream = 'stdout') AND item_id IS NULL))`

export function parseJsonCell(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function summarizeTextSnippet(input, maxChars = 160) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 3))}…` : text
}

export function machineRowToRecord(row) {
  if (!row) return null
  return {
    machineId: row.machine_id,
    machineName: row.machine_name,
    platform: row.platform,
    lastSeenMs: row.last_seen_ms,
    capabilities: parseJsonCell(row.capabilities_json, null)
  }
}

export function sessionRowToRecord(row) {
  if (!row) return null
  return {
    sessionId: row.session_id,
    machineId: row.machine_id,
    cwd: row.cwd,
    projectLabel: row.project_label ?? null,
    title: row.title ?? null,
    titleSource: row.title_source ?? 'auto',
    preview: row.preview ?? null,
    status: row.status,
    turnState: row.turn_state,
    pendingApprovals: row.pending_approvals,
    lastSeq: row.last_seq,
    lastReadSeq: row.last_read_seq,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
    codexThreadId: row.codex_thread_id ?? null,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    approvalPolicy: row.approval_policy ?? null,
    sandbox: row.sandbox_mode ?? null,
    archivedMs: row.archived_ms ?? null
  }
}

export function eventRowToRecord(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    seq: row.seq,
    tsMs: row.ts_ms,
    type: row.type,
    payload: parseJsonCell(row.payload_json, null)
  }
}

export function approvalRowToRecord(row) {
  if (!row) return null
  return {
    approvalId: row.approval_id,
    machineId: row.machine_id,
    sessionId: row.session_id,
    kind: row.kind,
    payload: parseJsonCell(row.payload_json, null),
    createdMs: row.created_ms
  }
}

export function ideSessionRowToRecord(row) {
  if (!row) return null
  return {
    ideId: row.ide_id,
    machineId: row.machine_id,
    cwd: row.cwd,
    port: row.port,
    basePath: row.base_path ?? null,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms
  }
}

export function uploadRowToRecord(row, sessionId = null) {
  if (!row) return null
  return {
    uploadId: row.upload_id,
    sessionId: sessionId ?? row.session_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    hostPath: row.host_path,
    runnerPath: row.runner_path,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms
  }
}

export function pushSubscriptionRowToRecord(row) {
  if (!row) return null
  return {
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms
  }
}

export function queuedPromptRowToRecord(row) {
  if (!row) return null
  return {
    promptId: row.prompt_id,
    sessionId: row.session_id,
    text: row.text,
    attachmentIds: parseJsonCell(row.attachments_json, []),
    createdMs: row.created_ms,
    updatedMs: row.updated_ms
  }
}
