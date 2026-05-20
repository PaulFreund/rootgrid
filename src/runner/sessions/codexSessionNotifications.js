import {
  minimizeFileChanges,
  normalizeItemType,
  safeString
} from './codexSessionProtocol.js'

function fromWrappedParams(params) {
  return { __rgFromWrapped: true, ...(params ?? {}) }
}

export function normalizeRetryDisplayMessage(message, { willRetry = false } = {}) {
  const text = safeString(message)
  if (!text || !willRetry) return text
  const match = text.match(/^(Reconnecting\.\.\.\s*)(\d+)(\/\d+)(.*)$/i)
  if (!match) return text
  const attempt = Number(match[2])
  if (!Number.isFinite(attempt) || attempt <= 1) return text
  return `${match[1]}${attempt - 1}${match[3]}${match[4]}`
}

export function normalizeWrappedNotification({ method, params, sessionId }) {
  if (typeof method !== 'string' || !method.startsWith('codex/event/')) return null

  const wrapped = params?.msg
  const msgType = safeString(wrapped?.type)
  if (!msgType) return { kind: 'ignore' }

  const turnId = safeString(wrapped?.turn_id ?? wrapped?.turnId)

  if (msgType === 'item_started' || msgType === 'item_completed') {
    const itemMethod = (msgType === 'item_started') ? 'item/started' : 'item/completed'
    const item = wrapped?.item ?? null
    const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? item?.id)
    const threadId = safeString(wrapped?.thread_id ?? wrapped?.threadId)
    return {
      kind: 'forward',
      notifications: [{
        method: itemMethod,
        params: fromWrappedParams({
          ...(item ? { item } : {}),
          ...(itemId ? { itemId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {})
        })
      }]
    }
  }

  if (msgType === 'task_started' && turnId) {
    return {
      kind: 'forward',
      notifications: [{ method: 'turn/started', params: fromWrappedParams({ turn: { id: turnId } }) }]
    }
  }

  if ((msgType === 'task_complete' || msgType === 'turn_complete') && turnId) {
    return {
      kind: 'forward',
      notifications: [{ method: 'turn/completed', params: fromWrappedParams({ turn: { id: turnId, status: 'completed' } }) }]
    }
  }

  if (msgType === 'turn_aborted' && turnId) {
    return {
      kind: 'forward',
      notifications: [{ method: 'turn/completed', params: fromWrappedParams({ turn: { id: turnId, status: 'interrupted' } }) }]
    }
  }

  if (msgType === 'task_failed' && turnId) {
    const errorMessage = safeString(wrapped?.error ?? wrapped?.message ?? wrapped?.reason ?? wrapped?.error_message)
    return {
      kind: 'forward',
      notifications: [{
        method: 'turn/completed',
        params: fromWrappedParams({ turn: { id: turnId, status: 'failed', ...(errorMessage ? { error: { message: errorMessage } } : {}) } })
      }]
    }
  }

  if (msgType === 'agent_message_delta' || msgType === 'agent_message_content_delta') {
    const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id) ?? 'agent-message'
    const delta = safeString(wrapped?.delta ?? wrapped?.text ?? wrapped?.message)
    if (!delta) return { kind: 'ignore' }
    return {
      kind: 'forward',
      notifications: [{ method: 'item/agentMessage/delta', params: fromWrappedParams({ itemId, delta }) }]
    }
  }

  if (msgType === 'reasoning_content_delta' || msgType === 'agent_reasoning_delta') {
    const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id) ?? 'reasoning'
    const delta = safeString(wrapped?.delta ?? wrapped?.text ?? wrapped?.message)
    if (!delta) return { kind: 'ignore' }
    const summaryIndex = wrapped?.summary_index ?? wrapped?.summaryIndex ?? null
    return {
      kind: 'forward',
      notifications: [{
        method: 'item/reasoning/summaryTextDelta',
        params: fromWrappedParams({
          itemId,
          delta,
          ...(Number.isFinite(Number(summaryIndex)) ? { summaryIndex: Number(summaryIndex) } : {})
        })
      }]
    }
  }

  if (msgType === 'agent_reasoning_section_break') {
    const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id) ?? 'reasoning'
    const summaryIndex = wrapped?.summary_index ?? wrapped?.summaryIndex ?? null
    return {
      kind: 'forward',
      notifications: [{
        method: 'item/reasoning/summaryPartAdded',
        params: fromWrappedParams({
          itemId,
          ...(Number.isFinite(Number(summaryIndex)) ? { summaryIndex: Number(summaryIndex) } : {})
        })
      }]
    }
  }

  if (msgType === 'token_count') {
    const info = wrapped?.info ?? null
    const rateLimits = wrapped?.rate_limits ?? wrapped?.rateLimits ?? null
    return {
      kind: 'emit',
      eventType: 'token.count',
      payload: {
        sessionId,
        ...(info ? { info } : {}),
        ...(rateLimits ? { rateLimits } : {})
      }
    }
  }

  if (msgType === 'exec_command_output_delta') {
    const itemId = safeString(wrapped?.call_id ?? wrapped?.callId ?? wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id)
    const delta = safeString(wrapped?.delta ?? wrapped?.output ?? wrapped?.stdout ?? wrapped?.text)
    if (!itemId || !delta) return { kind: 'ignore' }
    return {
      kind: 'forward',
      notifications: [{ method: 'item/commandExecution/outputDelta', params: fromWrappedParams({ itemId, delta }) }]
    }
  }

  if (msgType === 'error') {
    const willRetry = Boolean(wrapped?.will_retry ?? wrapped?.willRetry)
    const message = normalizeRetryDisplayMessage(wrapped?.message, { willRetry })
    const details = safeString(wrapped?.additional_details ?? wrapped?.additionalDetails)
    const codexErrorInfo = wrapped?.codex_error_info ?? wrapped?.codexErrorInfo ?? null
    return {
      kind: 'forward',
      notifications: [{
        method: 'error',
        params: fromWrappedParams({
          ...(turnId ? { turnId } : {}),
          willRetry,
          ...(message ? { message } : {}),
          ...(details ? { details } : {}),
          ...(codexErrorInfo ? { codexErrorInfo } : {})
        })
      }]
    }
  }

  return { kind: 'ignore' }
}

export function buildCodexErrorOutputText(params) {
  const willRetry = Boolean(params?.willRetry ?? params?.will_retry)
  if (willRetry) return null
  const errorMessage = safeString(params?.error?.message ?? params?.message) ?? 'Unknown error'
  const details = safeString(params?.error?.additionalDetails ?? params?.details)
  const codexErrorInfo = params?.error?.codexErrorInfo ?? null
  const extra = []
  if (details) extra.push(details)
  if (codexErrorInfo) {
    try { extra.push(JSON.stringify(codexErrorInfo)) } catch {}
  }
  return `[codex] ${errorMessage}${extra.length ? `\n${extra.join('\n')}` : ''}\n`
}

export function buildThreadTokenUsageEvent({ sessionId, params }) {
  const threadId = safeString(params?.threadId)
  const turnId = safeString(params?.turnId)
  const tokenUsage = params?.tokenUsage ?? null
  return {
    sessionId,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(tokenUsage ? { tokenUsage } : {})
  }
}

export function buildRateLimitsUpdatedEvent({ sessionId, params }) {
  const rateLimits = params?.rateLimits ?? params?.rate_limits ?? null
  if (!rateLimits || typeof rateLimits !== 'object') return null
  return {
    sessionId,
    rateLimits
  }
}

export function buildPlanUpdatedEvent({ sessionId, params }) {
  const plan = Array.isArray(params?.plan) ? params.plan : null
  if (!plan) return null
  const threadId = safeString(params?.threadId)
  const turnId = safeString(params?.turnId)
  const explanation = safeString(params?.explanation)
  return {
    sessionId,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(explanation ? { explanation } : {}),
    plan
  }
}

export function buildTerminalInteractionOutputText({ itemId, stdin }) {
  const safeItemId = safeString(itemId)
  const safeStdin = safeString(stdin)
  return `[codex] terminal interaction${safeItemId ? ` (${safeItemId})` : ''}${safeStdin ? `: ${safeStdin}` : ''}\n`
}

export function buildToolStartedEvent({ sessionId, item }) {
  const type = normalizeItemType(item?.type)
  const itemId = safeString(item?.id)
  if (!type || !itemId) return null

  if (type === 'commandexecution') {
    return {
      dedupeKey: `commandexecution:${itemId}`,
      payload: {
        sessionId,
        tool: 'commandExecution',
        itemId,
        command: item.command,
        cwd: item.cwd,
        commandActions: item.commandActions ?? null,
        status: item.status ?? null
      }
    }
  }

  if (type === 'filechange') {
    return {
      dedupeKey: `filechange:${itemId}`,
      payload: {
        sessionId,
        tool: 'fileChange',
        itemId,
        changes: minimizeFileChanges(item.changes),
        status: item.status ?? null
      }
    }
  }

  return null
}

export function buildToolCompletedEvent({ sessionId, item, hadOutput }) {
  const itemId = safeString(item?.id)
  const type = normalizeItemType(item?.type)
  if (!type || !itemId) return null

  if (type === 'commandexecution') {
    return {
      dedupeKey: `commandexecution:${itemId}`,
      itemId,
      payload: {
        sessionId,
        tool: 'commandExecution',
        itemId,
        command: item.command,
        cwd: item.cwd,
        commandActions: item.commandActions ?? null,
        status: item.status ?? null,
        exitCode: item.exitCode ?? null,
        hadOutput: Boolean(hadOutput),
        durationMs: item.durationMs ?? null
      }
    }
  }

  if (type === 'filechange') {
    return {
      dedupeKey: `filechange:${itemId}`,
      itemId,
      payload: {
        sessionId,
        tool: 'fileChange',
        itemId,
        changes: minimizeFileChanges(item.changes),
        status: item.status ?? null,
        hadOutput: Boolean(hadOutput)
      }
    }
  }

  return null
}
