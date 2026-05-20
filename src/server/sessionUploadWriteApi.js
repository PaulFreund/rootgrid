import crypto from 'node:crypto'
import { rm } from 'node:fs/promises'

export function createSessionUploadWriteApi({
  auth,
  store,
  json,
  uploadService,
  getSessionOr404
}) {
  const {
    safeFilename,
    formatUploadDescriptor,
    deleteRunnerUploadBestEffort,
    storeHostUploadFromRequest,
    uploadToRunnerFromFile
  } = uploadService

  return {
    async handle(req, res, url, parts) {
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'uploads' && parts.length === 4 && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const sessionId = parts[2]
        const session = getSessionOr404(res, sessionId)
        if (!session) return true

        const rawFilename = url.searchParams.get('filename') ?? req.headers['x-rootgrid-filename']
        const filename = safeFilename(rawFilename ?? 'upload')
        const mimeType = (typeof req.headers['content-type'] === 'string' && req.headers['content-type'].trim())
          ? req.headers['content-type'].trim()
          : 'application/octet-stream'
        const maxUploadBytes = 50 * 1024 * 1024
        const uploadId = crypto.randomUUID()

        let hostInfo = null
        let runnerInfo = null
        try {
          hostInfo = await storeHostUploadFromRequest({
            req,
            sessionId,
            uploadId,
            filename,
            maxBytes: maxUploadBytes
          })
          runnerInfo = await uploadToRunnerFromFile({
            machineId: session.machineId,
            sessionId,
            uploadId,
            filename,
            mimeType,
            hostPath: hostInfo.path
          })

          const runnerPath = runnerInfo?.path
          if (!runnerPath || typeof runnerPath !== 'string') {
            throw new Error('upload failed (missing runner path)')
          }

          store.upsertUpload({
            uploadId,
            sessionId,
            filename,
            mimeType,
            sizeBytes: hostInfo.sizeBytes,
            hostPath: hostInfo.path,
            runnerPath
          })

          json(res, 200, formatUploadDescriptor(sessionId, {
            uploadId,
            filename,
            mimeType,
            sizeBytes: hostInfo.sizeBytes,
            hostPath: hostInfo.path,
            runnerPath
          }))
          return true
        } catch (err) {
          deleteRunnerUploadBestEffort({ machineId: session.machineId, sessionId, uploadId })
          if (hostInfo?.path) {
            try { await rm(hostInfo.path, { force: true }) } catch { }
          }
          try { store.deleteUpload({ sessionId, uploadId }) } catch { }
          json(res, Number(err?.statusCode) || 400, { error: String(err?.message ?? err) })
          return true
        }
      }

      return false
    }
  }
}
