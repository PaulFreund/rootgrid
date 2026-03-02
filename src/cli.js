#!/usr/bin/env node
import process from 'node:process'

import { runSetupWizard } from './setup/runSetupWizard.js'

async function main() {
  const [cmd] = process.argv.slice(2)

  if (cmd === 'setup') {
    await runSetupWizard()
    return
  }

  if (cmd === '--help' || cmd === '-h') {
    console.log('Usage:')
    console.log('  rootgrid setup   # interactive setup wizard')
    console.log('  rootgrid         # start service (host/runner based on ~/.rootgrid/config.json)')
    return
  }

  if (cmd) {
    console.error(`Unknown subcommand: ${cmd}`)
    process.exitCode = 2
    return
  }

  const { loadConfig } = await import('./config/loadConfig.js')
  const { startRootgrid } = await import('./runtime/startRootgrid.js')

  const config = await loadConfig()
  await startRootgrid({ config })
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
