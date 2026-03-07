export function buildSessionLabel({ sessionId = null, session = null, cwd = null } = {}) {
  const project = session?.projectLabel ?? null
  if (typeof project === 'string' && project.trim()) return project.trim()
  const dir = session?.cwd ?? cwd
  const cwdBase = (typeof dir === 'string' && dir)
    ? dir.replace(/\/+$/, '').split('/').filter(Boolean).pop()
    : null
  return cwdBase || (sessionId ? String(sessionId).slice(0, 8) : 'Session')
}

export function buildNotificationKey({ type, sessionId = null, approvalId = null, turnId = null } = {}) {
  const kind = String(type ?? '').trim()
  const sid = String(sessionId ?? '').trim()
  const aid = String(approvalId ?? '').trim()
  const tid = String(turnId ?? '').trim()
  if (kind === 'approval.request') return aid ? `approval:${aid}` : (sid ? `approval:${sid}` : 'approval')
  if (kind === 'turn.completed') return sid ? `turn:${sid}:${tid || 'latest'}` : 'turn'
  if (kind === 'session.failed') return sid ? `session.failed:${sid}` : 'session.failed'
  return sid ? `${kind}:${sid}` : kind
}

export function buildApprovalNotificationPayload({ label, sessionId = null, approval = null } = {}) {
  const kind = approval?.kind ?? 'unknown'
  let message = `${String(label ?? 'Session')} · ${String(kind)}`
  const command = approval?.command
  const reason = approval?.reason
  const grantRoot = approval?.grantRoot
  if (typeof command === 'string' && command.trim()) message += `\n${command.trim()}`
  else if (typeof reason === 'string' && reason.trim()) message += `\n${reason.trim()}`
  if (typeof grantRoot === 'string' && grantRoot.trim()) message += `\nGrant: ${grantRoot.trim()}`
  return {
    level: 'error',
    title: 'Approval required',
    message,
    notificationKey: buildNotificationKey({
      type: 'approval.request',
      sessionId,
      approvalId: approval?.approvalId
    })
  }
}

export function buildTurnCompletedNotificationPayload({ label, sessionId = null, turn = null } = {}) {
  const status = turn?.status ?? 'completed'
  if (status === 'interrupted') return null
  const preview = turn?.preview
  const error = turn?.error
  return {
    level: (status === 'failed') ? 'error' : 'success',
    title: (status === 'failed') ? 'Turn failed' : 'Ready',
    message: (status === 'failed')
      ? `${String(label ?? 'Session')}${error ? `\n${String(error)}` : ''}`
      : `${String(label ?? 'Session')}${preview ? `\n${String(preview)}` : ''}`,
    notificationKey: buildNotificationKey({
      type: 'turn.completed',
      sessionId,
      turnId: turn?.turnId ?? turn?.id ?? null
    })
  }
}

export function buildSessionFailedNotificationPayload({ label, sessionId = null, sessionStatus = null } = {}) {
  if (sessionStatus?.status !== 'failed') return null
  const err = sessionStatus?.error
  return {
    level: 'error',
    title: 'Session failed',
    message: `${String(label ?? 'Session')}${err ? `\n${String(err)}` : ''}`,
    notificationKey: buildNotificationKey({
      type: 'session.failed',
      sessionId
    })
  }
}

function maybeSendPush({ push, sse, policy, sessionId, title, message, notificationKey, data }) {
  const shouldPush = push && policy !== 'never' && (
    policy === 'always' || (policy === 'if-not-visible' && !sse.isSessionVisible(sessionId))
  )
  if (!shouldPush) return false
  push.sendToAll({
    title,
    body: message,
    tag: notificationKey,
    data: {
      ...(data ?? {}),
      ...(notificationKey ? { notificationKey } : {})
    }
  }).catch(() => {})
  return true
}

export function createHostRunnerEventHandlers({
  config,
  store,
  sse,
  push,
  approvals,
  ideSessions,
  makeEnvelope,
  getUploadService,
  pendingRunnerCommands,
  pendingFsLists,
  pendingModelLists,
  pendingIdeStarts,
  httpError
}) {
  return {
    onRunnerMessage(msg, { machineId, inserted }) {
      if (getUploadService?.()?.handleRunnerMessage(msg)) return

      if (msg?.type === 'session.command.accepted') {
        const requestId = msg.payload?.requestId
        if (requestId) pendingRunnerCommands.resolve(requestId, msg.payload ?? null)
        return
      }

      if (msg?.type === 'session.command.rejected') {
        const requestId = msg.payload?.requestId
        if (requestId) pendingRunnerCommands.reject(requestId, httpError(400, msg.payload?.error ?? 'runner rejected command'))
        return
      }

      if (msg?.type === 'fs.list.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingFsLists.reject(requestId, new Error(msg.payload?.error ?? 'fs list failed'))
        else pendingFsLists.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'codex.model.list.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingModelLists.reject(requestId, new Error(msg.payload?.error ?? 'model list failed'))
        else pendingModelLists.resolve(requestId, msg.payload)
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
          try { store.upsertIdeSession({ ideId, machineId, cwd, port, basePath }) } catch {}
        }

        pendingIdeStarts.resolve(ideId, { ideId, machineId, cwd, port, basePath })
      }

      if (msg?.type === 'ide.failed') {
        const ideId = msg.payload?.ideId
        if (!ideId) return
        pendingIdeStarts.reject(ideId, new Error(msg.payload?.error ?? 'ide failed'))
        ideSessions.delete(ideId)
        try { store.deleteIdeSession(ideId) } catch {}
      }

      if (msg?.type === 'ide.stopped') {
        const ideId = msg.payload?.ideId
        if (!ideId) return
        ideSessions.delete(ideId)
        try { store.deleteIdeSession(ideId) } catch {}
      }

      if (!inserted) return
      const toastPolicy = config.notifications?.sseToasts ?? 'if-not-visible'
      if (toastPolicy === 'never') return

      const sessionId = msg?.scope?.sessionId ?? msg?.payload?.sessionId ?? null
      const session = sessionId ? store.getSession(sessionId) : null
      const label = buildSessionLabel({
        sessionId,
        session,
        cwd: msg?.payload?.cwd ?? null
      })

      if (msg?.type === 'approval.request') {
        const payload = buildApprovalNotificationPayload({ label, sessionId, approval: msg.payload })
        sse.sendToast(makeEnvelope({
          type: 'toast',
          scope: sessionId ? { machineId, sessionId } : { machineId },
          payload: {
            ...payload,
            ...(sessionId ? { sessionId } : {})
          }
        }), { policy: toastPolicy })

        maybeSendPush({
          push,
          sse,
          policy: config.notifications?.webPush ?? 'if-not-visible',
          sessionId,
          title: payload.title,
          message: payload.message,
          notificationKey: payload.notificationKey,
          data: {
            type: 'approval.request',
            ...(sessionId ? { sessionId } : {}),
            url: sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/'
          }
        })
        return
      }

      if (msg?.type === 'turn.completed' && sessionId) {
        const payload = buildTurnCompletedNotificationPayload({ label, sessionId, turn: msg.payload })
        if (!payload) return
        sse.sendToast(makeEnvelope({
          type: 'toast',
          scope: { machineId, sessionId },
          payload: { ...payload, sessionId }
        }), { policy: toastPolicy })

        maybeSendPush({
          push,
          sse,
          policy: config.notifications?.webPush ?? 'if-not-visible',
          sessionId,
          title: payload.title,
          message: payload.message,
          notificationKey: payload.notificationKey,
          data: {
            type: 'turn.completed',
            sessionId,
            url: `/?session=${encodeURIComponent(sessionId)}`
          }
        })
        return
      }

      if (msg?.type === 'session.status' && sessionId) {
        const payload = buildSessionFailedNotificationPayload({ label, sessionId, sessionStatus: msg.payload })
        if (!payload) return
        sse.sendToast(makeEnvelope({
          type: 'toast',
          scope: { machineId, sessionId },
          payload: { ...payload, sessionId }
        }), { policy: toastPolicy })

        maybeSendPush({
          push,
          sse,
          policy: config.notifications?.webPush ?? 'if-not-visible',
          sessionId,
          title: payload.title,
          message: payload.message,
          notificationKey: payload.notificationKey,
          data: {
            type: 'session.failed',
            sessionId,
            url: `/?session=${encodeURIComponent(sessionId)}`
          }
        })
      }
    },

    onRunnerDisconnect({ machineId }) {
      pendingRunnerCommands.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingFsLists.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingModelLists.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingIdeStarts.rejectByMachine(machineId, new Error('runner disconnected while starting ide session'))
      getUploadService?.()?.handleRunnerDisconnect(machineId)
    },

    onApprovalRequest(msg, { machineId }) {
      const approvalId = msg?.payload?.approvalId
      const sessionId = msg?.payload?.sessionId ?? msg?.scope?.sessionId ?? null
      if (!approvalId || !sessionId) return
      approvals.set(approvalId, { machineId, sessionId })
      try {
        store.upsertApproval({
          approvalId,
          machineId,
          sessionId,
          kind: String(msg?.payload?.kind ?? 'unknown'),
          payload: msg.payload ?? null
        })
      } catch {
      }
    }
  }
}
