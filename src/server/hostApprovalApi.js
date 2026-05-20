export function createHostApprovalApi({
  auth,
  approvals,
  store,
  runnerWs,
  makeEnvelope,
  readJsonBody,
  json,
  persistSessionEvent
}) {
  return {
    async handle(req, res, url, parts) {
      if (!(parts[0] === 'api' && parts[1] === 'approvals' && parts[2] && req.method === 'POST')) {
        return false
      }
      if (!auth.requireAuth(req, res)) return true

      const approvalId = parts[2]
      let route = approvals.get(approvalId) ?? null
      let row = null
      try {
        row = store.getApproval(approvalId)
      } catch {
      }
      if (!route && row) route = { machineId: row.machineId, sessionId: row.sessionId }
      if (!route) {
        json(res, 404, { error: 'not found' })
        return true
      }

      const body = await readJsonBody(req)
      const kind = row?.kind ?? null

      /** @type {any} */
      const respondPayload = { approvalId }
      /** @type {any} */
      const resolvedPayload = { approvalId }

      if (kind === 'userInput') {
        const decision = body?.decision ?? (body?.answers ? 'accept' : null)
        if (decision !== 'accept' && decision !== 'cancel') {
          json(res, 400, { error: 'decision must be accept|cancel' })
          return true
        }
        respondPayload.decision = decision

        if (decision === 'accept') {
          const answers = body?.answers
          if (!answers || typeof answers !== 'object') {
            json(res, 400, { error: 'answers is required' })
            return true
          }
          respondPayload.answers = answers
        }

        resolvedPayload.decision = decision
      } else {
        const decision = body?.decision
        const reason = body?.reason ?? null
        if (decision === undefined || decision === null) {
          json(res, 400, { error: 'decision is required' })
          return true
        }
        if (typeof decision !== 'string' && typeof decision !== 'object') {
          json(res, 400, { error: 'decision must be a string (or object)' })
          return true
        }
        respondPayload.decision = decision
        if (reason) respondPayload.reason = reason

        resolvedPayload.decision = decision
        if (reason) resolvedPayload.reason = reason
      }

      const ok = runnerWs.sendToMachine(route.machineId, makeEnvelope({
        type: 'approval.respond',
        scope: { machineId: route.machineId, sessionId: route.sessionId },
        payload: respondPayload
      }))
      if (!ok) {
        json(res, 503, { error: 'runner not connected' })
        return true
      }

      const resolved = makeEnvelope({
        type: 'approval.resolved',
        scope: { machineId: route.machineId, sessionId: route.sessionId },
        payload: resolvedPayload
      })
      persistSessionEvent(resolved, { sessionId: route.sessionId })

      approvals.delete(approvalId)
      try { store.deleteApproval(approvalId) } catch {}
      json(res, 200, { ok: true })
      return true
    }
  }
}
