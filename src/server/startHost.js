import crypto from 'node:crypto'
import http from 'node:http'
import { createReadStream, rmSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getConfigPath, getDbPath, getSecretKeyPath, getUploadsDir } from '../lib/paths.js'
import { getOrCreateVapidKeys } from '../lib/vapidKeys.js'
import { Store } from '../db/store.js'
import { RootgridConfigSchema } from '../config/schema.js'
import { AuthService } from './auth.js'
import { makeEnvelope } from './envelope.js'
import { readJsonBody, json } from './httpUtil.js'
import { PushService } from './pushService.js'
import { recoverAfterRunnerRestart } from './recovery.js'
import { SSEManager } from './sseManager.js'
import { serveWeb } from './static.js'
import { createRunnerWsServer } from './wsRunner.js'
import { createTunnelWsServer } from './wsTunnel.js'
import { TunnelHub } from './tunnelHub.js'

export async function startHost({ config }) {
  const store = new Store({ dbPath: getDbPath() })
  const auth = new AuthService({
    clientToken: config.host.auth.clientToken,
    secretKeyPath: getSecretKeyPath(),
    trustProxy: config.host.trustProxy
  })
  const sse = new SSEManager({ heartbeatMs: 30_000 })
  /** @type {PushService|null} */
  let push = null
  try {
    const vapidKeys = await getOrCreateVapidKeys()
    const subject = config.host.publicUrl ? String(config.host.publicUrl) : 'mailto:rootgrid@local'
    push = new PushService({ store, vapidKeys, subject })
  } catch (err) {
    console.warn('[rootgrid] web push disabled (failed to init VAPID keys):', String(err?.message ?? err))
  }

  const approvals = new Map() // approvalId -> { machineId, sessionId }
  const ideSessions = new Map() // ideId -> { machineId, cwd, port, basePath }
  const pendingIdeStarts = new Map() // ideId -> { resolve, reject, timer }
  const pendingUploads = new Map() // uploadId -> { resolve, reject, timer }
  const pendingFsLists = new Map() // requestId -> { resolve, reject, timer }
  const pendingModelLists = new Map() // requestId -> { resolve, reject, timer }

  const tunnelHub = new TunnelHub()

  const logRequests = process.env.ROOTGRID_LOG_REQUESTS === '1'

  // If we run a local runner in the same process, a host restart implies any
  // in-flight turns were interrupted. Clear stuck `turn_state=running` so the
  // UI doesn't get wedged showing an unkillable "Stop" state.
  if (config.runner?.enabled && config.runner?.machineId) {
    try {
      recoverAfterRunnerRestart({ store, machineId: config.runner.machineId, reason: 'host restarted' })
    } catch {
    }
  }

  // Recover pending approvals + IDE sessions (best-effort) after host restart.
  try {
    for (const a of store.listApprovals()) {
      approvals.set(a.approvalId, { machineId: a.machineId, sessionId: a.sessionId })
    }
  } catch {
  }
  try {
    for (const ide of store.listIdeSessions()) {
      ideSessions.set(ide.ideId, {
        ideId: ide.ideId,
        machineId: ide.machineId,
        cwd: ide.cwd,
        port: ide.port,
        basePath: ide.basePath
      })
    }
  } catch {
  }

  const runnerWs = createRunnerWsServer({
    config,
    store,
    sse,
    onRunnerMessage: (msg, { machineId, inserted }) => {
      if (msg?.type === 'session.uploaded') {
        const uploadId = msg.payload?.uploadId
        if (!uploadId) return
        const pending = pendingUploads.get(uploadId)
        if (pending) {
          pendingUploads.delete(uploadId)
          clearTimeout(pending.timer)
          pending.resolve(msg.payload)
        }
        return
      }

      if (msg?.type === 'session.upload.failed') {
        const uploadId = msg.payload?.uploadId
        if (!uploadId) return
        const pending = pendingUploads.get(uploadId)
        if (pending) {
          pendingUploads.delete(uploadId)
          clearTimeout(pending.timer)
          pending.reject(new Error(msg.payload?.error ?? 'upload failed'))
        }
        return
      }

      if (msg?.type === 'fs.list.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        const pending = pendingFsLists.get(requestId)
        if (pending) {
          pendingFsLists.delete(requestId)
          clearTimeout(pending.timer)
          if (msg.payload?.ok === false) {
            pending.reject(new Error(msg.payload?.error ?? 'fs list failed'))
          } else {
            pending.resolve(msg.payload)
          }
        }
        return
      }

      if (msg?.type === 'codex.model.list.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        const pending = pendingModelLists.get(requestId)
        if (pending) {
          pendingModelLists.delete(requestId)
          clearTimeout(pending.timer)
          if (msg.payload?.ok === false) {
            pending.reject(new Error(msg.payload?.error ?? 'model list failed'))
          } else {
            pending.resolve(msg.payload)
          }
        }
        return
      }

      if (msg?.type === 'ide.started') {
        const ideId = msg.payload?.ideId
        const cwd = msg.payload?.cwd
        const port = Number(msg.payload?.port)
        const basePath = msg.payload?.basePath ?? null
        if (!ideId || !Number.isFinite(port)) return

        ideSessions.set(ideId, { ideId, machineId, cwd, port, basePath })
        if (typeof cwd === 'string' && cwd) {
          try {
            store.upsertIdeSession({ ideId, machineId, cwd, port, basePath })
          } catch {
          }
        }

        const pending = pendingIdeStarts.get(ideId)
        if (pending) {
          pendingIdeStarts.delete(ideId)
          clearTimeout(pending.timer)
          pending.resolve({ ideId, machineId, cwd, port, basePath })
        }
      }

      if (msg?.type === 'ide.failed') {
        const ideId = msg.payload?.ideId
        if (!ideId) return
        const pending = pendingIdeStarts.get(ideId)
        if (pending) {
          pendingIdeStarts.delete(ideId)
          clearTimeout(pending.timer)
          pending.reject(new Error(msg.payload?.error ?? 'ide failed'))
        }
        ideSessions.delete(ideId)
        try { store.deleteIdeSession(ideId) } catch { }
      }

      if (msg?.type === 'ide.stopped') {
        const ideId = msg.payload?.ideId
        if (ideId) ideSessions.delete(ideId)
        if (ideId) {
          try { store.deleteIdeSession(ideId) } catch { }
        }
      }

      // Toast notifications (SSE) for important events.
      if (!inserted) return
      const toastPolicy = config.notifications?.sseToasts ?? 'if-not-visible'
      if (toastPolicy === 'never') return

      const sessionId = msg?.scope?.sessionId ?? msg?.payload?.sessionId ?? null
      const session = sessionId ? store.getSession(sessionId) : null
      const project = session?.projectLabel ?? null
      const cwd = session?.cwd ?? msg?.payload?.cwd ?? null
      const cwdBase = (typeof cwd === 'string' && cwd) ? cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() : null
      const label = (project && String(project).trim()) ? String(project).trim() : (cwdBase || (sessionId ? String(sessionId).slice(0, 8) : 'Session'))

      if (msg?.type === 'approval.request') {
        const kind = msg.payload?.kind ?? 'unknown'
        const title = 'Approval required'
        let message = `${label} · ${String(kind)}`
        const command = msg.payload?.command
        const reason = msg.payload?.reason
        const grantRoot = msg.payload?.grantRoot
        if (typeof command === 'string' && command.trim()) message += `\n${command.trim()}`
        else if (typeof reason === 'string' && reason.trim()) message += `\n${reason.trim()}`
        if (typeof grantRoot === 'string' && grantRoot.trim()) message += `\nGrant: ${grantRoot.trim()}`

        sse.sendToast(makeEnvelope({
          type: 'toast',
          scope: sessionId ? { machineId, sessionId } : { machineId },
          payload: {
            level: 'error',
            title,
            message,
            ...(sessionId ? { sessionId } : {})
          }
        }), { policy: toastPolicy })

        const pushPolicy = config.notifications?.webPush ?? 'if-not-visible'
        const shouldPush = push && pushPolicy !== 'never' && (
          pushPolicy === 'always' || (pushPolicy === 'if-not-visible' && !sse.isSessionVisible(sessionId))
        )
        if (shouldPush) {
          push.sendToAll({
            title,
            body: message,
            tag: sessionId ? `approval:${sessionId}` : 'approval',
            data: {
              type: 'approval.request',
              ...(sessionId ? { sessionId } : {}),
              url: sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/'
            }
          }).catch(() => {})
        }
      }

      if (msg?.type === 'turn.completed' && sessionId) {
        const status = msg.payload?.status ?? 'completed'
        if (status === 'interrupted') return
        const title = (status === 'failed') ? 'Turn failed' : 'Ready'
        const preview = msg.payload?.preview
        const error = msg.payload?.error
        const message = (status === 'failed')
          ? `${label}${error ? `\n${String(error)}` : ''}`
          : `${label}${preview ? `\n${String(preview)}` : ''}`

        sse.sendToast(makeEnvelope({
          type: 'toast',
          scope: { machineId, sessionId },
          payload: {
            level: (status === 'failed') ? 'error' : 'success',
            title,
            message,
            sessionId
          }
        }), { policy: toastPolicy })

        const pushPolicy = config.notifications?.webPush ?? 'if-not-visible'
        const shouldPush = push && pushPolicy !== 'never' && (
          pushPolicy === 'always' || (pushPolicy === 'if-not-visible' && !sse.isSessionVisible(sessionId))
        )
        if (shouldPush) {
          push.sendToAll({
            title,
            body: message,
            tag: `turn:${sessionId}`,
            data: {
              type: 'turn.completed',
              sessionId,
              url: `/?session=${encodeURIComponent(sessionId)}`
            }
          }).catch(() => {})
        }
      }

      if (msg?.type === 'session.status' && sessionId) {
        const st = msg.payload?.status
        if (st === 'failed') {
          const err = msg.payload?.error
          sse.sendToast(makeEnvelope({
            type: 'toast',
            scope: { machineId, sessionId },
            payload: {
              level: 'error',
              title: 'Session failed',
              message: `${label}${err ? `\n${String(err)}` : ''}`,
              sessionId
            }
          }), { policy: toastPolicy })

          const pushPolicy = config.notifications?.webPush ?? 'if-not-visible'
          const shouldPush = push && pushPolicy !== 'never' && (
            pushPolicy === 'always' || (pushPolicy === 'if-not-visible' && !sse.isSessionVisible(sessionId))
          )
          if (shouldPush) {
            const title = 'Session failed'
            const message = `${label}${err ? `\n${String(err)}` : ''}`
            push.sendToAll({
              title,
              body: message,
              tag: `failed:${sessionId}`,
              data: {
                type: 'session.failed',
                sessionId,
                url: `/?session=${encodeURIComponent(sessionId)}`
              }
            }).catch(() => {})
          }
        }
      }
    },
    onApprovalRequest: (msg, { machineId }) => {
      const approvalId = msg?.payload?.approvalId
      const sessionId = msg?.payload?.sessionId ?? msg?.scope?.sessionId ?? null
      if (!approvalId || !sessionId) return
      approvals.set(approvalId, { machineId, sessionId })
      try {
        const kind = String(msg?.payload?.kind ?? 'unknown')
        store.upsertApproval({
          approvalId,
          machineId,
          sessionId,
          kind,
          payload: msg.payload ?? null
        })
      } catch {
      }
    }
  })
  const runnerWss = runnerWs.wss
  const tunnelWs = createTunnelWsServer({ config, hub: tunnelHub })
  const tunnelWss = tunnelWs.wss

  function pickMachineId(preferredMachineId) {
    const connected = runnerWs.listConnectedMachineIds()
    if (preferredMachineId) {
      return connected.includes(preferredMachineId) ? preferredMachineId : null
    }
    if (config.runner.enabled && connected.includes(config.runner.machineId)) {
      return config.runner.machineId
    }
    return connected[0] ?? null
  }

  function safeFilename(input) {
    const raw = String(input ?? 'upload')
    const base = raw.replace(/[/\\\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim()
    return base || 'upload'
  }

  function httpError(statusCode, message) {
    const err = new Error(message)
    // @ts-ignore - ad-hoc error metadata
    err.statusCode = statusCode
    return err
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

  async function uploadToRunner({ machineId, sessionId, uploadId, filename, mimeType, contentBase64 }) {
    const uploadedP = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingUploads.delete(uploadId)
        reject(new Error('timeout uploading file'))
      }, 30_000)
      pendingUploads.set(uploadId, { resolve, reject, timer })
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'session.upload',
      scope: { machineId, sessionId },
      payload: { sessionId, uploadId, filename, mimeType, contentBase64 }
    }))
    if (!ok) {
      pendingUploads.delete(uploadId)
      throw new Error('runner not connected')
    }

    return await uploadedP
  }

  async function fsListOnRunner({ machineId, path }) {
    const requestId = crypto.randomUUID()
    const resultP = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFsLists.delete(requestId)
        reject(httpError(504, 'timeout listing directory'))
      }, 10_000)
      pendingFsLists.set(requestId, { resolve, reject, timer })
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'fs.list',
      scope: { machineId },
      payload: { requestId, path: String(path ?? '') }
    }))
    if (!ok) {
      pendingFsLists.delete(requestId)
      throw httpError(503, 'runner not connected')
    }

    const payload = await resultP
    return {
      path: payload?.path ?? '',
      parent: payload?.parent ?? null,
      entries: Array.isArray(payload?.entries) ? payload.entries : []
    }
  }

  async function codexModelListOnRunner({ machineId, cwd = '', limit = 200, includeHidden = false }) {
    const requestId = crypto.randomUUID()
    const resultP = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingModelLists.delete(requestId)
        reject(httpError(504, 'timeout listing models'))
      }, 20_000)
      pendingModelLists.set(requestId, { resolve, reject, timer })
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'codex.model.list',
      scope: { machineId },
      payload: {
        requestId,
        cwd: String(cwd ?? ''),
        limit: Number(limit) || 200,
        includeHidden: Boolean(includeHidden)
      }
    }))
    if (!ok) {
      pendingModelLists.delete(requestId)
      throw httpError(503, 'runner not connected')
    }

    const payload = await resultP
    return {
      models: Array.isArray(payload?.models) ? payload.models : [],
      nextCursor: (payload?.nextCursor === null || payload?.nextCursor === undefined) ? null : String(payload.nextCursor)
    }
  }

  async function storeHostUpload({ sessionId, uploadId, filename, contentBase64 }) {
    const dir = join(getUploadsDir(), sessionId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${uploadId}-${filename}`)
    const buf = Buffer.from(String(contentBase64), 'base64')
    await writeFile(path, buf, { mode: 0o600 })
    return { path, sizeBytes: buf.length }
  }

  async function processAttachments({ machineId, sessionId, attachments }) {
    const list = Array.isArray(attachments) ? attachments : []
    if (!list.length) return []

    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

    /** @type {Array<{ uploadId: string, filename: string, mimeType: string, sizeBytes: number, hostPath: string, runnerPath: string }>} */
    const created = []

    const rollback = () => {
      for (const u of created) {
        deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId: u.uploadId })
        try { rmSync(u.hostPath, { force: true }) } catch { }
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
          runnerInfo = await uploadToRunner({ machineId, sessionId, uploadId, filename, mimeType, contentBase64 })
        } catch (err) {
          // Best-effort: delete both host + runner copies.
          try { rmSync(hostInfo.path, { force: true }) } catch { }
          deleteRunnerUploadBestEffort({ machineId, sessionId, uploadId })
          throw err
        }

        const runnerPath = runnerInfo?.path
        if (!runnerPath || typeof runnerPath !== 'string') {
          try { rmSync(hostInfo.path, { force: true }) } catch { }
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
          // best-effort persistence; still serve the upload from disk.
        }

        created.push({ uploadId, filename, mimeType, sizeBytes: hostInfo.sizeBytes, hostPath: hostInfo.path, runnerPath })
      }
    } catch (err) {
      rollback()
      throw err
    }

    const out = created.map((u) => ({
      uploadId: u.uploadId,
      filename: u.filename,
      mimeType: u.mimeType,
      sizeBytes: u.sizeBytes,
      url: `/api/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(u.uploadId)}`,
      runnerPath: u.runnerPath
    }))

    return out
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      const parts = url.pathname.split('/').filter(Boolean)
      if (logRequests) {
        console.log(`[rootgrid] ${req.method ?? 'GET'} ${url.pathname}`)
      }

      const persistSessionEvent = (envelope, { sessionId }) => {
        sse.send(envelope)
        try {
          store.appendEvent({
            eventId: envelope.id,
            sessionId,
            tsMs: envelope.ts,
            type: envelope.type,
            payload: envelope.payload
          })
        } catch {
        }
      }

      // REST API
      if (url.pathname === '/api/auth' && req.method === 'POST') {
        const body = await readJsonBody(req)
        auth.handleAuth(req, res, body)
        return
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const connectionId = crypto.randomUUID()
        const visibility = (url.searchParams.get('visibility') === 'hidden') ? 'hidden' : 'visible'
        const all = (url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true')
        const sessionId = url.searchParams.get('sessionId')
        const machineId = url.searchParams.get('machineId')
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('Connection', 'keep-alive')
        res.write('\n')

        // Send an initial snapshot so the UI can render immediately.
        const connectedMachineIds = new Set(runnerWs.listConnectedMachineIds())
        res.write(`data: ${JSON.stringify({
          v: 1,
          type: 'registry.snapshot',
          ts: Date.now(),
          id: crypto.randomUUID(),
          scope: null,
          payload: {
            connectionId,
            machines: store.listMachines().map((m) => ({ ...m, connected: connectedMachineIds.has(m.machineId) })),
            sessions: store.listSessions(),
            approvals: store.listApprovals().map((a) => a.payload)
          }
        })}\n\n`)

        sse.addClient({ id: connectionId, res, visibility, all, sessionId, machineId })
        return
      }

      if (url.pathname === '/api/visibility' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const body = await readJsonBody(req)
        const connectionId = body?.connectionId
        const visibility = body?.visibility
        const sessionId = body?.sessionId
        const machineId = body?.machineId
        if (!connectionId || typeof connectionId !== 'string') return json(res, 400, { error: 'connectionId is required' })
        if (visibility !== 'visible' && visibility !== 'hidden') return json(res, 400, { error: 'visibility must be visible|hidden' })

        if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
          return json(res, 400, { error: 'sessionId must be a string or null' })
        }
        if (machineId !== undefined && machineId !== null && typeof machineId !== 'string') {
          return json(res, 400, { error: 'machineId must be a string or null' })
        }

        const ok = sse.setVisibility(connectionId, visibility)
        if (!ok) return json(res, 404, { error: 'not found' })

        // Update event routing filters without forcing the browser to reconnect
        // the SSE stream (which is slow and causes UI flicker).
        if (sessionId !== undefined) sse.setSessionId(connectionId, sessionId)
        if (machineId !== undefined) sse.setMachineId(connectionId, machineId)

        return json(res, 200, { ok: true })
      }

      if (url.pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        if (!push) return json(res, 503, { error: 'push not available' })
        return json(res, 200, { publicKey: push.getPublicKey() })
      }

      if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const body = await readJsonBody(req)
        const sub = body?.subscription ?? body
        const endpoint = sub?.endpoint
        const keys = sub?.keys
        const p256dh = keys?.p256dh
        const authKey = keys?.auth
        if (!endpoint || typeof endpoint !== 'string') return json(res, 400, { error: 'endpoint is required' })
        if (!p256dh || typeof p256dh !== 'string') return json(res, 400, { error: 'keys.p256dh is required' })
        if (!authKey || typeof authKey !== 'string') return json(res, 400, { error: 'keys.auth is required' })
        try {
          store.upsertPushSubscription({ endpoint, p256dh, auth: authKey })
        } catch (err) {
          return json(res, 500, { error: String(err?.message ?? err) })
        }
        return json(res, 200, { ok: true })
      }

      if (url.pathname === '/api/push/subscribe' && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return
        const body = await readJsonBody(req)
        const endpoint = body?.endpoint ?? body?.subscription?.endpoint ?? url.searchParams.get('endpoint')
        if (!endpoint || typeof endpoint !== 'string') return json(res, 400, { error: 'endpoint is required' })
        try {
          store.deletePushSubscription(endpoint)
        } catch (err) {
          return json(res, 500, { error: String(err?.message ?? err) })
        }
        return json(res, 200, { ok: true })
      }

      if (url.pathname === '/api/machines' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const connectedMachineIds = new Set(runnerWs.listConnectedMachineIds())
        return json(res, 200, { machines: store.listMachines().map((m) => ({ ...m, connected: connectedMachineIds.has(m.machineId) })) })
      }

      if (parts[0] === 'api' && parts[1] === 'machines' && parts.length === 3 && parts[2] && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return
        const machineId = parts[2]
        const machine = store.getMachine(machineId)
        if (!machine) return json(res, 404, { error: 'not found' })

        // To make deletion predictable, require the runner to be disconnected;
        // otherwise machine.alive messages can re-create the UI state immediately.
        if (runnerWs.listConnectedMachineIds().includes(machineId)) {
          return json(res, 409, { error: 'machine is currently connected; disconnect the runner before deleting' })
        }

        let sessionIds = []
        let uploadPaths = []
        try { sessionIds = store.listSessionIdsByMachine(machineId) } catch {}
        try { uploadPaths = store.listUploadHostPathsByMachine(machineId) } catch {}

        // Remove any pending approval routing entries for this machine.
        for (const [approvalId, route] of approvals.entries()) {
          if (route?.machineId === machineId) approvals.delete(approvalId)
        }

        const ok = store.deleteMachine(machineId)
        if (!ok) return json(res, 404, { error: 'not found' })

        // Notify UI clients: session deletions + machine deletion.
        for (const sessionId of sessionIds) {
          sse.send(makeEnvelope({
            type: 'registry.session.delete',
            scope: { machineId, sessionId },
            payload: { sessionId }
          }))
        }
        sse.send(makeEnvelope({
          type: 'registry.machine.delete',
          scope: { machineId },
          payload: { machineId }
        }))

        // Best-effort file removal (ignore missing).
        for (const p of uploadPaths) {
          if (!p || typeof p !== 'string') continue
          try { rmSync(p, { force: true }) } catch { }
        }

        return json(res, 200, { ok: true, machineId, deletedSessions: sessionIds.length })
      }

      if (parts[0] === 'api' && parts[1] === 'machines' && parts[2] && parts[3] === 'disconnect' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const machineId = parts[2]
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) return json(res, 404, { error: 'runner not connected' })
        const ok = runnerWs.disconnectMachine(machineId)
        if (!ok) return json(res, 404, { error: 'runner not connected' })
        return json(res, 200, { ok: true })
      }

      if (url.pathname === '/api/fs/list' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const machineId = url.searchParams.get('machineId')
        if (!machineId || typeof machineId !== 'string') return json(res, 400, { error: 'machineId is required' })
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) return json(res, 503, { error: 'runner not connected' })
        const path = url.searchParams.get('path') ?? ''
        try {
          const out = await fsListOnRunner({ machineId, path })
          return json(res, 200, out)
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          return json(res, code, { error: String(err?.message ?? err) })
        }
      }

      if (url.pathname === '/api/models' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const preferredMachineId = url.searchParams.get('machineId')
        const machineId = pickMachineId((typeof preferredMachineId === 'string' && preferredMachineId.trim()) ? preferredMachineId.trim() : null)
        if (!machineId) return json(res, 503, { error: 'no runner connected' })

        const cwd = url.searchParams.get('cwd') ?? ''
        const limitRaw = url.searchParams.get('limit')
        const includeHiddenRaw = url.searchParams.get('includeHidden')
        const limit = (limitRaw === null || limitRaw === undefined) ? 200 : Number(limitRaw)
        const includeHidden = (includeHiddenRaw === '1' || includeHiddenRaw === 'true')

        try {
          const out = await codexModelListOnRunner({ machineId, cwd, limit, includeHidden })
          return json(res, 200, { machineId, ...out })
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          return json(res, code, { error: String(err?.message ?? err) })
        }
      }

      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const archivedRaw = url.searchParams.get('archived')
        const archived = (archivedRaw === '1' || archivedRaw === 'true')
          ? true
          : (archivedRaw === 'all' ? null : false)
        return json(res, 200, { sessions: store.listSessions({ archived }) })
      }

      // Create a new "empty" session (thread) without starting Codex yet.
      // This lets the UI show the thread in the sidebar immediately, before the
      // first user message is sent.
      if (url.pathname === '/api/sessions/draft' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        let body = null
        try {
          body = await readJsonBody(req)
        } catch (err) {
          return json(res, 400, { error: String(err?.message ?? err) })
        }

        const cwdRaw = body?.cwd
        const preferredMachineId = body?.machineId ?? null
        const options = body?.options ?? null

        if (!cwdRaw || typeof cwdRaw !== 'string' || !cwdRaw.trim()) return json(res, 400, { error: 'cwd is required' })

        const machineId = pickMachineId((typeof preferredMachineId === 'string' && preferredMachineId.trim())
          ? preferredMachineId.trim()
          : null)
        if (!machineId) return json(res, 503, { error: 'no runner connected' })

        const cwd = cwdRaw.trim()
        const sessionId = crypto.randomUUID()
        store.createSession({ sessionId, machineId, cwd, status: 'idle', options })

        const session = store.getSession(sessionId)
        if (session) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId, sessionId },
            payload: session
          }))
        }

        return json(res, 200, { sessionId, session })
      }

      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        let body = null
        try {
          // Attachments are base64-encoded in JSON (v0). Allow large bodies.
          body = await readJsonBody(req, { limitBytes: 250_000_000 })
        } catch (err) {
          const msg = String(err?.message ?? err)
          const code = msg.includes('body too large') ? 413 : 400
          return json(res, code, { error: msg })
        }
        const cwd = body?.cwd
        const prompt = body?.prompt
        const preferredMachineId = body?.machineId ?? null
        const options = body?.options ?? null
        const attachments = body?.attachments ?? null

        if (!cwd || typeof cwd !== 'string') return json(res, 400, { error: 'cwd is required' })
        if (prompt === undefined || prompt === null || typeof prompt !== 'string') return json(res, 400, { error: 'prompt is required' })
        const hasPromptText = Boolean(String(prompt).trim())
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0
        if (!hasPromptText && !hasAttachments) return json(res, 400, { error: 'prompt or attachments are required' })

        const machineId = pickMachineId(preferredMachineId)
        if (!machineId) return json(res, 503, { error: 'no runner connected' })

        const sessionId = crypto.randomUUID()
        store.createSession({ sessionId, machineId, cwd, status: 'starting', options })

        /** @type {any[]} */
        let uploaded = []
        try {
          uploaded = await processAttachments({ machineId, sessionId, attachments })
        } catch (err) {
          // Cleanup any host-side files that may have been written.
          try {
            for (const u of store.listSessionUploads(sessionId)) {
              const p = u?.hostPath
              if (p && typeof p === 'string') {
                try { rmSync(p, { force: true }) } catch { }
              }
            }
          } catch {
          }
          try { store.deleteSession(sessionId) } catch { }
          const code = Number(err?.statusCode) || 400
          return json(res, code, { error: String(err?.message ?? err) })
        }

        // Build the Codex input array (text + local images).
        const fileLines = []
        for (const u of uploaded) {
          if (!u?.runnerPath) continue
          const mt = u?.mimeType
          if (isImageMimeType(mt)) continue
          fileLines.push(`- ${u.filename}: ${u.runnerPath}`)
        }
        let effectivePrompt = fileLines.length
          ? `${prompt}\n\n[Uploaded files]\n${fileLines.join('\n')}`
          : prompt
        if (!String(effectivePrompt).trim()) effectivePrompt = '(see attachments)'

        const inputItems = [{ type: 'text', text: effectivePrompt }]
        for (const u of uploaded) {
          const mt = u?.mimeType
          if (!isImageMimeType(mt)) continue
          if (u?.runnerPath) inputItems.push({ type: 'localImage', path: u.runnerPath })
        }

        const input = makeEnvelope({
          type: 'session.input',
          scope: { machineId, sessionId },
          payload: {
            sessionId,
            text: prompt,
            isInitial: true,
            ...(uploaded.length ? {
              attachments: uploaded.map((u) => ({
                uploadId: u.uploadId,
                filename: u.filename,
                mimeType: u.mimeType,
                sizeBytes: u.sizeBytes,
                url: u.url
              }))
            } : {})
          }
        })
        persistSessionEvent(input, { sessionId })

        const starting = makeEnvelope({
          type: 'session.status',
          scope: { machineId, sessionId },
          payload: { sessionId, status: 'starting' }
        })
        persistSessionEvent(starting, { sessionId })

        const session = store.getSession(sessionId)
        if (session) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId, sessionId },
            payload: session
          }))
        }

        const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'session.start',
          scope: { machineId, sessionId },
          payload: { sessionId, cwd, prompt, input: inputItems, options }
        }))

        if (!ok) {
          store.updateSession({ sessionId, status: 'failed' })
          return json(res, 503, { error: 'runner not connected' })
        }

        return json(res, 200, { sessionId })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })
        const includeEvents = url.searchParams.get('events') === '1'
        return json(res, 200, {
          session,
          ...(includeEvents ? { events: store.listSessionEvents(sessionId, { limit: 500 }) } : {})
        })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'events' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        const mode = (url.searchParams.get('mode') === 'full') ? 'full' : 'summary'
        const beforeSeqRaw = url.searchParams.get('beforeSeq')
        const limitRaw = url.searchParams.get('limit')
        const beforeSeq = beforeSeqRaw ? Number.parseInt(String(beforeSeqRaw), 10) : null
        const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : 200

        const page = store.listSessionEventsPage(sessionId, {
          beforeSeq: (Number.isFinite(beforeSeq) && beforeSeq > 0) ? beforeSeq : null,
          limit: (Number.isFinite(limit) && limit > 0) ? limit : 200,
          mode
        })
        return json(res, 200, {
          events: page.events,
          hasMoreBefore: page.hasMoreBefore,
          nextBeforeSeq: page.oldestSeq
        })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'turns' && parts[4] && parts[5] === 'reasoning' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const turnId = parts[4]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        const maxCharsRaw = url.searchParams.get('maxChars')
        const maxChars = maxCharsRaw ? Number.parseInt(String(maxCharsRaw), 10) : 400_000

        const out = store.getTurnReasoningSections(sessionId, turnId, { maxChars })
        if (!out) return json(res, 404, { error: 'not found' })
        return json(res, 200, out)
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'items' && parts[4] && parts[5] === 'output' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const itemId = parts[4]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        const beforeSeqRaw = url.searchParams.get('beforeSeq')
        const limitRaw = url.searchParams.get('limit')
        const beforeSeq = beforeSeqRaw ? Number.parseInt(String(beforeSeqRaw), 10) : null
        const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : 500

        const page = store.listItemOutputEvents(sessionId, itemId, {
          beforeSeq: (Number.isFinite(beforeSeq) && beforeSeq > 0) ? beforeSeq : null,
          limit: (Number.isFinite(limit) && limit > 0) ? limit : 500
        })
        return json(res, 200, {
          events: page.events,
          hasMoreBefore: page.hasMoreBefore,
          nextBeforeSeq: page.oldestSeq
        })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'uploads' && parts[4] && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const uploadId = parts[4]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        let upload = null
        try {
          upload = store.getUpload({ sessionId, uploadId })
        } catch {
        }
        if (!upload) return json(res, 404, { error: 'not found' })

        res.statusCode = 200
        res.setHeader('Content-Type', upload.mimeType || 'application/octet-stream')
        const disp = isImageMimeType(upload.mimeType) ? 'inline' : 'attachment'
        res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(upload.filename)}"`)

        const stream = createReadStream(upload.hostPath)
        stream.on('error', () => {
          try { res.statusCode = 404 } catch { }
          try { res.end() } catch { }
        })
        stream.pipe(res)
        return
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'messages' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        let body = null
        try {
          // Attachments are base64-encoded in JSON (v0). Allow large bodies.
          body = await readJsonBody(req, { limitBytes: 250_000_000 })
        } catch (err) {
          const msg = String(err?.message ?? err)
          const code = msg.includes('body too large') ? 413 : 400
          return json(res, code, { error: msg })
        }
        const text = body?.text
        const attachments = body?.attachments ?? null
        if (text === undefined || text === null || typeof text !== 'string') return json(res, 400, { error: 'text is required' })
        const hasText = Boolean(String(text).trim())
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0
        if (!hasText && !hasAttachments) return json(res, 400, { error: 'text or attachments are required' })

        /** @type {any[]} */
        let uploaded = []
        try {
          uploaded = await processAttachments({ machineId: session.machineId, sessionId, attachments })
        } catch (err) {
          const code = Number(err?.statusCode) || 400
          return json(res, code, { error: String(err?.message ?? err) })
        }

        const fileLines = []
        for (const u of uploaded) {
          if (!u?.runnerPath) continue
          if (isImageMimeType(u?.mimeType)) continue
          fileLines.push(`- ${u.filename}: ${u.runnerPath}`)
        }
        let effectivePrompt = fileLines.length
          ? `${text}\n\n[Uploaded files]\n${fileLines.join('\n')}`
          : text
        if (!String(effectivePrompt).trim()) effectivePrompt = '(see attachments)'

        const inputItems = [{ type: 'text', text: effectivePrompt }]
        for (const u of uploaded) {
          if (!isImageMimeType(u?.mimeType)) continue
          if (u?.runnerPath) inputItems.push({ type: 'localImage', path: u.runnerPath })
        }

        const input = makeEnvelope({
          type: 'session.input',
          scope: { machineId: session.machineId, sessionId },
          payload: {
            sessionId,
            text,
            ...(uploaded.length ? {
              attachments: uploaded.map((u) => ({
                uploadId: u.uploadId,
                filename: u.filename,
                mimeType: u.mimeType,
                sizeBytes: u.sizeBytes,
                url: u.url
              }))
            } : {})
          }
        })
        persistSessionEvent(input, { sessionId })

        const options = {
          ...(session.model ? { model: session.model } : {}),
          ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
          ...(session.approvalPolicy ? { approvalPolicy: session.approvalPolicy } : {}),
          ...(session.sandbox ? { sandbox: session.sandbox } : {})
        }

        const ok = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.send',
          scope: { machineId: session.machineId, sessionId },
          payload: {
            sessionId,
            text,
            input: inputItems,
            cwd: session.cwd,
            codexThreadId: session.codexThreadId ?? null,
            ...(Object.keys(options).length ? { options } : {})
          }
        }))
        if (!ok) return json(res, 503, { error: 'runner not connected' })

        return json(res, 200, { ok: true })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'read' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        store.markSessionRead(sessionId)
        const updated = store.getSession(sessionId)
        if (updated) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId: updated.machineId, sessionId },
            payload: updated
          }))
        }
        return json(res, 200, { ok: true, session: updated })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] && req.method === 'PUT') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        const body = await readJsonBody(req)
        const projectLabelRaw = body?.projectLabel
        const titleRaw = body?.title
        if (projectLabelRaw !== null && projectLabelRaw !== undefined && typeof projectLabelRaw !== 'string') {
          return json(res, 400, { error: 'projectLabel must be a string or null' })
        }
        if (titleRaw !== null && titleRaw !== undefined && typeof titleRaw !== 'string') {
          return json(res, 400, { error: 'title must be a string or null' })
        }
        const projectLabel = (typeof projectLabelRaw === 'string') ? projectLabelRaw.trim() : null
        const title = (typeof titleRaw === 'string') ? titleRaw.trim() : null

        if (projectLabelRaw !== undefined) store.setSessionProjectLabel(sessionId, projectLabel || null)
        if (titleRaw !== undefined) store.setSessionTitle(sessionId, title || null)
        const updated = store.getSession(sessionId)
        if (updated) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId: updated.machineId, sessionId },
            payload: updated
          }))
        }
        return json(res, 200, { ok: true, session: updated })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && parts[2] && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        // Best-effort runner cleanup (stop session + remove runner-local uploads).
        runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.cleanup',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))

        // Cleanup host-stored uploads before deleting the DB rows.
        let uploadRows = []
        try { uploadRows = store.listSessionUploads(sessionId) } catch { }

        // Remove any pending approval routing entries for this session.
        for (const [approvalId, route] of approvals.entries()) {
          if (route?.sessionId === sessionId) approvals.delete(approvalId)
        }

        store.deleteSession(sessionId)

        // Notify UI.
        sse.send(makeEnvelope({
          type: 'registry.session.delete',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))

        // Best-effort file removal (ignore missing).
        for (const u of uploadRows) {
          const p = u?.hostPath
          if (!p || typeof p !== 'string') continue
          try { rmSync(p, { force: true }) } catch { }
        }

        return json(res, 200, { ok: true })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'options' && req.method === 'PUT') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        const body = await readJsonBody(req)
        const patch = body?.options ?? body

        const approvalPolicyRaw = patch?.approvalPolicy
        const sandboxRaw = patch?.sandbox
        const modelRaw = patch?.model
        const reasoningEffortRaw = patch?.reasoningEffort

        if (approvalPolicyRaw === undefined && sandboxRaw === undefined && modelRaw === undefined && reasoningEffortRaw === undefined) {
          return json(res, 400, { error: 'at least one option is required' })
        }

        const model = (modelRaw === null || modelRaw === undefined)
          ? modelRaw
          : (typeof modelRaw === 'string' ? modelRaw.trim() : '__invalid__')
        if (model === '__invalid__') return json(res, 400, { error: 'model must be a string or null' })

        const reasoningEffort = (reasoningEffortRaw === null || reasoningEffortRaw === undefined)
          ? reasoningEffortRaw
          : (typeof reasoningEffortRaw === 'string' ? reasoningEffortRaw.trim() : '__invalid__')
        if (reasoningEffort === '__invalid__') return json(res, 400, { error: 'reasoningEffort must be a string or null' })

        const approvalPolicy = (approvalPolicyRaw === null || approvalPolicyRaw === undefined)
          ? approvalPolicyRaw
          : (typeof approvalPolicyRaw === 'string' ? approvalPolicyRaw.trim() : '__invalid__')
        if (approvalPolicy === '__invalid__') return json(res, 400, { error: 'approvalPolicy must be a string or null' })

        const sandbox = (sandboxRaw === null || sandboxRaw === undefined)
          ? sandboxRaw
          : (typeof sandboxRaw === 'string' ? sandboxRaw.trim() : '__invalid__')
        if (sandbox === '__invalid__') return json(res, 400, { error: 'sandbox must be a string or null' })

        store.updateSession({
          sessionId,
          ...(modelRaw !== undefined ? { model: model || null } : {}),
          ...(reasoningEffortRaw !== undefined ? { reasoningEffort: reasoningEffort || null } : {}),
          ...(approvalPolicyRaw !== undefined ? { approvalPolicy: approvalPolicy || null } : {}),
          ...(sandboxRaw !== undefined ? { sandbox: sandbox || null } : {})
        })

        const updated = store.getSession(sessionId)
        if (updated) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId: updated.machineId, sessionId },
            payload: updated
          }))
        }

        const runnerOk = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.options.update',
          scope: { machineId: session.machineId, sessionId },
          payload: {
            sessionId,
            options: {
              ...(modelRaw !== undefined ? { model: model || null } : {}),
              ...(reasoningEffortRaw !== undefined ? { reasoningEffort: reasoningEffort || null } : {}),
              ...(approvalPolicyRaw !== undefined ? { approvalPolicy: approvalPolicy || null } : {}),
              ...(sandboxRaw !== undefined ? { sandbox: sandbox || null } : {})
            }
          }
        }))

        return json(res, 200, { ok: true, runnerOk, session: updated })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'archive' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        store.archiveSession(sessionId)
        const updated = store.getSession(sessionId)
        if (updated) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId: updated.machineId, sessionId },
            payload: updated
          }))
        }
        return json(res, 200, { ok: true, session: updated })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'unarchive' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })

        store.unarchiveSession(sessionId)
        const updated = store.getSession(sessionId)
        if (updated) {
          sse.send(makeEnvelope({
            type: 'registry.session.upsert',
            scope: { machineId: updated.machineId, sessionId },
            payload: updated
          }))
        }
        return json(res, 200, { ok: true, session: updated })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'cancel' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })
        const ok = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.cancel',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))
        if (!ok) return json(res, 503, { error: 'runner not connected' })
        return json(res, 200, { ok: true })
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'stop' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const sessionId = parts[2]
        const session = store.getSession(sessionId)
        if (!session) return json(res, 404, { error: 'not found' })
        const ok = runnerWs.sendToMachine(session.machineId, makeEnvelope({
          type: 'session.stop',
          scope: { machineId: session.machineId, sessionId },
          payload: { sessionId }
        }))
        if (!ok) return json(res, 503, { error: 'runner not connected' })
        return json(res, 200, { ok: true })
      }

      // VS Code web viewer (code-server)
      if (url.pathname === '/api/ide-sessions' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const body = await readJsonBody(req)
        const cwd = body?.cwd
        const preferredMachineId = body?.machineId ?? null
        if (!cwd || typeof cwd !== 'string') return json(res, 400, { error: 'cwd is required' })

        const machineId = pickMachineId(preferredMachineId)
        if (!machineId) return json(res, 503, { error: 'no runner connected' })

        const ideId = crypto.randomUUID()

        const startedP = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingIdeStarts.delete(ideId)
            reject(new Error('timeout starting ide session'))
          }, 15_000)
          pendingIdeStarts.set(ideId, { resolve, reject, timer })
        })

        const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'ide.start',
          scope: { machineId },
          payload: { ideId, cwd }
        }))
        if (!ok) {
          pendingIdeStarts.delete(ideId)
          return json(res, 503, { error: 'runner not connected' })
        }

        try {
          await startedP
        } catch (err) {
          return json(res, 503, { error: String(err?.message ?? err) })
        }

        return json(res, 200, { ideId, urlPath: `/vscode/${ideId}/` })
      }

      if (parts[0] === 'api' && parts[1] === 'ide-sessions' && parts[2] && parts[3] === 'stop' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const ideId = parts[2]
        const ide = ideSessions.get(ideId)
        if (!ide) return json(res, 404, { error: 'not found' })

        const ok = runnerWs.sendToMachine(ide.machineId, makeEnvelope({
          type: 'ide.stop',
          scope: { machineId: ide.machineId },
          payload: { ideId }
        }))
        if (!ok) return json(res, 503, { error: 'runner not connected' })

        ideSessions.delete(ideId)
        try { store.deleteIdeSession(ideId) } catch { }
        return json(res, 200, { ok: true })
      }

      if (parts[0] === 'api' && parts[1] === 'approvals' && parts[2] && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return
        const approvalId = parts[2]
        let route = approvals.get(approvalId) ?? null
        let row = null
        try {
          row = store.getApproval(approvalId)
        } catch {
        }
        if (!route && row) route = { machineId: row.machineId, sessionId: row.sessionId }
        if (!route) return json(res, 404, { error: 'not found' })

        const body = await readJsonBody(req)
        const kind = row?.kind ?? null

        /** @type {any} */
        const respondPayload = { approvalId }
        /** @type {any} */
        const resolvedPayload = { approvalId }

        // EXPERIMENTAL: tool/user-input prompts.
        if (kind === 'userInput') {
          const decision = body?.decision ?? (body?.answers ? 'accept' : null)
          if (decision !== 'accept' && decision !== 'cancel') return json(res, 400, { error: 'decision must be accept|cancel' })
          respondPayload.decision = decision

          if (decision === 'accept') {
            const answers = body?.answers
            if (!answers || typeof answers !== 'object') return json(res, 400, { error: 'answers is required' })
            respondPayload.answers = answers
          }

          resolvedPayload.decision = decision
          // IMPORTANT: do NOT persist user input answers into the session event stream;
          // requests can mark questions as `isSecret`.
        } else {
          const decision = body?.decision
          const reason = body?.reason ?? null
          if (decision === undefined || decision === null) return json(res, 400, { error: 'decision is required' })
          if (typeof decision !== 'string' && typeof decision !== 'object') return json(res, 400, { error: 'decision must be a string (or object)' })
          respondPayload.decision = decision
          if (reason) respondPayload.reason = reason

          resolvedPayload.decision = decision
          if (reason) resolvedPayload.reason = reason
        }

        const ok = runnerWs.sendToMachine(route.machineId, makeEnvelope({
          type: 'approval.respond',
          scope: { machineId: route.machineId, sessionId: route.sessionId },
          payload: respondPayload
        }))
        if (!ok) return json(res, 503, { error: 'runner not connected' })

        const resolved = makeEnvelope({
          type: 'approval.resolved',
          scope: { machineId: route.machineId, sessionId: route.sessionId },
          payload: resolvedPayload
        })
        persistSessionEvent(resolved, { sessionId: route.sessionId })

        approvals.delete(approvalId)
        try { store.deleteApproval(approvalId) } catch { }
        return json(res, 200, { ok: true })
      }

      if (url.pathname === '/api/settings' && req.method === 'PUT') {
        if (!auth.requireAuth(req, res)) return

        const body = await readJsonBody(req)
        const retentionDaysRaw = body?.retentionDays
        const sseToastsRaw = body?.notifications?.sseToasts ?? body?.sseToasts
        const webPushRaw = body?.notifications?.webPush ?? body?.webPush

        if (retentionDaysRaw === undefined && sseToastsRaw === undefined && webPushRaw === undefined) {
          return json(res, 400, { error: 'at least one setting is required' })
        }

        let retentionDays = null
        if (retentionDaysRaw !== undefined) {
          retentionDays = Number.parseInt(String(retentionDaysRaw), 10)
          if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
            return json(res, 400, { error: 'retentionDays must be an integer between 1 and 3650' })
          }
        }

        let sseToasts = null
        if (sseToastsRaw !== undefined) {
          if (sseToastsRaw !== 'always' && sseToastsRaw !== 'never' && sseToastsRaw !== 'if-not-visible') {
            return json(res, 400, { error: 'notifications.sseToasts must be always|never|if-not-visible' })
          }
          sseToasts = sseToastsRaw
        }

        let webPush = null
        if (webPushRaw !== undefined) {
          if (webPushRaw !== 'always' && webPushRaw !== 'never' && webPushRaw !== 'if-not-visible') {
            return json(res, 400, { error: 'notifications.webPush must be always|never|if-not-visible' })
          }
          webPush = webPushRaw
        }

        const configPath = getConfigPath()
        const nextConfig = structuredClone(config)
        if (retentionDays !== null) nextConfig.retentionDays = retentionDays
        if (sseToasts !== null || webPush !== null) {
          nextConfig.notifications = nextConfig.notifications ?? {}
          if (sseToasts !== null) nextConfig.notifications.sseToasts = sseToasts
          if (webPush !== null) nextConfig.notifications.webPush = webPush
        }

        let validated
        try {
          validated = RootgridConfigSchema.parse(nextConfig)
        } catch (err) {
          return json(res, 400, { error: String(err?.message ?? err) })
        }

        // Atomic-ish write: write temp file then rename.
        const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`
        const raw = JSON.stringify(validated, null, 2) + '\n'
        await writeFile(tmpPath, raw, { encoding: 'utf-8', mode: 0o600 })
        await rename(tmpPath, configPath)
        try { await chmod(configPath, 0o600) } catch { }

        // Apply in-memory (affects retention pruning schedule).
        config.retentionDays = validated.retentionDays
        config.notifications = validated.notifications

        return json(res, 200, {
          ok: true,
          retentionDays: config.retentionDays,
          notifications: config.notifications,
          host: {
            enabled: config.host.enabled,
            listen: config.host.listen,
            publicUrl: config.host.publicUrl,
            trustProxy: config.host.trustProxy
          },
          runner: {
            enabled: config.runner.enabled,
            machineId: config.runner.machineId,
            machineName: config.runner.machineName
          }
        })
      }

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        return json(res, 200, {
          retentionDays: config.retentionDays,
          notifications: {
            sseToasts: config.notifications?.sseToasts ?? 'if-not-visible',
            webPush: config.notifications?.webPush ?? 'if-not-visible'
          },
          host: {
            enabled: config.host.enabled,
            listen: config.host.listen,
            publicUrl: config.host.publicUrl,
            trustProxy: config.host.trustProxy
          },
          runner: {
            enabled: config.runner.enabled,
            machineId: config.runner.machineId,
            machineName: config.runner.machineName
          }
        })
      }

      if (url.pathname.startsWith('/api/')) {
        return json(res, 404, { error: 'not found' })
      }

      // VS Code web viewer reverse proxy (HTTP; WS upgrades handled in server.on('upgrade'))
      if (parts[0] === 'vscode' && parts[1]) {
        if (!auth.requireAuth(req, res)) return
        const ideId = parts[1]
        const ide = ideSessions.get(ideId) ?? null
        if (!ide) {
          res.statusCode = 404
          res.end('Not found')
          return
        }

        if (!tunnelHub.isConnected(ide.machineId)) {
          res.statusCode = 503
          res.end('Runner tunnel not connected')
          return
        }

        let stream
        try {
          stream = tunnelHub.openStream({
            machineId: ide.machineId,
            mode: 'http',
            host: '127.0.0.1',
            port: ide.port,
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            headers: req.headers ?? {}
          })
        } catch (err) {
          res.statusCode = 502
          res.end(String(err?.message ?? err))
          return
        }

        const hopByHop = new Set([
          'connection',
          'keep-alive',
          'proxy-authenticate',
          'proxy-authorization',
          'te',
          'trailer',
          'transfer-encoding',
          'upgrade'
        ])

        let headersSent = false

        stream.once('response', (info) => {
          if (headersSent) return
          headersSent = true

          const outHeaders = {}
          for (const [k, v] of Object.entries(info?.headers ?? {})) {
            const key = String(k).toLowerCase()
            if (hopByHop.has(key)) continue
            if (v === undefined) continue
            outHeaders[k] = v
          }

          res.writeHead(Number(info?.statusCode ?? 200), outHeaders)
          stream.pipe(res)
        })

        const onError = (err) => {
          try { stream.destroy() } catch { }
          if (!headersSent && !res.headersSent) {
            res.statusCode = 502
            res.end(String(err?.message ?? err))
          }
        }

        stream.once('end', () => {
          if (!headersSent && !res.headersSent) {
            res.statusCode = 502
            res.end('tunnel closed before response headers')
          }
        })

        stream.on('error', onError)
        req.on('aborted', () => {
          try { stream.destroy(new Error('client aborted')) } catch { }
        })
        res.on('close', () => {
          if (res.writableEnded) return
          try { stream.destroy(new Error('client closed')) } catch { }
        })

        // Pipe request body → tunnel stream.
        req.pipe(stream)
        return
      }

      // Web UI (static)
      if (serveWeb(req, res)) return
      res.statusCode = 404
      res.end('Not found')
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(String(err?.stack ?? err))
    }
  })

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      if (url.pathname === '/v1/runner/ws') {
        runnerWss.handleUpgrade(req, socket, head, (ws) => {
          runnerWss.emit('connection', ws, req)
        })
        return
      }

      if (url.pathname === '/v1/tunnel') {
        tunnelWss.handleUpgrade(req, socket, head, (ws) => {
          tunnelWss.emit('connection', ws, req)
        })
        return
      }

      // VS Code web viewer WS upgrades.
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] === 'vscode' && parts[1]) {
        if (!auth.checkAuth(req)) {
          try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n') } catch { }
          socket.destroy()
          return
        }

        const ideId = parts[1]
        const ide = ideSessions.get(ideId) ?? null
        if (!ide) {
          try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n') } catch { }
          socket.destroy()
          return
        }

        if (!tunnelHub.isConnected(ide.machineId)) {
          try { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n') } catch { }
          socket.destroy()
          return
        }

        let stream
        try {
          stream = tunnelHub.openStream({
            machineId: ide.machineId,
            mode: 'tcp',
            host: '127.0.0.1',
            port: ide.port
          })
        } catch (err) {
          try { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { }
          socket.destroy()
          return
        }

        stream.on('error', () => {
          try { socket.destroy() } catch { }
        })
        socket.on('error', () => {
          try { stream.destroy() } catch { }
        })
        socket.on('close', () => {
          try { stream.destroy() } catch { }
        })
        stream.on('close', () => {
          try { socket.destroy() } catch { }
        })

        // Reconstruct the original HTTP upgrade request and send it over the TCP stream.
        let headerLines = ''
        for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
          const k = req.rawHeaders[i]
          const v = req.rawHeaders[i + 1]
          if (!k) continue
          if (String(k).toLowerCase() === 'host') continue
          headerLines += `${k}: ${v}\r\n`
        }
        headerLines += `Host: 127.0.0.1:${ide.port}\r\n`
        const requestLine = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`
        stream.write(Buffer.from(requestLine + headerLines + '\r\n', 'utf8'))
        if (head && head.length) stream.write(head)

        // Bi-directional piping: browser socket <-> tunnel stream <-> runner TCP socket.
        socket.pipe(stream).pipe(socket)
        return
      }
    } catch {
    }

    socket.destroy()
  })

  await new Promise((resolve, reject) => {
    server.listen(config.host.listen.port, config.host.listen.host, () => resolve())
    server.on('error', reject)
  })

  console.log(`[rootgrid] host listening on http://${config.host.listen.host}:${config.host.listen.port}`)

  // Retention pruning (Rootgrid-owned data only).
  const runRetention = () => {
    try {
      const cutoffMs = Date.now() - (config.retentionDays * 24 * 60 * 60 * 1000)
      const res = store.pruneOldData({ cutoffMs })
      const s = Number(res?.sessionsDeleted ?? 0)
      const m = Number(res?.machinesDeleted ?? 0)
      const uploadHostPaths = Array.isArray(res?.uploadHostPaths) ? res.uploadHostPaths : []
      const prunedSessions = Array.isArray(res?.prunedSessions) ? res.prunedSessions : []

      // Best-effort runner-side cleanup for pruned sessions (stop + remove runner-local uploads).
      for (const row of prunedSessions) {
        const machineId = row?.machineId
        const sessionId = row?.sessionId
        if (!machineId || typeof machineId !== 'string') continue
        if (!sessionId || typeof sessionId !== 'string') continue
        runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'session.cleanup',
          scope: { machineId, sessionId },
          payload: { sessionId }
        }))
      }

      for (const p of uploadHostPaths) {
        if (!p || typeof p !== 'string') continue
        // Best-effort (files may already be missing).
        try { rmSync(p, { force: true }) } catch { }
      }
      if (s > 0 || m > 0) {
        console.log(`[rootgrid] retention pruned: sessions=${s} machines=${m}`)
      }
    } catch (err) {
      console.warn('[rootgrid] retention prune failed:', String(err?.message ?? err))
    }
  }

  runRetention()
  const retentionTimer = setInterval(runRetention, 6 * 60 * 60 * 1000)
  retentionTimer.unref?.()
}
