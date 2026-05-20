import { spawn } from 'node:child_process'
import { access, chmod, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import process from 'node:process'

import { buildDefaultConfig } from '../config/defaultConfig.js'
import { RootgridConfigSchema } from '../config/schema.js'
import {
  getCurrentPackageRoot,
  installManagedRelease,
  ROOTGRID_USER_SERVICE_NAME
} from '../lib/managedRelease.js'
import { writeJsonFile } from '../lib/jsonFile.js'
import { applyManagedRunnerToolEnv, buildManagedRunnerToolEnv, getRunnerToolInstallSpec } from '../lib/runnerTooling.js'
import { getConfigPath, getRootgridDir } from '../lib/paths.js'
import { ROOTGRID_VERSION } from '../lib/rootgridVersion.js'
import { checkCodeServerInstalled, checkCodexInstalled, checkGitInstalled, checkLaunchdUserAvailable, checkSystemdUserAvailable } from './setupChecks.js'
import { installLaunchdUserService } from './launchdUserAutostart.js'
import { buildUserServiceInstallOptions, usesManagedRuntimeForConfig } from './localRuntimeCommands.js'
import { ensureSystemdUserLinger, installSystemdUserService } from './systemdUserAutostart.js'

function normalizeYesNo(input, fallback) {
  const v = String(input ?? '').trim().toLowerCase()
  if (!v) return fallback
  if (['y', 'yes'].includes(v)) return true
  if (['n', 'no'].includes(v)) return false
  return fallback
}

async function promptText(rl, question, { defaultValue = '' } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  const answer = await rl.question(`${question}${suffix}: `)
  return (answer && answer.trim().length > 0) ? answer.trim() : defaultValue
}

async function promptYesNo(rl, question, { defaultValue = true } = {}) {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]'
  const answer = await rl.question(`${question}${suffix}: `)
  return normalizeYesNo(answer, defaultValue)
}

async function promptChoice(rl, question, options) {
  // options: [{ value, label }]
  stdout.write(`${question}\n`)
  options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}\n`))
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await rl.question(`Select 1-${options.length}: `)
    const idx = Number.parseInt(answer, 10)
    if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1].value
    }
  }
}

async function maybeEnableSystemdUserLinger(rl, linger) {
  if (!linger?.supported || linger.enabled !== false || !linger.username) return

  stdout.write('\n[!] systemd user services usually stop after logout unless lingering is enabled.\n')
  const enable = await promptYesNo(rl, `Enable lingering for ${linger.username}?`, { defaultValue: true })
  if (!enable) {
    stdout.write(`    To keep Rootgrid running after logout later, run:\n    ${linger.command}\n`)
    return
  }

  stdout.write('\nThis may prompt for your sudo password.\n')
  const res = await ensureSystemdUserLinger({
    username: linger.username,
    interactive: true
  })
  if (res.enabled === true) {
    stdout.write(`[ok] Lingering enabled for ${linger.username}.\n`)
    return
  }

  stdout.write('[!] Could not enable lingering automatically.\n')
  stdout.write(`    Run: ${res.command || linger.command}\n`)
  if (res.error) stdout.write(`    Error: ${res.error}\n`)
}

function runShellCommand(cmd, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', cmd], {
      stdio: 'inherit',
      env
    })
    child.on('error', () => resolve({ ok: false, code: null }))
    child.on('exit', (code) => resolve({ ok: code === 0, code }))
  })
}

async function installManagedRunnerTool(toolId) {
  const spec = getRunnerToolInstallSpec(toolId)
  const result = await runShellCommand(spec.upgradeCommand, {
    env: buildManagedRunnerToolEnv(process.env)
  })
  if (result.ok) applyManagedRunnerToolEnv(process.env)
  return result
}

export async function runSetupWizard() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('rootgrid setup requires an interactive TTY.')
  }

  const nodeMajor = Number.parseInt(String(process.versions.node).split('.')[0] ?? '', 10)
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Node.js >= 22 is required. Detected: ${process.versions.node}`)
  }

  const configPath = getConfigPath()
  try {
    await access(configPath)
    throw new Error(`Config already exists: ${configPath}\nRefusing to overwrite in v0.`)
  } catch (err) {
    // ok: config missing
    if (String(err?.message ?? '').includes('Refusing')) throw err
  }

  await mkdir(getRootgridDir(), { recursive: true, mode: 0o700 })

  const rl = createInterface({ input: stdin, output: stdout })
  try {
    stdout.write('\nRootgrid setup\n')
    stdout.write('==========\n\n')

    const cfg = buildDefaultConfig()

    // Prereq checks
    const codexManaged = await checkCodexInstalled({ allowExternal: false })
    const codexDetected = codexManaged.ok ? codexManaged : await checkCodexInstalled({ allowExternal: true })
    if (!codexManaged.ok) {
      if (codexDetected.ok && codexDetected.source === 'external') {
        stdout.write(`\n[!] External Codex detected: ${codexDetected.version ?? 'installed'}\n`)
        if (codexDetected.command) stdout.write(`    External path: ${codexDetected.command}\n`)
        stdout.write('    Rootgrid now prefers a managed Codex install inside its runtime.\n')
      } else {
        stdout.write('\n[!] Managed Codex was not found in the Rootgrid runtime.\n')
      }
      stdout.write('    Rootgrid v0 requires the Codex CLI.\n')
      stdout.write('    See: https://developers.openai.com/codex/cli\n\n')

      const installNow = await promptYesNo(rl, 'Install managed Codex now into the Rootgrid runtime?', { defaultValue: true })
      if (installNow) {
        stdout.write('\nInstalling managed Codex…\n\n')
        const res = await installManagedRunnerTool('codex')
        if (!res.ok) stdout.write(`\n[!] Managed Codex install command failed (exit ${res.code}).\n`)
      }

      const codex2 = await checkCodexInstalled({ allowExternal: false })
      if (!codex2.ok) {
        stdout.write('\n[!] Managed Codex is still not available.\n')
        const continueAnyway = await promptYesNo(rl, 'Continue setup anyway?', { defaultValue: false })
        if (!continueAnyway) {
          stdout.write('\nAborted.\n')
          return
        }
      } else {
        stdout.write(`\n[ok] Codex (managed): ${codex2.version ?? 'installed'}\n`)
      }
    } else {
      stdout.write(`\n[ok] Codex (managed): ${codexManaged.version ?? 'installed'}\n`)
    }

    const git = await checkGitInstalled()
    if (!git.ok) stdout.write('[!] git was not found in PATH. (Optional, but recommended.)\n')
    else stdout.write(`[ok] Git: ${git.version ?? 'installed'}\n`)

    const codeServerManaged = await checkCodeServerInstalled({ allowExternal: false })
    const codeServerDetected = codeServerManaged.ok ? codeServerManaged : await checkCodeServerInstalled({ allowExternal: true })
    if (!codeServerManaged.ok) {
      if (codeServerDetected.ok && codeServerDetected.source === 'external') {
        stdout.write(`[!] External code-server detected: ${codeServerDetected.version ?? 'installed'}\n`)
        if (codeServerDetected.command) stdout.write(`    External path: ${codeServerDetected.command}\n`)
        stdout.write('    Rootgrid now prefers a managed code-server install inside its runtime.\n')
      } else {
        stdout.write('[!] Managed code-server was not found. (Optional; required for VS Code web viewer.)\n')
      }
      stdout.write('    Docs: https://coder.com/docs/code-server/latest/install\n\n')
      const installCodeServer = await promptYesNo(rl, 'Install managed code-server now into the Rootgrid runtime?', { defaultValue: false })
      if (installCodeServer) {
        stdout.write('\nInstalling managed code-server…\n\n')
        const res = await installManagedRunnerTool('codeServer')
        if (!res.ok) stdout.write(`\n[!] Managed code-server install command failed (exit ${res.code}).\n`)
      }

      const codeServer2 = await checkCodeServerInstalled({ allowExternal: false })
      if (codeServer2.ok) stdout.write(`[ok] code-server (managed): ${codeServer2.version ?? 'installed'}\n`)
      else stdout.write('[!] Managed code-server still not found. VS Code web viewer will be unavailable until installed.\n')
    } else {
      stdout.write(`[ok] code-server (managed): ${codeServerManaged.version ?? 'installed'}\n`)
    }

    // Autostart
    const systemdUserAvailable = await checkSystemdUserAvailable()
    const launchdUserAvailable = await checkLaunchdUserAvailable()
    if (systemdUserAvailable || launchdUserAvailable) {
      const method = systemdUserAvailable ? 'systemd-user' : 'launchd-user'
      const label = method === 'systemd-user' ? 'systemd --user' : 'launchd'
      const enableAutostart = await promptYesNo(rl, `Enable autostart via ${label}?`, { defaultValue: true })
      cfg.autostart.enabled = enableAutostart
      cfg.autostart.method = enableAutostart ? method : null
    } else {
      cfg.autostart.enabled = false
      cfg.autostart.method = null
    }

    // Runner
    cfg.runner.enabled = await promptYesNo(rl, 'Run agent sessions on this machine (runner mode)?', { defaultValue: true })
    if (cfg.runner.enabled) {
      cfg.runner.machineName = await promptText(rl, 'Machine name', { defaultValue: cfg.runner.machineName })
    }

    // Host vs upstream (mutually exclusive in v0)
    const role = await promptChoice(rl, 'How should this machine connect?', [
      { value: 'host', label: 'Host mode (serve web UI + API here)' },
      { value: 'upstream', label: 'Upstream runner (connect to another host)' }
    ])

    if (role === 'host') {
      cfg.host.enabled = true
      cfg.upstream.enabled = false

      cfg.host.listen.host = await promptText(rl, 'Host listen address', { defaultValue: cfg.host.listen.host })
      const portStr = await promptText(rl, 'Host listen port', { defaultValue: String(cfg.host.listen.port) })
      const port = Number.parseInt(portStr, 10)
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${portStr}`)
      }
      cfg.host.listen.port = port

      const behindProxy = await promptYesNo(rl, 'Will Rootgrid be behind a reverse proxy (TLS termination)?', { defaultValue: false })
      cfg.host.trustProxy = behindProxy
      if (behindProxy) {
        const publicUrl = await promptText(rl, 'Public URL (https://...)', { defaultValue: '' })
        cfg.host.publicUrl = publicUrl ? publicUrl : null
      }
    } else {
      cfg.host.enabled = false
      cfg.upstream.enabled = true

      const url = await promptText(rl, 'Upstream host URL (https://...)', { defaultValue: '' })
      if (!url) throw new Error('Upstream URL is required')
      cfg.upstream.url = url

      const token = await promptText(rl, 'Upstream runner token', { defaultValue: '' })
      if (!token) throw new Error('Upstream runner token is required')
      cfg.upstream.runnerToken = token
    }

    const validated = RootgridConfigSchema.parse(cfg)
    await writeJsonFile(configPath, validated, { mode: 0o600 })
    try {
      await chmod(getRootgridDir(), 0o700)
    } catch {
    }

    stdout.write(`\nWrote config to: ${configPath}\n`)
    let installedRelease = null
    if (usesManagedRuntimeForConfig(validated)) {
      installedRelease = await installManagedRelease({
        sourceRoot: getCurrentPackageRoot(),
        version: ROOTGRID_VERSION,
        source: 'setup'
      })
      stdout.write(`Managed runtime installed at: ${installedRelease.releaseDir}\n`)
    } else {
      stdout.write(`Using current package install directly for host mode.\n`)
    }

    if (validated.host.enabled) {
      const url = `http://${validated.host.listen.host}:${validated.host.listen.port}/`
      stdout.write(`Open: ${url}\n`)
      stdout.write('\nClient token (browser → host):\n')
      stdout.write(`  ${validated.host.auth.clientToken}\n`)
      stdout.write('\nRunner token (runner → host):\n')
      stdout.write(`  ${validated.host.auth.runnerToken}\n`)
      stdout.write('\nStore these somewhere safe.\n')
    } else {
      stdout.write('\nRunner is configured to connect upstream. Start rootgrid to register.\n')
    }

    if (validated.autostart.enabled && validated.autostart.method) {
      const installOpts = buildUserServiceInstallOptions(validated)

      if (validated.autostart.method === 'systemd-user') {
        stdout.write('\nSetting up autostart (systemd --user)…\n')
        const res = await installSystemdUserService({
          serviceName: ROOTGRID_USER_SERVICE_NAME,
          description: validated.host.enabled ? 'Rootgrid (Codex web UI + runner)' : 'Rootgrid (runner)',
          ...installOpts
        })
        if (res.ok) {
          stdout.write(`[ok] Autostart enabled: ${res.unitPath}\n`)
          await maybeEnableSystemdUserLinger(rl, res.linger)
        }
        else {
          stdout.write(`[!] Autostart setup failed (${res.step}).\n`)
          stdout.write(`    Unit path: ${res.unitPath}\n`)
          stdout.write(`    Error: ${res.error}\n`)
        }
      } else if (validated.autostart.method === 'launchd-user') {
        stdout.write('\nSetting up autostart (launchd)…\n')
        const res = await installLaunchdUserService(installOpts)
        if (res.ok) stdout.write(`[ok] Autostart enabled: ${res.unitPath}\n`)
        else {
          stdout.write(`[!] Autostart setup failed (${res.step}).\n`)
          stdout.write(`    Unit path: ${res.unitPath}\n`)
          stdout.write(`    Error: ${res.error}\n`)
        }
      }
    }

    stdout.write('\nNext: run `rootgrid` to start the service.\n\n')
  } finally {
    rl.close()
  }
}
