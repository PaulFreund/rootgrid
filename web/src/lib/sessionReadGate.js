function normalizeSessionId(sessionId) {
  return String(sessionId ?? '').trim()
}

export function createSessionReadGate() {
  let interactionSeq = 0
  const requiredInteractionBySessionId = new Map()

  function noteInteraction() {
    interactionSeq += 1
    return interactionSeq
  }

  function requireInteraction(sessionId) {
    const sid = normalizeSessionId(sessionId)
    if (!sid) return 0
    const nextSeq = interactionSeq + 1
    const current = Number(requiredInteractionBySessionId.get(sid) ?? 0)
    if (nextSeq > current) requiredInteractionBySessionId.set(sid, nextSeq)
    return nextSeq
  }

  function syncSessionUnread(sessionId, unread) {
    const sid = normalizeSessionId(sessionId)
    if (!sid) return false
    if (!unread) {
      requiredInteractionBySessionId.delete(sid)
      return false
    }
    requireInteraction(sid)
    return true
  }

  function canMarkRead(sessionId) {
    const sid = normalizeSessionId(sessionId)
    if (!sid) return false
    const requiredSeq = Number(requiredInteractionBySessionId.get(sid) ?? 0)
    return interactionSeq >= requiredSeq
  }

  function clearSession(sessionId) {
    const sid = normalizeSessionId(sessionId)
    if (!sid) return false
    return requiredInteractionBySessionId.delete(sid)
  }

  return {
    noteInteraction,
    requireInteraction,
    syncSessionUnread,
    canMarkRead,
    clearSession
  }
}
