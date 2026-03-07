import { createSessionReadApi } from './sessionReadApi.js'
import { createSessionWriteApi } from './sessionWriteApi.js'

export function createSessionApi(deps) {
  const { store, sse, makeEnvelope, json } = deps

  function sendSessionUpsert(session) {
    if (!session) return
    sse.send(makeEnvelope({
      type: 'registry.session.upsert',
      scope: { machineId: session.machineId, sessionId: session.sessionId },
      payload: session
    }))
  }

  function getSessionOr404(res, sessionId) {
    const session = store.getSession(sessionId)
    if (!session) {
      json(res, 404, { error: 'not found' })
      return null
    }
    return session
  }

  const readApi = createSessionReadApi({
    ...deps,
    getSessionOr404
  })

  const writeApi = createSessionWriteApi({
    ...deps,
    sendSessionUpsert,
    getSessionOr404
  })

  return {
    async handle(req, res, url, parts) {
      if (await readApi.handle(req, res, url, parts)) return true
      if (await writeApi.handle(req, res, url, parts)) return true
      return false
    }
  }
}
