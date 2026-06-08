import { pruneStaleManagedReleaseArtifacts } from '../lib/managedRelease.js'
import { startRunnerClient } from './startRunnerClient.js'
import { startTunnelClient } from './startTunnelClient.js'

function toLocalConnectHost(listenHost) {
  const h = String(listenHost ?? '').trim()
  if (!h) return '127.0.0.1'
  if (h === '0.0.0.0') return '127.0.0.1'
  if (h === '::' || h === '::0') return '[::1]'
  // IPv6 literal
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`
  return h
}

export async function startRunner({ config }) {
  if (!config.runner.enabled) return
  await pruneStaleManagedReleaseArtifacts().catch((err) => {
    console.warn('[rootgrid] stale managed artifact prune failed:', String(err?.message ?? err))
  })

  if (config.host.enabled) {
    const host = toLocalConnectHost(config.host.listen.host)
    const baseUrl = `http://${host}:${config.host.listen.port}`
    await startRunnerClient({
      url: baseUrl,
      token: config.host.auth.runnerToken,
      machineId: config.runner.machineId,
      machineName: config.runner.machineName,
      debug: config.debug ?? null,
      upgrade: config.runner?.upgrade ?? null,
      autostart: config.autostart ?? null
    })
    await startTunnelClient({
      url: baseUrl,
      token: config.host.auth.runnerToken,
      machineId: config.runner.machineId,
      machineName: config.runner.machineName
    })
    return
  }

  if (config.upstream.enabled) {
    await startRunnerClient({
      url: config.upstream.url,
      token: config.upstream.runnerToken,
      machineId: config.runner.machineId,
      machineName: config.runner.machineName,
      debug: config.debug ?? null,
      upgrade: config.runner?.upgrade ?? null,
      autostart: config.autostart ?? null
    })
    await startTunnelClient({
      url: config.upstream.url,
      token: config.upstream.runnerToken,
      machineId: config.runner.machineId,
      machineName: config.runner.machineName
    })
    return
  }
}
