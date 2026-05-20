import {
  buildComposerAttachments,
  clearComposerAttachments as clearComposerAttachmentList,
  revokeAttachmentPreview as revokeComposerAttachmentPreview,
  uploadComposerAttachments as uploadComposerAttachmentRefs
} from './composerAttachments.js'
import {
  buildSessionDraftOptions
} from './newThreadDialog.js'
import {
  refreshSessionQueuedPrompts
} from './sessionQueuedPrompts.js'

export function buildComposerMessageBody({
  text = '',
  uploadedAttachments = []
} = {}) {
  const body = {
    text: String(text ?? '')
  }

  const attachments = (Array.isArray(uploadedAttachments) ? uploadedAttachments : [])
    .map((upload) => String(upload?.uploadId ?? '').trim())
    .filter(Boolean)

  if (attachments.length) {
    body.attachments = attachments.map((uploadId) => ({ uploadId }))
  }

  return body
}

export function createComposerSessionActions({
  apiFetch,
  clearDraftForSession,
  defaults,
  defaultsError,
  openSettings,
  attachments,
  composerDragging,
  fileInputEl,
  sendError,
  messageDraft,
  sending,
  getSessionStore,
  selectedSession,
  selectedSessionId
}) {
  let composerDragDepth = 0

  function ensureDefaultsReady() {
    defaultsError.value = ''
    if (!String(defaults.cwd ?? '').trim()) {
      defaultsError.value = 'Workspace (cwd) is required.'
      if (typeof openSettings === 'function') openSettings('machines')
      return false
    }
    return true
  }

  function revokeAttachmentPreview(attachment) {
    revokeComposerAttachmentPreview(attachment)
  }

  function clearComposerAttachments() {
    clearComposerAttachmentList(attachments.value)
  }

  function openFilePicker() {
    try { fileInputEl.value?.click?.() } catch {}
  }

  function addFiles(files) {
    const { added, errors } = buildComposerAttachments(files)
    attachments.value.push(...added)
    if (errors.length) sendError.value = errors[errors.length - 1]
  }

  async function onFilesPicked(event) {
    sendError.value = ''
    const files = Array.from(event?.target?.files ?? [])
    try { event.target.value = '' } catch {}
    if (!files.length) return
    addFiles(files)
  }

  async function onComposerPaste(event) {
    try {
      const files = Array.from(event?.clipboardData?.files ?? [])
      if (!files.length) return
      sendError.value = ''
      addFiles(files)
      const text = event?.clipboardData?.getData?.('text') ?? ''
      if (!String(text ?? '').trim()) event.preventDefault?.()
    } catch {
    }
  }

  function onComposerDragEnter() {
    composerDragDepth += 1
    composerDragging.value = true
  }

  function onComposerDragLeave() {
    composerDragDepth -= 1
    if (composerDragDepth <= 0) {
      composerDragDepth = 0
      composerDragging.value = false
    }
  }

  async function onComposerDrop(event) {
    composerDragDepth = 0
    composerDragging.value = false
    sendError.value = ''
    const files = Array.from(event?.dataTransfer?.files ?? [])
    if (!files.length) return
    addFiles(files)
  }

  function removeAttachment(id) {
    const idx = attachments.value.findIndex((attachment) => attachment?.id === id)
    if (idx < 0) return
    revokeAttachmentPreview(attachments.value[idx])
    attachments.value.splice(idx, 1)
  }

  async function uploadComposerAttachments(sessionId, attachmentList = attachments.value) {
    return await uploadComposerAttachmentRefs({
      sessionId,
      attachments: attachmentList,
      apiFetch
    })
  }

  async function sendComposerMessage(sessionId, text, attachmentList = attachments.value) {
    const uploaded = attachmentList.length ? await uploadComposerAttachments(sessionId, attachmentList) : []
    const res = await apiFetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify(buildComposerMessageBody({
        text,
        uploadedAttachments: uploaded
      }))
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      throw new Error(err?.error ?? `HTTP ${res.status}`)
    }
    return uploaded
  }

  function getQueuedPromptStore(sessionId) {
    if (!sessionId || typeof getSessionStore !== 'function') return null
    const store = getSessionStore(sessionId)
    if (!Array.isArray(store?.queuedPrompts)) store.queuedPrompts = []
    if (typeof store?.queueSending !== 'boolean') store.queueSending = false
    return store
  }

  function replaceQueuedPrompts(store, queuedPrompts) {
    if (!store) return
    store.queuedPrompts = Array.isArray(queuedPrompts) ? queuedPrompts : []
  }

  async function recoverMissingQueuedPrompt(sessionId, store, res, data) {
    if (!store || Number(res?.status ?? 0) !== 404) return false
    const message = String(data?.error ?? '').trim().toLowerCase()
    if (message !== 'queued prompt not found') return false
    const reconciled = await refreshSessionQueuedPrompts({
      sessionId,
      apiFetch,
      getSessionStore: () => store
    }).catch(() => false)
    if (reconciled) sendError.value = ''
    return reconciled
  }

  async function removeQueuedPrompt(sessionId, promptId) {
    const store = getQueuedPromptStore(sessionId)
    if (!store) return false
    store.queueSending = true
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(String(sessionId))}/queued-prompts/${encodeURIComponent(String(promptId ?? ''))}`, {
        method: 'DELETE'
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        if (await recoverMissingQueuedPrompt(sessionId, store, res, data)) return true
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      replaceQueuedPrompts(store, data?.queuedPrompts)
      return true
    } catch (err) {
      sendError.value = String(err?.message ?? err)
      return false
    } finally {
      store.queueSending = false
    }
  }

  async function queueCurrentDraftForSession(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return false
    const text = String(messageDraft.value ?? '').trim()
    const currentAttachments = Array.isArray(attachments.value) ? attachments.value : []
    if (!text && !currentAttachments.length) return false
    const store = getQueuedPromptStore(sid)
    if (!store) return false
    store.queueSending = true
    sendError.value = ''
    try {
      const uploaded = currentAttachments.length ? await uploadComposerAttachments(sid, currentAttachments) : []
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sid)}/queued-prompts`, {
        method: 'POST',
        body: JSON.stringify(buildComposerMessageBody({
          text,
          uploadedAttachments: uploaded
        }))
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      replaceQueuedPrompts(store, data?.queuedPrompts)
      if (typeof clearDraftForSession === 'function') {
        clearDraftForSession(sid)
      } else {
        messageDraft.value = ''
        clearComposerAttachmentList(currentAttachments)
      }
      return true
    } catch (err) {
      sendError.value = String(err?.message ?? err)
      return false
    } finally {
      store.queueSending = false
    }
  }

  async function sendQueuedPromptNow(sessionId, promptId = null) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return false
    const store = getQueuedPromptStore(sid)
    if (!store || store.queueSending) return false

    store.queueSending = true
    sendError.value = ''
    try {
      const targetPromptId = String(promptId ?? store.queuedPrompts[0]?.promptId ?? store.queuedPrompts[0]?.id ?? '').trim()
      if (!targetPromptId) return false
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sid)}/queued-prompts/${encodeURIComponent(targetPromptId)}/send`, {
        method: 'POST'
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        if (await recoverMissingQueuedPrompt(sid, store, res, data)) return true
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      replaceQueuedPrompts(store, data?.queuedPrompts)
      return true
    } catch (err) {
      sendError.value = String(err?.message ?? err)
      return false
    } finally {
      store.queueSending = false
    }
  }

  async function updateQueuedPromptText(sessionId, promptId, text) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return false
    const store = getQueuedPromptStore(sid)
    if (!store || store.queueSending) return false
    store.queueSending = true
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sid)}/queued-prompts/${encodeURIComponent(String(promptId ?? ''))}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: String(text ?? '') })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        if (await recoverMissingQueuedPrompt(sid, store, res, data)) return true
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      replaceQueuedPrompts(store, data?.queuedPrompts)
      return true
    } catch (err) {
      sendError.value = String(err?.message ?? err)
      return false
    } finally {
      store.queueSending = false
    }
  }

  async function createSessionFromDraft(prompt) {
    if (!ensureDefaultsReady()) return null

    const options = buildSessionDraftOptions(defaults)
    const currentAttachments = Array.isArray(attachments.value) ? attachments.value : []

    try {
      const res = await apiFetch('/api/sessions/draft', {
        method: 'POST',
        body: JSON.stringify({
          cwd: String(defaults.cwd ?? '').trim(),
          ...(defaults.machineId ? { machineId: defaults.machineId } : {}),
          options
        })
      })

      if (!res.ok) {
        const err = await res.json().catch(() => null)
        sendError.value = err?.error ?? `HTTP ${res.status}`
        return null
      }

      const data = await res.json().catch(() => null)
      const sessionId = data?.sessionId
      if (!sessionId) {
        sendError.value = 'Missing sessionId'
        return null
      }

      await sendComposerMessage(sessionId, prompt, currentAttachments)
      if (typeof clearDraftForSession === 'function') {
        clearDraftForSession(null)
      } else {
        messageDraft.value = ''
        clearComposerAttachmentList(currentAttachments)
      }
      selectedSessionId.value = sessionId
      return sessionId
    } catch (err) {
      sendError.value = String(err?.message ?? err)
      return null
    }
  }

  async function stopSession() {
    const sessionId = selectedSessionId.value
    if (!sessionId) return
    await apiFetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
  }

  async function stopGenerating() {
    const sessionId = selectedSessionId.value
    if (!sessionId) return
    await apiFetch(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
  }

  async function submit() {
    sendError.value = ''
    if (selectedSession.value?.turnState === 'running') {
      if (await queueCurrentDraftForSession(selectedSessionId.value)) return
      await stopGenerating()
      return
    }

    const text = String(messageDraft.value ?? '').trim()
    if (!text && !attachments.value.length) return
    if (sending.value) return
    sending.value = true

    try {
      if (!selectedSessionId.value) {
        const sessionId = await createSessionFromDraft(text)
        return
      }

      const sessionId = String(selectedSessionId.value ?? '').trim()
      const currentAttachments = Array.isArray(attachments.value) ? attachments.value : []
      await sendComposerMessage(sessionId, text, currentAttachments)
      if (typeof clearDraftForSession === 'function') {
        clearDraftForSession(sessionId)
      } else {
        messageDraft.value = ''
        clearComposerAttachmentList(currentAttachments)
      }
    } catch (err) {
      sendError.value = String(err?.message ?? err)
    } finally {
      sending.value = false
    }
  }

  return {
    ensureDefaultsReady,
    revokeAttachmentPreview,
    clearComposerAttachments,
    openFilePicker,
    addFiles,
    onFilesPicked,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragLeave,
    onComposerDrop,
    removeAttachment,
    uploadComposerAttachments,
    createSessionFromDraft,
    queueCurrentDraftForSession,
    sendQueuedPromptNow,
    updateQueuedPromptText,
    removeQueuedPrompt,
    submit,
    stopSession,
    stopGenerating
  }
}
