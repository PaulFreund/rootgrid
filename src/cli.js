#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'
import { realpath } from 'node:fs/promises'

import { loadConfig } from './config/loadConfig.js'
import { getCurrentPackageRoot, getManagedReleaseCliPath, installManagedRelease } from './lib/managedRelease.js'
import { ROOTGRID_VERSION } from './lib/rootgridVersion.js'
import { applyManagedRunnerToolEnv } from './lib/runnerTooling.js'
import {
  applyAutostartConfig,
  installLocalManagedReleaseFromCurrentPackage,
  installUserServiceForConfig,
  loadConfigIfPresent,
  resolveRemoveUserServiceMethod,
  removeUserService,
  saveConfig,
  usesManagedRuntimeForConfig
} from './setup/localRuntimeCommands.js'
import { runSetupWizard } from './setup/runSetupWizard.js'

function printSystemdLingerStatus(service) {
  const linger = service?.linger ?? null
  if (!linger?.supported) return
  if (linger.enabled === true && linger.changed) {
    console.log(`Enabled lingering for ${linger.username}.`)
    return
  }
  if (linger.enabled === false) {
    console.warn('Warning: this systemd --user service may stop after logout because lingering is disabled.')
    console.warn(`Run: ${linger.command}`)
    if (linger.error) console.warn(`Automatic linger enable failed: ${linger.error}`)
  }
}

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

  if (cmd === 'update-local') {
    const config = await loadConfigIfPresent()
    if (!config || usesManagedRuntimeForConfig(config)) {
      const release = await installLocalManagedReleaseFromCurrentPackage()
      console.log(`Installed managed release: ${release.releaseDir}`)
    } else {
      console.log('Host mode uses the current package install directly; skipped managed release staging.')
    }

    if (config?.autostart?.enabled) {
      const service = await installUserServiceForConfig(config)
      const nextConfig = applyAutostartConfig(config, { enabled: true, method: service.method })
      await saveConfig(nextConfig)
      console.log(`Updated user service: ${service.unitPath}`)
      console.log(`Restarted via: ${service.method}`)
      printSystemdLingerStatus(service)
    } else {
      console.log('Autostart is not enabled; no user service was updated.')
    }
    return
  }

  if (cmd === 'install-service') {
    const config = await loadConfig()
    if (usesManagedRuntimeForConfig(config)) {
      await installLocalManagedReleaseFromCurrentPackage({ source: 'install-service' })
    }
    const service = await installUserServiceForConfig(config)
    const nextConfig = applyAutostartConfig(config, { enabled: true, method: service.method })
    await saveConfig(nextConfig)
    console.log(`Installed user service: ${service.unitPath}`)
    console.log(`Method: ${service.method}`)
    printSystemdLingerStatus(service)
    return
  }

  if (cmd === 'remove-service') {
    const config = await loadConfigIfPresent()
    const method = await resolveRemoveUserServiceMethod(config?.autostart?.method ?? null)
    const service = await removeUserService(method || null)
    if (config) {
      const nextConfig = applyAutostartConfig(config, { enabled: false, method: null })
      await saveConfig(nextConfig)
    }
    console.log(`Removed user service: ${service.unitPath}`)
    console.log(`Method: ${service.method}`)
    return
  }

  if (cmd === '--help' || cmd === '-h') {
    console.log('Usage:')
    console.log('  rootgrid setup   # interactive setup wizard')
    console.log('  rootgrid update-local   # install the current package into ~/.rootgrid/current and refresh autostart')
    console.log('  rootgrid install-service   # install/start the user service for the current managed runtime')
    console.log('  rootgrid remove-service   # stop/remove the user service and disable autostart in config')
    console.log('  rootgrid         # start service (host/runner based on ~/.rootgrid/config.json)')
    return
  }

  if (cmd) {
    console.error(`Unknown subcommand: ${cmd}`)
    process.exitCode = 2
    return
  }

  const config = await loadConfig()
  if (config?.runner?.enabled) applyManagedRunnerToolEnv(process.env)
  if (usesManagedRuntimeForConfig(config)) {
    await ensureManagedRuntimeInstalled()
    if (await maybeRedirectToManagedRelease()) return
  }

  const { startRootgrid } = await import('./runtime/startRootgrid.js')
  await startRootgrid({ config })
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
