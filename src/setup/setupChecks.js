import { spawn } from 'node:child_process'

import {
  buildCodeServerCommandCandidates,
  buildCodexCommandCandidates,
  inferRunnerToolSource,
  resolveCommandCandidate
} from '../lib/runnerTooling.js'

const VERSION_PATTERN = /\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?\b/

function normalizeOutputLines(output) {
  return String(output ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function runCommand(command, args, {
  env = null,
  timeoutMs = 5_000
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: 'ignore'
    })

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
      }
      resolve({ ok: false, code: null, signal: 'SIGKILL', timedOut: true })
    }, timeoutMs)

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, timedOut: false })
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, signal, timedOut: false })
    })
  })
}

function runCommandCapture(command, args, {
  env = null,
  timeoutMs = 5_000,
  maxBytes = 64 * 1024
} = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
      }
      resolve({ ok: false, code: null, signal: 'SIGKILL', timedOut: true, stdout, stderr })
    }, timeoutMs)

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, timedOut: false, stdout, stderr })
    })

    child.stdout?.on('data', (buf) => {
      if (stdout.length >= maxBytes) return
      stdout += String(buf).slice(0, maxBytes - stdout.length)
    })
    child.stderr?.on('data', (buf) => {
      if (stderr.length >= maxBytes) return
      stderr += String(buf).slice(0, maxBytes - stderr.length)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, signal, timedOut: false, stdout, stderr })
    })
  })
}

function parseVersionLine(output) {
  const lines = normalizeOutputLines(output)
  for (const line of lines) {
    if (VERSION_PATTERN.test(line)) return line
  }
  return null
}

function parseFirstLineVersion(output) {
  return normalizeOutputLines(output)[0] || null
}

async function checkRunnerTool(commandCandidates, toolId, {
  allowVersionOutputFallback = false,
  env = process.env,
  timeoutMs = 3_000
} = {}) {
  const command = await resolveCommandCandidate(commandCandidates)
  if (!command) {
    return {
      ok: false,
      version: null,
      command: null,
      source: 'missing'
    }
  }
  const res = await runCommandCapture(command, ['--version'], { env, timeoutMs })
  const version = parseVersionLine(res.stdout || res.stderr)
  return {
    ok: res.ok || (allowVersionOutputFallback && Boolean(version)),
    version,
    command,
    source: inferRunnerToolSource(toolId, command, { env })
  }
}

export async function checkCodexInstalled({
  env = process.env,
  allowExternal = true
} = {}) {
  return await checkRunnerTool(
    buildCodexCommandCandidates(env, { allowExternal }),
    'codex',
    { env }
  )
}

export async function checkGitInstalled() {
  const res = await runCommandCapture('git', ['--version'], { timeoutMs: 3_000 })
  return { ok: res.ok, version: parseFirstLineVersion(res.stdout || res.stderr) }
}

export async function checkCodeServerInstalled({
  env = process.env,
  allowExternal = true,
  timeoutMs = 10_000
} = {}) {
  return await checkRunnerTool(
    buildCodeServerCommandCandidates(env, { allowExternal }),
    'codeServer',
    {
      allowVersionOutputFallback: true,
      env,
      timeoutMs
    }
  )
}

export async function checkSystemdUserAvailable() {
  // This is a best-effort detection. In many WSL setups systemd is absent or disabled.
  const res = await runCommand('systemctl', ['--user', 'is-system-running'], { timeoutMs: 3_000 })
  return res.ok
}

export async function checkLaunchdUserAvailable() {
  if (process.platform !== 'darwin') return false
  const res = await runCommand('launchctl', ['help'], { timeoutMs: 3_000 })
  return res.ok
}
