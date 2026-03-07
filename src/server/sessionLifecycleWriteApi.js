import crypto from 'node:crypto'

import { buildAttachmentPayload, buildCodexInputItems } from './sessionApiHelpers.js'

export function createSessionLifecycleWriteApi({
  auth,
  store,
  makeEnvelope,
  readJsonBody,
  json,
  pickMachineId,
  sendRunnerCommandAndAwait,
  uploadService,
  persistSessionEvent,
  sendSessionUpsert,
  getSessionOr404
}) {
  const { isImageMimeType, resolveAttachmentInputs, cleanupUploadedDescriptors } = uploadService

  async function readMessageBody(req) {
    return await readJsonBody(req, { limitBytes: 250_000_000 })
  }

  return {
    async handle(req, res, url, parts) {
      if (url.pathname === '/api/sessions/draft' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        let body = null
        try {
          body = await readJsonBody(req)
        } catch (err) {
          json(res, 400, { error: String(err?.message ?? err) })
          return true
        }

        const cwdRaw = body?.cwd
        const preferredMachineId = body?.machineId ?? null
        const options = body?.options ?? null

        if (!cwdRaw || typeof cwdRaw !== 'string' || !cwdRaw.trim()) {
          json(res, 400, { error: 'cwd is required' })
          return true
        }

        const machineId = pickMachineId((typeof preferredMachineId === 'string' && preferredMachineId.trim())
          ? preferredMachineId.trim()
          : null)
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }

        const cwd = cwdRaw.trim()
        const sessionId = crypto.randomUUID()
        store.createSession({ sessionId, machineId, cwd, status: 'idle', options })

        const session = store.getSession(sessionId)
        sendSessionUpsert(session)

        json(res, 200, { sessionId, session })
        return true
      }

      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        let body = null
        try {
          body = await readMessageBody(req)
        } catch (err) {
          const msg = String(err?.message ?? err)
          json(res, msg.includes('body too large') ? 413 : 400, { error: msg })
          return true
        }

        const cwd = body?.cwd
        const prompt = body?.prompt
        const preferredMachineId = body?.machineId ?? null
        const options = body?.options ?? null
        const attachments = body?.attachments ?? null

        if (!cwd || typeof cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return true
        }
        if (prompt === undefined || prompt === null || typeof prompt !== 'string') {
          json(res, 400, { error: 'prompt is required' })
          return true
        }

        const hasPromptText = Boolean(String(prompt).trim())
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0
        if (!hasPromptText && !hasAttachments) {
          json(res, 400, { error: 'prompt or attachments are required' })
          return true
        }

        const machineId = pickMachineId(preferredMachineId)
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }

        const sessionId = crypto.randomUUID()
        store.createSession({ sessionId, machineId, cwd, status: 'starting', options })

        let uploaded = []
        try {
          uploaded = await resolveAttachmentInputs({ machineId, sessionId, attachments })
        } catch (err) {
          let existingUploads = []
          try { existingUploads = store.listSessionUploads(sessionId) } catch { }
          await cleanupUploadedDescriptors({ machineId, sessionId, uploads: existingUploads })
          try { store.deleteSession(sessionId) } catch { }
          json(res, Number(err?.statusCode) || 400, { error: String(err?.message ?? err) })
          return true
        }

        const inputItems = buildCodexInputItems({ text: prompt, uploads: uploaded, isImageMimeType })
        const attachmentPayload = buildAttachmentPayload(uploaded)
        const input = makeEnvelope({
          type: 'session.input',
          scope: { machineId, sessionId },
          payload: {
            sessionId,
            text: prompt,
            isInitial: true,
            ...(attachmentPayload ? { attachments: attachmentPayload } : {})
          }
        })

        try {
          await sendRunnerCommandAndAwait({
            machineId,
            sessionId,
            type: 'session.start',
            payload: { sessionId, cwd, prompt, input: inputItems, options },
            timeoutMs: 15_000
          })
        } catch (err) {
          await cleanupUploadedDescriptors({ machineId, sessionId, uploads: uploaded })
          try { store.deleteSession(sessionId) } catch { }
          json(res, Number(err?.statusCode) || 503, { error: String(err?.message ?? err) })
          return true
        }

        persistSessionEvent(input, { sessionId })
        sendSessionUpsert(store.getSession(sessionId))
        json(res, 200, { sessionId })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'messages' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true

        let body = null
        try {
          body = await readMessageBody(req)
        } catch (err) {
          const msg = String(err?.message ?? err)
          json(res, msg.includes('body too large') ? 413 : 400, { error: msg })
          return true
        }

        const text = body?.text
        const attachments = body?.attachments ?? null
        if (text === undefined || text === null || typeof text !== 'string') {
          json(res, 400, { error: 'text is required' })
          return true
        }

        const hasText = Boolean(String(text).trim())
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0
        if (!hasText && !hasAttachments) {
          json(res, 400, { error: 'text or attachments are required' })
          return true
        }

        let uploaded = []
        try {
          uploaded = await resolveAttachmentInputs({ machineId: session.machineId, sessionId, attachments })
        } catch (err) {
          json(res, Number(err?.statusCode) || 400, { error: String(err?.message ?? err) })
          return true
        }

        const inputItems = buildCodexInputItems({ text, uploads: uploaded, isImageMimeType })
        const attachmentPayload = buildAttachmentPayload(uploaded)
        const input = makeEnvelope({
          type: 'session.input',
          scope: { machineId: session.machineId, sessionId },
          payload: {
            sessionId,
            text,
            ...(attachmentPayload ? { attachments: attachmentPayload } : {})
          }
        })
        const options = {
          ...(session.model ? { model: session.model } : {}),
          ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
          ...(session.approvalPolicy ? { approvalPolicy: session.approvalPolicy } : {}),
          ...(session.sandbox ? { sandbox: session.sandbox } : {})
        }

        try {
          await sendRunnerCommandAndAwait({
            machineId: session.machineId,
            sessionId,
            type: 'session.send',
            payload: {
              sessionId,
              text,
              input: inputItems,
              cwd: session.cwd,
              codexThreadId: session.codexThreadId ?? null,
              ...(Object.keys(options).length ? { options } : {})
            },
            timeoutMs: 10_000
          })
        } catch (err) {
          await cleanupUploadedDescriptors({ machineId: session.machineId, sessionId, uploads: uploaded })
          json(res, Number(err?.statusCode) || 503, { error: String(err?.message ?? err) })
          return true
        }

        persistSessionEvent(input, { sessionId })
        json(res, 200, { ok: true })
        return true
      }

      return false
    }
  }
}
