import {
  enqueueApproval,
  removeApproval,
  replaceApprovalQueue
} from './approvalQueue.js'
import {
  canCoalesceSessionEvent,
  coalesceSessionEvent
} from './sessionHistory.js'

function truncatePreview(text, maxChars = 160) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return (normalized.length > maxChars) ? `${normalized.slice(0, maxChars - 3)}…` : normalized
}

export function createSessionEnvelopeHandler({
  currentVisibility,
  notificationPermission,
  showBrowserToast,
  toasts,
  scheduleDismissToast,
  sseConnectionId,
  replaceMachineRows,
  replaceSessionRows,
  applySessionPageInfo = null,
  sessionRowsById,
  approvalQueue,
  approvalIds = null,
  hasSnapshot,
  schedulePostVisibility,
  selectedSessionId,
  sessionStores,
  backfillSessionAfter,
  upsertMachineRow,
  removeMachineLocal,
  removeSessionRow,
  upsertSessionRow,
  getSessionStore,
  stickToBottom,
  scheduleMarkRead,
  bumpSessionToTop,
  updateTokenUsage = null,
  appendToolOutput,
  addSessionEvent
}) {
  let toastSeq = 0
  const seenToastIds = new Set()
  const seenToastOrder = []

  function rememberToast(toastId, maxSize = 500) {
    const id = String(toastId ?? '').trim()
    if (!id || seenToastIds.has(id)) return false
    seenToastIds.add(id)
    seenToastOrder.push(id)
    if (seenToastOrder.length > maxSize) {
      const stale = seenToastOrder.splice(0, seenToastOrder.length - maxSize)
      for (const key of stale) seenToastIds.delete(key)
    }
    return true
  }

  return function handleEnvelope(env) {
    if (!env || typeof env.type !== 'string') return

    if (env.type === 'toast') {
      const p = env.payload ?? {}
      const notificationKey = (typeof p.notificationKey === 'string' && p.notificationKey.trim())
        ? p.notificationKey.trim()
        : null
      const toastId = env.id ?? notificationKey ?? `toast-${++toastSeq}`
      const toast = {
        id: toastId,
        level: p.level ?? 'info',
        title: p.title ?? 'Rootgrid',
        message: p.message ?? '',
        sessionId: p.sessionId ?? null,
        notificationKey,
        stickyUntilVisible: false
      }
      if (!rememberToast(notificationKey ?? toast.id)) return

      const visible = currentVisibility() === 'visible'
      if (!visible && showBrowserToast(toast)) return
      if (!visible && notificationPermission.value !== 'granted') toast.stickyUntilVisible = true

      toasts.value.push(toast)
      if (visible) scheduleDismissToast(toast.id, 7_500)
      return
    }

    if (env.type === 'registry.snapshot') {
      sseConnectionId.value = env.payload?.connectionId ?? null
      replaceMachineRows(env.payload?.machines ?? [])
      replaceSessionRows(env.payload?.sessions ?? [])
      try { applySessionPageInfo?.(env.payload ?? null) } catch {}
      replaceApprovalQueue(approvalQueue.value, env.payload?.approvals, approvalIds)
      hasSnapshot.value = true
      schedulePostVisibility()

      const sid = String(selectedSessionId.value ?? '').trim()
      const store = sid ? sessionStores.get(sid) : null
      const lastSeen = Number(store?.lastRealtimeSeqSeen ?? 0)
      const sessionRow = sid ? (sessionRowsById?.get?.(sid) ?? null) : null
      const snapshotLastSeq = Number(sessionRow?.lastSeq ?? 0)
      if (sid && lastSeen > 0 && snapshotLastSeq > lastSeen) {
        backfillSessionAfter(sid, { afterSeq: lastSeen }).catch(() => {})
      }
      return
    }

    if (env.type === 'registry.hello') {
      sseConnectionId.value = env.payload?.connectionId ?? null
      schedulePostVisibility()
      return
    }

    if (env.type === 'registry.machine.upsert') {
      upsertMachineRow(env.payload)
      return
    }

    if (env.type === 'registry.machine.delete') {
      const mid = env.payload?.machineId ?? env.scope?.machineId
      if (mid) removeMachineLocal(mid)
      return
    }

    if (env.type === 'registry.session.upsert') {
      upsertSessionRow(env.payload)
      return
    }

    if (env.type === 'registry.session.delete') {
      const sid = env.payload?.sessionId
      if (sid) {
        removeSessionRow(sid)
        if (selectedSessionId.value === sid) selectedSessionId.value = null
        try { sessionStores.delete(sid) } catch {}
      }
      return
    }

    const sessionId = env.scope?.sessionId ?? env.payload?.sessionId ?? null
    if (!sessionId) return

    const realtimeSeq = Number(env.eventSeq ?? env.seq ?? 0)
    const knownStore = sessionStores.get(sessionId)
    if (knownStore && Number.isFinite(realtimeSeq) && realtimeSeq > 0) {
      knownStore.lastRealtimeSeqSeen = Math.max(Number(knownStore.lastRealtimeSeqSeen ?? 0), realtimeSeq)
    }

    const session = sessionRowsById?.get?.(sessionId) ?? null
    if (session) {
      if (Number.isFinite(realtimeSeq) && realtimeSeq > 0) {
        session.lastSeq = Math.max(Number(session.lastSeq ?? 0), realtimeSeq)
      } else {
        session.lastSeq = Number(session.lastSeq ?? 0) + 1
      }

      if (env.type === 'session.status' && env.payload?.status) {
        session.status = env.payload.status
        if (env.payload.codexThreadId) session.codexThreadId = env.payload.codexThreadId
      }

      if (env.type === 'session.input') {
        const preview = truncatePreview(env.payload?.text)
        if (preview) session.preview = preview
        if (env.payload?.isInitial && !String(session.title ?? '').trim()) {
          session.title = session.preview
        }
      }

      if (env.type === 'turn.started') session.turnState = 'running'

      if (env.type === 'turn.completed') {
        session.turnState = 'idle'
        const preview = truncatePreview(env.payload?.preview)
        if (preview) session.preview = preview
      }

      if (env.type === 'approval.request') {
        enqueueApproval(approvalQueue.value, env.payload, approvalIds)
        session.pendingApprovals = Number(session.pendingApprovals ?? 0) + 1
      }

      if (env.type === 'approval.resolved') {
        session.pendingApprovals = Math.max(0, Number(session.pendingApprovals ?? 0) - 1)
        removeApproval(approvalQueue.value, env.payload?.approvalId, approvalIds)
      }

      if (selectedSessionId.value === sessionId && stickToBottom.value) {
        scheduleMarkRead(sessionId)
      }

      const stream = env.type === 'session.output' ? (env.payload?.stream ?? 'normalized') : null
      const shouldBump = !(env.type === 'session.output' && stream !== 'normalized')
        && env.type !== 'thread.tokenUsage.updated'
        && env.type !== 'token.count'
      if (shouldBump) bumpSessionToTop(sessionId)
    } else if (env.type === 'approval.request') {
      enqueueApproval(approvalQueue.value, env.payload, approvalIds)
    }

    if (selectedSessionId.value !== sessionId) return

    if (env.type === 'thread.tokenUsage.updated' || env.type === 'token.count') {
      try { updateTokenUsage?.(sessionId, env.payload) } catch {}
      return
    }

    if (env.type === 'turn.started') {
      const store = getSessionStore(sessionId)
      store.currentTurnId = env.payload?.turnId ?? null
    }

    if (env.type === 'turn.completed') {
      const store = getSessionStore(sessionId)
      store.currentTurnId = null
    }

    if (env.type === 'session.output') {
      const stream = env.payload?.stream ?? 'normalized'
      const itemId = env.payload?.itemId ?? null
      const text = env.payload?.text ?? ''
      if (stream !== 'normalized' && itemId && (stream === 'stdout' || stream === 'stderr')) {
        appendToolOutput(sessionId, String(itemId), stream, String(text ?? ''))
        return
      }
      if (stream === 'reasoning') {
        const store = getSessionStore(sessionId)
        const tid = String(store.currentTurnId ?? '').trim()
        if (tid) {
          store.turnHasReasoningLive.add(tid)
          store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
        }
        return
      }
      if (stream === 'plan') return
    }

    try {
      const store = getSessionStore(sessionId)
      if (store.loadingBefore && !stickToBottom.value) {
        const pendingEvent = {
          eventId: env.id,
          tsMs: env.ts,
          type: env.type,
          payload: env.payload
        }
        const lastPending = Array.isArray(store.pendingAfter) ? store.pendingAfter[store.pendingAfter.length - 1] : null
        if (lastPending && typeof lastPending === 'object' && typeof pendingEvent === 'object' && canCoalesceSessionEvent(lastPending, pendingEvent)) {
          coalesceSessionEvent(lastPending, pendingEvent)
          return
        }
        store.pendingAfter.push(pendingEvent)
        return
      }
    } catch {
    }

    addSessionEvent(sessionId, {
      eventId: env.id,
      seq: Number.isFinite(realtimeSeq) && realtimeSeq > 0 ? realtimeSeq : null,
      tsMs: env.ts,
      type: env.type,
      payload: env.payload
    }, { atStart: false, applyDerived: true })
  }
}
