import { rm } from 'node:fs/promises'

export function createSessionMetadataWriteApi({
  auth,
  store,
  sse,
  runnerWs,
  makeEnvelope,
  readJsonBody,
  json,
  approvals,
  sendSessionUpsert,
  getSessionOr404
}) {
  return {
    async handle(req, res, url, parts) {
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'read' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        if (!getSessionOr404(res, sessionId)) return true

        store.markSessionRead(sessionId)
        const updated = store.getSession(sessionId)
        sendSessionUpsert(updated)
        json(res, 200, { ok: true, session: updated })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] && req.method === 'PUT') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const currentSession = getSessionOr404(res, sessionId)
        if (!currentSession) return true

        const body = await readJsonBody(req)
        const projectLabelRaw = body?.projectLabel
        const titleRaw = body?.title
        if (projectLabelRaw !== null && projectLabelRaw !== undefined && typeof projectLabelRaw !== 'string') {
          json(res, 400, { error: 'projectLabel must be a string or null' })
          return true
        }
        if (titleRaw !== null && titleRaw !== undefined && typeof titleRaw !== 'string') {
          json(res, 400, { error: 'title must be a string or null' })
          return true
        }

        const projectLabel = (typeof projectLabelRaw === 'string') ? projectLabelRaw.trim() : null
        const title = (typeof titleRaw === 'string') ? titleRaw.trim() : null

        const updatedSessionIds = new Set()
        if (projectLabelRaw !== undefined) {
          for (const updatedId of store.setWorkspaceProjectLabelBySessionId(sessionId, projectLabel || null)) {
            if (updatedId) updatedSessionIds.add(updatedId)
          }
        }
        if (titleRaw !== undefined) {
          const currentTitle = (typeof currentSession?.title === 'string' && currentSession.title.trim()) ? currentSession.title.trim() : null
          const currentTitleSource = String(currentSession?.titleSource ?? 'auto').trim() || 'auto'
          const nextTitle = title || null
          if (!(currentTitleSource === 'auto' && nextTitle === currentTitle)) {
            store.setSessionTitle(sessionId, nextTitle)
            updatedSessionIds.add(sessionId)
          }
        }

        const updatedSessions = [...updatedSessionIds]
          .map((updatedId) => store.getSession(updatedId))
          .filter(Boolean)

        for (const updatedSession of updatedSessions) {
          sendSessionUpsert(updatedSession)
        }

        const updated = store.getSession(sessionId)
        json(res, 200, {
          ok: true,
          session: updated,
          sessions: updatedSessions
        })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true

        runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.cleanup',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))

        let uploadRows = []
        try { uploadRows = store.listSessionUploads(sessionId) } catch { }

        for (const [approvalId, route] of approvals.entries()) {
          if (route?.sessionId === sessionId) approvals.delete(approvalId)
        }

        store.deleteSession(sessionId)
        sse.send(makeEnvelope({
          type: 'registry.session.delete',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))

        for (const upload of uploadRows) {
          const path = upload?.hostPath
          if (!path || typeof path !== 'string') continue
          try { await rm(path, { force: true }) } catch { }
        }

        json(res, 200, { ok: true })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'options' && req.method === 'PUT') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true

        const body = await readJsonBody(req)
        const patch = body?.options ?? body

        const approvalPolicyRaw = patch?.approvalPolicy
        const sandboxRaw = patch?.sandbox
        const modelRaw = patch?.model
        const reasoningEffortRaw = patch?.reasoningEffort
        const serviceTierRaw = patch?.serviceTier

        if (approvalPolicyRaw === undefined && sandboxRaw === undefined && modelRaw === undefined && reasoningEffortRaw === undefined && serviceTierRaw === undefined) {
          json(res, 400, { error: 'at least one option is required' })
          return true
        }

        const model = (modelRaw === null || modelRaw === undefined)
          ? modelRaw
          : (typeof modelRaw === 'string' ? modelRaw.trim() : '__invalid__')
        if (model === '__invalid__') {
          json(res, 400, { error: 'model must be a string or null' })
          return true
        }

        const reasoningEffort = (reasoningEffortRaw === null || reasoningEffortRaw === undefined)
          ? reasoningEffortRaw
          : (typeof reasoningEffortRaw === 'string' ? reasoningEffortRaw.trim() : '__invalid__')
        if (reasoningEffort === '__invalid__') {
          json(res, 400, { error: 'reasoningEffort must be a string or null' })
          return true
        }

        const serviceTier = (serviceTierRaw === null || serviceTierRaw === undefined)
          ? serviceTierRaw
          : (typeof serviceTierRaw === 'string' ? serviceTierRaw.trim() : '__invalid__')
        if (serviceTier === '__invalid__') {
          json(res, 400, { error: 'serviceTier must be a string or null' })
          return true
        }

        const approvalPolicy = (approvalPolicyRaw === null || approvalPolicyRaw === undefined)
          ? approvalPolicyRaw
          : (typeof approvalPolicyRaw === 'string' ? approvalPolicyRaw.trim() : '__invalid__')
        if (approvalPolicy === '__invalid__') {
          json(res, 400, { error: 'approvalPolicy must be a string or null' })
          return true
        }

        const sandbox = (sandboxRaw === null || sandboxRaw === undefined)
          ? sandboxRaw
          : (typeof sandboxRaw === 'string' ? sandboxRaw.trim() : '__invalid__')
        if (sandbox === '__invalid__') {
          json(res, 400, { error: 'sandbox must be a string or null' })
          return true
        }

        store.updateSession({
          sessionId,
          ...(modelRaw !== undefined ? { model: model || null } : {}),
          ...(reasoningEffortRaw !== undefined ? { reasoningEffort: reasoningEffort || null } : {}),
          ...(serviceTierRaw !== undefined ? { serviceTier: serviceTier || null } : {}),
          ...(approvalPolicyRaw !== undefined ? { approvalPolicy: approvalPolicy || null } : {}),
          ...(sandboxRaw !== undefined ? { sandbox: sandbox || null } : {})
        })

        const updated = store.getSession(sessionId)
        sendSessionUpsert(updated)

        const runnerOk = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.options.update',
          scope: { machineId: session.machineId, sessionId },
          payload: {
            sessionId,
            options: {
              ...(modelRaw !== undefined ? { model: model || null } : {}),
              ...(reasoningEffortRaw !== undefined ? { reasoningEffort: reasoningEffort || null } : {}),
              ...(serviceTierRaw !== undefined ? { serviceTier: serviceTier || null } : {}),
              ...(approvalPolicyRaw !== undefined ? { approvalPolicy: approvalPolicy || null } : {}),
              ...(sandboxRaw !== undefined ? { sandbox: sandbox || null } : {})
            }
          }
        }))

        json(res, 200, { ok: true, runnerOk, session: updated })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'archive' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        if (!getSessionOr404(res, sessionId)) return true

        store.archiveSession(sessionId)
        const updated = store.getSession(sessionId)
        sendSessionUpsert(updated)
        json(res, 200, { ok: true, session: updated })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'unarchive' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        if (!getSessionOr404(res, sessionId)) return true

        store.unarchiveSession(sessionId)
        const updated = store.getSession(sessionId)
        sendSessionUpsert(updated)
        json(res, 200, { ok: true, session: updated })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'cancel' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true

        const ok = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.cancel',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))
        if (!ok) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }

        json(res, 200, { ok: true })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'stop' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true

        const ok = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.stop',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))
        if (!ok) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }

        json(res, 200, { ok: true })
        return true
      }

      return false
    }
  }
}
