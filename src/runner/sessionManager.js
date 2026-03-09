import crypto from 'node:crypto'

import { getRunnerUploadsDir } from '../lib/paths.js'
import { CodexAppServerSession } from './sessions/CodexAppServerSession.js'
import { RunnerIdeManager } from './ideManager.js'
import { RunnerReleaseManager } from './runnerReleaseManager.js'
import { RunnerTerminalManager } from './runnerTerminalManager.js'
import { RunnerUploadManager } from './runnerUploadManager.js'
import {
  createGitBranch,
  execTerminalCommand,
  getGitStatus,
  listCodexModels,
  listWorkspaceEntries,
  readWorkspaceFile,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths
} from './runnerWorkspaceApi.js'

function nextTurnOfLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

export class RunnerSessionManager {
  /**
   * @param {{
   *   machineId: string,
   *   send: (envelope: any) => boolean,
   *   debug?: any,
   *   upgrade?: any,
   *   autostart?: any,
   *   makeEnvelope: (input: { type: string, scope?: any, payload?: any, track?: boolean }) => any
   * }} opts
   */
  constructor({ machineId, send, debug = null, upgrade = null, autostart = null, makeEnvelope }) {
    this.machineId = machineId
    this.send = send
    this.debug = debug ?? null
    this.makeEnvelope = makeEnvelope
    /** @type {Map<string, CodexAppServerSession>} */
    this.sessions = new Map()

    this.ide = new RunnerIdeManager({
      machineId,
      emit: (type, payload) => this.#emit(type, { machineId: this.machineId }, payload)
    })
    this.uploads = new RunnerUploadManager({
      machineId,
      uploadsDir: getRunnerUploadsDir(machineId),
      emit: (type, scope, payload, options) => this.#emit(type, scope, payload, options)
    })
    this.terminals = new RunnerTerminalManager({
      machineId,
      emit: (type, payload, options) => this.#emit(type, { machineId: this.machineId }, payload, options)
    })
    this.upgrade = new RunnerReleaseManager({
      machineId,
      upgrade,
      autostart,
      emit: (type, payload, options) => this.#emit(type, { machineId: this.machineId }, payload, options)
    })
  }

  /**
   * @param {any} env
   */
  handleHostEnvelope(env) {
    const type = env?.type
    const payload = env?.payload ?? null

    if (type === 'fs.list') return this.#onFsList(payload)
    if (type === 'fs.read') return this.#onFsRead(payload)
    if (type === 'git.status') return this.#onGitStatus(payload)
    if (type === 'git.stage') return this.#onGitStage(payload)
    if (type === 'git.unstage') return this.#onGitUnstage(payload)
    if (type === 'git.branch.switch') return this.#onGitBranchSwitch(payload)
    if (type === 'git.branch.create') return this.#onGitBranchCreate(payload)
    if (type === 'terminal.exec') return this.#onTerminalExec(payload)
    if (type === 'terminal.pty.start') return this.#onTerminalPtyStart(payload)
    if (type === 'terminal.pty.input') return this.#onTerminalPtyInput(payload)
    if (type === 'terminal.pty.resize') return this.#onTerminalPtyResize(payload)
    if (type === 'terminal.pty.close') return this.#onTerminalPtyClose(payload)
    if (type === 'codex.model.list') return this.#onCodexModelList(payload)
    if (type === 'session.start') return this.#onSessionStart(payload)
    if (type === 'session.send') return this.#onSessionSend(payload)
    if (type === 'session.options.update') return this.#onSessionOptionsUpdate(payload)
    if (type === 'session.upload.begin') return this.#onSessionUploadBegin(payload)
    if (type === 'session.upload.chunk') return this.#onSessionUploadChunk(payload)
    if (type === 'session.upload.end') return this.#onSessionUploadEnd(payload)
    if (type === 'session.upload.abort') return this.#onSessionUploadAbort(payload)
    if (type === 'session.upload') return this.#onSessionUpload(payload)
    if (type === 'session.upload.delete') return this.#onSessionUploadDelete(payload)
    if (type === 'session.cleanup') return this.#onSessionCleanup(payload)
    if (type === 'session.cancel') return this.#onSessionCancel(payload)
    if (type === 'session.stop') return this.#onSessionStop(payload)
    if (type === 'approval.respond') return this.#onApprovalRespond(payload)
    if (type === 'machine.upgrade.start') return this.#onMachineUpgradeStart(payload)
    if (type === 'machine.upgrade.chunk') return this.#onMachineUpgradeChunk(payload)
    if (type === 'machine.upgrade.end') return this.#onMachineUpgradeEnd(payload)
    if (type === 'machine.upgrade.abort') return this.#onMachineUpgradeAbort(payload)
    if (type === 'ide.start') return this.#onIdeStart(payload)
    if (type === 'ide.stop') return this.#onIdeStop(payload)
  }

  #emit(type, scope, payload, { track = true } = {}) {
    this.send(this.makeEnvelope({ type, scope, payload, track }))
  }

  #sessionScope(sessionId) {
    return { machineId: this.machineId, sessionId }
  }

  #respondCommand(requestId, sessionId, kind, { ok, error = null } = {}) {
    if (!requestId || typeof requestId !== 'string') return
    this.#emit(ok ? 'session.command.accepted' : 'session.command.rejected', this.#sessionScope(sessionId), {
      requestId,
      sessionId,
      kind,
      ...(ok ? {} : { error: String(error ?? 'command rejected') })
    }, { track: false })
  }

  async #onSessionStart(payload) {
    const requestId = payload?.requestId ?? null
    const sessionId = payload?.sessionId ?? crypto.randomUUID()
    const cwd = payload?.cwd
    const prompt = payload?.prompt
    const input = payload?.input ?? null
    const options = payload?.options ?? null

    if (!cwd || typeof cwd !== 'string') {
      this.#respondCommand(requestId, sessionId, 'start', { ok: false, error: 'cwd is required' })
      return
    }
    const startInput = (Array.isArray(input) && input.length) ? input : prompt
    if (!startInput || (typeof startInput !== 'string' && !Array.isArray(startInput))) {
      this.#respondCommand(requestId, sessionId, 'start', { ok: false, error: 'prompt or input is required' })
      return
    }

    if (this.sessions.has(sessionId)) {
      this.#respondCommand(requestId, sessionId, 'start', { ok: false, error: 'session already exists' })
      return
    }

    const session = new CodexAppServerSession({
      sessionId,
      cwd,
      options,
      debug: this.debug,
      emit: (type, eventPayload) => this.#emit(type, this.#sessionScope(sessionId), eventPayload)
    })
    this.sessions.set(sessionId, session)
    this.#respondCommand(requestId, sessionId, 'start', { ok: true })

    try {
      await nextTurnOfLoop()
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
    const requestId = payload?.requestId ?? null
    const sessionId = payload?.sessionId
    const text = payload?.text
    const input = payload?.input ?? null
    if (!sessionId || typeof sessionId !== 'string') {
      this.#respondCommand(requestId, String(sessionId ?? ''), 'send', { ok: false, error: 'sessionId is required' })
      return
    }
    const sendInput = (Array.isArray(input) && input.length) ? input : text
    if (!sendInput || (typeof sendInput !== 'string' && !Array.isArray(sendInput))) {
      this.#respondCommand(requestId, sessionId, 'send', { ok: false, error: 'text or input is required' })
      return
    }

    let session = this.sessions.get(sessionId)
    if (!session) {
      const cwd = payload?.cwd
      const codexThreadId = payload?.codexThreadId ?? null
      const options = payload?.options ?? null
      if (!cwd || typeof cwd !== 'string') {
        this.#respondCommand(requestId, sessionId, 'send', { ok: false, error: 'missing cwd for resume' })
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
        debug: this.debug,
        emit: (type, eventPayload) => this.#emit(type, this.#sessionScope(sessionId), eventPayload)
      })
      this.sessions.set(sessionId, session)
      this.#respondCommand(requestId, sessionId, 'send', { ok: true })

      try {
        await nextTurnOfLoop()
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

    this.#respondCommand(requestId, sessionId, 'send', { ok: true })

    try {
      await nextTurnOfLoop()
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
    await this.uploads.handleLegacyUpload(payload)
  }

  async #onSessionUploadBegin(payload) {
    await this.uploads.begin(payload)
  }

  async #onSessionUploadChunk(payload) {
    await this.uploads.chunk(payload)
  }

  async #onSessionUploadEnd(payload) {
    await this.uploads.end(payload)
  }

  async #onSessionUploadAbort(payload) {
    await this.uploads.abort(payload)
  }

  async #onSessionUploadDelete(payload) {
    await this.uploads.delete(payload)
  }

  async #onFsList(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    try {
      const out = await listWorkspaceEntries(payload?.path, {
        includeFiles: Boolean(payload?.includeFiles)
      })
      this.#emit('fs.list.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('fs.list.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onFsRead(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    try {
      const out = await readWorkspaceFile(payload?.path, {
        maxBytes: Number(payload?.maxBytes) || 200_000
      })
      this.#emit('fs.read.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('fs.read.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onGitStatus(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    try {
      const out = await getGitStatus({
        cwd: payload?.cwd,
        timeoutMs: Number(payload?.timeoutMs) || 10_000
      })
      this.#emit('git.status.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('git.status.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onGitStage(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return
    try {
      const out = await stageGitPaths({
        cwd: payload?.cwd,
        paths: payload?.paths,
        timeoutMs: Number(payload?.timeoutMs) || 10_000
      })
      this.#emit('git.stage.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('git.stage.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onGitUnstage(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return
    try {
      const out = await unstageGitPaths({
        cwd: payload?.cwd,
        paths: payload?.paths,
        timeoutMs: Number(payload?.timeoutMs) || 10_000
      })
      this.#emit('git.unstage.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('git.unstage.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onGitBranchSwitch(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return
    try {
      const out = await switchGitBranch({
        cwd: payload?.cwd,
        branch: payload?.branch,
        timeoutMs: Number(payload?.timeoutMs) || 10_000
      })
      this.#emit('git.branch.switch.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('git.branch.switch.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onGitBranchCreate(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return
    try {
      const out = await createGitBranch({
        cwd: payload?.cwd,
        branch: payload?.branch,
        timeoutMs: Number(payload?.timeoutMs) || 10_000
      })
      this.#emit('git.branch.create.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('git.branch.create.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onTerminalExec(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    try {
      const out = await execTerminalCommand({
        cwd: payload?.cwd,
        command: payload?.command,
        timeoutMs: Number(payload?.timeoutMs) || 60_000
      })
      this.#emit('terminal.exec.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('terminal.exec.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onTerminalPtyStart(payload) {
    try {
      await this.terminals.start(payload)
    } catch (err) {
      this.#emit('terminal.pty.start.result', { machineId: this.machineId }, {
        requestId: payload?.requestId ?? null,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  #onTerminalPtyInput(payload) {
    try {
      this.terminals.input(payload)
    } catch {
    }
  }

  #onTerminalPtyResize(payload) {
    try {
      this.terminals.resize(payload)
    } catch {
    }
  }

  #onTerminalPtyClose(payload) {
    try {
      this.terminals.close(payload)
    } catch {
    }
  }

  async #onMachineUpgradeStart(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    try {
      await this.upgrade.begin(payload)
      this.#emit('machine.upgrade.accepted', { machineId: this.machineId }, {
        requestId,
        machineId: this.machineId
      }, { track: false })
    } catch (err) {
      this.#emit('machine.upgrade.rejected', { machineId: this.machineId }, {
        requestId,
        machineId: this.machineId,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onMachineUpgradeChunk(payload) {
    try {
      await this.upgrade.chunk(payload)
    } catch (err) {
      const requestId = payload?.requestId
      if (!requestId) return
      this.#emit('machine.upgrade.bundle.failed', { machineId: this.machineId }, {
        requestId,
        machineId: this.machineId,
        error: String(err?.message ?? err)
      }, { track: false })
    }
  }

  async #onMachineUpgradeEnd(payload) {
    try {
      await this.upgrade.end(payload)
    } catch {
    }
  }

  async #onMachineUpgradeAbort(payload) {
    try {
      await this.upgrade.abort(payload)
    } catch {
    }
  }

  async #onCodexModelList(payload) {
    const requestId = payload?.requestId
    if (!requestId || typeof requestId !== 'string') return

    try {
      const out = await listCodexModels({
        cwd: payload?.cwd,
        limit: payload?.limit,
        includeHidden: payload?.includeHidden
      })
      this.#emit('codex.model.list.result', { machineId: this.machineId }, {
        requestId,
        ok: true,
        ...out
      }, { track: false })
    } catch (err) {
      this.#emit('codex.model.list.result', { machineId: this.machineId }, {
        requestId,
        ok: false,
        error: String(err?.message ?? err)
      }, { track: false })
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

    await this.uploads.cleanupSession(sessionId)
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
    const trustedOrigins = Array.isArray(payload?.trustedOrigins) ? payload.trustedOrigins : []
    if (!ideId || typeof ideId !== 'string') return
    if (!cwd || typeof cwd !== 'string') return
    try {
      await this.ide.start({ ideId, cwd, trustedOrigins })
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
