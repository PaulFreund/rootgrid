import { access, chmod, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import process from 'node:process'
import { stdin, stdout } from 'node:process'

import { buildDefaultConfig } from '../config/defaultConfig.js'
import { RootgridConfigSchema } from '../config/schema.js'
import { writeJsonFile } from '../lib/jsonFile.js'
import { getConfigPath, getRootgridDir } from '../lib/paths.js'
import { checkCodexInstalled, checkSystemdUserAvailable } from './setupChecks.js'

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

export async function runSetupWizard() {
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
    const codexOk = await checkCodexInstalled()
    if (!codexOk) {
      stdout.write('\n[!] Codex was not found in PATH.\n')
      stdout.write('    Install Codex first, then re-run: rootgrid setup\n')
      stdout.write('    See: https://developers.openai.com/codex/\n\n')

      const continueAnyway = await promptYesNo(rl, 'Continue setup anyway?', { defaultValue: false })
      if (!continueAnyway) {
        stdout.write('\nAborted.\n')
        return
      }
    }

    // Autostart (systemd --user)
    const systemdUserAvailable = await checkSystemdUserAvailable()
    if (systemdUserAvailable) {
      const enableAutostart = await promptYesNo(rl, 'Enable autostart via systemd --user?', { defaultValue: true })
      cfg.autostart.enabled = enableAutostart
      cfg.autostart.method = enableAutostart ? 'systemd-user' : null
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

    if (validated.host.enabled) {
      const url = `http://${validated.host.listen.host}:${validated.host.listen.port}/`
      stdout.write(`Open: ${url}\n`)
      stdout.write('\nClient token (browser → host) was generated and saved in config.\n')
      stdout.write('Runner token (runner → host) was generated and saved in config.\n')
    } else {
      stdout.write('\nRunner is configured to connect upstream. Start rootgrid to register.\n')
    }

    stdout.write('\nNext: run `rootgrid` to start the service.\n\n')
  } finally {
    rl.close()
  }
}
