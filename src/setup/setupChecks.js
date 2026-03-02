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

export async function checkCodexInstalled() {
  const res = await runCommand('codex', ['--version'], { timeoutMs: 3_000 })
  return res.ok
}

export async function checkSystemdUserAvailable() {
  // This is a best-effort detection. In many WSL setups systemd is absent or disabled.
  const res = await runCommand('systemctl', ['--user', 'is-system-running'], { timeoutMs: 3_000 })
  return res.ok
}

