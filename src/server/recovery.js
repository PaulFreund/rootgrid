import { makeEnvelope } from './envelope.js'

function safeString(input) {
  const s = String(input ?? '').trim()
  return s || null
}

/**
 * Best-effort recovery when a runner restarts mid-turn.
 *
 * Goals:
 * - Unstick sessions that were left in `turn_state=running` (no `turn.completed`)
 * - Clear stale pending approvals (they cannot be answered after restart)
 *
 * This does *not* attempt to resume an in-flight Codex turn; it only makes the
 * session usable again so the user can continue the thread.
 *
 * @param {{
 *   store: import('../db/store.js').Store,
 *   sse?: { send: (env: any) => void }|null,
 *   machineId: string,
 *   reason?: string,
 * }} opts
 */
export function recoverAfterRunnerRestart({ store, sse = null, machineId, reason = 'runner restarted' }) {
  const mid = safeString(machineId)
  if (!mid) return { approvalsResolved: 0, sessionsRecovered: 0 }

  let approvalsResolved = 0
  try {
    const approvals = store.listApprovals().filter((a) => a?.machineId === mid)
    for (const a of approvals) {
      const approvalId = safeString(a?.approvalId)
      const sessionId = safeString(a?.sessionId)
      if (!approvalId || !sessionId) continue

      const resolved = makeEnvelope({
        type: 'approval.resolved',
        scope: { machineId: mid, sessionId },
        payload: { approvalId, decision: 'cancel', reason }
      })

      try {
        store.appendEvent({
          eventId: resolved.id,
          sessionId,
          tsMs: resolved.ts,
          type: resolved.type,
          payload: resolved.payload
        })
      } catch {
      }

      try { store.deleteApproval(approvalId) } catch { }
      try { sse?.send?.(resolved) } catch { }
      approvalsResolved += 1
    }
  } catch {
  }

  let sessionsRecovered = 0
  try {
    const sessionIds = store.listSessionIdsByMachine(mid)
    for (const sessionId of sessionIds) {
      const session = store.getSession(sessionId)
      if (!session || session.turnState !== 'running') continue

      const note = makeEnvelope({
        type: 'session.output',
        scope: { machineId: mid, sessionId },
        payload: {
          sessionId,
          stream: 'stderr',
          text: `[rootgrid] ${reason}; marking the previous turn as interrupted.\n`
        }
      })
      try {
        store.appendEvent({
          eventId: note.id,
          sessionId,
          tsMs: note.ts,
          type: note.type,
          payload: note.payload
        })
      } catch {
      }
      try { sse?.send?.(note) } catch { }

      const completed = makeEnvelope({
        type: 'turn.completed',
        scope: { machineId: mid, sessionId },
        payload: { sessionId, status: 'interrupted', error: reason }
      })
      try {
        store.appendEvent({
          eventId: completed.id,
          sessionId,
          tsMs: completed.ts,
          type: completed.type,
          payload: completed.payload
        })
      } catch {
      }
      try { sse?.send?.(completed) } catch { }

      sessionsRecovered += 1
    }
  } catch {
  }

  return { approvalsResolved, sessionsRecovered }
}

