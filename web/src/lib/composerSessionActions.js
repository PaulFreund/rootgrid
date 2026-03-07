import {
  buildComposerAttachments,
  clearComposerAttachments as clearComposerAttachmentList,
  revokeAttachmentPreview as revokeComposerAttachmentPreview,
  uploadComposerAttachments as uploadComposerAttachmentRefs
} from './composerAttachments.js'
import {
  buildSessionDraftOptions
} from './newThreadDialog.js'

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
  defaults,
  defaultsError,
  openSettings,
  attachments,
  composerDragging,
  fileInputEl,
  sendError,
  messageDraft,
  sending,
  selectedSession,
  selectedSessionId
}) {
  let composerDragDepth = 0

  function ensureDefaultsReady() {
    defaultsError.value = ''
    if (!String(defaults.cwd ?? '').trim()) {
      defaultsError.value = 'Workspace (cwd) is required.'
      if (typeof openSettings === 'function') openSettings('defaults')
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

  async function uploadComposerAttachments(sessionId) {
    return await uploadComposerAttachmentRefs({
      sessionId,
      attachments: attachments.value,
      apiFetch
    })
  }

  async function sendComposerMessage(sessionId, text) {
    const uploaded = attachments.value.length ? await uploadComposerAttachments(sessionId) : []
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

  async function createSessionFromDraft(prompt) {
    if (!ensureDefaultsReady()) return null

    const options = buildSessionDraftOptions(defaults)

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

      selectedSessionId.value = sessionId
      await sendComposerMessage(sessionId, prompt)
      clearComposerAttachments()
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
        if (sessionId) messageDraft.value = ''
        return
      }

      await sendComposerMessage(selectedSessionId.value, text)
      messageDraft.value = ''
      clearComposerAttachments()
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
    submit,
    stopSession,
    stopGenerating
  }
}
