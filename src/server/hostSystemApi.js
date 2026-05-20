import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'

import { ROOTGRID_VERSION } from '../lib/rootgridVersion.js'
import { normalizeRuntimeSettings, readRuntimeSettingsFromConfig, applyRuntimeSettingsToConfig } from '../lib/runtimeSettings.js'
import { buildHostSelfUpdatePublicState } from './hostSelfUpdateManager.js'

const SNAPSHOT_SESSION_LIMIT = 150

function resolveAppSettings({ config, store }) {
  const fallback = readRuntimeSettingsFromConfig(config)
  try {
    const stored = store?.getAppSettings?.()
    if (stored) return normalizeRuntimeSettings(stored, fallback)
  } catch {
  }
  return fallback
}

async function buildSettingsPayload(config, {
  store = null,
  appSettings = null,
  hostSelfUpdate = null
} = {}) {
  const settings = normalizeRuntimeSettings(appSettings, resolveAppSettings({ config, store }))
  const hostSelfUpdateState = hostSelfUpdate?.getPublicState
    ? await hostSelfUpdate.getPublicState()
    : buildHostSelfUpdatePublicState(config)
  const appVersion = String(hostSelfUpdateState?.installed?.version ?? ROOTGRID_VERSION ?? '').trim() || null
  return {
    appVersion,
    retentionDays: settings.retentionDays,
    notifications: {
      sseToasts: settings.notifications.sseToasts,
      webPush: settings.notifications.webPush,
      sound: settings.notifications.sound === true
    },
    host: {
      enabled: config.host.enabled,
      listen: config.host.listen,
      publicUrl: config.host.publicUrl,
      trustProxy: config.host.trustProxy,
      selfUpdate: hostSelfUpdateState
    },
    runner: {
      enabled: config.runner.enabled,
      machineId: config.runner.machineId,
      machineName: config.runner.machineName
    }
  }
}

export function createHostSystemApi({
  auth,
  store,
  runnerWs,
  sse,
  push,
  config,
  runnerInstall = null,
  hostSelfUpdate = null,
  readJsonBody,
  json
}) {
  return {
    async handle(req, res, url, parts) {
      if ((url.pathname === '/install/runner.sh' || url.pathname === '/api/install/runner.sh') && req.method === 'GET') {
        const installToken = url.searchParams.get('installToken')
        const script = await runnerInstall?.renderInstallScript?.(req, installToken)
        if (!script) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end('invalid or expired install token\n')
          return true
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(script)
        return true
      }

      if (url.pathname === '/api/install/runner-bundle' && req.method === 'GET') {
        const installToken = url.searchParams.get('installToken')
        const bundle = await runnerInstall?.getBundleForToken?.(installToken)
        if (!bundle?.bundlePath) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify({ error: 'invalid or expired install token' }))
          return true
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/gzip')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Disposition', `attachment; filename="${String(bundle.filename ?? 'rootgrid-runner.tgz').replaceAll('"', '')}"`)
        if (Number.isFinite(Number(bundle.sizeBytes)) && Number(bundle.sizeBytes) > 0) {
          res.setHeader('Content-Length', String(Number(bundle.sizeBytes)))
        }
        const stream = createReadStream(bundle.bundlePath)
        stream.on('error', () => {
          try {
            if (!res.headersSent) res.statusCode = 500
            res.end()
          } catch {
          }
        })
        stream.pipe(res)
        return true
      }

      if (url.pathname === '/api/auth' && req.method === 'POST') {
        const body = await readJsonBody(req)
        auth.handleAuth(req, res, body)
        return true
      }

      if (url.pathname === '/api/auth' && req.method === 'DELETE') {
        auth.handleLogout(req, res)
        return true
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true

        const connectionId = crypto.randomUUID()
        const visibility = (url.searchParams.get('visibility') === 'hidden') ? 'hidden' : 'visible'
        const all = (url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true')
        const sessionId = url.searchParams.get('sessionId')
        const machineId = url.searchParams.get('machineId')
        const resume = (url.searchParams.get('resume') === '1' || url.searchParams.get('resume') === 'true')
        const lastEventIdHeader = req.headers['last-event-id']
        const lastEventIdRaw = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : (lastEventIdHeader ?? url.searchParams.get('lastEventId'))
        const lastEventId = Number(lastEventIdRaw)
        const replayAfter = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : null
        const canResumeWithoutSnapshot = Boolean(resume && replayAfter && sse.canReplayFrom(replayAfter))

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        res.setHeader('Connection', 'keep-alive')
        res.write('\n')

        sse.addClient({
          id: connectionId,
          res,
          visibility,
          all,
          sessionId,
          machineId,
          active: false
        })

        const connectedMachineIds = canResumeWithoutSnapshot
          ? null
          : new Set(runnerWs.listConnectedMachineIds())
        const sessionPage = canResumeWithoutSnapshot
          ? null
          : store.listSessionsPage({ limit: SNAPSHOT_SESSION_LIMIT })

        sse.sendDirect({
          id: connectionId,
          res,
          recordHistory: false,
          envelope: {
            v: 1,
            type: canResumeWithoutSnapshot ? 'registry.hello' : 'registry.snapshot',
            ts: Date.now(),
            id: crypto.randomUUID(),
            scope: null,
            payload: canResumeWithoutSnapshot
              ? {
                  connectionId,
                  resumed: true
                }
              : {
                  connectionId,
                  machines: store.listMachines().map((machine) => ({
                    ...machine,
                    connected: connectedMachineIds.has(machine.machineId)
                  })),
                  sessions: sessionPage?.sessions ?? [],
                  sessionsHasMore: Boolean(sessionPage?.hasMoreBefore),
                  sessionsNextBeforeUpdatedMs: sessionPage?.nextBeforeUpdatedMs ?? null,
                  sessionsNextBeforeSessionId: sessionPage?.nextBeforeSessionId ?? null,
                  approvals: store.listApprovals().map((approval) => approval.payload)
                }
          }
        })

        sse.activateClient(connectionId, {
          replayAfter
        })
        return true
      }

      if (url.pathname === '/api/visibility' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true

        const body = await readJsonBody(req)
        const connectionId = body?.connectionId
        const visibility = body?.visibility
        const sessionId = body?.sessionId
        const machineId = body?.machineId
        if (!connectionId || typeof connectionId !== 'string') {
          json(res, 400, { error: 'connectionId is required' })
          return true
        }
        if (visibility !== 'visible' && visibility !== 'hidden') {
          json(res, 400, { error: 'visibility must be visible|hidden' })
          return true
        }
        if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
          json(res, 400, { error: 'sessionId must be a string or null' })
          return true
        }
        if (machineId !== undefined && machineId !== null && typeof machineId !== 'string') {
          json(res, 400, { error: 'machineId must be a string or null' })
          return true
        }

        const ok = sse.setVisibility(connectionId, visibility)
        if (!ok) {
          json(res, 404, { error: 'not found' })
          return true
        }

        if (sessionId !== undefined) sse.setSessionId(connectionId, sessionId)
        if (machineId !== undefined) sse.setMachineId(connectionId, machineId)
        json(res, 200, { ok: true })
        return true
      }

      if (url.pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        if (!push) {
          json(res, 503, { error: 'push not available' })
          return true
        }
        json(res, 200, { publicKey: push.getPublicKey() })
        return true
      }

      if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        const body = await readJsonBody(req)
        const sub = body?.subscription ?? body
        const endpoint = sub?.endpoint
        const keys = sub?.keys
        const p256dh = keys?.p256dh
        const authKey = keys?.auth
        if (!endpoint || typeof endpoint !== 'string') {
          json(res, 400, { error: 'endpoint is required' })
          return true
        }
        if (!p256dh || typeof p256dh !== 'string') {
          json(res, 400, { error: 'keys.p256dh is required' })
          return true
        }
        if (!authKey || typeof authKey !== 'string') {
          json(res, 400, { error: 'keys.auth is required' })
          return true
        }
        try {
          store.upsertPushSubscription({ endpoint, p256dh, auth: authKey })
        } catch (err) {
          json(res, 500, { error: String(err?.message ?? err) })
          return true
        }
        json(res, 200, { ok: true })
        return true
      }

      if (url.pathname === '/api/push/subscribe' && req.method === 'DELETE') {
        if (!auth.requireAuth(req, res)) return true
        const body = await readJsonBody(req)
        const endpoint = body?.endpoint ?? body?.subscription?.endpoint ?? url.searchParams.get('endpoint')
        if (!endpoint || typeof endpoint !== 'string') {
          json(res, 400, { error: 'endpoint is required' })
          return true
        }
        try {
          store.deletePushSubscription(endpoint)
        } catch (err) {
          json(res, 500, { error: String(err?.message ?? err) })
          return true
        }
        json(res, 200, { ok: true })
        return true
      }

      if (url.pathname === '/api/settings' && req.method === 'PUT') {
        if (!auth.requireAuth(req, res)) return true

        const body = await readJsonBody(req)
        const currentSettings = resolveAppSettings({ config, store })
        const retentionDaysRaw = body?.retentionDays
        const sseToastsRaw = body?.notifications?.sseToasts ?? body?.sseToasts
        const webPushRaw = body?.notifications?.webPush ?? body?.webPush
        const soundRaw = body?.notifications?.sound ?? body?.sound

        if (retentionDaysRaw === undefined && sseToastsRaw === undefined && webPushRaw === undefined && soundRaw === undefined) {
          json(res, 400, { error: 'at least one setting is required' })
          return true
        }

        let retentionDays = null
        if (retentionDaysRaw !== undefined) {
          retentionDays = Number.parseInt(String(retentionDaysRaw), 10)
          if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
            json(res, 400, { error: 'retentionDays must be an integer between 1 and 3650' })
            return true
          }
        }

        let sseToasts = null
        if (sseToastsRaw !== undefined) {
          if (sseToastsRaw !== 'always' && sseToastsRaw !== 'never' && sseToastsRaw !== 'if-not-visible') {
            json(res, 400, { error: 'notifications.sseToasts must be always|never|if-not-visible' })
            return true
          }
          sseToasts = sseToastsRaw
        }

        let webPush = null
        if (webPushRaw !== undefined) {
          if (webPushRaw !== 'always' && webPushRaw !== 'never' && webPushRaw !== 'if-not-visible') {
            json(res, 400, { error: 'notifications.webPush must be always|never|if-not-visible' })
            return true
          }
          webPush = webPushRaw
        }

        let sound = null
        if (soundRaw !== undefined) {
          if (typeof soundRaw !== 'boolean') {
            json(res, 400, { error: 'notifications.sound must be a boolean' })
            return true
          }
          sound = soundRaw
        }

        const nextSettings = normalizeRuntimeSettings({
          retentionDays: retentionDays !== null ? retentionDays : currentSettings.retentionDays,
          notifications: {
            sseToasts: sseToasts !== null ? sseToasts : currentSettings.notifications.sseToasts,
            webPush: webPush !== null ? webPush : currentSettings.notifications.webPush,
            sound: sound !== null ? sound : currentSettings.notifications.sound
          }
        }, currentSettings)

        try {
          store.upsertAppSettings(nextSettings)
        } catch (err) {
          json(res, 500, { error: String(err?.message ?? err) })
          return true
        }

        applyRuntimeSettingsToConfig(config, nextSettings)

        json(res, 200, {
          ok: true,
          ...(await buildSettingsPayload(config, {
            store,
            appSettings: nextSettings,
            hostSelfUpdate
          }))
        })
        return true
      }

      if (url.pathname === '/api/host/self-update' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        if (!hostSelfUpdate?.start) {
          json(res, 503, { error: 'host self-update is unavailable' })
          return true
        }
        try {
          const result = await hostSelfUpdate.start()
          json(res, 200, result)
          try { hostSelfUpdate.scheduleExit?.() } catch {}
        } catch (err) {
          const code = Number(err?.statusCode) || 500
          const payload = { error: String(err?.message ?? err) }
          if (Number(err?.activeSessionCount) > 0) payload.activeSessionCount = Number(err.activeSessionCount)
          json(res, code, payload)
        }
        return true
      }

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return true
        json(res, 200, await buildSettingsPayload(config, { store, hostSelfUpdate }))
        return true
      }

      if (url.pathname === '/api/install/runner-bootstrap' && req.method === 'POST') {
        if (!auth.requireAuth(req, res)) return true
        try {
          const payload = await runnerInstall?.createBootstrap?.(req)
          if (!payload) {
            json(res, 503, { error: 'runner install is unavailable' })
            return true
          }
          json(res, 200, payload)
        } catch (err) {
          json(res, 500, { error: String(err?.message ?? err) })
        }
        return true
      }

      return false
    }
  }
}
