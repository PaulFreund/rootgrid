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
    autostart: {
      enabled: false,
      method: null
    },
    runner: {
      enabled: true,
      machineId: crypto.randomUUID(),
      machineName: hostname()
    },
    host: {
      enabled: true,
      listen: { host: '127.0.0.1', port: 7337 },
      publicUrl: null,
      trustProxy: false,
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
