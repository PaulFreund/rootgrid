import { spawn } from 'node:child_process'
import { access, chmod, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import process from 'node:process'
import { stdin, stdout } from 'node:process'
import { join } from 'node:path'

import { buildDefaultConfig } from '../config/defaultConfig.js'
import { RootgridConfigSchema } from '../config/schema.js'
import {
  getCurrentPackageRoot,
  getCurrentReleaseLinkPath,
  installManagedRelease,
  ROOTGRID_USER_SERVICE_NAME
} from '../lib/managedRelease.js'
import { writeJsonFile } from '../lib/jsonFile.js'
import { getConfigPath, getRootgridDir } from '../lib/paths.js'
import { ROOTGRID_VERSION } from '../lib/rootgridVersion.js'
import { checkCodeServerInstalled, checkCodexInstalled, checkGitInstalled, checkLaunchdUserAvailable, checkSystemdUserAvailable } from './setupChecks.js'
import { installLaunchdUserService } from './launchdUserAutostart.js'
import { installSystemdUserService } from './systemdUserAutostart.js'

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
    const codex = await checkCodexInstalled()
    if (!codex.ok) {
      stdout.write('\n[!] Codex was not found in PATH.\n')
      stdout.write('    Rootgrid v0 requires the Codex CLI.\n')
      stdout.write('    See: https://developers.openai.com/codex/cli\n\n')

      const installNow = await promptYesNo(rl, 'Install Codex now via npm? (npm i -g @openai/codex)', { defaultValue: true })
      if (installNow) {
        stdout.write('\nInstalling Codex…\n\n')
        const res = await runShellCommand('npm i -g @openai/codex')
        if (!res.ok) stdout.write(`\n[!] Codex install command failed (exit ${res.code}).\n`)
      }

      const codex2 = await checkCodexInstalled()
      if (!codex2.ok) {
        stdout.write('\n[!] Codex is still not available in PATH.\n')
        const continueAnyway = await promptYesNo(rl, 'Continue setup anyway?', { defaultValue: false })
        if (!continueAnyway) {
          stdout.write('\nAborted.\n')
          return
        }
      } else {
        stdout.write(`\n[ok] Codex: ${codex2.version ?? 'installed'}\n`)
      }
    } else {
      stdout.write(`\n[ok] Codex: ${codex.version ?? 'installed'}\n`)
    }

    const git = await checkGitInstalled()
    if (!git.ok) stdout.write('[!] git was not found in PATH. (Optional, but recommended.)\n')
    else stdout.write(`[ok] Git: ${git.version ?? 'installed'}\n`)

    const codeServer = await checkCodeServerInstalled()
    if (!codeServer.ok) {
      stdout.write('[!] code-server was not found in PATH. (Optional; required for VS Code web viewer.)\n')
      stdout.write('    Docs: https://coder.com/docs/code-server/latest/install\n\n')
      const installCodeServer = await promptYesNo(rl, 'Install code-server now? (runs the official install script)', { defaultValue: false })
      if (installCodeServer) {
        stdout.write('\nInstalling code-server…\n\n')
        const res = await runShellCommand('curl -fsSL https://code-server.dev/install.sh | sh')
        if (!res.ok) stdout.write(`\n[!] code-server install script failed (exit ${res.code}).\n`)
      }

      const codeServer2 = await checkCodeServerInstalled()
      if (codeServer2.ok) stdout.write(`[ok] code-server: ${codeServer2.version ?? 'installed'}\n`)
      else stdout.write('[!] code-server still not found. VS Code web viewer will be unavailable until installed.\n')
    } else {
      stdout.write(`[ok] code-server: ${codeServer.version ?? 'installed'}\n`)
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

    const installedRelease = await installManagedRelease({
      sourceRoot: getCurrentPackageRoot(),
      version: ROOTGRID_VERSION,
      source: 'setup'
    })

    stdout.write(`\nWrote config to: ${configPath}\n`)
    stdout.write(`Managed runtime installed at: ${installedRelease.releaseDir}\n`)

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
      const execStart = [process.execPath, join(getCurrentReleaseLinkPath(), 'src', 'cli.js')]
      const installOpts = {
        execStart,
        workingDirectory: getCurrentReleaseLinkPath(),
        environment: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {})
        }
      }

      if (validated.autostart.method === 'systemd-user') {
        stdout.write('\nSetting up autostart (systemd --user)…\n')
        const res = await installSystemdUserService({
          serviceName: ROOTGRID_USER_SERVICE_NAME,
          description: validated.host.enabled ? 'Rootgrid (Codex web UI + runner)' : 'Rootgrid (runner)',
          ...installOpts
        })
        if (res.ok) stdout.write(`[ok] Autostart enabled: ${res.unitPath}\n`)
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
