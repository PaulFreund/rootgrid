const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export function isImageMimeType(mimeType) {
  return String(mimeType ?? '').toLowerCase().startsWith('image/')
}

export function revokeAttachmentPreview(att, {
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL)
} = {}) {
  const url = att?.previewUrl
  if (!url || typeof url !== 'string') return
  if (!url.startsWith('blob:')) return
  if (typeof revokeObjectURL !== 'function') return
  try { revokeObjectURL(url) } catch {}
}

export function clearComposerAttachments(list, deps) {
  const items = Array.isArray(list) ? list : []
  for (const att of items) revokeAttachmentPreview(att, deps)
  items.splice(0, items.length)
}

export function buildComposerAttachments(files, {
  createId = () => globalThis.crypto.randomUUID(),
  createPreviewUrl = globalThis.URL?.createObjectURL?.bind(globalThis.URL)
} = {}) {
  const added = []
  const errors = []

  for (const file of (Array.isArray(files) ? files : [])) {
    if (!file) continue
    if (Number(file.size ?? 0) > MAX_UPLOAD_BYTES) {
      errors.push(`File too large: ${file.name} (max 50MB)`)
      continue
    }

    const mimeType = file.type || 'application/octet-stream'
    added.push({
      id: createId(),
      filename: file.name,
      mimeType,
      sizeBytes: Number(file.size ?? 0) || 0,
      file,
      previewUrl: (isImageMimeType(mimeType) && typeof createPreviewUrl === 'function')
        ? createPreviewUrl(file)
        : null
    })
  }

  return { added, errors }
}

export async function uploadComposerAttachments({ sessionId, attachments, apiFetch }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return []
  if (typeof apiFetch !== 'function') throw new Error('apiFetch is required')

  const uploaded = []
  for (const att of (Array.isArray(attachments) ? attachments : [])) {
    const existingUploadId = String(att?.uploadId ?? '').trim()
    const uploadedForSessionId = String(att?.uploadedForSessionId ?? '').trim()
    if (existingUploadId && uploadedForSessionId === sid) {
      uploaded.push({ uploadId: existingUploadId })
      continue
    }

    const file = att?.file ?? null
    if (!(file instanceof Blob)) throw new Error(`Attachment missing file bytes: ${att?.filename ?? 'upload'}`)

    const res = await apiFetch(`/api/sessions/${sid}/uploads?filename=${encodeURIComponent(String(att?.filename ?? 'upload'))}`, {
      method: 'POST',
      headers: {
        'Content-Type': String(att?.mimeType ?? file.type ?? 'application/octet-stream')
      },
      body: file
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
    att.uploadId = data?.uploadId ?? null
    att.uploadedForSessionId = sid
    uploaded.push(data)
  }

  return uploaded
}
