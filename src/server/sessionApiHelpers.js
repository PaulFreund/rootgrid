export function buildAttachmentPayload(uploads) {
  const list = Array.isArray(uploads) ? uploads : []
  if (!list.length) return undefined
  return list.map((u) => ({
    uploadId: u.uploadId,
    filename: u.filename,
    mimeType: u.mimeType,
    sizeBytes: u.sizeBytes,
    url: u.url
  }))
}

export function buildCodexInputItems({ text, uploads, isImageMimeType }) {
  const list = Array.isArray(uploads) ? uploads : []
  const fileLines = []
  for (const upload of list) {
    if (!upload?.runnerPath) continue
    if (isImageMimeType(upload?.mimeType)) continue
    fileLines.push(`- ${upload.filename}: ${upload.runnerPath}`)
  }

  let effectiveText = fileLines.length
    ? `${text}\n\n[Uploaded files]\n${fileLines.join('\n')}`
    : text
  if (!String(effectiveText).trim()) effectiveText = '(see attachments)'

  const inputItems = [{ type: 'text', text: effectiveText }]
  for (const upload of list) {
    if (!isImageMimeType(upload?.mimeType)) continue
    if (upload?.runnerPath) inputItems.push({ type: 'localImage', path: upload.runnerPath })
  }
  return inputItems
}
