import {
  appendTerminalOutputRecord,
  applyTerminalExit,
  applyTerminalStart,
  createTerminalSessionRecord
} from './terminalSessionState.js'

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

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
  onSessionTurnCompleted = null
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

      if (msg?.type === 'machine.tools.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingMachineTools.reject(requestId, httpError(400, msg.payload?.error ?? 'runner tools unavailable'))
        else pendingMachineTools.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'machine.tools.upgrade.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingMachineToolUpgrades.reject(requestId, httpError(400, msg.payload?.error ?? 'runner tool upgrade failed'))
        else pendingMachineToolUpgrades.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'machine.tools.auth.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingMachineToolAuth.reject(requestId, httpError(400, msg.payload?.error ?? 'runner tool auth action failed'))
        else pendingMachineToolAuth.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'fs.list.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingFsLists.reject(requestId, new Error(msg.payload?.error ?? 'fs list failed'))
        else pendingFsLists.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'fs.read.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingFsReads.reject(requestId, new Error(msg.payload?.error ?? 'fs read failed'))
        else pendingFsReads.resolve(requestId, msg.payload)
        return
      }

      if (
        msg?.type === 'git.status.result'
        || msg?.type === 'git.stage.result'
        || msg?.type === 'git.unstage.result'
        || msg?.type === 'git.commit.result'
        || msg?.type === 'git.push.result'
        || msg?.type === 'git.branch.switch.result'
        || msg?.type === 'git.branch.create.result'
      ) {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingGitStatuses.reject(requestId, new Error(msg.payload?.error ?? 'git status failed'))
        else pendingGitStatuses.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'terminal.exec.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) pendingTerminalExecs.reject(requestId, new Error(msg.payload?.error ?? 'terminal command failed'))
        else pendingTerminalExecs.resolve(requestId, msg.payload)
        return
      }

      if (msg?.type === 'terminal.pty.start.result') {
        const requestId = msg.payload?.requestId
        if (!requestId) return
        if (msg.payload?.ok === false) {
          pendingTerminalStarts.reject(requestId, new Error(msg.payload?.error ?? 'terminal failed to start'))
        } else {
          const terminalId = String(msg.payload?.terminalId ?? '').trim()
          if (terminalId) {
            const current = terminalSessions.get(terminalId) ?? null
            terminalSessions.set(terminalId, applyTerminalStart(current, {
              terminalId,
              machineId,
              cwd: msg.payload?.cwd,
              shell: msg.payload?.shell,
              cols: msg.payload?.cols,
              rows: msg.payload?.rows
            }))
          }
          pendingTerminalStarts.resolve(requestId, msg.payload)
        }
        return
      }

      if (msg?.type === 'terminal.pty.output') {
        const terminalId = String(msg.payload?.terminalId ?? '').trim()
        if (!terminalId) return
        const current = terminalSessions.get(terminalId) ?? createTerminalSessionRecord({
          terminalId,
          machineId,
          connected: true
        })
        terminalSessions.set(terminalId, appendTerminalOutputRecord(current, msg.payload?.data ?? ''))
        sse.send(makeEnvelope({
          type: 'terminal.pty.output',
          scope: { machineId, terminalId },
          payload: {
            machineId,
            terminalId,
            data: String(msg.payload?.data ?? '')
          }
        }), { recordHistory: false })
        return
      }

      if (msg?.type === 'terminal.pty.exit') {
        const terminalId = String(msg.payload?.terminalId ?? '').trim()
        if (!terminalId) return
        const current = terminalSessions.get(terminalId) ?? createTerminalSessionRecord({
          terminalId,
          machineId
        })
        terminalSessions.set(terminalId, applyTerminalExit(current, {
          exitCode: msg.payload?.exitCode,
          signal: msg.payload?.signal
        }))
        sse.send(makeEnvelope({
          type: 'terminal.pty.exit',
          scope: { machineId, terminalId },
          payload: {
            machineId,
            terminalId,
            exitCode: toOptionalNumber(msg.payload?.exitCode),
            signal: toOptionalNumber(msg.payload?.signal)
          }
        }), { recordHistory: false })
        return
      }

      if (msg?.type === 'machine.upgrade.accepted') {
        const requestId = msg.payload?.requestId
        if (requestId) pendingMachineUpgrades.resolve(requestId, msg.payload ?? null)
        return
      }

      if (msg?.type === 'machine.upgrade.rejected') {
        const requestId = msg.payload?.requestId
        if (requestId) pendingMachineUpgrades.reject(requestId, httpError(400, msg.payload?.error ?? 'runner rejected upgrade'))
        return
      }

      if (msg?.type === 'machine.upgrade.state') {
        sse.send(makeEnvelope({
          type: 'registry.machine.upsert',
          scope: { machineId },
          payload: {
            machineId,
            upgrade: {
              state: String(msg.payload?.state ?? 'unknown'),
              ...(msg.payload?.message ? { message: String(msg.payload.message) } : {}),
              updatedAtMs: Date.now()
            }
          }
        }))
        return
      }

      if (msg?.type === 'machine.upgrade.bundle.received') {
        const requestId = msg.payload?.requestId
        if (requestId) pendingMachineUpgradeTransfers.resolve(requestId, msg.payload ?? null)
        return
      }

      if (msg?.type === 'machine.upgrade.bundle.failed') {
        const requestId = msg.payload?.requestId
        if (requestId) pendingMachineUpgradeTransfers.reject(requestId, httpError(400, msg.payload?.error ?? 'upgrade bundle failed'))
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
        try {
          onSessionTurnCompleted?.({ sessionId, machineId, payload: msg.payload ?? null })
        } catch {
        }
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
      pendingMachineTools.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingMachineToolUpgrades.rejectByMachine(machineId, httpError(503, 'runner disconnected while upgrading tool'))
      pendingMachineToolAuth.rejectByMachine(machineId, httpError(503, 'runner disconnected while updating tool authentication'))
      pendingMachineUpgrades.rejectByMachine(machineId, httpError(503, 'runner disconnected while upgrading'))
      pendingMachineUpgradeTransfers.rejectByMachine(machineId, httpError(503, 'runner disconnected while installing upgrade'))
      pendingFsLists.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingFsReads.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingGitStatuses.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingTerminalStarts.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingTerminalExecs.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingModelLists.rejectByMachine(machineId, httpError(503, 'runner disconnected'))
      pendingIdeStarts.rejectByMachine(machineId, new Error('runner disconnected while starting ide session'))
      for (const [terminalId, terminal] of terminalSessions.entries()) {
        if (terminal?.machineId !== machineId) continue
        terminalSessions.set(terminalId, applyTerminalExit(terminal, {
          disconnected: true
        }))
        sse.send(makeEnvelope({
          type: 'terminal.pty.exit',
          scope: { machineId, terminalId },
          payload: {
            machineId,
            terminalId,
            exitCode: null,
            signal: null,
            disconnected: true
          }
        }), { recordHistory: false })
      }
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
