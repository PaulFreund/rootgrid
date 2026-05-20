import { getSessionStoreLoadedSeq } from './sessionHistory.js'

export function resolveSessionLoadStrategy(store, sessionRow) {
  if (!store?.historyLoaded) {
    return { action: 'load', knownSeq: 0, targetSeq: Number(sessionRow?.lastSeq ?? 0) || 0 }
  }

  const knownSeq = getSessionStoreLoadedSeq(store)
  const targetSeq = Number(sessionRow?.lastSeq ?? 0)
  if (!Number.isFinite(targetSeq) || targetSeq <= 0 || knownSeq >= targetSeq) {
    return { action: 'reuse', knownSeq, targetSeq: Number.isFinite(targetSeq) ? targetSeq : 0 }
  }

  if (knownSeq > 0) {
    return { action: 'backfill', knownSeq, targetSeq }
  }

  return { action: 'load', knownSeq, targetSeq }
}

