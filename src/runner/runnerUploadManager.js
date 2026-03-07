import crypto from 'node:crypto'
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getUploadsDir } from '../lib/paths.js'

export function safeRunnerUploadFilename(input) {
  const raw = String(input ?? 'upload')
  const base = raw.replace(/[/\\\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base || 'upload'
}

export class RunnerUploadManager {
  /**
   * @param {{
   *   machineId: string,
   *   emit: (type: string, scope: any, payload: any, options?: { track?: boolean }) => void,
   *   uploadsDir?: string,
   * }} opts
   */
  constructor({ machineId, emit, uploadsDir = getUploadsDir() }) {
    this.machineId = machineId
    this.emit = emit
    this.uploadsDir = uploadsDir
    /** @type {Map<string, { sessionId: string, path: string, filename: string, mimeType: string, sizeBytes: number, file: import('node:fs/promises').FileHandle, queue: Promise<void> }>} */
    this.uploadStreams = new Map()
  }

  #sessionScope(sessionId) {
    return { machineId: this.machineId, sessionId }
  }

  #emitUploadFailed(sessionId, uploadId, error) {
    this.emit('session.upload.failed', this.#sessionScope(sessionId), {
      sessionId,
      uploadId,
      error: String(error ?? 'upload failed')
    })
  }

  async handleLegacyUpload(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId ?? crypto.randomUUID()
    const filename = safeRunnerUploadFilename(payload?.filename ?? payload?.name ?? 'upload')
    const mimeType = (typeof payload?.mimeType === 'string' && payload.mimeType.trim())
      ? payload.mimeType.trim()
      : 'application/octet-stream'
    const contentBase64 = payload?.contentBase64 ?? payload?.content ?? null

    if (!sessionId || typeof sessionId !== 'string') return
    if (!contentBase64 || typeof contentBase64 !== 'string') return

    try {
      const dir = join(this.uploadsDir, sessionId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${uploadId}-${filename}`)
      const buf = Buffer.from(contentBase64, 'base64')
      await writeFile(path, buf, { mode: 0o600 })

      this.emit('session.uploaded', this.#sessionScope(sessionId), {
        sessionId,
        uploadId,
        path,
        filename,
        mimeType,
        sizeBytes: buf.length
      })
    } catch (err) {
      this.#emitUploadFailed(sessionId, uploadId, err?.message ?? err)
    }
  }

  async begin(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId ?? crypto.randomUUID()
    const filename = safeRunnerUploadFilename(payload?.filename ?? payload?.name ?? 'upload')
    const mimeType = (typeof payload?.mimeType === 'string' && payload.mimeType.trim())
      ? payload.mimeType.trim()
      : 'application/octet-stream'

    if (!sessionId || typeof sessionId !== 'string') return

    await this.#closeStream(uploadId, { removeFile: true })

    try {
      const dir = join(this.uploadsDir, sessionId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${uploadId}-${filename}`)
      const file = await open(path, 'w', 0o600)
      this.uploadStreams.set(uploadId, {
        sessionId,
        path,
        filename,
        mimeType,
        sizeBytes: 0,
        file,
        queue: Promise.resolve()
      })
    } catch (err) {
      this.#emitUploadFailed(sessionId, uploadId, err?.message ?? err)
    }
  }

  async chunk(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId
    const chunkBase64 = payload?.chunkBase64
    if (!sessionId || typeof sessionId !== 'string') return
    if (!uploadId || typeof uploadId !== 'string') return
    if (!chunkBase64 || typeof chunkBase64 !== 'string') return

    const state = this.uploadStreams.get(uploadId)
    if (!state) {
      this.#emitUploadFailed(sessionId, uploadId, 'upload stream not found')
      return
    }

    const buf = Buffer.from(chunkBase64, 'base64')
    state.queue = state.queue.then(async () => {
      await state.file.write(buf, 0, buf.length, null)
      state.sizeBytes += buf.length
    })

    try {
      await state.queue
    } catch (err) {
      await this.#closeStream(uploadId, { removeFile: true })
      this.#emitUploadFailed(sessionId, uploadId, err?.message ?? err)
    }
  }

  async end(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId
    if (!sessionId || typeof sessionId !== 'string') return
    if (!uploadId || typeof uploadId !== 'string') return

    const state = this.uploadStreams.get(uploadId)
    if (!state) {
      this.#emitUploadFailed(sessionId, uploadId, 'upload stream not found')
      return
    }

    try {
      await state.queue
      await state.file.close()
      this.uploadStreams.delete(uploadId)

      this.emit('session.uploaded', this.#sessionScope(sessionId), {
        sessionId,
        uploadId,
        path: state.path,
        filename: state.filename,
        mimeType: state.mimeType,
        sizeBytes: state.sizeBytes
      })
    } catch (err) {
      await this.#closeStream(uploadId, { removeFile: true })
      this.#emitUploadFailed(sessionId, uploadId, err?.message ?? err)
    }
  }

  async abort(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId
    if (!sessionId || typeof sessionId !== 'string') return
    if (!uploadId || typeof uploadId !== 'string') return
    await this.#closeStream(uploadId, { removeFile: true })
  }

  async delete(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId
    if (!sessionId || typeof sessionId !== 'string') return
    if (!uploadId || typeof uploadId !== 'string') return

    const dir = join(this.uploadsDir, sessionId)
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const prefix = `${uploadId}-`
    for (const ent of entries) {
      const name = ent?.name
      if (!name || typeof name !== 'string') continue
      if (!name.startsWith(prefix)) continue
      try {
        await rm(join(dir, name), { force: true })
      } catch {
      }
    }
  }

  async cleanupSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return
    for (const [uploadId, state] of this.uploadStreams.entries()) {
      if (state?.sessionId !== sessionId) continue
      await this.#closeStream(uploadId, { removeFile: true })
    }

    try {
      await rm(join(this.uploadsDir, sessionId), { recursive: true, force: true })
    } catch {
    }
  }

  async #closeStream(uploadId, { removeFile = false } = {}) {
    const state = this.uploadStreams.get(uploadId)
    if (!state) return
    this.uploadStreams.delete(uploadId)

    try { await state.queue } catch { }
    try { await state.file.close() } catch { }
    if (removeFile) {
      try { await rm(state.path, { force: true }) } catch { }
    }
  }
}
