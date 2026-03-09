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
  listQueuedPromptPayloads,
  sendQueuedPromptsUpdated,
  sendQueuedPromptNowBackend,
  sendSessionUpsert,
  getSessionOr404
}) {
  const { isImageMimeType, resolveAttachmentInputs, cleanupUploadedDescriptors } = uploadService

  async function readMessageBody(req) {
    return await readJsonBody(req, { limitBytes: 250_000_000 })
  }

  async function sendQueuedPrompt(sessionId, promptId = null) {
    return await sendQueuedPromptNowBackend({ sessionId, promptId })
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

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'queued-prompts' && parts.length === 4 && req.method === 'POST') {
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

        const text = String(body?.text ?? '')
        const attachments = body?.attachments ?? null
        const hasText = Boolean(text.trim())
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

        const promptId = crypto.randomUUID()
        try {
          store.upsertQueuedPrompt({
            promptId,
            sessionId,
            text,
            attachmentIds: uploaded.map((upload) => String(upload?.uploadId ?? '').trim()).filter(Boolean)
          })
        } catch (err) {
          json(res, 500, { error: String(err?.message ?? err) })
          return true
        }

        const queuedPrompts = sendQueuedPromptsUpdated(sessionId)
        json(res, 200, { ok: true, promptId, queuedPrompts })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'queued-prompts' && parts[4] && parts.length === 5 && req.method === 'PATCH') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const promptId = parts[4]
        if (!getSessionOr404(res, sessionId)) return true

        const current = store.getQueuedPrompt({ sessionId, promptId })
        if (!current) {
          json(res, 404, { error: 'queued prompt not found' })
          return true
        }

        let body = null
        try {
          body = await readJsonBody(req)
        } catch (err) {
          json(res, 400, { error: String(err?.message ?? err) })
          return true
        }

        try {
          store.upsertQueuedPrompt({
            promptId,
            sessionId,
            text: String(body?.text ?? current.text ?? ''),
            attachmentIds: Array.isArray(current.attachmentIds) ? current.attachmentIds : [],
            createdMs: Number(current.createdMs ?? Date.now()) || Date.now()
          })
        } catch (err) {
          json(res, 500, { error: String(err?.message ?? err) })
          return true
        }

        const queuedPrompts = sendQueuedPromptsUpdated(sessionId)
        json(res, 200, { ok: true, queuedPrompts })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'queued-prompts' && parts[4] && parts.length === 5 && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const promptId = parts[4]
        if (!getSessionOr404(res, sessionId)) return true

        const deleted = store.deleteQueuedPrompt({ sessionId, promptId })
        if (!deleted) {
          json(res, 404, { error: 'queued prompt not found' })
          return true
        }

        const queuedPrompts = sendQueuedPromptsUpdated(sessionId)
        json(res, 200, { ok: true, queuedPrompts })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'queued-prompts' && parts[4] && parts[5] === 'send' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const promptId = parts[4]
        if (!getSessionOr404(res, sessionId)) return true

        try {
          const result = await sendQueuedPrompt(sessionId, promptId)
          json(res, 200, {
            ok: true,
            ...(result && typeof result === 'object' ? result : {}),
            queuedPrompts: Array.isArray(result?.queuedPrompts)
              ? result.queuedPrompts
              : listQueuedPromptPayloads(sessionId)
          })
        } catch (err) {
          json(res, Number(err?.statusCode) || 503, { error: String(err?.message ?? err) })
        }
        return true
      }

      return false
    }
  }
}
