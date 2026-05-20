import { startHost } from '../server/startHost.js'
import { startRunner } from '../runner/startRunner.js'

export async function startRootgrid({ config }) {
  if (!config.host.enabled && !config.upstream.enabled) {
    throw new Error('Invalid config: host.enabled and upstream.enabled cannot both be false.')
  }
  if (config.host.enabled && config.upstream.enabled) {
    throw new Error('Invalid config: host.enabled and upstream.enabled cannot both be true (v0).')
  }

  if (config.host.enabled) {
    await startHost({ config })
  }

  // Runner can be enabled in both host mode (local) and upstream mode.
  await startRunner({ config })
}

