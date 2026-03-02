import { startRunnerClient } from './startRunnerClient.js'

export async function startRunner({ config }) {
  if (!config.runner.enabled) return

  if (config.host.enabled) {
    const baseUrl = `http://${config.host.listen.host}:${config.host.listen.port}`
    await startRunnerClient({
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
      machineName: config.runner.machineName
    })
    return
  }
}

