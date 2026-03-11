import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import {
  DEFAULT_GITHUB_RELEASE_ASSET_NAME,
  buildGitHubReleaseChannelTag,
  downloadGitHubReleaseBundleToFile,
  extractGitHubAccessTokenFromRepoSpec,
  sanitizeGitHubRepoForDisplay
} from '../lib/githubReleaseChannel.js'
import {
  getReleaseTransfersDir,
  hashFileSha256,
  installManagedReleaseFromBundle,
  isCurrentProcessUsingManagedRelease
} from '../lib/managedRelease.js'

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

function normalizeKeepReleases(value, fallback = 3) {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

function resolveHostSelfUpdateRepoConfig(config) {
  const repo = trimText(config?.host?.selfUpdate?.repo)
    ?? trimText(config?.host?.selfUpdate?.repoUrl)
  const accessToken = trimText(config?.host?.selfUpdate?.accessToken)
    ?? trimText(config?.host?.selfUpdate?.token)
    ?? extractGitHubAccessTokenFromRepoSpec(repo)
  return {
    repo,
    accessToken
  }
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
  return sanitizeGitHubRepoForDisplay(value)
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
  state = null
} = {}) {
  const source = config?.host?.selfUpdate ?? {}
  const repoConfig = resolveHostSelfUpdateRepoConfig(config)
  const enabled = source?.enabled === true
  const branch = trimText(source?.branch) ?? 'main'
  const assetName = trimText(source?.assetName) ?? DEFAULT_GITHUB_RELEASE_ASSET_NAME
  const keepReleases = normalizeKeepReleases(source?.keepReleases, 3)
  const restartCommand = trimText(source?.restartCommand)
  const working = Boolean(state?.working)
  const awaitingRestart = Boolean(state?.awaitingRestart)
  const lastError = trimText(state?.lastError) ?? ''
  const lastStartedAtMs = Number(state?.lastStartedAtMs)
  const lastCompletedAtMs = Number(state?.lastCompletedAtMs)

  return {
    enabled,
    mode: 'github-release',
    repo: sanitizeRepoUrlForDisplay(repoConfig.repo),
    branch,
    channelTag: buildGitHubReleaseChannelTag(branch),
    assetName,
    keepReleases,
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
  runCommand = defaultRunCommand,
  exitProcess = (code) => process.exit(code),
  setTimer = globalThis.setTimeout,
  isManagedRuntime = isCurrentProcessUsingManagedRelease,
  downloadReleaseBundle = downloadGitHubReleaseBundleToFile,
  installReleaseBundle = installManagedReleaseFromBundle,
  hashFile = hashFileSha256
} = {}) {
  const state = {
    working: false,
    awaitingRestart: false,
    lastError: '',
    lastStartedAtMs: null,
    lastCompletedAtMs: null,
    exitScheduled: false
  }

  async function runShell(command, { cwd = null, detached = false, wait = true } = {}) {
    return await runCommand('/bin/sh', ['-lc', command], {
      cwd,
      detached,
      wait
    })
  }

  function getPublicState() {
    return buildHostSelfUpdatePublicState(config, { state })
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

    const managedRuntime = await isManagedRuntime()
    if (!managedRuntime) {
      throw httpError(
        409,
        'host self-update requires a managed host install; reinstall with the GitHub install/upgrade command first'
      )
    }

    const repoConfig = resolveHostSelfUpdateRepoConfig(config)
    if (!repoConfig.repo) throw httpError(400, 'host self-update repo is not configured')

    state.working = true
    state.awaitingRestart = false
    state.exitScheduled = false
    state.lastError = ''
    state.lastStartedAtMs = Date.now()
    state.lastCompletedAtMs = null

    const transferDir = await mkdtemp(join(getReleaseTransfersDir(), 'host-update-'))
    const archivePath = join(transferDir, summary.assetName)

    try {
      const bundle = await downloadReleaseBundle({
        repoSpec: repoConfig.repo,
        branch: summary.branch,
        assetName: summary.assetName,
        accessToken: repoConfig.accessToken,
        outPath: archivePath
      })

      if (bundle?.expectedSha256) {
        const actualSha256 = await hashFile(archivePath)
        if (actualSha256 !== bundle.expectedSha256) {
          throw httpError(500, 'downloaded host bundle checksum mismatch')
        }
      }

      const installed = await installReleaseBundle({
        archivePath,
        keep: summary.keepReleases
      })

      state.awaitingRestart = true
      state.lastCompletedAtMs = Date.now()

      return {
        ok: true,
        releaseId: trimText(installed?.manifest?.releaseId),
        version: trimText(installed?.manifest?.version),
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
    } finally {
      await rm(transferDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  function scheduleExit() {
    if (!state.awaitingRestart || state.exitScheduled) return false
    state.exitScheduled = true

    const restartCommand = trimText(config?.host?.selfUpdate?.restartCommand)

    if (restartCommand) {
      runShell(restartCommand, {
        cwd: process.cwd(),
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
