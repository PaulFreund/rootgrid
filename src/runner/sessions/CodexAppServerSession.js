import crypto from 'node:crypto'

import { JsonRpcStdioClient } from './JsonRpcStdioClient.js'
import { JsonRpcDebugCapture } from './JsonRpcDebugCapture.js'
import {
  approvalPolicyCandidates,
  buildResumeThreadAttempts,
  buildStartThreadAttempts,
  buildStartTurnAttempts,
  normalizeAgentMessagePhase,
  normalizeItemType,
  reasoningEffortCandidates,
  safeString,
  sandboxCandidates,
  sandboxPolicyCandidates,
  tryExtractAgentMessageText,
  tryExtractDeltaText,
  tryExtractPlanText,
  tryExtractReasoningText
} from './codexSessionProtocol.js'
import {
  buildCodexErrorOutputText,
  buildPlanUpdatedEvent,
  buildTerminalInteractionOutputText,
  buildThreadTokenUsageEvent,
  buildToolCompletedEvent,
  buildToolStartedEvent,
  normalizeWrappedNotification
} from './codexSessionNotifications.js'
import {
  buildApprovalRequestEvent,
  buildUserInputRequestEvent,
  isApprovalRequestMethod,
  isUserInputRequestMethod
} from './codexSessionRequests.js'

export class CodexAppServerSession {
  /**
   * @param {{
   *   sessionId: string,
   *   cwd: string,
   *   options: any,
   *   debug?: any,
   *   emit: (type: string, payload: any) => void,
   * }} opts
   */
  constructor({ sessionId, cwd, options, debug = null, emit }) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.options = options ?? null
    this.emit = emit

    this.outputSeq = 0
    this.threadId = null
    this.activeTurnId = null
    this.started = false
    this.turnText = ''
    this.turnCommentaryText = ''
    this.turnTextMax = 8_000

    // Dedupe guards. Some Codex app-server builds emit both a wrapped event
    // stream (`codex/event/*`) *and* direct v2-style notifications, which can
    // otherwise cause duplicated turn boundaries and duplicated output chunks.
    this.lastTurnStartedId = null
    this.lastTurnCompletedId = null
    this.lastNormalizedChunk = { text: null, tsMs: 0 }
    this.lastReasoningChunk = { text: null, tsMs: 0 }
    this.seenToolStarted = new Set()
    this.seenToolCompleted = new Set()

    /** @type {Map<string, { resolve: (v:any)=>void, reject:(e:any)=>void }>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, { sawDelta: boolean, phase?: string|null }>} */
    this.itemState = new Map()
    /** @type {Map<string, string>} */
    this.lastDeltaByKey = new Map()

    // Some Codex builds emit both:
    //   1) a wrapped event stream (`codex/event/*`) and
    //   2) direct v2-style notifications (`item/*`, `turn/*`, etc.)
    // When both are present, tokenization can differ slightly and naive dedupe
    // can still "double every token" (very confusing in the UI). Prefer one
    // notification source per session.
    /** @type {'direct'|'wrapped'|null} */
    this.notificationMode = null
    /** @type {Array<{ method: string, params: any }>} */
    this.pendingWrappedNotifications = []
    /** @type {any} */
    this.pendingWrappedTimer = null
    /** @type {Map<string, { stream: string, itemId: string|null, text: string, timer: any }>} */
    this.outputBuffers = new Map()

    this.rpc = new JsonRpcStdioClient({
      command: 'codex',
      args: ['app-server'],
      cwd: this.cwd,
      env: process.env,
      debugCapture: (debug?.codexRawCapture?.enabled)
        ? new JsonRpcDebugCapture({
          sessionId: this.sessionId,
          cwd: this.cwd,
          command: 'codex',
          args: ['app-server'],
          dir: debug?.codexRawCapture?.dir ?? null
        })
        : null,
      onNotification: (msg) => this.#onNotification(msg),
      onRequest: (msg) => this.#onRequest(msg),
      onStderr: (chunk) => {
        this.#bufferOutput({ stream: 'stderr', text: chunk })
      },
      onExit: ({ code, signal }) => {
        this.#disposeWrappedNotifications()
        this.#rejectPendingApprovals(new Error('session exited'))
        this.#flushAllOutputBuffers()
        const status = (code === 0) ? 'exited' : 'failed'
        this.emit('session.status', {
          sessionId: this.sessionId,
          status,
          exitCode: code,
          error: signal ? `signal ${signal}` : null
        })
      }
    })
  }

  #resetTurnScopedState() {
    this.turnText = ''
    this.turnCommentaryText = ''
    this.lastNormalizedChunk = { text: null, tsMs: 0 }
    this.lastReasoningChunk = { text: null, tsMs: 0 }
    try { this.seenToolStarted.clear() } catch { }
    try { this.seenToolCompleted.clear() } catch { }
    try { this.itemState.clear() } catch { }
    try { this.lastDeltaByKey.clear() } catch { }
  }

  #disposeWrappedNotifications() {
    if (this.pendingWrappedTimer) {
      try { clearTimeout(this.pendingWrappedTimer) } catch { }
    }
    this.pendingWrappedTimer = null
    this.pendingWrappedNotifications = []
  }

  #rejectPendingApprovals(error) {
    const err = (error instanceof Error) ? error : new Error(String(error ?? 'approval cancelled'))
    for (const [approvalId, pending] of this.pendingApprovals.entries()) {
      this.pendingApprovals.delete(approvalId)
      try { pending.reject(err) } catch { }
    }
  }

  #appendTurnText(chunk, { phase = null } = {}) {
    if (!chunk) return
    const next = String(chunk)
    const target = normalizeAgentMessagePhase(phase) === 'commentary'
      ? 'turnCommentaryText'
      : 'turnText'
    this[target] += next
    if (this[target].length > this.turnTextMax) {
      this[target] = this[target].slice(this[target].length - this.turnTextMax)
    }
  }

  #turnPreview() {
    const source = String(this.turnText ?? '').trim()
      ? this.turnText
      : this.turnCommentaryText
    const t = String(source ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return null
    return t.length > 200 ? `${t.slice(0, 197)}…` : t
  }

  #bufferOutput({ stream, text, itemId = null, phase = null }) {
    const body = String(text ?? '')
    if (!body) return

    const sid = (typeof itemId === 'string' && itemId.trim()) ? itemId.trim() : null
    const normalizedPhase = normalizeAgentMessagePhase(phase)
    const key = `${String(stream ?? 'normalized')}:${sid ?? ''}:${normalizedPhase ?? ''}`
    let entry = this.outputBuffers.get(key)
    if (!entry) {
      entry = {
        stream: String(stream ?? 'normalized'),
        itemId: sid,
        phase: normalizedPhase,
        text: '',
        timer: null
      }
      this.outputBuffers.set(key, entry)
    }

    entry.text += body

    const flushNow = entry.text.length >= 16 * 1024 || entry.stream === 'stderr'
    if (flushNow) {
      this.#flushOutputBuffer(key)
      return
    }

    if (entry.timer) return
    entry.timer = setTimeout(() => this.#flushOutputBuffer(key), 40)
    try { entry.timer.unref?.() } catch { }
  }

  #flushOutputBuffer(key) {
    const entry = this.outputBuffers.get(key)
    if (!entry) return
    this.outputBuffers.delete(key)
    try { if (entry.timer) clearTimeout(entry.timer) } catch { }
    if (!entry.text) return
    this.emit('session.output', {
      sessionId: this.sessionId,
      seq: this.nextSeq(),
      stream: entry.stream,
      text: entry.text,
      ...(entry.phase ? { phase: entry.phase } : {}),
      ...(entry.itemId ? { itemId: entry.itemId } : {})
    })
  }

  #flushAllOutputBuffers() {
    for (const key of Array.from(this.outputBuffers.keys())) {
      this.#flushOutputBuffer(key)
    }
  }

  #flushOutputBuffersForItem(itemId) {
    const tid = safeString(itemId)
    if (!tid) return
    for (const [key, entry] of this.outputBuffers.entries()) {
      if (entry?.itemId !== tid) continue
      this.#flushOutputBuffer(key)
    }
  }

  /**
   * Best-effort suppression of duplicated normalized chunks emitted back-to-back.
   * This is intentionally time-bounded so we don't suppress legitimate repeated
   * text in longer outputs.
   *
   * @param {string} text
   */
  #shouldDropNormalizedChunk(text) {
    const t = String(text ?? '')
    if (!t) return false
    const now = Date.now()
    const last = this.lastNormalizedChunk
    if (last && last.text === t && (now - Number(last.tsMs ?? 0)) < 500) {
      return true
    }
    this.lastNormalizedChunk = { text: t, tsMs: now }
    return false
  }

  /**
   * Best-effort suppression of duplicated reasoning chunks emitted back-to-back.
   * Some Codex app-server builds emit both wrapped and unwrapped deltas, which
   * can otherwise double every token (and is very confusing in the UI).
   *
   * @param {string} text
   */
  #shouldDropReasoningChunk(text) {
    const t = String(text ?? '')
    if (!t) return false
    const now = Date.now()
    const last = this.lastReasoningChunk
    if (last && last.text === t && (now - Number(last.tsMs ?? 0)) < 500) {
      return true
    }
    this.lastReasoningChunk = { text: t, tsMs: now }
    return false
  }

  #rememberItemPhase(itemId, phase) {
    const key = safeString(itemId)
    const normalizedPhase = normalizeAgentMessagePhase(phase)
    if (!key || !normalizedPhase) return
    const prev = this.itemState.get(key) ?? { sawDelta: false }
    this.itemState.set(key, { ...prev, phase: normalizedPhase })
  }

  #agentMessageStreamForPhase(phase) {
    return normalizeAgentMessagePhase(phase) === 'commentary' ? 'commentary' : 'normalized'
  }

  #isCompatibilityFallbackError(error) {
    const message = safeString(error instanceof Error ? error.message : error)
    if (!message) return false
    return (
      message.startsWith('Invalid request:') ||
      message.includes('expected internally tagged enum') ||
      message.includes('unknown field') ||
      message.includes('missing field')
    )
  }

  #emitCompatibilityRetryWarning({ operation, error }) {
    const details = safeString(error instanceof Error ? error.message : error)
    if (!details) return
    this.emit('session.error', {
      sessionId: this.sessionId,
      message: `Retrying ${String(operation ?? 'request')} with Codex compatibility fallback`,
      details,
      willRetry: true
    })
  }

  #emitRequestFailure({ operation, error }) {
    const details = safeString(error instanceof Error ? error.message : error)
    if (!details) return
    this.emit('session.error', {
      sessionId: this.sessionId,
      message: `Codex rejected ${String(operation ?? 'request')}`,
      details,
      willRetry: false
    })
  }

  nextSeq() {
    this.outputSeq += 1
    return this.outputSeq
  }

  async start(input, { threadId = null } = {}) {
    if (this.started) return
    this.started = true

    this.emit('session.status', { sessionId: this.sessionId, status: 'starting' })

    await this.rpc.start()

    await this.rpc.sendRequest('initialize', {
      clientInfo: {
        name: 'rootgrid',
        title: 'Rootgrid',
        version: '0.0.0'
      }
    })
    this.rpc.sendNotification('initialized', {})

    const model = safeString(this.options?.model)
    const approvalPolicies = approvalPolicyCandidates(this.options?.approvalPolicy)
    const sandboxes = sandboxCandidates(this.options?.sandbox)
    const reasoningEfforts = reasoningEffortCandidates(this.options?.reasoningEffort)

    /** @type {any} */
    let threadRes = null
    /** @type {string|null} */
    let effectiveThreadId = null

    if (threadId && typeof threadId === 'string') {
      const paramVariants = buildResumeThreadAttempts({
        threadId,
        cwd: this.cwd,
        model,
        approvalPolicies,
        sandboxes,
        reasoningEfforts
      })

      let resumeOk = false
      for (const params of paramVariants) {
        try {
          threadRes = await this.rpc.sendRequest('thread/resume', params)
          resumeOk = true
          break
        } catch {
        }
      }

      if (resumeOk) {
        effectiveThreadId = threadRes?.thread?.id ?? threadRes?.threadId ?? threadRes?.id ?? null
        if (!effectiveThreadId) effectiveThreadId = threadId
      }
    }

    if (!effectiveThreadId) {
      let startedOk = false
      let lastErr = null
      const attempts = buildStartThreadAttempts({
        cwd: this.cwd,
        model,
        approvalPolicies,
        sandboxes,
        reasoningEfforts
      })
      for (const params of attempts) {
        try {
          threadRes = await this.rpc.sendRequest('thread/start', params)
          startedOk = true
          break
        } catch (err) {
          lastErr = err
        }
      }
      if (!startedOk) throw lastErr ?? new Error('thread/start failed')
      effectiveThreadId = threadRes?.thread?.id ?? threadRes?.threadId ?? threadRes?.id ?? null
    }

    this.threadId = effectiveThreadId
    const threadName = safeString(threadRes?.thread?.name ?? threadRes?.name)
    const threadPreview = safeString(threadRes?.thread?.preview ?? threadRes?.preview)

    this.emit('session.status', {
      sessionId: this.sessionId,
      status: 'running',
      ...(effectiveThreadId ? { codexThreadId: effectiveThreadId } : {}),
      ...(threadName ? { threadName } : {}),
      ...(threadPreview ? { threadPreview } : {})
    })

    await this.#startTurn(input)
  }

  async send(input) {
    if (!this.threadId) throw new Error('session not started')
    await this.#startTurn(input)
  }

  /**
   * Update the per-session Codex options (applied on the next `turn/start`).
   * @param {{ model?: string|null, reasoningEffort?: string|null, approvalPolicy?: string|null, sandbox?: string|null }} patch
   */
  updateOptions(patch) {
    if (!patch || typeof patch !== 'object') return
    const next = { ...(this.options ?? {}) }
    if ('model' in patch) next.model = (typeof patch.model === 'string' && patch.model.trim()) ? patch.model.trim() : (patch.model ?? null)
    if ('reasoningEffort' in patch) next.reasoningEffort = (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort.trim()) ? patch.reasoningEffort.trim() : (patch.reasoningEffort ?? null)
    if ('approvalPolicy' in patch) next.approvalPolicy = (typeof patch.approvalPolicy === 'string' && patch.approvalPolicy.trim()) ? patch.approvalPolicy.trim() : (patch.approvalPolicy ?? null)
    if ('sandbox' in patch) next.sandbox = (typeof patch.sandbox === 'string' && patch.sandbox.trim()) ? patch.sandbox.trim() : (patch.sandbox ?? null)
    this.options = next
  }

  async cancel() {
    if (!this.threadId) return
    const interruptTurnId = this.activeTurnId
    try {
      await this.rpc.sendRequest('turn/interrupt', {
        threadId: this.threadId,
        ...(interruptTurnId ? { turnId: interruptTurnId } : {})
      })
    } catch {
    }

    // Some clients observe that interrupt does not always yield a `turn/completed`
    // notification. To keep the UI responsive, force-clear the running state.
    if (interruptTurnId) {
      const tid = interruptTurnId
      const done = () => {
        if (this.activeTurnId !== tid) return
        this.#flushAllOutputBuffers()
        const preview = this.#turnPreview()
        this.emit('turn.completed', {
          sessionId: this.sessionId,
          turnId: tid,
          status: 'interrupted',
          ...(preview ? { preview } : {})
        })
        this.activeTurnId = null
        this.#resetTurnScopedState()
      }
      const timer = setTimeout(done, 1_500)
      timer.unref?.()
    }
  }

  async stop() {
    // Best-effort graceful.
    await this.cancel()
    this.#disposeWrappedNotifications()
    this.#rejectPendingApprovals(new Error('session stopped'))
    this.#flushAllOutputBuffers()
    this.rpc.stop({ signal: 'SIGTERM' })
  }

  /**
   * Resolve a pending Codex app-server request that Rootgrid surfaced to the UI
   * as an "approval" prompt.
   *
   * For command/file-change approvals, `response` is typically:
   *   { decision: "accept"|"acceptForSession"|"decline"|"cancel", reason? }
   *
   * For EXPERIMENTAL user-input requests, `response` is:
   *   { answers: { [questionId]: { answers: string[] } } }
   *
   * @param {{ approvalId: string, response: any }} input
   */
  async respondToApproval({ approvalId, response }) {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    this.pendingApprovals.delete(approvalId)
    pending.resolve(response)
    return true
  }

  async #startTurn(input) {
    if (!this.threadId) throw new Error('missing threadId')

    const items = Array.isArray(input)
      ? input.filter((x) => x && typeof x === 'object' && typeof x.type === 'string')
      : [{ type: 'text', text: String(input ?? '') }]

    const model = safeString(this.options?.model)
    const approvalPolicies = approvalPolicyCandidates(this.options?.approvalPolicy)
    const sandboxes = sandboxCandidates(this.options?.sandbox)
    const sandboxPolicies = sandboxPolicyCandidates(this.options?.sandbox, this.cwd)
    const reasoningEfforts = reasoningEffortCandidates(this.options?.reasoningEffort)
    const attempts = buildStartTurnAttempts({
      threadId: this.threadId,
      cwd: this.cwd,
      input: items,
      model,
      approvalPolicies,
      sandboxes,
      sandboxPolicies,
      reasoningEfforts
    })

    let lastErr = null
    let warnedCompatibilityRetry = false
    for (let i = 0; i < attempts.length; i += 1) {
      const params = attempts[i]
      try {
        await this.rpc.sendRequest('turn/start', params)
        return
      } catch (err) {
        lastErr = err
        if (!warnedCompatibilityRetry && i < (attempts.length - 1) && this.#isCompatibilityFallbackError(err)) {
          warnedCompatibilityRetry = true
          this.#emitCompatibilityRetryWarning({
            operation: 'turn start',
            error: err
          })
        }
      }
    }

    this.#emitRequestFailure({ operation: 'turn start', error: lastErr })
    throw lastErr ?? new Error('turn/start failed')
  }

  /**
   * @param {{ method: string, params: any }} msg
   */
  #onNotification(msg) {
    const { method, params } = msg

    // Decide whether to use wrapped or direct notifications (avoid duplicates).
    const isWrapped = (typeof method === 'string' && method.startsWith('codex/event/'))
    if (isWrapped) {
      if (this.notificationMode === 'direct') return
      if (!this.notificationMode) {
        this.pendingWrappedNotifications.push(msg)
        if (!this.pendingWrappedTimer) {
          const t = setTimeout(() => {
            // If we observed any direct notifications, the mode will already be set.
            if (this.notificationMode) return
            this.notificationMode = 'wrapped'
            const queued = this.pendingWrappedNotifications
            this.pendingWrappedNotifications = []
            this.pendingWrappedTimer = null
            for (const q of queued) this.#onNotification(q)
          }, 150)
          try { t.unref?.() } catch { }
          this.pendingWrappedTimer = t
        }
        return
      }
    } else {
      // Allow internal remapped notifications from the wrapped stream.
      const fromWrapped = Boolean(params?.__rgFromWrapped)
      if (!this.notificationMode) {
        this.notificationMode = 'direct'
        this.#disposeWrappedNotifications()
      } else if (this.notificationMode === 'wrapped' && !fromWrapped) {
        return
      }
    }

    // Some Codex builds emit a wrapped event stream under `codex/event/*` where the
    // real event discriminator lives in `params.msg.type`. Normalize a few common
    // ones back into the v2-style notification methods we already handle.
    if (typeof method === 'string' && method.startsWith('codex/event/')) {
      const normalized = normalizeWrappedNotification({
        method,
        params,
        sessionId: this.sessionId
      })
      if (!normalized || normalized.kind === 'ignore') return
      if (normalized.kind === 'emit') {
        this.emit(normalized.eventType, normalized.payload)
        return
      }
      for (const next of normalized.notifications ?? []) this.#onNotification(next)
      return
    }

    if (method === 'error') {
      const willRetry = Boolean(params?.willRetry ?? params?.will_retry)
      const message = safeString(params?.error?.message ?? params?.message) ?? 'Unknown error'
      const details = safeString(params?.error?.additionalDetails ?? params?.details)
      const codexErrorInfo = params?.error?.codexErrorInfo ?? params?.codexErrorInfo ?? null
      const turnId = safeString(params?.turnId ?? params?.turn?.id) ?? this.activeTurnId
      this.emit('session.error', {
        sessionId: this.sessionId,
        ...(turnId ? { turnId } : {}),
        message,
        willRetry,
        ...(details ? { details } : {}),
        ...(codexErrorInfo ? { codexErrorInfo } : {})
      })

      if (!willRetry) {
        const text = buildCodexErrorOutputText(params)
        if (text) this.#bufferOutput({ stream: 'stderr', text })
      }
      return
    }

    if (method === 'turn/started') {
      const nextTurnId = params?.turn?.id ?? params?.turnId ?? null

      // Deduplicate repeated turn start notifications.
      if (this.activeTurnId && (!nextTurnId || nextTurnId === this.activeTurnId)) return
      if (nextTurnId && nextTurnId === this.lastTurnStartedId) return

      this.activeTurnId = nextTurnId ?? this.activeTurnId ?? null
      this.lastTurnStartedId = this.activeTurnId
      this.#resetTurnScopedState()
      this.#flushAllOutputBuffers()
      this.emit('turn.started', { sessionId: this.sessionId, ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}) })
      return
    }

    if (method === 'turn/completed') {
      const turn = params?.turn ?? params ?? null
      const status = safeString(turn?.status ?? params?.status)
      const errorMessage = safeString(turn?.error?.message ?? params?.error?.message)
      const tid = safeString(turn?.id ?? params?.turnId) ?? this.activeTurnId

      // Deduplicate repeated completion notifications for the same turn.
      if (tid && tid === this.lastTurnCompletedId) return
      if (tid) this.lastTurnCompletedId = tid

      this.#flushAllOutputBuffers()
      const preview = this.#turnPreview()
      this.emit('turn.completed', {
        sessionId: this.sessionId,
        ...(tid ? { turnId: tid } : {}),
        ...(status ? { status } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(preview ? { preview } : {})
      })

      if (status === 'failed' && errorMessage) {
        this.#bufferOutput({ stream: 'stderr', text: `[codex] Turn failed: ${errorMessage}\n` })
        this.#flushAllOutputBuffers()
      }

      this.activeTurnId = null
      this.#resetTurnScopedState()
      return
    }

    if (method === 'turn/diff/updated') {
      const diff = params?.diff
      if (typeof diff === 'string') {
        this.emit('diff.updated', { sessionId: this.sessionId, diff })
      }
      return
    }

    if (method === 'thread/tokenUsage/updated') {
      this.emit('thread.tokenUsage.updated', buildThreadTokenUsageEvent({
        sessionId: this.sessionId,
        params
      }))
      return
    }

    if (method === 'turn/plan/updated') {
      const event = buildPlanUpdatedEvent({ sessionId: this.sessionId, params })
      if (!event) return
      this.emit('plan.updated', event)
      return
    }

    // Streamed output
    if (method === 'item/agentMessage/delta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      if (itemId) {
        const prev = this.itemState.get(itemId) ?? { sawDelta: false }
        this.itemState.set(itemId, { ...prev, sawDelta: true })
      }
      const text = tryExtractDeltaText(params)
      if (text) {
        const phase = normalizeAgentMessagePhase(params?.phase ?? this.itemState.get(itemId)?.phase ?? null)
        const stream = this.#agentMessageStreamForPhase(phase)
        const key = `agent:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)
        if (stream === 'normalized' && this.#shouldDropNormalizedChunk(text)) return

        this.#appendTurnText(text, { phase })
        this.#bufferOutput({ stream, text, phase })
      }
      return
    }

    if (method === 'item/reasoning/summaryPartAdded') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      const summaryIndex = params?.summaryIndex ?? null
      const key = `reasoning-part:${itemId ?? ''}:${summaryIndex ?? ''}`
      if (this.lastDeltaByKey.get(key) === '1') return
      this.lastDeltaByKey.set(key, '1')

      if (this.#shouldDropReasoningChunk('\n\n')) return
      this.#bufferOutput({ stream: 'reasoning', text: '\n\n' })
      return
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      if (itemId) {
        const prev = this.itemState.get(itemId) ?? { sawDelta: false }
        this.itemState.set(itemId, { ...prev, sawDelta: true })
      }
      const text = tryExtractDeltaText(params)
      if (text) {
        const idx = (params?.summaryIndex !== undefined && params?.summaryIndex !== null)
          ? String(params.summaryIndex)
          : ((params?.contentIndex !== undefined && params?.contentIndex !== null) ? String(params.contentIndex) : '')
        const key = `reasoning:${itemId ?? ''}:${method}:${idx}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)
        if (this.#shouldDropReasoningChunk(text)) return
        this.#bufferOutput({ stream: 'reasoning', text })
      }
      return
    }

    if (method === 'item/plan/delta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      if (itemId) {
        const prev = this.itemState.get(itemId) ?? { sawDelta: false }
        this.itemState.set(itemId, { ...prev, sawDelta: true })
      }
      const text = tryExtractDeltaText(params)
      if (text) {
        const key = `plan:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)
        this.#bufferOutput({ stream: 'plan', text })
      }
      return
    }

    if (method === 'item/commandExecution/outputDelta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      if (itemId) {
        const prev = this.itemState.get(itemId) ?? { sawDelta: false }
        this.itemState.set(itemId, { ...prev, sawDelta: true })
      }
      const text = tryExtractDeltaText(params)
      if (text) {
        const key = `cmd:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)

        this.#bufferOutput({ stream: 'stdout', text, itemId: safeString(itemId) })
      }
      return
    }

    if (method === 'item/fileChange/outputDelta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      if (itemId) {
        const prev = this.itemState.get(itemId) ?? { sawDelta: false }
        this.itemState.set(itemId, { ...prev, sawDelta: true })
      }
      const text = tryExtractDeltaText(params)
      if (text) {
        const key = `patch:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)

        this.#bufferOutput({ stream: 'stdout', text, itemId: safeString(itemId) })
      }
      return
    }

    if (method === 'item/commandExecution/terminalInteraction') {
      const itemId = safeString(params?.itemId)
      const text = buildTerminalInteractionOutputText({ itemId, stdin: params?.stdin })
      this.#bufferOutput({ stream: 'stderr', text, itemId })
      return
    }

    if (method === 'item/started') {
      const item = params?.item ?? null
      const itemId = item?.id ?? params?.itemId ?? null
      const type = normalizeItemType(item?.type ?? null)
      if (type === 'agentmessage') {
        this.#rememberItemPhase(itemId, item?.phase ?? params?.phase ?? null)
      }
      const started = buildToolStartedEvent({
        sessionId: this.sessionId,
        item
      })
      if (!started) return
      if (this.seenToolStarted.has(started.dedupeKey)) return
      this.seenToolStarted.add(started.dedupeKey)
      this.emit('tool.started', started.payload)
      return
    }

    if (method === 'item/completed') {
      const item = params?.item ?? null
      const itemId = item?.id ?? params?.itemId ?? null
      const typeRaw = item?.type ?? null
      const type = normalizeItemType(typeRaw)
      if (type === 'agentmessage') this.#rememberItemPhase(itemId, item?.phase ?? params?.phase ?? null)
      if (type === 'agentmessage') {
        const sawDelta = itemId ? (this.itemState.get(itemId)?.sawDelta ?? false) : false
        if (!sawDelta) {
          const text = tryExtractAgentMessageText(item)
          if (text) {
            const phase = normalizeAgentMessagePhase(item?.phase ?? this.itemState.get(itemId)?.phase ?? null)
            const stream = this.#agentMessageStreamForPhase(phase)
            if (stream === 'normalized' && this.#shouldDropNormalizedChunk(text)) return
            this.#appendTurnText(text, { phase })
            this.#bufferOutput({ stream, text, phase })
          }
        }
      }

      if (type === 'reasoning') {
        const sawDelta = itemId ? (this.itemState.get(itemId)?.sawDelta ?? false) : false
        if (!sawDelta) {
          const text = tryExtractReasoningText(item)
          if (text) {
            if (this.#shouldDropReasoningChunk(text)) return
            this.#bufferOutput({ stream: 'reasoning', text })
          }
        }
      }

      if (type === 'plan') {
        const sawDelta = itemId ? (this.itemState.get(itemId)?.sawDelta ?? false) : false
        if (!sawDelta) {
          const text = tryExtractPlanText(item)
          if (text) {
            this.#bufferOutput({ stream: 'plan', text })
          }
        }
      }

      if (type === 'commandexecution' || type === 'filechange') {
        const tid = safeString(itemId)
        const sawOutput = tid ? (this.itemState.get(tid)?.sawDelta ?? false) : false
        const completed = buildToolCompletedEvent({
          sessionId: this.sessionId,
          item,
          hadOutput: sawOutput
        })
        if (!completed) return
        if (this.seenToolCompleted.has(completed.dedupeKey)) return
        this.seenToolCompleted.add(completed.dedupeKey)
        this.#flushOutputBuffersForItem(completed.itemId)
        this.emit('tool.completed', completed.payload)
      }
      return
    }
  }

  /**
   * @param {{ id: string|number, method: string, params: any }} req
   */
  async #onRequest(req) {
    const { method, params } = req

    // Codex-managed approvals
    if (isApprovalRequestMethod(method)) {
      const approvalId = crypto.randomUUID()
      const decisionP = new Promise((resolve, reject) => {
        this.pendingApprovals.set(approvalId, { resolve, reject })
      })

      this.emit('approval.request', buildApprovalRequestEvent({
        approvalId,
        sessionId: this.sessionId,
        cwd: this.cwd,
        method,
        params
      }))

      // Wait for host/UI decision.
      return await decisionP
    }

    // EXPERIMENTAL: user-input requests (Codex tool call prompting).
    //
    // Method name as of codex-cli 0.106.0 JSON schema generation:
    //   "item/tool/requestUserInput"
    //
    // Docs may also refer to it without the leading "item/" prefix.
    if (isUserInputRequestMethod(method)) {
      const approvalId = crypto.randomUUID()

      const responseP = new Promise((resolve, reject) => {
        this.pendingApprovals.set(approvalId, { resolve, reject })
      })

      this.emit('approval.request', buildUserInputRequestEvent({
        approvalId,
        sessionId: this.sessionId,
        cwd: this.cwd,
        params
      }))

      return await responseP
    }

    // Dynamic tool call (client-side tool execution). Rootgrid v0 does not implement
    // any dynamic tools; return an explicit failure response so the app-server can continue.
    if (method === 'item/tool/call') {
      return { success: false, contentItems: [] }
    }

    // Default: return null so the app-server can proceed (or treat as unsupported).
    return null
  }
}
