import crypto from 'node:crypto'

export function makeEnvelope({ type, scope = null, payload = null }) {
  return {
    v: 1,
    type,
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope,
    payload
  }
}

