import crypto from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { CodexAppServerSession } from './sessions/CodexAppServerSession.js'
import { JsonRpcStdioClient } from './sessions/JsonRpcStdioClient.js'
import { RunnerIdeManager } from './ideManager.js'
import { getUploadsDir } from '../lib/paths.js'

function safeFilename(input) {
  const raw = String(input ?? 'upload')
  // Drop any path separators and control chars.
  const base = raw.replace(/[/\\\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base || 'upload'
}

export class RunnerSessionManager {
  /**
   * @param {{
   *   machineId: string,
   *   send: (envelope: any) => boolean,
   *   makeEnvelope: (input: { type: string, scope?: any, payload?: any, track?: boolean }) => any
   * }} opts
   */
  constructor({ machineId, send, makeEnvelope }) {
    this.machineId = machineId
    this.send = send
    this.makeEnvelope = makeEnvelope
    /** @type {Map<string, CodexAppServerSession>} */
    this.sessions = new Map()

    this.ide = new RunnerIdeManager({
      machineId,
      emit: (type, payload) => this.#emit(type, { machineId: this.machineId }, payload)
    })
  }

  /**
   * @param {any} env
   */
  handleHostEnvelope(env) {
    const type = env?.type
    const payload = env?.payload ?? null

    if (type === 'fs.list') return this.#onFsList(payload)
    if (type === 'codex.model.list') return this.#onCodexModelList(payload)
    if (type === 'session.start') return this.#onSessionStart(payload)
    if (type === 'session.send') return this.#onSessionSend(payload)
    if (type === 'session.options.update') return this.#onSessionOptionsUpdate(payload)
    if (type === 'session.upload') return this.#onSessionUpload(payload)
    if (type === 'session.upload.delete') return this.#onSessionUploadDelete(payload)
    if (type === 'session.cleanup') return this.#onSessionCleanup(payload)
    if (type === 'session.cancel') return this.#onSessionCancel(payload)
    if (type === 'session.stop') return this.#onSessionStop(payload)
    if (type === 'approval.respond') return this.#onApprovalRespond(payload)
    if (type === 'ide.start') return this.#onIdeStart(payload)
    if (type === 'ide.stop') return this.#onIdeStop(payload)
  }

  #emit(type, scope, payload, { track = true } = {}) {
    this.send(this.makeEnvelope({ type, scope, payload, track }))
  }

  #sessionScope(sessionId) {
    return { machineId: this.machineId, sessionId }
  }

  async #onSessionStart(payload) {
    const sessionId = payload?.sessionId ?? crypto.randomUUID()
    const cwd = payload?.cwd
    const prompt = payload?.prompt
    const input = payload?.input ?? null
    const options = payload?.options ?? null

    if (!cwd || typeof cwd !== 'string') return
    const startInput = (Array.isArray(input) && input.length) ? input : prompt
    if (!startInput || (typeof startInput !== 'string' && !Array.isArray(startInput))) return

    if (this.sessions.has(sessionId)) return

    const session = new CodexAppServerSession({
      sessionId,
      cwd,
      options,
      emit: (type, eventPayload) => this.#emit(type, this.#sessionScope(sessionId), eventPayload)
    })
    this.sessions.set(sessionId, session)

    try {
      await session.start(startInput)
    } catch (err) {
      this.#emit('session.status', this.#sessionScope(sessionId), {
        sessionId,
        status: 'failed',
        error: String(err?.message ?? err)
      })
      this.sessions.delete(sessionId)
    }
  }

  async #onSessionSend(payload) {
    const sessionId = payload?.sessionId
    const text = payload?.text
    const input = payload?.input ?? null
    if (!sessionId || typeof sessionId !== 'string') return
    const sendInput = (Array.isArray(input) && input.length) ? input : text
    if (!sendInput || (typeof sendInput !== 'string' && !Array.isArray(sendInput))) return

    let session = this.sessions.get(sessionId)
    if (!session) {
      const cwd = payload?.cwd
      const codexThreadId = payload?.codexThreadId ?? null
      const options = payload?.options ?? null
      if (!cwd || typeof cwd !== 'string') {
        this.#emit('session.output', this.#sessionScope(sessionId), {
          sessionId,
          seq: 1,
          stream: 'stderr',
          text: '[rootgrid] cannot resume session (missing cwd)\n'
        })
        return
      }

      session = new CodexAppServerSession({
        sessionId,
        cwd,
        options,
        emit: (type, eventPayload) => this.#emit(type, this.#sessionScope(sessionId), eventPayload)
      })
      this.sessions.set(sessionId, session)

      try {
        await session.start(sendInput, { threadId: (typeof codexThreadId === 'string' && codexThreadId) ? codexThreadId : null })
      } catch (err) {
        this.#emit('session.status', this.#sessionScope(sessionId), {
          sessionId,
          status: 'failed',
          error: String(err?.message ?? err)
        })
        this.sessions.delete(sessionId)
      }
      return
    }

    try {
      await session.send(sendInput)
    } catch (err) {
      this.#emit('session.output', this.#sessionScope(sessionId), {
        sessionId,
        seq: session.nextSeq(),
        stream: 'stderr',
        text: `[rootgrid] send failed: ${String(err?.message ?? err)}\n`
      })
    }
  }

  async #onSessionCancel(payload) {
    const sessionId = payload?.sessionId
    if (!sessionId || typeof sessionId !== 'string') return
    const session = this.sessions.get(sessionId)
    if (!session) return
    await session.cancel()
  }

  async #onSessionOptionsUpdate(payload) {
    const sessionId = payload?.sessionId
    const patch = payload?.options ?? payload?.patch ?? null
    if (!sessionId || typeof sessionId !== 'string') return
    if (!patch || typeof patch !== 'object') return
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      session.updateOptions?.(patch)
    } catch {
    }
  }

  async #onSessionUpload(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId ?? crypto.randomUUID()
    const filename = safeFilename(payload?.filename ?? payload?.name ?? 'upload')
    const mimeType = (typeof payload?.mimeType === 'string' && payload.mimeType.trim())
      ? payload.mimeType.trim()
      : 'application/octet-stream'
    const contentBase64 = payload?.contentBase64 ?? payload?.content ?? null

    if (!sessionId || typeof sessionId !== 'string') return
    if (!contentBase64 || typeof contentBase64 !== 'string') return

    try {
      const dir = join(getUploadsDir(), sessionId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${uploadId}-${filename}`)
      const buf = Buffer.from(contentBase64, 'base64')
      await writeFile(path, buf, { mode: 0o600 })

      this.#emit('session.uploaded', this.#sessionScope(sessionId), {
        sessionId,
        uploadId,
        path,
        filename,
        mimeType,
        sizeBytes: buf.length
      })
    } catch (err) {
      this.#emit('session.upload.failed', this.#sessionScope(sessionId), {
        sessionId,
        uploadId,
        error: String(err?.message ?? err)
      })
    }
  }

  async #onSessionUploadDelete(payload) {
    const sessionId = payload?.sessionId
    const uploadId = payload?.uploadId
    if (!sessionId || typeof sessionId !== 'string') return
    if (!uploadId || typeof uploadId !== 'string') return

    const dir = join(getUploadsDir(), sessionId)
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

  async #onFsList(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    const home = homedir()
    let dir = String(payload?.path ?? '').trim()
    if (!dir || dir === '~') {
      dir = home
    } else if (dir.startsWith('~/') || dir.startsWith('~\\')) {
      dir = join(home, dir.slice(2))
    } else if (!dir.startsWith('/')) {
      // Treat relative paths as relative to the user's home.
      dir = resolve(home, dir)
    }

    dir = resolve(dir)

    let entries = []
    try {
      const raw = await readdir(dir, { withFileTypes: true })
      entries = raw
        .filter((ent) => Boolean(ent?.isDirectory?.()))
        .map((ent) => ({
          name: ent.name,
          path: join(dir, ent.name),
          kind: 'dir'
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .slice(0, 500)
    } catch (err) {
      this.#emit('fs.list.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
      return
    }

    let parent = null
    try {
      const p = dirname(dir)
      if (p && p !== dir) parent = p
    } catch {
    }

    this.#emit('fs.list.result', { machineId: this.machineId }, {
      requestId,
      ok: true,
      path: dir,
      parent,
      entries
    }, { track: false })
  }

  async #onCodexModelList(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    const cwd = (typeof payload?.cwd === 'string' && payload.cwd.trim()) ? payload.cwd.trim() : homedir()
    const limit = Number(payload?.limit)
    const includeHidden = Boolean(payload?.includeHidden)

    const rpc = new JsonRpcStdioClient({
      command: 'codex',
      args: ['app-server'],
      cwd,
      env: process.env,
      onNotification: () => {},
      onRequest: async () => null,
      onStderr: () => {}
    })

    try {
      await rpc.start()
      await rpc.sendRequest('initialize', {
        clientInfo: {
          name: 'rootgrid',
          title: 'Rootgrid',
          version: '0.0.0'
        }
      })
      rpc.sendNotification('initialized', {})

      const params = {
        limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        includeHidden
      }

      let result = null
      let lastErr = null
      for (const method of ['model/list', 'models/list']) {
        try {
          result = await rpc.sendRequest(method, params)
          break
        } catch (err) {
          lastErr = err
        }
      }
      if (!result) throw lastErr ?? new Error('model list failed')

      const models = Array.isArray(result?.models)
        ? result.models
        : (Array.isArray(result?.data) ? result.data : (Array.isArray(result?.items) ? result.items : []))
      const nextCursorRaw = result?.nextCursor ?? result?.next_cursor ?? result?.cursor ?? null
      const nextCursor = (nextCursorRaw === null || nextCursorRaw === undefined) ? null : String(nextCursorRaw)

      this.#emit('codex.model.list.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        models,
        nextCursor
      }, { track: false })
    } catch (err) {
      this.#emit('codex.model.list.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    } finally {
      try { rpc.stop({ signal: 'SIGTERM' }) } catch {}
    }
  }

  async #onSessionStop(payload) {
    const sessionId = payload?.sessionId
    if (!sessionId || typeof sessionId !== 'string') return
    const session = this.sessions.get(sessionId)
    if (!session) return
    await session.stop()
    this.sessions.delete(sessionId)
  }

  async #onSessionCleanup(payload) {
    const sessionId = payload?.sessionId
    if (!sessionId || typeof sessionId !== 'string') return

    // Stop the in-memory session (if running) then cleanup runner-local uploads.
    const session = this.sessions.get(sessionId)
    if (session) {
      try { await session.stop() } catch { }
      this.sessions.delete(sessionId)
    }

    // Best-effort: remove the whole per-session uploads directory.
    try {
      const dir = join(getUploadsDir(), sessionId)
      await rm(dir, { recursive: true, force: true })
    } catch {
    }
  }

  async #onApprovalRespond(payload) {
    const approvalId = payload?.approvalId
    if (!approvalId || typeof approvalId !== 'string') return

    /** @type {any} */
    let response = null

    // EXPERIMENTAL: tool/user-input responses
    if (payload?.answers && typeof payload.answers === 'object') {
      response = { answers: payload.answers, ...(payload?.decision ? { decision: payload.decision } : {}) }
    } else if ('decision' in (payload ?? {})) {
      const decision = payload?.decision
      const reason = payload?.reason ?? null
      if (decision === undefined || decision === null) return
      response = { decision, ...(reason ? { reason } : {}) }
    } else {
      return
    }

    for (const session of this.sessions.values()) {
      if (await session.respondToApproval({ approvalId, response })) {
        return
      }
    }
  }

  async #onIdeStart(payload) {
    const ideId = payload?.ideId
    const cwd = payload?.cwd
    if (!ideId || typeof ideId !== 'string') return
    if (!cwd || typeof cwd !== 'string') return
    try {
      await this.ide.start({ ideId, cwd })
    } catch (err) {
      this.#emit('ide.failed', { machineId: this.machineId }, { ideId, error: String(err?.message ?? err) })
    }
  }

  async #onIdeStop(payload) {
    const ideId = payload?.ideId
    if (!ideId || typeof ideId !== 'string') return
    await this.ide.stop({ ideId })
  }
}
