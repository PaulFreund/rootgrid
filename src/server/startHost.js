import crypto from 'node:crypto'
import http from 'node:http'

import { getDbPath } from '../lib/paths.js'
import { Store } from '../db/store.js'
import { AuthService } from './auth.js'
import { readJsonBody, json } from './httpUtil.js'
import { SSEManager } from './sseManager.js'
import { serveWeb } from './static.js'
import { createRunnerWsServer } from './wsRunner.js'
import { createTunnelWsServer } from './wsTunnel.js'

export async function startHost({ config }) {
  const store = new Store({ dbPath: getDbPath() })
  const auth = new AuthService({ clientToken: config.host.auth.clientToken })
  const sse = new SSEManager({ heartbeatMs: 30_000 })

  const runnerWss = createRunnerWsServer({ config, store, sse })
  const tunnelWss = createTunnelWsServer()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local')

      // REST API
      if (url.pathname === '/api/auth' && req.method === 'POST') {
        const body = await readJsonBody(req)
        auth.handleAuth(req, res, body)
        return
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.write('\n')

        // Send an initial snapshot so the UI can render immediately.
        res.write(`data: ${JSON.stringify({
          v: 1,
          type: 'registry.snapshot',
          ts: Date.now(),
          id: crypto.randomUUID(),
          scope: null,
          payload: { machines: store.listMachines(), sessions: [] }
        })}\n\n`)

        sse.addClient(res)
        return
      }

      if (url.pathname === '/api/machines' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        return json(res, 200, { machines: store.listMachines() })
      }

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        if (!auth.requireAuth(req, res)) return
        return json(res, 200, {
          retentionDays: config.retentionDays,
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
    } catch {
    }

    socket.destroy()
  })

  await new Promise((resolve, reject) => {
    server.listen(config.host.listen.port, config.host.listen.host, () => resolve())
    server.on('error', reject)
  })

  console.log(`[rootgrid] host listening on http://${config.host.listen.host}:${config.host.listen.port}`)
}
