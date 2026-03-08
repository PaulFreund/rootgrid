import crypto from 'node:crypto'
import { rm } from 'node:fs/promises'

import {
  findReusableTerminalSession,
  listMatchingTerminalIds,
  serializeTerminalSession
} from './terminalSessionState.js'

export function createHostMachineApi({
  auth,
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
  terminalSessions,
  terminalPtyStartOnRunner,
  terminalExecOnRunner,
  codexModelListOnRunner,
  pendingIdeStarts,
  requestMachineUpgrade
}) {
  function clearPendingIdeStart(ideId) {
    pendingIdeStarts.cancel(ideId)
  }

  return {
    async handle(req, res, url, parts) {
      if (url.pathname === '/api/machines' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const connectedMachineIds = new Set(runnerWs.listConnectedMachineIds())
        json(res, 200, {
          machines: store.listMachines().map((machine) => ({
            ...machine,
            connected: connectedMachineIds.has(machine.machineId)
          }))
        })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'machines' && parts.length === 3 && parts[2] && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return true
        const machineId = parts[2]
        const machine = store.getMachine(machineId)
        if (!machine) {
          json(res, 404, { error: 'not found' })
          return true
        }

        if (runnerWs.listConnectedMachineIds().includes(machineId)) {
          json(res, 409, { error: 'machine is currently connected; disconnect the runner before deleting' })
          return true
        }

        let sessionIds = []
        let uploadPaths = []
        try { sessionIds = store.listSessionIdsByMachine(machineId) } catch {}
        try { uploadPaths = store.listUploadHostPathsByMachine(machineId) } catch {}

        for (const [approvalId, route] of approvals.entries()) {
          if (route?.machineId === machineId) approvals.delete(approvalId)
        }

        const ideIds = []
        for (const [ideId, ide] of ideSessions.entries()) {
          if (ide?.machineId !== machineId) continue
          ideIds.push(ideId)
        }

        const ok = store.deleteMachine(machineId)
        if (!ok) {
          json(res, 404, { error: 'not found' })
          return true
        }

        for (const ideId of ideIds) {
          ideSessions.delete(ideId)
          try { store.deleteIdeSession(ideId) } catch {}
        }
        for (const [terminalId, terminal] of terminalSessions.entries()) {
          if (terminal?.machineId !== machineId) continue
          terminalSessions.delete(terminalId)
        }

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

        for (const hostPath of uploadPaths) {
          if (!hostPath || typeof hostPath !== 'string') continue
          try { await rm(hostPath, { force: true }) } catch { }
        }

        json(res, 200, { ok: true, machineId, deletedSessions: sessionIds.length })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'machines' && parts[2] && parts[3] === 'disconnect' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const machineId = parts[2]
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) {
          json(res, 404, { error: 'runner not connected' })
          return true
        }
        const ok = runnerWs.disconnectMachine(machineId)
        if (!ok) {
          json(res, 404, { error: 'runner not connected' })
          return true
        }
        json(res, 200, { ok: true })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'machines' && parts[2] && parts[3] === 'upgrade' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const machineId = parts[2]
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) {
          json(res, 404, { error: 'runner not connected' })
          return true
        }

        const body = await readJsonBody(req)
        const hostVersion = String(body?.hostVersion ?? '').trim() || null

        try {
          const accepted = await requestMachineUpgrade({ machineId, hostVersion })
          json(res, 200, {
            ok: true,
            machineId,
            accepted: true,
            ...(accepted && typeof accepted === 'object' ? accepted : {})
          })
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (url.pathname === '/api/fs/list' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const preferredMachineId = url.searchParams.get('machineId')
        const machineId = pickMachineId(
          (typeof preferredMachineId === 'string' && preferredMachineId.trim()) ? preferredMachineId.trim() : null
        )
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        const path = url.searchParams.get('path') ?? ''
        const includeFiles = (url.searchParams.get('includeFiles') === '1' || url.searchParams.get('includeFiles') === 'true')
        try {
          const out = await fsListOnRunner({ machineId, path, includeFiles })
          json(res, 200, out)
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (url.pathname === '/api/fs/read' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const preferredMachineId = url.searchParams.get('machineId')
        const machineId = pickMachineId(
          (typeof preferredMachineId === 'string' && preferredMachineId.trim()) ? preferredMachineId.trim() : null
        )
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        const path = url.searchParams.get('path') ?? ''
        if (!path || typeof path !== 'string') {
          json(res, 400, { error: 'path is required' })
          return true
        }
        const maxBytes = Number(url.searchParams.get('maxBytes') ?? 200_000)
        try {
          const out = await fsReadOnRunner({ machineId, path, maxBytes })
          json(res, 200, out)
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (url.pathname === '/api/git/status' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const preferredMachineId = url.searchParams.get('machineId')
        const machineId = pickMachineId(
          (typeof preferredMachineId === 'string' && preferredMachineId.trim()) ? preferredMachineId.trim() : null
        )
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }
        if (!runnerWs.listConnectedMachineIds().includes(machineId)) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        const cwd = url.searchParams.get('cwd') ?? ''
        if (!cwd || typeof cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return true
        }
        try {
          const out = await gitStatusOnRunner({ machineId, cwd })
          json(res, 200, out)
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (url.pathname === '/api/terminal/exec' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const body = await readJsonBody(req)
        const preferredMachineId = body?.machineId ?? null
        const cwd = body?.cwd
        const command = body?.command
        if (!cwd || typeof cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return true
        }
        if (!command || typeof command !== 'string') {
          json(res, 400, { error: 'command is required' })
          return true
        }
        const machineId = pickMachineId(preferredMachineId)
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }
        try {
          const out = await terminalExecOnRunner({
            machineId,
            cwd,
            command,
            timeoutMs: Number(body?.timeoutMs) || 60_000
          })
          json(res, 200, { machineId, ...out })
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (url.pathname === '/api/terminal/sessions' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const body = await readJsonBody(req)
        const preferredMachineId = body?.machineId ?? null
        const cwd = body?.cwd
        const reuse = body?.reuse !== false
        if (!cwd || typeof cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return true
        }
        const machineId = pickMachineId(preferredMachineId)
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }
        if (reuse) {
          const existing = findReusableTerminalSession(terminalSessions, { machineId, cwd })
          if (existing) {
            const cols = Number(body?.cols) || existing.cols || 80
            const rows = Number(body?.rows) || existing.rows || 24
            existing.cols = cols
            existing.rows = rows
            existing.updatedAtMs = Date.now()
            if (existing.connected) {
              try {
                runnerWs.sendToMachine(machineId, makeEnvelope({
                  type: 'terminal.pty.resize',
                  scope: { machineId },
                  payload: {
                    terminalId: existing.terminalId,
                    cols,
                    rows
                  }
                }))
              } catch {
              }
            }
            json(res, 200, serializeTerminalSession(existing, { reused: true }))
            return true
          }
        } else {
          for (const terminalId of listMatchingTerminalIds(terminalSessions, { machineId, cwd })) {
            const existing = terminalSessions.get(terminalId)
            if (existing?.connected) continue
            terminalSessions.delete(terminalId)
          }
        }
        try {
          const out = await terminalPtyStartOnRunner({
            machineId,
            cwd,
            cols: Number(body?.cols) || 80,
            rows: Number(body?.rows) || 24
          })
          const record = terminalSessions.get(String(out?.terminalId ?? '').trim())
          const fallbackCols = Number(body?.cols) || 80
          const fallbackRows = Number(body?.rows) || 24
          json(res, 200, serializeTerminalSession(record ?? {
            terminalId: out?.terminalId,
            machineId,
            cwd: out?.cwd ?? cwd,
            shell: out?.shell ?? '',
            cols: out?.cols ?? fallbackCols,
            rows: out?.rows ?? fallbackRows,
            connected: true
          }, { reused: false }))
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'terminal' && parts[2] === 'sessions' && parts[3] && parts.length === 5 && parts[4] === 'input' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const terminalId = String(parts[3] ?? '').trim()
        const terminal = terminalSessions.get(terminalId)
        if (!terminal) {
          json(res, 404, { error: 'terminal not found' })
          return true
        }
        if (!terminal.connected) {
          json(res, 409, { error: 'terminal not connected' })
          return true
        }
        if (!runnerWs.listConnectedMachineIds().includes(terminal.machineId)) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        const body = await readJsonBody(req)
        const data = String(body?.data ?? '')
        const ok = runnerWs.sendToMachine(terminal.machineId, makeEnvelope({
          type: 'terminal.pty.input',
          scope: { machineId: terminal.machineId },
          payload: { terminalId, data }
        }))
        if (!ok) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        json(res, 202, { ok: true, terminalId })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'terminal' && parts[2] === 'sessions' && parts[3] && parts.length === 5 && parts[4] === 'resize' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const terminalId = String(parts[3] ?? '').trim()
        const terminal = terminalSessions.get(terminalId)
        if (!terminal) {
          json(res, 404, { error: 'terminal not found' })
          return true
        }
        const body = await readJsonBody(req)
        if (!terminal.connected) {
          terminal.cols = Number(body?.cols) || terminal.cols || 80
          terminal.rows = Number(body?.rows) || terminal.rows || 24
          terminal.updatedAtMs = Date.now()
          json(res, 202, { ok: true, terminalId, connected: false })
          return true
        }
        if (!runnerWs.listConnectedMachineIds().includes(terminal.machineId)) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        const ok = runnerWs.sendToMachine(terminal.machineId, makeEnvelope({
          type: 'terminal.pty.resize',
          scope: { machineId: terminal.machineId },
          payload: {
            terminalId,
            cols: Number(body?.cols) || terminal.cols || 80,
            rows: Number(body?.rows) || terminal.rows || 24
          }
        }))
        if (!ok) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }
        terminal.cols = Number(body?.cols) || terminal.cols || 80
        terminal.rows = Number(body?.rows) || terminal.rows || 24
        json(res, 202, { ok: true, terminalId })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'terminal' && parts[2] === 'sessions' && parts[3] && parts.length === 4 && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return true
        const terminalId = String(parts[3] ?? '').trim()
        const terminal = terminalSessions.get(terminalId)
        if (!terminal) {
          json(res, 404, { error: 'terminal not found' })
          return true
        }
        terminalSessions.delete(terminalId)
        try {
          runnerWs.sendToMachine(terminal.machineId, makeEnvelope({
            type: 'terminal.pty.close',
            scope: { machineId: terminal.machineId },
            payload: { terminalId }
          }))
        } catch {
        }
        json(res, 202, { ok: true, terminalId })
        return true
      }

      if (url.pathname === '/api/models' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        const preferredMachineId = url.searchParams.get('machineId')
        const machineId = pickMachineId(
          (typeof preferredMachineId === 'string' && preferredMachineId.trim()) ? preferredMachineId.trim() : null
        )
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }

        const cwd = url.searchParams.get('cwd') ?? ''
        const limitRaw = url.searchParams.get('limit')
        const includeHiddenRaw = url.searchParams.get('includeHidden')
        const limit = (limitRaw === null || limitRaw === undefined) ? 200 : Number(limitRaw)
        const includeHidden = (includeHiddenRaw === '1' || includeHiddenRaw === 'true')

        try {
          const out = await codexModelListOnRunner({ machineId, cwd, limit, includeHidden })
          json(res, 200, { machineId, ...out })
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          json(res, code, { error: String(err?.message ?? err) })
        }
        return true
      }

      if (url.pathname === '/api/ide-sessions' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const body = await readJsonBody(req)
        const cwd = body?.cwd
        const preferredMachineId = body?.machineId ?? null
        if (!cwd || typeof cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return true
        }

        const machineId = pickMachineId(preferredMachineId)
        if (!machineId) {
          json(res, 503, { error: 'no runner connected' })
          return true
        }

        const ideId = crypto.randomUUID()
        const startedP = pendingIdeStarts.create(ideId, {
          machineId,
          timeoutMs: 15_000,
          onTimeout: () => new Error('timeout starting ide session')
        })

        const ok = runnerWs.sendToMachine(machineId, makeEnvelope({
          type: 'ide.start',
          scope: { machineId },
          payload: { ideId, cwd }
        }))
        if (!ok) {
          clearPendingIdeStart(ideId)
          json(res, 503, { error: 'runner not connected' })
          return true
        }

        try {
          await startedP
        } catch (err) {
          json(res, 503, { error: String(err?.message ?? err) })
          return true
        }

        json(res, 200, { ideId, urlPath: `/vscode/${ideId}/` })
        return true
      }

      if (parts[0] === 'api' && parts[1] === 'ide-sessions' && parts[2] && parts[3] === 'stop' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const ideId = parts[2]
        const ide = ideSessions.get(ideId)
        if (!ide) {
          json(res, 404, { error: 'not found' })
          return true
        }

        const ok = runnerWs.sendToMachine(ide.machineId, makeEnvelope({
          type: 'ide.stop',
          scope: { machineId: ide.machineId },
          payload: { ideId }
        }))
        if (!ok) {
          json(res, 503, { error: 'runner not connected' })
          return true
        }

        ideSessions.delete(ideId)
        try { store.deleteIdeSession(ideId) } catch {}
        json(res, 200, { ok: true })
        return true
      }

      return false
    }
  }
}
