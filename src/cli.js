#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'
import { realpath } from 'node:fs/promises'

import { getCurrentPackageRoot, getManagedReleaseCliPath, installManagedRelease } from './lib/managedRelease.js'
import { ROOTGRID_VERSION } from './lib/rootgridVersion.js'
import { runSetupWizard } from './setup/runSetupWizard.js'

async function ensureManagedRuntimeInstalled() {
  if (process.env.ROOTGRID_DISABLE_AUTO_MANAGED_RUNTIME === '1') return false
  const targetCli = await getManagedReleaseCliPath()
  if (targetCli) return false
  await installManagedRelease({
    sourceRoot: getCurrentPackageRoot(),
    version: ROOTGRID_VERSION,
    source: 'bootstrap'
  })
  return true
}

async function maybeRedirectToManagedRelease() {
  if (process.env.ROOTGRID_SKIP_MANAGED_REDIRECT === '1') return false
  const targetCli = await getManagedReleaseCliPath()
  if (!targetCli) return false

  const currentCli = process.argv?.[1]
  if (!currentCli) return false

  try {
    const [currentReal, targetReal] = await Promise.all([realpath(currentCli), realpath(targetCli)])
    if (currentReal === targetReal) return false
  } catch {
    return false
  }

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [targetCli, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ROOTGRID_SKIP_MANAGED_REDIRECT: '1'
      }
    })
    child.once('exit', (code, signal) => {
      process.exitCode = Number.isInteger(code) ? code : (signal ? 1 : 0)
      resolve()
    })
    child.once('error', () => {
      process.exitCode = 1
      resolve()
    })
  })

  return true
}

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

  await ensureManagedRuntimeInstalled()
  if (await maybeRedirectToManagedRelease()) return

  const { loadConfig } = await import('./config/loadConfig.js')
  const { startRootgrid } = await import('./runtime/startRootgrid.js')

  const config = await loadConfig()
  await startRootgrid({ config })
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
