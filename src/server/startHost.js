import crypto from 'node:crypto'
import http from 'node:http'
import { rm } from 'node:fs/promises'

import { stripIdeBasePath } from '../lib/idePaths.js'
import { pruneStaleManagedReleaseArtifacts } from '../lib/managedRelease.js'
import { getDbPath, getSecretKeyPath } from '../lib/paths.js'
import { applyRuntimeSettingsToConfig, readRuntimeSettingsFromConfig } from '../lib/runtimeSettings.js'
import { getOrCreateVapidKeys } from '../lib/vapidKeys.js'
import { Store } from '../db/store.js'
import { AuthService } from './auth.js'
import { makeEnvelope } from './envelope.js'
import { createHostApprovalApi } from './hostApprovalApi.js'
import { createHostMachineApi } from './hostMachineApi.js'
import { createHostRunnerEventHandlers } from './hostRunnerEvents.js'
import { createHostSelfUpdateManager } from './hostSelfUpdateManager.js'
import { createHostSystemApi } from './hostSystemApi.js'
import { readJsonBody, json } from './httpUtil.js'
import { createModelCatalogCache } from './modelCatalogCache.js'
import { createPendingRequestBook } from './pendingRequestBook.js'
import { PushService } from './pushService.js'
import { createReleaseBundleManager } from './releaseBundleManager.js'
import { recoverAfterRunnerRestart } from './recovery.js'
import { buildExternalBaseUrl, createRunnerInstallManager } from './runnerInstallManager.js'
import { createSessionApi } from './sessionApi.js'
import { buildAttachmentPayload, buildCodexInputItems } from './sessionApiHelpers.js'
import { SSEManager } from './sseManager.js'
import { serveWeb } from './static.js'
import { createUploadService } from './uploads.js'
import { createRunnerWsServer } from './wsRunner.js'
import { createTunnelWsServer } from './wsTunnel.js'
import { TunnelHub } from './tunnelHub.js'

export async function startHost({ config }) {
  const store = new Store({ dbPath: getDbPath() })
  const persistedAppSettings = store.getAppSettings()
  if (persistedAppSettings) {
    applyRuntimeSettingsToConfig(config, persistedAppSettings)
  } else {
    const seededAppSettings = readRuntimeSettingsFromConfig(config)
    store.upsertAppSettings(seededAppSettings)
    applyRuntimeSettingsToConfig(config, seededAppSettings)
  }
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
  const terminalSessions = new Map() // terminalId -> { terminalId, machineId, cwd, shell, cols, rows, connected, outputText, outputVersion, createdAtMs, updatedAtMs }
  const pendingIdeStarts = createPendingRequestBook()
  const pendingMachineTools = createPendingRequestBook()
  const pendingMachineToolUpgrades = createPendingRequestBook()
  const pendingMachineToolAuth = createPendingRequestBook()
  const pendingMachineUpgrades = createPendingRequestBook()
  const pendingMachineUpgradeTransfers = createPendingRequestBook()
  const pendingFsLists = createPendingRequestBook()
  const pendingFsReads = createPendingRequestBook()
  const pendingGitStatuses = createPendingRequestBook()
  const pendingTerminalStarts = createPendingRequestBook()
  const pendingTerminalExecs = createPendingRequestBook()
  const pendingModelLists = createPendingRequestBook()
  const pendingRunnerCommands = createPendingRequestBook()
  const releaseBundles = createReleaseBundleManager({
    keepBundles: config?.runner?.upgrade?.keepReleases
      ?? config?.host?.selfUpdate?.keepReleases
      ?? 3
  })
  const runnerInstall = createRunnerInstallManager({
    config,
    releaseBundles
  })
  const hostSelfUpdate = createHostSelfUpdateManager({
    config,
    store
  })

  const tunnelHub = new TunnelHub()

  const logRequests = process.env.ROOTGRID_LOG_REQUESTS === '1'
  const exposeErrors = process.env.ROOTGRID_EXPOSE_ERRORS === '1'

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

  /** @type {ReturnType<typeof createUploadService>|null} */
  let uploadService = null
  const runnerEventHandlers = createHostRunnerEventHandlers({
    config,
    store,
    sse,
    push,
    approvals,
    ideSessions,
    makeEnvelope,
    getUploadService: () => uploadService,
    pendingRunnerCommands,
    pendingMachineTools,
    pendingMachineToolUpgrades,
    pendingMachineToolAuth,
    pendingMachineUpgrades,
    pendingMachineUpgradeTransfers,
    pendingFsLists,
    pendingFsReads,
    pendingGitStatuses,
    pendingTerminalStarts,
    pendingTerminalExecs,
    pendingModelLists,
    pendingIdeStarts,
    terminalSessions,
    httpError,
    onSessionTurnCompleted: ({ sessionId, payload }) => {
      if (String(payload?.status ?? 'completed') !== 'completed') return
      queueMicrotask(() => {
        sendQueuedPromptNowBackend({ sessionId, skipIfBusy: true }).catch(() => {})
      })
    }
  })
  const runnerWs = createRunnerWsServer({
    config,
    store,
    sse,
    ...runnerEventHandlers
  })
  uploadService = createUploadService({ runnerWs, store, makeEnvelope, httpError })
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

  function httpError(statusCode, message) {
    const err = new Error(message)
    // @ts-ignore - ad-hoc error metadata
    err.statusCode = statusCode
    return err
  }

  const persistSessionEvent = (envelope, { sessionId }) => {
    try {
      const seq = store.appendEvent({
        eventId: envelope.id,
        sessionId,
        tsMs: envelope.ts,
        type: envelope.type,
        payload: envelope.payload
      })
      if (Number.isFinite(Number(seq))) envelope.eventSeq = Number(seq)
      sse.send(envelope)
    } catch {
    }
  }

  const queuedPromptSendLocks = new Set()

  function listQueuedPromptPayloads(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return []
    let rows = []
    try { rows = store.listQueuedPrompts(sid) } catch { }
    const formatUploadDescriptor = uploadService?.formatUploadDescriptor
    return rows.map((row) => {
      const attachments = []
      for (const uploadId of (Array.isArray(row?.attachmentIds) ? row.attachmentIds : [])) {
        try {
          const upload = store.getUpload({ sessionId: sid, uploadId })
          if (!upload) continue
          if (typeof formatUploadDescriptor === 'function') attachments.push(formatUploadDescriptor(sid, upload))
        } catch {
        }
      }
      return {
        id: row.promptId,
        promptId: row.promptId,
        text: String(row?.text ?? ''),
        attachments,
        createdAtMs: Number(row?.createdMs ?? Date.now()) || Date.now(),
        updatedAtMs: Number(row?.updatedMs ?? Date.now()) || Date.now()
      }
    })
  }

  function sendQueuedPromptsUpdated(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return []
    const session = store.getSession(sid)
    const queuedPrompts = listQueuedPromptPayloads(sid)
    if (!session) return queuedPrompts
    sse.send(makeEnvelope({
      type: 'session.queuedPrompts.updated',
      scope: { machineId: session.machineId, sessionId: sid },
      payload: { sessionId: sid, queuedPrompts }
    }), { recordHistory: false })
    return queuedPrompts
  }

  function sendQueuedPromptRestoreRequested(sessionId, prompt, error = '') {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return false
    const session = store.getSession(sid)
    if (!session) return false
    sse.send(makeEnvelope({
      type: 'session.queuedPrompt.restoreRequested',
      scope: { machineId: session.machineId, sessionId: sid },
      payload: {
        sessionId: sid,
        prompt: (prompt && typeof prompt === 'object') ? prompt : null,
        error: String(error ?? '').trim()
      }
    }), { recordHistory: false })
    return true
  }

  async function sendRunnerCommandAndAwait({
    machineId,
    sessionId = null,
    type,
    payload,
    timeoutMs = 10_000
  }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingRunnerCommands.create(requestId, {
      machineId,
      timeoutMs,
      onTimeout: () => httpError(504, `timeout waiting for runner to accept ${type}`)
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type,
      scope: sessionId ? { machineId, sessionId } : { machineId },
      payload: { ...(payload ?? {}), requestId }
    }))
    if (!ok) {
      pendingRunnerCommands.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }

    return await resultP
  }

  async function sendQueuedPromptNowBackend({ sessionId, promptId = null, skipIfBusy = false } = {}) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) throw httpError(400, 'sessionId is required')
    if (queuedPromptSendLocks.has(sid)) {
      if (skipIfBusy) return { ok: false, skipped: true, queuedPrompts: listQueuedPromptPayloads(sid) }
      throw httpError(409, 'queued prompt already sending')
    }

    const session = store.getSession(sid)
    if (!session) throw httpError(404, 'not found')

    const pid = String(promptId ?? '').trim()
    const row = pid
      ? store.getQueuedPrompt({ sessionId: sid, promptId: pid })
      : (store.listQueuedPrompts(sid)?.[0] ?? null)
    if (!row) throw httpError(404, 'queued prompt not found')
    const failedPrompt = listQueuedPromptPayloads(sid)
      .find((prompt) => String(prompt?.promptId ?? prompt?.id ?? '').trim() === String(row?.promptId ?? '').trim()) ?? null

    const text = String(row?.text ?? '')
    const attachments = (Array.isArray(row?.attachmentIds) ? row.attachmentIds : [])
      .map((uploadId) => ({ uploadId: String(uploadId ?? '').trim() }))
      .filter((attachment) => attachment.uploadId)

    if (!String(text).trim() && !attachments.length) {
      try { store.deleteQueuedPrompt({ sessionId: sid, promptId: row.promptId }) } catch { }
      return {
        ok: true,
        sent: false,
        queuedPrompts: sendQueuedPromptsUpdated(sid)
      }
    }

    queuedPromptSendLocks.add(sid)
    try {
      const uploaded = await uploadService.resolveAttachmentInputs({
        machineId: session.machineId,
        sessionId: sid,
        attachments
      })
      const inputItems = buildCodexInputItems({
        text,
        uploads: uploaded,
        isImageMimeType: uploadService.isImageMimeType
      })
      const attachmentPayload = buildAttachmentPayload(uploaded)
      const input = makeEnvelope({
        type: 'session.input',
        scope: { machineId: session.machineId, sessionId: sid },
        payload: {
          sessionId: sid,
          text,
          ...(attachmentPayload ? { attachments: attachmentPayload } : {})
        }
      })
      const options = {
        ...(session.model ? { model: session.model } : {}),
        ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
        ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
        ...(session.approvalPolicy ? { approvalPolicy: session.approvalPolicy } : {}),
        ...(session.sandbox ? { sandbox: session.sandbox } : {})
      }

      try {
        await sendRunnerCommandAndAwait({
          machineId: session.machineId,
          sessionId: sid,
          type: 'session.send',
          payload: {
            sessionId: sid,
            text,
            input: inputItems,
            cwd: session.cwd,
            codexThreadId: session.codexThreadId ?? null,
            ...(Object.keys(options).length ? { options } : {})
          },
          timeoutMs: 10_000
        })
      } catch (err) {
        try { store.deleteQueuedPrompt({ sessionId: sid, promptId: row.promptId }) } catch { }
        sendQueuedPromptsUpdated(sid)
        sendQueuedPromptRestoreRequested(sid, failedPrompt, String(err?.message ?? err))
        throw err
      }

      persistSessionEvent(input, { sessionId: sid })
      try { store.deleteQueuedPrompt({ sessionId: sid, promptId: row.promptId }) } catch { }
      return {
        ok: true,
        sent: true,
        promptId: row.promptId,
        queuedPrompts: sendQueuedPromptsUpdated(sid)
      }
    } finally {
      queuedPromptSendLocks.delete(sid)
    }
  }

  async function fsListOnRunner({ machineId, path, includeFiles = false }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingFsLists.create(requestId, {
      machineId,
      timeoutMs: 10_000,
      onTimeout: () => httpError(504, 'timeout listing directory')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'fs.list',
      scope: { machineId },
      payload: { requestId, path: String(path ?? ''), includeFiles: Boolean(includeFiles) }
    }))
    if (!ok) {
      pendingFsLists.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }

    const payload = await resultP
    return {
      path: payload?.path ?? '',
      parent: payload?.parent ?? null,
      entries: Array.isArray(payload?.entries) ? payload.entries : []
    }
  }

  async function fsReadOnRunner({ machineId, path, maxBytes = 200_000 }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingFsReads.create(requestId, {
      machineId,
      timeoutMs: 10_000,
      onTimeout: () => httpError(504, 'timeout reading file')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'fs.read',
      scope: { machineId },
      payload: { requestId, path: String(path ?? ''), maxBytes: Number(maxBytes) || 200_000 }
    }))
    if (!ok) {
      pendingFsReads.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }
    return await resultP
  }

  async function gitStatusOnRunner({ machineId, cwd, timeoutMs = 10_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.status',
      payload: { cwd: String(cwd ?? ''), timeoutMs: Number(timeoutMs) || 10_000 },
      timeoutMs: Math.max(5_000, Number(timeoutMs) || 10_000),
      timeoutMessage: 'timeout reading git status'
    })
  }

  async function gitRequestOnRunner({ machineId, type, payload, timeoutMs = 10_000, timeoutMessage = 'timeout running git command' }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingGitStatuses.create(requestId, {
      machineId,
      timeoutMs: Math.max(5_000, Number(timeoutMs) || 10_000),
      onTimeout: () => httpError(504, timeoutMessage)
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type,
      scope: { machineId },
      payload: { requestId, ...(payload ?? {}) }
    }))
    if (!ok) {
      pendingGitStatuses.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }
    return await resultP
  }

  async function gitStageOnRunner({ machineId, cwd, paths, timeoutMs = 10_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.stage',
      payload: {
        cwd: String(cwd ?? ''),
        paths: Array.isArray(paths) ? paths : [],
        timeoutMs: Number(timeoutMs) || 10_000
      },
      timeoutMs,
      timeoutMessage: 'timeout staging files'
    })
  }

  async function gitUnstageOnRunner({ machineId, cwd, paths, timeoutMs = 10_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.unstage',
      payload: {
        cwd: String(cwd ?? ''),
        paths: Array.isArray(paths) ? paths : [],
        timeoutMs: Number(timeoutMs) || 10_000
      },
      timeoutMs,
      timeoutMessage: 'timeout unstaging files'
    })
  }

  async function gitCommitOnRunner({ machineId, cwd, message, timeoutMs = 20_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.commit',
      payload: {
        cwd: String(cwd ?? ''),
        message: String(message ?? ''),
        timeoutMs: Number(timeoutMs) || 20_000
      },
      timeoutMs,
      timeoutMessage: 'timeout creating commit'
    })
  }

  async function gitPushOnRunner({ machineId, cwd, remote = '', branch = '', setUpstream = false, timeoutMs = 60_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.push',
      payload: {
        cwd: String(cwd ?? ''),
        remote: String(remote ?? ''),
        branch: String(branch ?? ''),
        setUpstream: Boolean(setUpstream),
        timeoutMs: Number(timeoutMs) || 60_000
      },
      timeoutMs,
      timeoutMessage: 'timeout pushing branch'
    })
  }

  async function gitSwitchBranchOnRunner({ machineId, cwd, branch, timeoutMs = 10_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.branch.switch',
      payload: {
        cwd: String(cwd ?? ''),
        branch: String(branch ?? ''),
        timeoutMs: Number(timeoutMs) || 10_000
      },
      timeoutMs,
      timeoutMessage: 'timeout switching branches'
    })
  }

  async function gitCreateBranchOnRunner({ machineId, cwd, branch, timeoutMs = 10_000 }) {
    return await gitRequestOnRunner({
      machineId,
      type: 'git.branch.create',
      payload: {
        cwd: String(cwd ?? ''),
        branch: String(branch ?? ''),
        timeoutMs: Number(timeoutMs) || 10_000
      },
      timeoutMs,
      timeoutMessage: 'timeout creating branch'
    })
  }

  async function terminalExecOnRunner({ machineId, cwd, command, timeoutMs = 60_000 }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingTerminalExecs.create(requestId, {
      machineId,
      timeoutMs: Math.max(10_000, Number(timeoutMs) || 60_000) + 1_000,
      onTimeout: () => httpError(504, 'timeout waiting for command output')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'terminal.exec',
      scope: { machineId },
      payload: {
        requestId,
        cwd: String(cwd ?? ''),
        command: String(command ?? ''),
        timeoutMs: Number(timeoutMs) || 60_000
      }
    }))
    if (!ok) {
      pendingTerminalExecs.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }
    return await resultP
  }

  async function terminalPtyStartOnRunner({ machineId, cwd, cols = 80, rows = 24 }) {
    const requestId = crypto.randomUUID()
    const terminalId = crypto.randomUUID()
    const resultP = pendingTerminalStarts.create(requestId, {
      machineId,
      timeoutMs: 10_000,
      onTimeout: () => httpError(504, 'timeout starting terminal')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'terminal.pty.start',
      scope: { machineId },
      payload: {
        requestId,
        terminalId,
        cwd: String(cwd ?? ''),
        cols: Number(cols) || 80,
        rows: Number(rows) || 24
      }
    }))
    if (!ok) {
      pendingTerminalStarts.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }
    return await resultP
  }

  async function requestMachineUpgrade({ machineId, hostVersion = null, timeoutMs = 10_000 }) {
    const requestId = releaseBundles.nextRequestId()
    try {
      const bundle = await releaseBundles.getBundle()
      const acceptedP = pendingMachineUpgrades.create(requestId, {
        machineId,
        timeoutMs,
        onTimeout: () => httpError(504, 'timeout waiting for runner to accept upgrade')
      })
      await releaseBundles.sendBundleToMachine({
        machineId,
        requestId,
        runnerWs,
        makeEnvelope,
        bundle
      })
      await acceptedP
      const installedP = pendingMachineUpgradeTransfers.create(requestId, {
        machineId,
        timeoutMs: 60_000,
        onTimeout: () => httpError(504, 'timeout waiting for runner to install upgrade bundle')
      })
      await releaseBundles.streamBundleToMachine({
        machineId,
        requestId,
        runnerWs,
        makeEnvelope
      })
      await installedP
      return {
        machineId,
        requestId,
        releaseId: bundle.releaseId,
        version: bundle.version,
        ...(hostVersion ? { hostVersion } : {})
      }
    } catch (err) {
      pendingMachineUpgrades.cancel(requestId)
      pendingMachineUpgradeTransfers.cancel(requestId)
      if (Number(err?.statusCode)) throw err
      throw httpError(503, String(err?.message ?? err))
    }
  }

  async function getMachineToolsOnRunner({ machineId, timeoutMs = 15_000 }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingMachineTools.create(requestId, {
      machineId,
      timeoutMs,
      onTimeout: () => httpError(504, 'timeout reading runner tools')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'machine.tools.get',
      scope: { machineId },
      payload: {
        requestId
      }
    }))
    if (!ok) {
      pendingMachineTools.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }

    const payload = await resultP
    return {
      machineId,
      tools: (payload?.tools && typeof payload.tools === 'object') ? payload.tools : {}
    }
  }

  async function upgradeMachineToolOnRunner({ machineId, toolId, timeoutMs = 20 * 60 * 1000 }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingMachineToolUpgrades.create(requestId, {
      machineId,
      timeoutMs,
      onTimeout: () => httpError(504, 'timeout upgrading runner tool')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'machine.tools.upgrade',
      scope: { machineId },
      payload: {
        requestId,
        toolId: String(toolId ?? '')
      }
    }))
    if (!ok) {
      pendingMachineToolUpgrades.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }

    return await resultP
  }

  async function authMachineToolOnRunner({ machineId, toolId, action, input = null, timeoutMs = 120_000 }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingMachineToolAuth.create(requestId, {
      machineId,
      timeoutMs,
      onTimeout: () => httpError(504, 'timeout running runner tool auth action')
    })

    const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
      type: 'machine.tools.auth',
      scope: { machineId },
      payload: {
        requestId,
        toolId: String(toolId ?? ''),
        action: String(action ?? ''),
        input: (input && typeof input === 'object') ? input : null
      }
    }))
    if (!ok) {
      pendingMachineToolAuth.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }

    return await resultP
  }

  async function codexModelListOnRunner({ machineId, cwd = '', limit = 200, includeHidden = false }) {
    const requestId = crypto.randomUUID()
    const resultP = pendingModelLists.create(requestId, {
      machineId,
      timeoutMs: 20_000,
      onTimeout: () => httpError(504, 'timeout listing models')
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
      pendingModelLists.cancel(requestId)
      throw httpError(503, 'runner not connected')
    }

    const payload = await resultP
    return {
      models: Array.isArray(payload?.models) ? payload.models : [],
      nextCursor: (payload?.nextCursor === null || payload?.nextCursor === undefined) ? null : String(payload.nextCursor)
    }
  }

  const modelCatalogCache = createModelCatalogCache({
    load: codexModelListOnRunner
  })

  const sessionApi = createSessionApi({
    auth,
    store,
    sse,
    runnerWs,
    makeEnvelope,
    readJsonBody,
    json,
    pickMachineId,
    sendRunnerCommandAndAwait,
    uploadService,
    approvals,
    persistSessionEvent,
    listQueuedPromptPayloads,
    sendQueuedPromptsUpdated,
    sendQueuedPromptNowBackend
  })

  const hostSystemApi = createHostSystemApi({
    auth,
    store,
    runnerWs,
    sse,
    push,
    config,
    runnerInstall,
    hostSelfUpdate,
    readJsonBody,
    json
  })

  const hostMachineApi = createHostMachineApi({
    auth,
    getExternalBaseUrl(req) {
      return buildExternalBaseUrl(req, {
        publicUrl: config?.host?.publicUrl ?? null,
        trustProxy: config?.host?.trustProxy ?? false
      })
    },
    store,
    sse,
    runnerWs,
    approvals,
    ideSessions,
    makeEnvelope,
    json,
    readJsonBody,
    pickMachineId,
    fsListOnRunner,
    fsReadOnRunner,
    gitStatusOnRunner,
    gitStageOnRunner,
    gitUnstageOnRunner,
    gitCommitOnRunner,
    gitPushOnRunner,
    gitSwitchBranchOnRunner,
    gitCreateBranchOnRunner,
    terminalSessions,
    terminalPtyStartOnRunner,
    terminalExecOnRunner,
    codexModelListOnRunner: modelCatalogCache.list,
    pendingIdeStarts,
    requestMachineUpgrade,
    getMachineToolsOnRunner,
    upgradeMachineToolOnRunner,
    authMachineToolOnRunner
  })

  const hostApprovalApi = createHostApprovalApi({
    auth,
    approvals,
    store,
    runnerWs,
    makeEnvelope,
    readJsonBody,
    json,
    persistSessionEvent
  })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      const parts = url.pathname.split('/').filter(Boolean)
      if (logRequests) {
        console.log(`[rootgrid] ${req.method ?? 'GET'} ${url.pathname}`)
      }

      if (await sessionApi.handle(req, res, url, parts)) return
      if (await hostSystemApi.handle(req, res, url, parts)) return
      if (await hostMachineApi.handle(req, res, url, parts)) return
      if (await hostApprovalApi.handle(req, res, url, parts)) return

      // REST API
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
          const proxiedPath = `${stripIdeBasePath(url.pathname, ideId)}${url.search ?? ''}`
          stream = tunnelHub.openStream({
            machineId: ide.machineId,
            mode: 'http',
            host: '127.0.0.1',
            port: ide.port,
            method: req.method ?? 'GET',
            path: proxiedPath,
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
      console.error('[rootgrid] request failed:', String(err?.stack ?? err))
      res.statusCode = 500
      const pathname = (() => {
        try { return new URL(req.url ?? '/', 'http://local').pathname } catch { return '/' }
      })()
      if (pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: exposeErrors ? String(err?.stack ?? err) : 'internal server error' }))
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(exposeErrors ? String(err?.stack ?? err) : 'Internal server error')
      }
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
        const proxiedPath = `${stripIdeBasePath(url.pathname, ideId)}${url.search ?? ''}`
        let headerLines = ''
        for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
          const k = req.rawHeaders[i]
          const v = req.rawHeaders[i + 1]
          if (!k) continue
          if (String(k).toLowerCase() === 'host') continue
          headerLines += `${k}: ${v}\r\n`
        }
        headerLines += `Host: 127.0.0.1:${ide.port}\r\n`
        const requestLine = `${req.method ?? 'GET'} ${proxiedPath} HTTP/1.1\r\n`
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
  // Warm the runner install bundle as soon as the host is up so the first
  // "Add machine" flow doesn't have to pay the full packaging cost.
  releaseBundles.warmBundle()

  // Retention pruning (Rootgrid-owned data only).
  let retentionRunning = false
  const runRetention = async () => {
    if (retentionRunning) return
    retentionRunning = true
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
        try { await rm(p, { force: true }) } catch { }
      }
      const artifacts = await pruneStaleManagedReleaseArtifacts()
      if (s > 0 || m > 0) {
        console.log(`[rootgrid] retention pruned: sessions=${s} machines=${m}`)
      }
      const artifactCount = Object.values(artifacts).reduce((sum, value) => sum + (Number(value) || 0), 0)
      if (artifactCount > 0) {
        console.log(`[rootgrid] retention pruned stale managed artifacts: ${artifactCount}`)
      }
    } catch (err) {
      console.warn('[rootgrid] retention prune failed:', String(err?.message ?? err))
    } finally {
      retentionRunning = false
    }
  }

  void runRetention()
  const retentionTimer = setInterval(() => {
    void runRetention()
  }, 6 * 60 * 60 * 1000)
  retentionTimer.unref?.()
}
