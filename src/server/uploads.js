import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getUploadsDir } from '../lib/paths.js'
import { writeAll } from '../lib/writeAll.js'

function safeFilename(input) {
  const raw = String(input ?? 'upload')
  const base = raw.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base || 'upload'
}

function estimateBase64Bytes(b64) {
  const s = String(b64 ?? '')
  if (!s) return 0
  const padding = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0)
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding)
}

function isImageMimeType(mimeType) {
  const mt = String(mimeType ?? '').toLowerCase()
  return mt.startsWith('image/')
}

function formatUploadDescriptor(sessionId, upload, { internal = false } = {}) {
  const out = {
    uploadId: upload.uploadId,
    filename: upload.filename,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    url: `/api/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(upload.uploadId)}`
  }
  if (internal) {
    if (upload.hostPath) out.hostPath = upload.hostPath
    if (upload.runnerPath) out.runnerPath = upload.runnerPath
  }
  return out
}

/**
 * Host-side upload/attachment service used by startHost.
 *
 * @param {{
 *   runnerWs: { sendToMachine: (machineId: string, envelope: any) => boolean },
 *   store: any,
 *   makeEnvelope: (input: { type: string, scope?: any, payload?: any }) => any,
 *   httpError: (statusCode: number, message: string) => Error,
 * }} deps
 */
export function createUploadService({ runnerWs, store, makeEnvelope, httpError }) {
  const pendingUploads = new Map() // uploadId -> { resolve, reject, timer, machineId }

  function handleRunnerMessage(msg) {
    if (msg?.type === 'session.uploaded') {
      const uploadId = msg.payload?.uploadId
      if (!uploadId) return false
      const pending = pendingUploads.get(uploadId)
      if (pending) {
        pendingUploads.delete(uploadId)
        clearTimeout(pending.timer)
        pending.resolve(msg.payload)
      }
      return true
    }

    if (msg?.type === 'session.upload.failed') {
      const uploadId = msg.payload?.uploadId
      if (!uploadId) return false
      const pending = pendingUploads.get(uploadId)
      if (pending) {
        pendingUploads.delete(uploadId)
        clearTimeout(pending.timer)
        pending.reject(new Error(msg.payload?.error ?? 'upload failed'))
      }
      return true
    }

    return false
  }

  function handleRunnerDisconnect(machineId) {
    if (!machineId || typeof machineId !== 'string') return
    for (const [uploadId, pending] of pendingUploads.entries()) {
      if (pending?.machineId !== machineId) continue
      pendingUploads.delete(uploadId)
      try { clearTimeout(pending.timer) } catch { }
      try { pending.reject(new Error('runner disconnected during upload')) } catch { }
    }
  }

  function deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId }) {
    if (!machineId || !sessionId || !uploadId) return
    try {
      runnerWs.sendToMachine(machineId, makeEnvelope({
        type: 'session.upload.delete',
        scope: { machineId, sessionId },
        payload: { sessionId, uploadId }
      }))
    } catch {
    }
  }

  function abortRunnerUploadBestEffort({ machineId, sessionId, uploadId }) {
    if (!machineId || !sessionId || !uploadId) return
    try {
      runnerWs.sendToMachine(machineId, makeEnvelope({
        type: 'session.upload.abort',
        scope: { machineId, sessionId },
        payload: { sessionId, uploadId }
      }))
    } catch {
    }
  }

  async function uploadToRunnerFromFile({ machineId, sessionId, uploadId, filename, mimeType, hostPath }) {
    const uploadedP = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingUploads.delete(uploadId)
        reject(new Error('timeout uploading file'))
      }, 30_000)
      pendingUploads.set(uploadId, { resolve, reject, timer, machineId })
    })
    uploadedP.catch(() => {})

    const beginOk = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'session.upload.begin',
      scope: { machineId, sessionId },
      payload: { sessionId, uploadId, filename, mimeType }
    }))
    if (!beginOk) {
      const pending = pendingUploads.get(uploadId)
      if (pending) {
        pendingUploads.delete(uploadId)
        clearTimeout(pending.timer)
      }
      throw new Error('runner not connected')
    }

    try {
      for await (const chunk of createReadStream(hostPath, { highWaterMark: 64 * 1024 })) {
        const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'session.upload.chunk',
          scope: { machineId, sessionId },
          payload: {
            sessionId,
            uploadId,
            chunkBase64: Buffer.from(chunk).toString('base64')
          }
        }))
        if (!ok) throw new Error('runner not connected')
      }

      const endOk = runnerWs.sendToMachine(machineId, makeEnvelope({
        type: 'session.upload.end',
        scope: { machineId, sessionId },
        payload: { sessionId, uploadId }
      }))
      if (!endOk) throw new Error('runner not connected')
    } catch (err) {
      const pending = pendingUploads.get(uploadId)
      if (pending) {
        pendingUploads.delete(uploadId)
        clearTimeout(pending.timer)
      }
      abortRunnerUploadBestEffort({ machineId, sessionId, uploadId })
      throw err
    }

    return await uploadedP
  }

  async function storeHostUpload({ sessionId, uploadId, filename, contentBase64 }) {
    const dir = join(getUploadsDir(), sessionId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${uploadId}-${filename}`)
    const buf = Buffer.from(String(contentBase64), 'base64')
    await writeFile(path, buf, { mode: 0o600 })
    return { path, sizeBytes: buf.length }
  }

  async function storeHostUploadFromRequest({ req, sessionId, uploadId, filename, maxBytes }) {
    const dir = join(getUploadsDir(), sessionId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${uploadId}-${filename}`)
    const fh = await open(path, 'w', 0o600)

    let total = 0
    let writeOffset = 0
    try {
      const contentLength = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw httpError(413, `attachment too large: ${filename} (${contentLength} bytes)`)
      }

      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > maxBytes) {
          throw httpError(413, `attachment too large: ${filename} (${total} bytes)`)
        }
        writeOffset += await writeAll(fh, buf, writeOffset)
      }

      await fh.close()
      return { path, sizeBytes: total }
    } catch (err) {
      try { await fh.close() } catch { }
      try { await rm(path, { force: true }) } catch { }
      throw err
    }
  }

  async function processAttachments({ machineId, sessionId, attachments }) {
    const list = Array.isArray(attachments) ? attachments : []
    if (!list.length) return []

    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

    /** @type {Array<{ uploadId: string, filename: string, mimeType: string, sizeBytes: number, hostPath: string, runnerPath: string }>} */
    const created = []

    const rollback = async () => {
      for (const u of created) {
        deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId: u.uploadId })
        try { await rm(u.hostPath, { force: true }) } catch { }
        try { store.deleteUpload({ sessionId, uploadId: u.uploadId }) } catch { }
      }
      created.splice(0, created.length)
    }

    try {
      for (const a of list) {
        if (!a || typeof a !== 'object') continue
        const filename = safeFilename(a.filename ?? a.name ?? 'upload')
        const mimeType = (typeof a.mimeType === 'string' && a.mimeType.trim())
          ? a.mimeType.trim()
          : (typeof a.type === 'string' && a.type.trim() ? a.type.trim() : 'application/octet-stream')
        const contentBase64 = a.contentBase64 ?? a.content ?? null
        if (!contentBase64 || typeof contentBase64 !== 'string') {
          throw httpError(400, 'attachment contentBase64 is required')
        }

        const estimated = estimateBase64Bytes(contentBase64)
        if (estimated > MAX_UPLOAD_BYTES) {
          throw httpError(413, `attachment too large: ${filename} (${estimated} bytes)`)
        }

        const uploadId = crypto.randomUUID()
        const hostInfo = await storeHostUpload({ sessionId, uploadId, filename, contentBase64 })

        let runnerInfo = null
        try {
          runnerInfo = await uploadToRunnerFromFile({ machineId, sessionId, uploadId, filename, mimeType, hostPath: hostInfo.path })
        } catch (err) {
          try { await rm(hostInfo.path, { force: true }) } catch { }
          deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId })
          throw err
        }

        const runnerPath = runnerInfo?.path
        if (!runnerPath || typeof runnerPath !== 'string') {
          try { await rm(hostInfo.path, { force: true }) } catch { }
          deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId })
          throw new Error('upload failed (missing runner path)')
        }

        try {
          store.upsertUpload({
            uploadId,
            sessionId,
            filename,
            mimeType,
            sizeBytes: hostInfo.sizeBytes,
            hostPath: hostInfo.path,
            runnerPath
          })
        } catch {
        }

        created.push({ uploadId, filename, mimeType, sizeBytes: hostInfo.sizeBytes, hostPath: hostInfo.path, runnerPath })
      }
    } catch (err) {
      await rollback()
      throw err
    }

    return created.map((u) => formatUploadDescriptor(sessionId, u, { internal: true }))
  }

  async function resolveAttachmentInputs({ machineId, sessionId, attachments }) {
    const list = Array.isArray(attachments) ? attachments : []
    if (!list.length) return []

    const existing = []
    const inline = []
    const seenUploadIds = new Set()

    for (const a of list) {
      if (!a || typeof a !== 'object') continue
      const uploadId = (typeof a.uploadId === 'string' && a.uploadId.trim()) ? a.uploadId.trim() : null
      const hasInlineContent = typeof a.contentBase64 === 'string' || typeof a.content === 'string'
      if (uploadId && !hasInlineContent) {
        if (seenUploadIds.has(uploadId)) continue
        seenUploadIds.add(uploadId)
        const row = store.getUpload({ sessionId, uploadId })
        if (!row) throw httpError(400, `attachment not found: ${uploadId}`)
        existing.push(formatUploadDescriptor(sessionId, row, { internal: true }))
        continue
      }
      inline.push(a)
    }

    if (inline.length) {
      const created = await processAttachments({ machineId, sessionId, attachments: inline })
      existing.push(...created)
    }

    return existing
  }

  async function cleanupUploadedDescriptors({ machineId, sessionId, uploads = [] }) {
    for (const u of (Array.isArray(uploads) ? uploads : [])) {
      const uploadId = u?.uploadId
      if (uploadId) deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId })
      const hostPath = u?.hostPath
      if (hostPath && typeof hostPath === 'string') {
        try { await rm(hostPath, { force: true }) } catch { }
      }
      if (uploadId) {
        try { store.deleteUpload({ sessionId, uploadId }) } catch { }
      }
    }
  }

  return {
    safeFilename,
    isImageMimeType,
    formatUploadDescriptor,
    handleRunnerMessage,
    handleRunnerDisconnect,
    uploadToRunnerFromFile,
    storeHostUploadFromRequest,
    processAttachments,
    resolveAttachmentInputs,
    cleanupUploadedDescriptors,
    deleteRunnerUploadBestEffort
  }
}
