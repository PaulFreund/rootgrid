import { spawn } from 'node:child_process'
import process from 'node:process'

import { getRootgridPackageRoot } from '../lib/rootgridVersion.js'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function httpError(statusCode, message, extras = null) {
  const err = new Error(message)
  err.statusCode = statusCode
  if (extras && typeof extras === 'object') Object.assign(err, extras)
  return err
}

function summarizeCommandFailure(command, stderr = '', stdout = '') {
  const detail = trimText(stderr) ?? trimText(stdout)
  return detail ? `${command}: ${detail}` : `${command} failed`
}

function normalizeShellOutput(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function defaultRunCommand(command, args = [], {
  cwd = null,
  env = null,
  detached = false,
  wait = true,
  shell = false
} = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : process.env,
        detached,
        stdio: wait ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        shell
      })
    } catch (err) {
      reject(err)
      return
    }

    if (!wait) {
      let settled = false
      child.once('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      child.once('spawn', () => {
        if (settled) return
        settled = true
        try { child.unref() } catch {}
        resolve({ ok: true, code: 0, stdout: '', stderr: '' })
      })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (Number(code) === 0) {
        resolve({ ok: true, code: 0, stdout, stderr })
        return
      }
      const err = new Error(summarizeCommandFailure(
        [command, ...args].join(' '),
        normalizeShellOutput(stderr),
        normalizeShellOutput(stdout)
      ))
      err.code = code
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    })
  })
}

export function sanitizeRepoUrlForDisplay(value) {
  const raw = trimText(value)
  if (!raw) return 'origin'
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return raw.replace(/\/\/[^/@:\s]+:[^/@\s]+@/g, '//***:***@')
  }
}

export function countWorkingHostSessions(store) {
  if (!store?.listSessionsPage || !store?.getSession) return 0

  let count = 0
  let beforeUpdatedMs = null
  let beforeSessionId = null

  for (;;) {
    const page = store.listSessionsPage({
      limit: 200,
      beforeUpdatedMs,
      beforeSessionId
    })
    const sessions = Array.isArray(page?.sessions) ? page.sessions : []
    if (!sessions.length) break

    for (const row of sessions) {
      const sessionId = String(row?.sessionId ?? '').trim()
      if (!sessionId) continue
      const session = store.getSession(sessionId)
      if (!session) continue
      if (session.turnState === 'running' || session.status === 'starting') count += 1
    }

    if (!page?.hasMoreBefore) break
    beforeUpdatedMs = page?.nextBeforeUpdatedMs ?? sessions[sessions.length - 1]?.updatedMs ?? null
    beforeSessionId = page?.nextBeforeSessionId ?? sessions[sessions.length - 1]?.sessionId ?? null
    if (!beforeSessionId) break
  }

  return count
}

export function buildHostSelfUpdatePublicState(config, {
  packageRoot = getRootgridPackageRoot(),
  state = null
} = {}) {
  const source = config?.host?.selfUpdate ?? {}
  const enabled = source?.enabled === true
  const repoUrl = trimText(source?.repoUrl)
  const branch = trimText(source?.branch) ?? 'main'
  const workdir = trimText(source?.workdir) ?? packageRoot
  const installCommand = trimText(source?.installCommand) ?? 'npm ci'
  const buildCommand = trimText(source?.buildCommand) ?? 'npm run build'
  const restartCommand = trimText(source?.restartCommand)
  const working = Boolean(state?.working)
  const awaitingRestart = Boolean(state?.awaitingRestart)
  const lastError = trimText(state?.lastError) ?? ''
  const lastStartedAtMs = Number(state?.lastStartedAtMs)
  const lastCompletedAtMs = Number(state?.lastCompletedAtMs)

  return {
    enabled,
    repo: sanitizeRepoUrlForDisplay(repoUrl),
    branch,
    workdir,
    installCommand,
    buildCommand,
    restartMode: restartCommand ? 'command' : 'exit',
    working,
    awaitingRestart,
    lastError,
    lastStartedAtMs: Number.isFinite(lastStartedAtMs) && lastStartedAtMs > 0 ? lastStartedAtMs : null,
    lastCompletedAtMs: Number.isFinite(lastCompletedAtMs) && lastCompletedAtMs > 0 ? lastCompletedAtMs : null
  }
}

export function createHostSelfUpdateManager({
  config,
  store,
  packageRoot = getRootgridPackageRoot(),
  runCommand = defaultRunCommand,
  exitProcess = (code) => process.exit(code),
  setTimer = globalThis.setTimeout
} = {}) {
  const state = {
    working: false,
    awaitingRestart: false,
    lastError: '',
    lastStartedAtMs: null,
    lastCompletedAtMs: null,
    exitScheduled: false
  }

  async function runGit(args, { cwd }) {
    return await runCommand('git', ['-C', cwd, ...args], { cwd })
  }

  async function runShell(command, { cwd, detached = false, wait = true }) {
    return await runCommand('/bin/sh', ['-lc', command], {
      cwd,
      detached,
      wait
    })
  }

  function getPublicState() {
    return buildHostSelfUpdatePublicState(config, {
      packageRoot,
      state
    })
  }

  async function start() {
    const summary = getPublicState()
    if (!summary.enabled) throw httpError(400, 'host self-update is not enabled in config')
    if (state.working || state.awaitingRestart) throw httpError(409, 'host self-update is already running')

    const activeSessionCount = countWorkingHostSessions(store)
    if (activeSessionCount > 0) {
      throw httpError(
        409,
        `finish ${activeSessionCount} running ${activeSessionCount === 1 ? 'session' : 'sessions'} before updating the host`,
        { activeSessionCount }
      )
    }

    const workdir = summary.workdir
    const repoSpec = trimText(config?.host?.selfUpdate?.repoUrl) ?? 'origin'
    const branch = summary.branch
    const installCommand = trimText(config?.host?.selfUpdate?.installCommand) ?? 'npm ci'
    const buildCommand = trimText(config?.host?.selfUpdate?.buildCommand) ?? 'npm run build'

    state.working = true
    state.awaitingRestart = false
    state.exitScheduled = false
    state.lastError = ''
    state.lastStartedAtMs = Date.now()
    state.lastCompletedAtMs = null

    try {
      await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workdir })
      const status = await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd: workdir })
      if (normalizeShellOutput(status?.stdout)) {
        throw httpError(409, 'host checkout has local changes; commit or stash them before updating')
      }

      await runGit(['fetch', '--depth', '1', repoSpec, branch], { cwd: workdir })

      try {
        await runGit(['checkout', branch], { cwd: workdir })
        await runGit(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: workdir })
      } catch {
        await runGit(['checkout', '-B', branch, 'FETCH_HEAD'], { cwd: workdir })
      }

      if (installCommand) await runShell(installCommand, { cwd: workdir })
      if (buildCommand) await runShell(buildCommand, { cwd: workdir })

      state.awaitingRestart = true
      state.lastCompletedAtMs = Date.now()

      return {
        ok: true,
        message: summary.restartMode === 'command'
          ? 'Host update succeeded. Rootgrid is restarting.'
          : 'Host update succeeded. Rootgrid is exiting so its service/container can restart it.',
        selfUpdate: getPublicState()
      }
    } catch (err) {
      state.lastError = trimText(err?.message) ?? 'host self-update failed'
      state.lastCompletedAtMs = Date.now()
      state.working = false
      state.awaitingRestart = false
      throw (Number(err?.statusCode) ? err : httpError(500, state.lastError))
    }
  }

  function scheduleExit() {
    if (!state.awaitingRestart || state.exitScheduled) return false
    state.exitScheduled = true

    const restartCommand = trimText(config?.host?.selfUpdate?.restartCommand)
    const workdir = trimText(config?.host?.selfUpdate?.workdir) ?? packageRoot

    if (restartCommand) {
      runShell(restartCommand, {
        cwd: workdir,
        detached: true,
        wait: false
      }).catch(() => {})
    }

    setTimer(() => {
      try { exitProcess(0) } catch {}
    }, 250)
    return true
  }

  return {
    getPublicState,
    start,
    scheduleExit
  }
}
