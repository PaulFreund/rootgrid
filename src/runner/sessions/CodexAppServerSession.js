import crypto from 'node:crypto'

import { JsonRpcStdioClient } from './JsonRpcStdioClient.js'

function uniqStrings(values) {
  const out = []
  const seen = new Set()
  for (const v of values) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function approvalPolicyCandidates(input) {
  if (!input) return []
  const raw = String(input).trim()
  if (!raw) return []

  const out = []

  // App-server style values (Codex v2+).
  if (raw === 'untrusted') out.push('unlessTrusted')
  if (raw === 'on-request') out.push('onRequest')
  if (raw === 'on-failure') out.push('onFailure')
  if (raw === 'never') out.push('never')

  // Already app-server style.
  if (raw === 'unlessTrusted' || raw === 'onRequest' || raw === 'onFailure' || raw === 'never') out.push(raw)

  // Legacy CLI-style strings (still used in `config.toml`).
  if (raw === 'untrusted' || raw === 'on-request' || raw === 'on-failure' || raw === 'never') out.push(raw)

  return uniqStrings(out)
}

function sandboxCandidates(input) {
  if (!input) return []
  const raw = String(input).trim()
  if (!raw) return []

  const out = []

  // App-server style values.
  if (raw === 'read-only') out.push('readOnly')
  if (raw === 'workspace-write') out.push('workspaceWrite')
  if (raw === 'danger-full-access') out.push('dangerFullAccess')

  // Already app-server style.
  if (raw === 'readOnly' || raw === 'workspaceWrite' || raw === 'dangerFullAccess' || raw === 'externalSandbox') out.push(raw)

  // Legacy CLI-style strings.
  if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') out.push(raw)

  return uniqStrings(out)
}

function sandboxPolicyCandidates(input, cwd) {
  const modes = sandboxCandidates(input)

  const toType = (mode) => {
    if (mode === 'read-only') return 'readOnly'
    if (mode === 'workspace-write') return 'workspaceWrite'
    if (mode === 'danger-full-access') return 'dangerFullAccess'
    if (mode === 'readOnly' || mode === 'workspaceWrite' || mode === 'dangerFullAccess' || mode === 'externalSandbox') return mode
    return null
  }

  /** @type {any[]} */
  const out = []
  for (const m of modes) {
    const type = toType(m)
    if (!type) continue

    out.push({ type })

    // Best-effort: some schemas are pickier about workspace roots.
    if (type === 'workspaceWrite' && typeof cwd === 'string' && cwd) {
      out.push({ type, writableRoots: [cwd] })
    }
  }

  const seen = new Set()
  const deduped = []
  for (const obj of out) {
    const key = JSON.stringify(obj)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(obj)
  }
  return deduped
}

function tryExtractDeltaText(params) {
  // Best-effort: schemas may evolve.
  const candidates = [
    params?.delta,
    params?.textDelta,
    params?.outputDelta,
    params?.chunk,
    params?.text
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
    if (c && typeof c === 'object') {
      if (typeof c.text === 'string' && c.text.length > 0) return c.text
      if (typeof c.delta === 'string' && c.delta.length > 0) return c.delta
      if (typeof c.value === 'string' && c.value.length > 0) return c.value
    }
  }
  return null
}

function tryExtractAgentMessageText(item) {
  if (!item || typeof item !== 'object') return null
  const content = item.content ?? item.message ?? item.text ?? null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const p of content) {
      if (typeof p === 'string') parts.push(p)
      else if (p && typeof p === 'object') {
        if (typeof p.text === 'string') parts.push(p.text)
        else if (typeof p.content === 'string') parts.push(p.content)
        else if (typeof p.value === 'string') parts.push(p.value)
      }
    }
    const joined = parts.join('')
    return joined ? joined : null
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
  }
  return null
}

function tryExtractReasoningText(item) {
  if (!item || typeof item !== 'object') return null

  // Prefer summary if present (often safer/shorter).
  const summary = item.summary ?? item.summary_text ?? item.summaryText ?? null
  if (Array.isArray(summary)) {
    const parts = summary.filter((x) => typeof x === 'string' && x.length > 0)
    const joined = parts.join('\n')
    if (joined) return joined
  }

  const content = item.content ?? null
  if (Array.isArray(content)) {
    const parts = content.filter((x) => typeof x === 'string' && x.length > 0)
    const joined = parts.join('')
    if (joined) return joined
  }

  return tryExtractAgentMessageText(item)
}

function tryExtractPlanText(item) {
  if (!item || typeof item !== 'object') return null
  const text = safeString(item.text)
  if (text) return text
  return tryExtractAgentMessageText(item)
}

function normalizeItemType(value) {
  if (typeof value !== 'string') return null
  const t = value.toLowerCase().replace(/[\s_-]/g, '')
  return t || null
}

function safeString(value) {
  return (typeof value === 'string' && value.trim()) ? value : null
}

function minimizeFileChanges(changes) {
  if (!Array.isArray(changes)) return null
  const out = []
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue
    const path = safeString(c.path)
    const kind = safeString(c.kind)
    if (!path) continue
    out.push({ path, ...(kind ? { kind } : {}) })
  }
  return out
}

export class CodexAppServerSession {
  /**
   * @param {{
   *   sessionId: string,
   *   cwd: string,
   *   options: any,
   *   emit: (type: string, payload: any) => void,
   * }} opts
   */
  constructor({ sessionId, cwd, options, emit }) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.options = options ?? null
    this.emit = emit

    this.outputSeq = 0
    this.threadId = null
    this.activeTurnId = null
    this.started = false
    this.turnText = ''
    this.turnTextMax = 8_000

    // Dedupe guards. Some Codex app-server builds emit both a wrapped event
    // stream (`codex/event/*`) *and* direct v2-style notifications, which can
    // otherwise cause duplicated turn boundaries and duplicated output chunks.
    this.lastTurnStartedId = null
    this.lastTurnCompletedId = null
    this.lastNormalizedChunk = { text: null, tsMs: 0 }

    /** @type {Map<string, { resolve: (v:any)=>void, reject:(e:any)=>void }>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, { sawDelta: boolean }>} */
    this.itemState = new Map()
    /** @type {Map<string, string>} */
    this.lastDeltaByKey = new Map()

    this.rpc = new JsonRpcStdioClient({
      command: 'codex',
      args: ['app-server'],
      cwd: this.cwd,
      env: process.env,
      onNotification: (msg) => this.#onNotification(msg),
      onRequest: (msg) => this.#onRequest(msg),
      onStderr: (chunk) => {
        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'stderr',
          text: chunk
        })
      },
      onExit: ({ code, signal }) => {
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

  #appendTurnText(chunk) {
    if (!chunk) return
    this.turnText += String(chunk)
    if (this.turnText.length > this.turnTextMax) {
      this.turnText = this.turnText.slice(this.turnText.length - this.turnTextMax)
    }
  }

  #turnPreview() {
    const t = String(this.turnText ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return null
    return t.length > 200 ? `${t.slice(0, 197)}…` : t
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

    /** @type {any} */
    let threadRes = null
    /** @type {string|null} */
    let effectiveThreadId = null

    if (threadId && typeof threadId === 'string') {
      const approvalVals = approvalPolicies.length ? approvalPolicies : [null]
      const sandboxVals = sandboxes.length ? sandboxes : [null]
      const paramVariants = []

      for (const ap of approvalVals) {
        for (const sb of sandboxVals) {
          paramVariants.push({
            threadId,
            cwd: this.cwd,
            ...(model ? { model } : {}),
            ...(ap ? { approvalPolicy: ap } : {}),
            ...(sb ? { sandbox: sb } : {})
          })
          // Older/alternate schema (best-effort): some builds used `id` instead of `threadId`.
          paramVariants.push({
            id: threadId,
            cwd: this.cwd,
            ...(model ? { model } : {}),
            ...(ap ? { approvalPolicy: ap } : {}),
            ...(sb ? { sandbox: sb } : {})
          })
        }
      }

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
      const approvalVals = approvalPolicies.length ? approvalPolicies : [null]
      const sandboxVals = sandboxes.length ? sandboxes : [null]
      let startedOk = false
      let lastErr = null
      for (const ap of approvalVals) {
        for (const sb of sandboxVals) {
          try {
            threadRes = await this.rpc.sendRequest('thread/start', {
              ...(model ? { model } : {}),
              cwd: this.cwd,
              ...(ap ? { approvalPolicy: ap } : {}),
              ...(sb ? { sandbox: sb } : {})
            })
            startedOk = true
            break
          } catch (err) {
            lastErr = err
          }
        }
        if (startedOk) break
      }
      if (!startedOk) throw lastErr ?? new Error('thread/start failed')
      effectiveThreadId = threadRes?.thread?.id ?? threadRes?.threadId ?? threadRes?.id ?? null
    }

    this.threadId = effectiveThreadId

    this.emit('session.status', {
      sessionId: this.sessionId,
      status: 'running',
      ...(effectiveThreadId ? { codexThreadId: effectiveThreadId } : {})
    })

    await this.#startTurn(input)
  }

  async send(input) {
    if (!this.threadId) throw new Error('session not started')
    await this.#startTurn(input)
  }

  /**
   * Update the per-session Codex options (applied on the next `turn/start`).
   * @param {{ model?: string|null, approvalPolicy?: string|null, sandbox?: string|null }} patch
   */
  updateOptions(patch) {
    if (!patch || typeof patch !== 'object') return
    const next = { ...(this.options ?? {}) }
    if ('model' in patch) next.model = (typeof patch.model === 'string' && patch.model.trim()) ? patch.model.trim() : (patch.model ?? null)
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
        const preview = this.#turnPreview()
        this.emit('turn.completed', {
          sessionId: this.sessionId,
          turnId: tid,
          status: 'interrupted',
          ...(preview ? { preview } : {})
        })
        this.activeTurnId = null
        this.turnText = ''
      }
      const timer = setTimeout(done, 1_500)
      timer.unref?.()
    }
  }

  async stop() {
    // Best-effort graceful.
    await this.cancel()
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

    const base = {
      threadId: this.threadId,
      cwd: this.cwd,
      input: items
    }

    const approvalVals = approvalPolicies.length ? approvalPolicies : [null]
    const sandboxPolicyVals = sandboxPolicies.length ? sandboxPolicies : [null]
    const sandboxVals = sandboxes.length ? sandboxes : [null]

    /** @type {any[]} */
    const attempts = []

    // Prefer the documented v2-style `sandboxPolicy`, but keep fallbacks for older schemas.
    for (const ap of approvalVals) {
      for (const sp of sandboxPolicyVals) {
        attempts.push({
          ...base,
          ...(model ? { model } : {}),
          ...(ap ? { approvalPolicy: ap } : {}),
          ...(sp ? { sandboxPolicy: sp } : {})
        })
      }
      for (const sb of sandboxVals) {
        attempts.push({
          ...base,
          ...(model ? { model } : {}),
          ...(ap ? { approvalPolicy: ap } : {}),
          ...(sb ? { sandbox: sb } : {})
        })
      }
    }

    // Final fallback: no per-turn overrides.
    attempts.push({
      ...base,
      ...(model ? { model } : {})
    })

    const seen = new Set()
    const uniqueAttempts = []
    for (const a of attempts) {
      const key = JSON.stringify(a)
      if (seen.has(key)) continue
      seen.add(key)
      uniqueAttempts.push(a)
    }

    let lastErr = null
    for (const params of uniqueAttempts) {
      try {
        await this.rpc.sendRequest('turn/start', params)
        return
      } catch (err) {
        lastErr = err
      }
    }

    throw lastErr ?? new Error('turn/start failed')
  }

  /**
   * @param {{ method: string, params: any }} msg
   */
  #onNotification(msg) {
    const { method, params } = msg

    // Some Codex builds emit a wrapped event stream under `codex/event/*` where the
    // real event discriminator lives in `params.msg.type`. Normalize a few common
    // ones back into the v2-style notification methods we already handle.
    if (typeof method === 'string' && method.startsWith('codex/event/')) {
      const wrapped = params?.msg
      const msgType = safeString(wrapped?.type)
      if (!msgType) return

      const turnId = safeString(wrapped?.turn_id ?? wrapped?.turnId)

      if (msgType === 'item_started' || msgType === 'item_completed') {
        const itemMethod = (msgType === 'item_started') ? 'item/started' : 'item/completed'
        const item = wrapped?.item ?? null
        const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? item?.id)
        const threadId = safeString(wrapped?.thread_id ?? wrapped?.threadId)
        this.#onNotification({
          method: itemMethod,
          params: {
            ...(item ? { item } : {}),
            ...(itemId ? { itemId } : {}),
            ...(threadId ? { threadId } : {}),
            ...(turnId ? { turnId } : {})
          }
        })
        return
      }

      if (msgType === 'task_started' && turnId) {
        this.#onNotification({ method: 'turn/started', params: { turn: { id: turnId } } })
        return
      }

      if ((msgType === 'task_complete' || msgType === 'turn_complete') && turnId) {
        this.#onNotification({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } })
        return
      }

      if (msgType === 'turn_aborted' && turnId) {
        this.#onNotification({ method: 'turn/completed', params: { turn: { id: turnId, status: 'interrupted' } } })
        return
      }

      if (msgType === 'task_failed' && turnId) {
        const err = safeString(wrapped?.error ?? wrapped?.message ?? wrapped?.reason ?? wrapped?.error_message)
        this.#onNotification({
          method: 'turn/completed',
          params: { turn: { id: turnId, status: 'failed', ...(err ? { error: { message: err } } : {}) } }
        })
        return
      }

      if (msgType === 'agent_message_delta' || msgType === 'agent_message_content_delta') {
        const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id) ?? 'agent-message'
        const delta = safeString(wrapped?.delta ?? wrapped?.text ?? wrapped?.message)
        if (!delta) return
        this.#onNotification({ method: 'item/agentMessage/delta', params: { itemId, delta } })
        return
      }

      if (msgType === 'reasoning_content_delta' || msgType === 'agent_reasoning_delta') {
        const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id) ?? 'reasoning'
        const delta = safeString(wrapped?.delta ?? wrapped?.text ?? wrapped?.message)
        if (!delta) return
        const summaryIndex = wrapped?.summary_index ?? wrapped?.summaryIndex ?? null
        this.#onNotification({
          method: 'item/reasoning/summaryTextDelta',
          params: {
            itemId,
            delta,
            ...(Number.isFinite(Number(summaryIndex)) ? { summaryIndex: Number(summaryIndex) } : {})
          }
        })
        return
      }

      if (msgType === 'agent_reasoning_section_break') {
        const itemId = safeString(wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id) ?? 'reasoning'
        const summaryIndex = wrapped?.summary_index ?? wrapped?.summaryIndex ?? null
        this.#onNotification({
          method: 'item/reasoning/summaryPartAdded',
          params: {
            itemId,
            ...(Number.isFinite(Number(summaryIndex)) ? { summaryIndex: Number(summaryIndex) } : {})
          }
        })
        return
      }

      if (msgType === 'token_count') {
        const info = wrapped?.info ?? null
        const rateLimits = wrapped?.rate_limits ?? wrapped?.rateLimits ?? null
        this.emit('token.count', {
          sessionId: this.sessionId,
          ...(info ? { info } : {}),
          ...(rateLimits ? { rateLimits } : {})
        })
        return
      }

      if (msgType === 'exec_command_output_delta') {
        const itemId = safeString(wrapped?.call_id ?? wrapped?.callId ?? wrapped?.item_id ?? wrapped?.itemId ?? wrapped?.id)
        const delta = safeString(wrapped?.delta ?? wrapped?.output ?? wrapped?.stdout ?? wrapped?.text)
        if (!itemId || !delta) return
        this.#onNotification({ method: 'item/commandExecution/outputDelta', params: { itemId, delta } })
        return
      }

      if (msgType === 'error') {
        const willRetry = Boolean(wrapped?.will_retry ?? wrapped?.willRetry)
        const message = safeString(wrapped?.message)
        this.#onNotification({ method: 'error', params: { willRetry, message } })
        return
      }

      // Ignore unknown wrapped message types (best-effort).
      return
    }

    if (method === 'error') {
      const willRetry = Boolean(params?.willRetry ?? params?.will_retry)
      if (willRetry) return
      const errorMessage = safeString(params?.error?.message ?? params?.message) ?? 'Unknown error'
      const details = safeString(params?.error?.additionalDetails ?? params?.details)
      const codexErrorInfo = params?.error?.codexErrorInfo ?? null
      const extra = []
      if (details) extra.push(details)
      if (codexErrorInfo) {
        try { extra.push(JSON.stringify(codexErrorInfo)) } catch { }
      }
      const text = `[codex] ${errorMessage}${extra.length ? `\n${extra.join('\n')}` : ''}\n`
      this.emit('session.output', {
        sessionId: this.sessionId,
        seq: this.nextSeq(),
        stream: 'stderr',
        text
      })
      return
    }

    if (method === 'turn/started') {
      const nextTurnId = params?.turn?.id ?? params?.turnId ?? null

      // Deduplicate repeated turn start notifications.
      if (this.activeTurnId && (!nextTurnId || nextTurnId === this.activeTurnId)) return
      if (nextTurnId && nextTurnId === this.lastTurnStartedId) return

      this.activeTurnId = nextTurnId ?? this.activeTurnId ?? null
      this.lastTurnStartedId = this.activeTurnId
      this.turnText = ''
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

      const preview = this.#turnPreview()
      this.emit('turn.completed', {
        sessionId: this.sessionId,
        ...(tid ? { turnId: tid } : {}),
        ...(status ? { status } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(preview ? { preview } : {})
      })

      if (status === 'failed' && errorMessage) {
        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'stderr',
          text: `[codex] Turn failed: ${errorMessage}\n`
        })
      }

      this.activeTurnId = null
      this.turnText = ''
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
      const threadId = safeString(params?.threadId)
      const turnId = safeString(params?.turnId)
      const tokenUsage = params?.tokenUsage ?? null
      this.emit('thread.tokenUsage.updated', {
        sessionId: this.sessionId,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(tokenUsage ? { tokenUsage } : {})
      })
      return
    }

    if (method === 'turn/plan/updated') {
      const threadId = safeString(params?.threadId)
      const turnId = safeString(params?.turnId)
      const explanation = safeString(params?.explanation)
      const plan = Array.isArray(params?.plan) ? params.plan : null
      if (!plan) return
      this.emit('plan.updated', {
        sessionId: this.sessionId,
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(explanation ? { explanation } : {}),
        plan
      })
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
        const key = `agent:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)
        if (this.#shouldDropNormalizedChunk(text)) return

        this.#appendTurnText(text)
        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'normalized',
          text
        })
      }
      return
    }

    if (method === 'item/reasoning/summaryPartAdded') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      const summaryIndex = params?.summaryIndex ?? null
      const key = `reasoning-part:${itemId ?? ''}:${summaryIndex ?? ''}`
      if (this.lastDeltaByKey.get(key) === '1') return
      this.lastDeltaByKey.set(key, '1')

      this.emit('session.output', {
        sessionId: this.sessionId,
        seq: this.nextSeq(),
        stream: 'reasoning',
        text: '\n\n'
      })
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
        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'reasoning',
          text
        })
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
        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'plan',
          text
        })
      }
      return
    }

    if (method === 'item/commandExecution/outputDelta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      const text = tryExtractDeltaText(params)
      if (text) {
        const key = `cmd:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)

        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'stdout',
          text,
          ...(itemId ? { itemId: safeString(itemId) } : {})
        })
      }
      return
    }

    if (method === 'item/fileChange/outputDelta') {
      const itemId = params?.itemId ?? params?.item?.id ?? null
      const text = tryExtractDeltaText(params)
      if (text) {
        const key = `patch:${itemId ?? ''}`
        if (this.lastDeltaByKey.get(key) === text) return
        this.lastDeltaByKey.set(key, text)

        this.emit('session.output', {
          sessionId: this.sessionId,
          seq: this.nextSeq(),
          stream: 'stdout',
          text,
          ...(itemId ? { itemId: safeString(itemId) } : {})
        })
      }
      return
    }

    if (method === 'item/commandExecution/terminalInteraction') {
      const stdin = safeString(params?.stdin)
      const itemId = safeString(params?.itemId)
      const text = `[codex] terminal interaction${itemId ? ` (${itemId})` : ''}${stdin ? `: ${stdin}` : ''}\n`
      this.emit('session.output', {
        sessionId: this.sessionId,
        seq: this.nextSeq(),
        stream: 'stderr',
        text,
        ...(itemId ? { itemId } : {})
      })
      return
    }

    if (method === 'item/started') {
      const item = params?.item ?? null
      const type = normalizeItemType(item?.type)
      const itemId = safeString(item?.id)
      if (!type || !itemId) return

      if (type === 'commandexecution') {
        this.emit('tool.started', {
          sessionId: this.sessionId,
          tool: 'commandExecution',
          itemId,
          command: item.command,
          cwd: item.cwd,
          commandActions: item.commandActions ?? null,
          status: item.status ?? null
        })
      }

      if (type === 'filechange') {
        this.emit('tool.started', {
          sessionId: this.sessionId,
          tool: 'fileChange',
          itemId,
          changes: minimizeFileChanges(item.changes),
          status: item.status ?? null
        })
      }

      return
    }

    if (method === 'item/completed') {
      const item = params?.item ?? null
      const itemId = item?.id ?? params?.itemId ?? null
      const typeRaw = item?.type ?? null
      const type = normalizeItemType(typeRaw)
      if (type === 'agentmessage') {
        const sawDelta = itemId ? (this.itemState.get(itemId)?.sawDelta ?? false) : false
        if (!sawDelta) {
          const text = tryExtractAgentMessageText(item)
          if (text) {
            if (this.#shouldDropNormalizedChunk(text)) return
            this.#appendTurnText(text)
            this.emit('session.output', {
              sessionId: this.sessionId,
              seq: this.nextSeq(),
              stream: 'normalized',
              text
            })
          }
        }
      }

      if (type === 'reasoning') {
        const sawDelta = itemId ? (this.itemState.get(itemId)?.sawDelta ?? false) : false
        if (!sawDelta) {
          const text = tryExtractReasoningText(item)
          if (text) {
            this.emit('session.output', {
              sessionId: this.sessionId,
              seq: this.nextSeq(),
              stream: 'reasoning',
              text
            })
          }
        }
      }

      if (type === 'plan') {
        const sawDelta = itemId ? (this.itemState.get(itemId)?.sawDelta ?? false) : false
        if (!sawDelta) {
          const text = tryExtractPlanText(item)
          if (text) {
            this.emit('session.output', {
              sessionId: this.sessionId,
              seq: this.nextSeq(),
              stream: 'plan',
              text
            })
          }
        }
      }

      if (type === 'commandexecution') {
        this.emit('tool.completed', {
          sessionId: this.sessionId,
          tool: 'commandExecution',
          itemId: safeString(itemId),
          command: item.command,
          cwd: item.cwd,
          commandActions: item.commandActions ?? null,
          status: item.status ?? null,
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null
        })
      }

      if (type === 'filechange') {
        this.emit('tool.completed', {
          sessionId: this.sessionId,
          tool: 'fileChange',
          itemId: safeString(itemId),
          changes: minimizeFileChanges(item.changes),
          status: item.status ?? null
        })
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
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const approvalId = crypto.randomUUID()
      const kind = method.includes('commandExecution') ? 'command' : 'fileChange'

      const itemId = params?.itemId ?? params?.item?.id ?? null
      const threadId = params?.threadId ?? null
      const turnId = params?.turnId ?? null
      const approvalCallbackId = params?.approvalId ?? null

      const reason = params?.reason ?? params?.prompt ?? null
      const command = params?.command ?? params?.item?.command ?? null
      const cwd = params?.cwd ?? this.cwd ?? null

      const availableDecisions = params?.availableDecisions ?? null
      const additionalPermissions = params?.additionalPermissions ?? null
      const commandActions = params?.commandActions ?? null
      const proposedExecpolicyAmendment = params?.proposedExecpolicyAmendment ?? null
      const proposedNetworkPolicyAmendments = params?.proposedNetworkPolicyAmendments ?? null
      const networkApprovalContext = params?.networkApprovalContext ?? null
      const grantRoot = params?.grantRoot ?? null

      const decisionP = new Promise((resolve, reject) => {
        this.pendingApprovals.set(approvalId, { resolve, reject })
      })

      this.emit('approval.request', {
        approvalId,
        sessionId: this.sessionId,
        kind,
        ...(itemId ? { itemId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(approvalCallbackId ? { approvalCallbackId } : {}),
        ...(reason ? { reason } : {}),
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(grantRoot ? { grantRoot } : {}),
        ...(availableDecisions ? { availableDecisions } : {}),
        ...(additionalPermissions ? { additionalPermissions } : {}),
        ...(commandActions ? { commandActions } : {}),
        ...(proposedExecpolicyAmendment ? { proposedExecpolicyAmendment } : {}),
        ...(proposedNetworkPolicyAmendments ? { proposedNetworkPolicyAmendments } : {}),
        ...(networkApprovalContext ? { networkApprovalContext } : {})
      })

      // Wait for host/UI decision.
      return await decisionP
    }

    // EXPERIMENTAL: user-input requests (Codex tool call prompting).
    //
    // Method name as of codex-cli 0.106.0 JSON schema generation:
    //   "item/tool/requestUserInput"
    //
    // Docs may also refer to it without the leading "item/" prefix.
    if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
      const approvalId = crypto.randomUUID()

      const questions = Array.isArray(params?.questions) ? params.questions : []
      const itemId = params?.itemId ?? null
      const threadId = params?.threadId ?? null
      const turnId = params?.turnId ?? null

      const responseP = new Promise((resolve, reject) => {
        this.pendingApprovals.set(approvalId, { resolve, reject })
      })

      this.emit('approval.request', {
        approvalId,
        sessionId: this.sessionId,
        kind: 'userInput',
        ...(itemId ? { itemId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        questions,
        ...(this.cwd ? { cwd: this.cwd } : {})
      })

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
