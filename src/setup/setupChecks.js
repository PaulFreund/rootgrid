import { spawn } from 'node:child_process'

function runCommand(command, args, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })

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

function runCommandCapture(command, args, { timeoutMs = 5_000, maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })

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

function parseFirstLineVersion(output) {
  const line = String(output ?? '').trim().split('\n')[0]?.trim()
  return line || null
}

export async function checkCodexInstalled() {
  const res = await runCommandCapture('codex', ['--version'], { timeoutMs: 3_000 })
  return { ok: res.ok, version: parseFirstLineVersion(res.stdout || res.stderr) }
}

export async function checkGitInstalled() {
  const res = await runCommandCapture('git', ['--version'], { timeoutMs: 3_000 })
  return { ok: res.ok, version: parseFirstLineVersion(res.stdout || res.stderr) }
}

export async function checkCodeServerInstalled() {
  const res = await runCommandCapture('code-server', ['--version'], { timeoutMs: 3_000 })
  return { ok: res.ok, version: parseFirstLineVersion(res.stdout || res.stderr) }
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
