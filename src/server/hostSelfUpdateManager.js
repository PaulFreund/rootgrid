import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import {
  DEFAULT_GITHUB_RELEASE_ASSET_NAME,
  buildGitHubReleaseChannelTag,
  downloadGitHubReleaseBundleToFile,
  extractGitHubAccessTokenFromRepoSpec,
  fetchGitHubReleaseChannelInfo,
  sanitizeGitHubRepoForDisplay
} from '../lib/githubReleaseChannel.js'
import {
  getCurrentPackageRoot,
  getReleaseTransfersDir,
  getManagedReleaseCliPath,
  hashFileSha256,
  installManagedReleaseFromBundle,
  isCurrentProcessUsingManagedRelease
} from '../lib/managedRelease.js'
import { ROOTGRID_VERSION } from '../lib/rootgridVersion.js'

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

function normalizeOptionalFlag(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return null
}

function normalizeExecEnv(env) {
  const source = (env && typeof env === 'object') ? env : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue
    out[String(key)] = String(value)
  }
  return out
}

function normalizeSha256(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(text) ? text : null
}

function normalizeTimestampMs(value) {
  const n = Number(value ?? NaN)
  if (Number.isFinite(n) && n > 0) return Math.trunc(n)
  const text = trimText(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function extractVersionHash(version) {
  const text = trimText(version)
  if (!text) return null
  const match = text.match(/(?:^|[+.-])(g[a-f0-9]{7,40})$/i)
  return match ? match[1].toLowerCase() : null
}

function inferVersionFromReleaseId(releaseId) {
  const text = trimText(releaseId)
  if (!text) return null
  const managedMatch = text.match(/^rootgrid-(.+?)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z?-[A-Za-z0-9]+$/)
  if (managedMatch?.[1]) return trimText(managedMatch[1])
  const match = text.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)/)
  return trimText(match?.[1])
}

function readInstalledHostReleaseInfo() {
  let manifest = null
  try {
    const raw = readFileSync(join(getCurrentPackageRoot(), 'release.json'), 'utf8')
    manifest = JSON.parse(raw)
  } catch {
  }

  const installedVersion = trimText(manifest?.version)
    ?? inferVersionFromReleaseId(manifest?.releaseId)
    ?? trimText(ROOTGRID_VERSION)
  return {
    version: installedVersion,
    versionHash: extractVersionHash(installedVersion),
    releaseId: trimText(manifest?.releaseId),
    bundleSha256: normalizeSha256(manifest?.bundleSha256),
    source: trimText(manifest?.source),
    createdAtMs: normalizeTimestampMs(manifest?.createdAtMs)
  }
}

function buildInstalledReleaseState(info = null) {
  const version = trimText(info?.version) ?? inferVersionFromReleaseId(info?.releaseId)
  return {
    version,
    versionHash: extractVersionHash(version),
    releaseId: trimText(info?.releaseId),
    bundleSha256: normalizeSha256(info?.bundleSha256),
    source: trimText(info?.source),
    createdAtMs: normalizeTimestampMs(info?.createdAtMs)
  }
}

function buildLatestReleaseState(info = null, checkedAtMs = null, error = '') {
  const version = trimText(info?.version) ?? inferVersionFromReleaseId(info?.releaseId)
  const bundleSha256 = normalizeSha256(info?.bundleSha256 ?? info?.expectedSha256)
  return {
    checkedAtMs: normalizeTimestampMs(checkedAtMs),
    error: trimText(error) ?? '',
    version,
    versionHash: extractVersionHash(version),
    releaseId: trimText(info?.releaseId),
    bundleSha256,
    releaseName: trimText(info?.releaseName),
    publishedAtMs: normalizeTimestampMs(info?.publishedAtMs),
    source: trimText(info?.source)
  }
}

function compareReleaseStates(installed, latest) {
  if (!latest?.version && !latest?.releaseId && !latest?.bundleSha256) return null
  if (latest?.releaseId) {
    if (!installed?.releaseId) return null
    return installed.releaseId !== latest.releaseId
  }
  if (latest?.version) {
    if (!installed?.version) return null
    return installed.version !== latest.version
  }
  if (latest?.bundleSha256) {
    if (!installed?.bundleSha256) return null
    return installed.bundleSha256 !== latest.bundleSha256
  }
  return null
}

export function buildHostSelfRestartSpec({
  execPath = process.execPath,
  execArgv = process.execArgv,
  argv = process.argv,
  env = process.env,
  managedCliPath
} = {}) {
  const nextCli = trimText(managedCliPath)
  if (!nextCli) throw new Error('managed release CLI path is unavailable')

  const nextExecPath = trimText(execPath)
  if (!nextExecPath) throw new Error('process execPath is unavailable')

  const nodeArgs = Array.isArray(execArgv) ? execArgv.map((value) => String(value ?? '')).filter(Boolean) : []
  const cliArgs = Array.isArray(argv) ? argv.slice(2).map((value) => String(value ?? '')) : []
  const nextEnv = normalizeExecEnv({
    ...env,
    ROOTGRID_SKIP_MANAGED_REDIRECT: '1'
  })

  return {
    execPath: nextExecPath,
    args: [nextExecPath, ...nodeArgs, nextCli, ...cliArgs],
    env: nextEnv
  }
}

function resolveHostSelfUpdateEnabled(config, env = process.env) {
  const source = config?.host?.selfUpdate ?? {}
  const envValue = normalizeOptionalFlag(env?.ROOTGRID_ENABLE_HOST_SELF_UPDATE)
  if (envValue !== null) return envValue
  return source?.enabled === true
}

function resolveHostSelfUpdateRepoConfig(config, env = process.env) {
  const repo = trimText(env?.ROOTGRID_GITHUB_REPO)
    ?? trimText(config?.host?.selfUpdate?.repo)
    ?? trimText(config?.host?.selfUpdate?.repoUrl)
  const accessToken = trimText(env?.ROOTGRID_GITHUB_TOKEN)
    ?? trimText(env?.GITHUB_TOKEN)
    ?? trimText(config?.host?.selfUpdate?.accessToken)
    ?? trimText(config?.host?.selfUpdate?.token)
    ?? extractGitHubAccessTokenFromRepoSpec(repo)
  return {
    repo,
    accessToken
  }
}

function resolveHostSelfUpdateBranch(config, env = process.env) {
  return trimText(env?.ROOTGRID_GITHUB_BRANCH)
    ?? trimText(config?.host?.selfUpdate?.branch)
    ?? 'main'
}

function resolveHostSelfUpdateAssetName(config, env = process.env) {
  return trimText(env?.ROOTGRID_GITHUB_ASSET_NAME)
    ?? trimText(config?.host?.selfUpdate?.assetName)
    ?? DEFAULT_GITHUB_RELEASE_ASSET_NAME
}

function resolveHostSelfUpdateKeepReleases(config, env = process.env) {
  return normalizeKeepReleases(
    env?.ROOTGRID_HOST_KEEP_RELEASES ?? config?.host?.selfUpdate?.keepReleases,
    3
  )
}

function resolveHostSelfUpdateRestartCommand(config, env = process.env) {
  return trimText(env?.ROOTGRID_HOST_RESTART_COMMAND)
    ?? trimText(config?.host?.selfUpdate?.restartCommand)
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
  state = null,
  env = process.env,
  installed = null,
  latest = null
} = {}) {
  const repoConfig = resolveHostSelfUpdateRepoConfig(config, env)
  const enabled = resolveHostSelfUpdateEnabled(config, env)
  const configured = Boolean(enabled && repoConfig.repo)
  const branch = resolveHostSelfUpdateBranch(config, env)
  const assetName = resolveHostSelfUpdateAssetName(config, env)
  const keepReleases = resolveHostSelfUpdateKeepReleases(config, env)
  const restartCommand = resolveHostSelfUpdateRestartCommand(config, env)
  const working = Boolean(state?.working)
  const awaitingRestart = Boolean(state?.awaitingRestart)
  const lastError = trimText(state?.lastError) ?? ''
  const lastStartedAtMs = Number(state?.lastStartedAtMs)
  const lastCompletedAtMs = Number(state?.lastCompletedAtMs)
  const installedInfo = installed && typeof installed === 'object'
    ? buildInstalledReleaseState(installed)
    : readInstalledHostReleaseInfo()
  const latestInfo = latest && typeof latest === 'object'
    ? buildLatestReleaseState(latest, latest?.checkedAtMs, latest?.error)
    : buildLatestReleaseState(state?.latestInfo, state?.latestCheckedAtMs, state?.latestError)
  const updateCheckInProgress = Boolean(state?.latestCheckPromise)
  const comparison = compareReleaseStates(installedInfo, latestInfo)

  return {
    enabled,
    configured,
    mode: 'github-release',
    repo: sanitizeRepoUrlForDisplay(repoConfig.repo),
    branch,
    channelTag: buildGitHubReleaseChannelTag(branch),
    assetName,
    keepReleases,
    restartMode: restartCommand ? 'command' : 'self',
    installed: installedInfo,
    latest: latestInfo,
    latestCheckInProgress: updateCheckInProgress,
    updateAvailable: comparison === true,
    upToDate: comparison === false,
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
  env = process.env,
  runCommand = defaultRunCommand,
  execProcess = process.execve,
  exitProcess = (code) => process.exit(code),
  setTimer = globalThis.setTimeout,
  isManagedRuntime = isCurrentProcessUsingManagedRelease,
  getManagedCliPath = getManagedReleaseCliPath,
  getTransferDir = getReleaseTransfersDir,
  fetchLatestReleaseInfo = fetchGitHubReleaseChannelInfo,
  downloadReleaseBundle = downloadGitHubReleaseBundleToFile,
  installReleaseBundle = installManagedReleaseFromBundle,
  hashFile = hashFileSha256,
  logError = (...args) => console.error(...args)
} = {}) {
  const state = {
    working: false,
    awaitingRestart: false,
    lastError: '',
    lastStartedAtMs: null,
    lastCompletedAtMs: null,
    exitScheduled: false,
    latestInfo: null,
    latestError: '',
    latestCheckedAtMs: null,
    latestCheckPromise: null
  }
  const latestCheckTtlMs = 60_000

  async function runShell(command, { cwd = null, detached = false, wait = true } = {}) {
    return await runCommand('/bin/sh', ['-lc', command], {
      cwd,
      detached,
      wait
    })
  }

  async function refreshLatestRelease({ force = false } = {}) {
    const repoConfig = resolveHostSelfUpdateRepoConfig(config, env)
    const enabled = resolveHostSelfUpdateEnabled(config, env)
    if (!enabled || !repoConfig.repo) {
      state.latestInfo = null
      state.latestError = ''
      state.latestCheckedAtMs = null
      return null
    }

    const now = Date.now()
    if (!force && state.latestCheckPromise) return await state.latestCheckPromise
    if (
      !force
      && Number.isFinite(Number(state.latestCheckedAtMs))
      && (now - Number(state.latestCheckedAtMs)) < latestCheckTtlMs
    ) {
      return state.latestInfo
    }

    state.latestCheckPromise = (async () => {
      try {
        const info = await fetchLatestReleaseInfo({
          repoSpec: repoConfig.repo,
          branch: resolveHostSelfUpdateBranch(config, env),
          assetName: resolveHostSelfUpdateAssetName(config, env),
          accessToken: repoConfig.accessToken
        })
        state.latestInfo = buildLatestReleaseState(info, Date.now(), '')
        state.latestError = ''
        state.latestCheckedAtMs = state.latestInfo.checkedAtMs ?? Date.now()
        return state.latestInfo
      } catch (err) {
        state.latestInfo = null
        state.latestError = trimText(err?.message) ?? 'failed to check latest host release'
        state.latestCheckedAtMs = Date.now()
        return null
      } finally {
        state.latestCheckPromise = null
      }
    })()

    return await state.latestCheckPromise
  }

  async function getPublicState({ refreshLatest = true, forceLatest = false } = {}) {
    if (refreshLatest) await refreshLatestRelease({ force: forceLatest })
    return buildHostSelfUpdatePublicState(config, {
      state,
      env,
      installed: readInstalledHostReleaseInfo()
    })
  }

  async function start() {
    const summary = await getPublicState({ refreshLatest: true, forceLatest: true })
    if (!summary.enabled) throw httpError(400, 'host self-update is not enabled in config')
    if (!summary.configured) throw httpError(400, 'host self-update repo is not configured')
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

    const repoConfig = resolveHostSelfUpdateRepoConfig(config, env)

    state.working = true
    state.awaitingRestart = false
    state.exitScheduled = false
    state.lastError = ''
    state.lastStartedAtMs = Date.now()
    state.lastCompletedAtMs = null

    await mkdir(getTransferDir(), { recursive: true, mode: 0o700 })
    const transferDir = await mkdtemp(join(getTransferDir(), 'host-update-'))
    const archivePath = join(transferDir, summary.assetName)

    try {
      const bundle = await downloadReleaseBundle({
        repoSpec: repoConfig.repo,
        branch: summary.branch,
        assetName: summary.assetName,
        accessToken: repoConfig.accessToken,
        outPath: archivePath
      })

      const actualSha256 = await hashFile(archivePath)
      if (bundle?.expectedSha256) {
        if (actualSha256 !== bundle.expectedSha256) {
          throw httpError(500, 'downloaded host bundle checksum mismatch')
        }
      }

      const installed = await installReleaseBundle({
        archivePath,
        keep: summary.keepReleases,
        bundleSha256: actualSha256
      })

      state.awaitingRestart = true
      state.lastCompletedAtMs = Date.now()
      state.latestInfo = buildLatestReleaseState({
        ...bundle,
        version: trimText(installed?.manifest?.version) ?? trimText(bundle?.version),
        releaseId: trimText(installed?.manifest?.releaseId) ?? trimText(bundle?.releaseId),
        bundleSha256: actualSha256
      }, state.lastCompletedAtMs, '')
      state.latestError = ''
      state.latestCheckedAtMs = state.latestInfo.checkedAtMs ?? state.lastCompletedAtMs

      return {
        ok: true,
        releaseId: trimText(installed?.manifest?.releaseId),
        version: trimText(installed?.manifest?.version),
        message: 'Host update succeeded. Rootgrid is restarting.',
        selfUpdate: await getPublicState({ refreshLatest: false })
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

    const restartCommand = resolveHostSelfUpdateRestartCommand(config, env)

    setTimer(async () => {
      if (restartCommand) {
        await runShell(restartCommand, {
          cwd: process.cwd(),
          detached: true,
          wait: false
        }).catch((err) => {
          try { logError('[rootgrid] host self-update restart command failed:', String(err?.message ?? err)) } catch {}
        }).finally(() => {
          try { exitProcess(0) } catch {}
        })
        return
      }

      try {
        const managedCliPath = await Promise.resolve(getManagedCliPath())
        const spec = buildHostSelfRestartSpec({ managedCliPath })
        if (typeof execProcess === 'function') {
          execProcess(spec.execPath, spec.args, spec.env)
          return
        }
        await runCommand(spec.execPath, spec.args.slice(1), {
          cwd: process.cwd(),
          env: spec.env,
          detached: true,
          wait: false
        })
        try { exitProcess(0) } catch {}
      } catch (err) {
        try { logError('[rootgrid] host self-update restart failed:', String(err?.message ?? err)) } catch {}
        try { exitProcess(1) } catch {}
      }
    }, 250)
    return true
  }

  return {
    getPublicState,
    start,
    scheduleExit
  }
}
