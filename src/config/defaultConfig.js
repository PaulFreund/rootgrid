import crypto from 'node:crypto'
import { hostname } from 'node:os'

function randomToken() {
  // 32 bytes => 64 hex chars (simple to copy/paste)
  return crypto.randomBytes(32).toString('hex')
}

export function buildDefaultConfig() {
  return {
    version: 1,
    retentionDays: 30,
    notifications: {
      sseToasts: 'if-not-visible',
      webPush: 'if-not-visible'
    },
    debug: {
      codexRawCapture: {
        enabled: false,
        dir: null
      }
    },
    autostart: {
      enabled: false,
      method: null
    },
    runner: {
      enabled: true,
      machineId: crypto.randomUUID(),
      machineName: hostname(),
      upgrade: {
        enabled: true,
        keepReleases: 3
      }
    },
    host: {
      enabled: true,
      listen: { host: '127.0.0.1', port: 7337 },
      publicUrl: null,
      trustProxy: false,
      selfUpdate: {
        enabled: false,
        repoUrl: null,
        branch: 'main',
        workdir: null,
        installCommand: 'npm ci',
        buildCommand: 'npm run build',
        restartCommand: null
      },
      auth: {
        clientToken: randomToken(),
        runnerToken: randomToken()
      }
    },
    upstream: {
      enabled: false,
      url: null,
      runnerToken: null
    }
  }
}
