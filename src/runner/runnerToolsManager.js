import { spawn } from 'node:child_process'
import process from 'node:process'

import { resetCodeServerDetectionCache } from './ideManager.js'
import { checkCodeServerInstalled, checkCodexInstalled } from '../setup/setupChecks.js'
import { codexDeviceAuthSucceeded, detectCodexAuthIssue, parseCodexDeviceAuthOutput, parseCodexLoginStatus, stripAnsiText } from '../lib/codexAuth.js'
import { applyManagedRunnerToolEnv, buildManagedRunnerToolEnv, getRunnerToolInstallSpec } from '../lib/runnerTooling.js'

function trimText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function httpError(statusCode, message) {
  const err = new Error(message)
  err.statusCode = statusCode
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

function summarizeToolInstallWarning(toolId, result) {
  if (toolId !== 'codex') return ''
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n')
  if (!/bubblewrap could not be installed automatically/i.test(output)) return ''
  return ' System bubblewrap could not be installed automatically; Codex may keep using its vendored sandbox fallback on this runner.'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultRunCommand(command, args = [], {
  cwd = null,
  env = null,
  input = null,
  timeoutMs = 20 * 60 * 1000,
  maxBytes = 128 * 1024
} = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`${[command, ...args].join(' ')} timed out`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (stdout.length >= maxBytes) return
      stdout += String(chunk).slice(0, maxBytes - stdout.length)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length >= maxBytes) return
      stderr += String(chunk).slice(0, maxBytes - stderr.length)
    })
    try {
      child.stdin?.end((input === null || input === undefined) ? undefined : String(input))
    } catch {
    }

    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

function createCodexAuthState() {
  return {
    supported: true,
    status: 'unknown',
    provider: null,
    code: null,
    message: 'Codex sign-in state has not been checked yet.',
    needsReauth: false,
    lastCheckedAtMs: null,
    lastIssueAtMs: null,
    detectedIssue: null,
    flow: null
  }
}

function ensureCodexAuthState(toolState) {
  if (!toolState || typeof toolState !== 'object') return createCodexAuthState()
  if (!toolState.auth || typeof toolState.auth !== 'object') {
    toolState.auth = createCodexAuthState()
  }
  return toolState.auth
}

function buildPublicCodexAuthState(authState) {
  if (!authState || typeof authState !== 'object') return null
  return {
    supported: authState.supported === true,
    status: trimText(authState.status) ?? 'unknown',
    provider: trimText(authState.provider),
    code: trimText(authState.code),
    message: trimText(authState.message) ?? '',
    needsReauth: authState.needsReauth === true,
    lastCheckedAtMs: Number.isFinite(Number(authState.lastCheckedAtMs)) ? Number(authState.lastCheckedAtMs) : null,
    lastIssueAtMs: Number.isFinite(Number(authState.lastIssueAtMs)) ? Number(authState.lastIssueAtMs) : null,
    flow: buildPublicCodexAuthFlow(authState.flow)
  }
}

function buildPublicCodexAuthFlow(flow) {
  if (!flow || typeof flow !== 'object') return null
  return {
    active: flow.active === true,
    method: trimText(flow.method),
    status: trimText(flow.status),
    output: String(flow.output ?? ''),
    verificationUrl: trimText(flow.verificationUrl),
    userCode: trimText(flow.userCode),
    error: trimText(flow.error),
    startedAtMs: Number.isFinite(Number(flow.startedAtMs)) ? Number(flow.startedAtMs) : null,
    completedAtMs: Number.isFinite(Number(flow.completedAtMs)) ? Number(flow.completedAtMs) : null
  }
}

function createToolState(toolId) {
  return {
    installed: false,
    version: null,
    source: 'missing',
    command: null,
    checking: false,
    working: false,
    lastError: '',
    lastStartedAtMs: null,
    lastCompletedAtMs: null,
    auth: toolId === 'codex' ? createCodexAuthState() : null
  }
}

function buildPublicToolState(spec, state) {
  return {
    id: spec.id,
    label: spec.label,
    installed: Boolean(state?.installed),
    version: trimText(state?.version),
    source: trimText(state?.source) ?? 'missing',
    path: trimText(state?.command),
    checking: Boolean(state?.checking),
    working: Boolean(state?.working),
    lastError: String(state?.lastError ?? '').trim(),
    lastStartedAtMs: (state?.lastStartedAtMs !== null && state?.lastStartedAtMs !== undefined && Number.isFinite(Number(state?.lastStartedAtMs)))
      ? Number(state.lastStartedAtMs)
      : null,
    lastCompletedAtMs: (state?.lastCompletedAtMs !== null && state?.lastCompletedAtMs !== undefined && Number.isFinite(Number(state?.lastCompletedAtMs)))
      ? Number(state.lastCompletedAtMs)
      : null,
    upgradeCommand: spec.upgradeCommand,
    docsUrl: spec.docsUrl,
    auth: buildPublicCodexAuthState(state?.auth)
  }
}

export function createRunnerToolsManager({
  runCommand = defaultRunCommand,
  checkCodex = checkCodexInstalled,
  checkCodeServer = checkCodeServerInstalled,
  spawnProcess = spawn
} = {}) {
  const specs = new Map([
    ['codex', {
      ...getRunnerToolInstallSpec('codex'),
      check: checkCodex
    }],
    ['codeServer', {
      ...getRunnerToolInstallSpec('codeServer'),
      check: checkCodeServer
    }]
  ])

  const state = Object.fromEntries(
    Array.from(specs.keys()).map((toolId) => [toolId, createToolState(toolId)])
  )
  let initialized = false
  let refreshPromise = null
  let codexDeviceAuthProcess = null

  async function runCodexToolCommand(args, {
    input = null,
    timeoutMs = 60_000
  } = {}) {
    const spec = specs.get('codex')
    const toolState = state.codex
    const command = trimText(toolState?.command) ?? trimText(spec?.managedBinPath)
    if (!command) throw httpError(409, 'Codex is not installed on this runner')

    try {
      const result = await runCommand(command, args, {
        cwd: process.cwd(),
        env: buildManagedRunnerToolEnv(process.env),
        input,
        timeoutMs
      })
      return {
        ok: true,
        code: 0,
        stdout: String(result?.stdout ?? ''),
        stderr: String(result?.stderr ?? '')
      }
    } catch (err) {
      return {
        ok: false,
        code: Number.isFinite(Number(err?.code)) ? Number(err.code) : null,
        stdout: String(err?.stdout ?? ''),
        stderr: String(err?.stderr ?? ''),
        error: err
      }
    }
  }

  async function refreshCodexAuth({
    clearIssue = false
  } = {}) {
    const toolState = state.codex
    if (!toolState) return null
    const authState = ensureCodexAuthState(toolState)

    if (clearIssue) authState.detectedIssue = null

    if (authState.flow?.active) {
      authState.status = 'pending-browser-auth'
      authState.code = 'device_auth_pending'
      authState.provider = null
      authState.message = authState.flow?.verificationUrl
        ? 'Open the verification URL in your browser and complete ChatGPT sign-in.'
        : 'Waiting for ChatGPT browser sign-in to complete on this runner.'
      authState.needsReauth = false
      authState.lastCheckedAtMs = Date.now()
      return buildPublicCodexAuthState(authState)
    }

    if (!toolState.installed || !trimText(toolState.command)) {
      authState.status = 'unavailable'
      authState.provider = null
      authState.code = 'tool_missing'
      authState.message = toolState.source === 'external'
        ? 'Install managed Codex on this runner to use Rootgrid sessions and web auth actions.'
        : 'Install Codex on this runner to use Rootgrid sessions.'
      authState.needsReauth = false
      authState.lastCheckedAtMs = Date.now()
      return buildPublicCodexAuthState(authState)
    }

    const result = await runCodexToolCommand(['login', 'status'], { timeoutMs: 15_000 })
    const parsed = parseCodexLoginStatus(
      [result.stdout, result.stderr].filter(Boolean).join('\n'),
      { exitCode: result.code }
    )

    authState.status = parsed.status
    authState.provider = trimText(parsed.provider)
    authState.code = trimText(parsed.code)
    authState.message = trimText(parsed.message) ?? 'Unable to determine Codex sign-in state.'
    authState.needsReauth = parsed.needsReauth === true
    authState.lastCheckedAtMs = Date.now()

    const detectedIssue = authState.detectedIssue
    if (detectedIssue && typeof detectedIssue === 'object') {
      authState.status = trimText(detectedIssue.status) ?? authState.status
      authState.code = trimText(detectedIssue.code) ?? authState.code
      authState.message = trimText(detectedIssue.message) ?? authState.message
      authState.needsReauth = detectedIssue.needsReauth === true
      authState.lastIssueAtMs = Number.isFinite(Number(detectedIssue.detectedAtMs))
        ? Number(detectedIssue.detectedAtMs)
        : authState.lastIssueAtMs
    }

    return buildPublicCodexAuthState(authState)
  }

  function reportCodexAuthIssue(value) {
    const toolState = state.codex
    if (!toolState) return null
    const issue = detectCodexAuthIssue(value)
    if (!issue) return null

    const authState = ensureCodexAuthState(toolState)
    const now = Date.now()
    authState.detectedIssue = {
      ...issue,
      detectedAtMs: now
    }
    authState.status = issue.status
    authState.code = issue.code
    authState.message = issue.message
    authState.needsReauth = issue.needsReauth === true
    authState.lastIssueAtMs = now
    return buildPublicCodexAuthState(authState)
  }

  function updateCodexDeviceAuthFlow(flow, text) {
    if (!flow || typeof flow !== 'object') return
    const nextText = stripAnsiText(text)
    if (!nextText) return
    flow.output = `${String(flow.output ?? '')}${nextText}`
    if (flow.output.length > 12 * 1024) {
      flow.output = flow.output.slice(flow.output.length - 12 * 1024)
    }
    const parsed = parseCodexDeviceAuthOutput(flow.output)
    if (parsed.verificationUrl) flow.verificationUrl = parsed.verificationUrl
    if (parsed.userCode) flow.userCode = parsed.userCode
    if (codexDeviceAuthSucceeded(flow.output) && flow.status === 'waiting') {
      flow.status = 'finishing'
    }
  }

  function currentCodexAuthFlow() {
    return ensureCodexAuthState(state.codex).flow
  }

  async function finalizeCodexDeviceAuthFlow({ code = null, signal = null, error = null } = {}) {
    const authState = ensureCodexAuthState(state.codex)
    const flow = authState.flow
    codexDeviceAuthProcess = null
    if (!flow || typeof flow !== 'object') return
    if (flow.completedAtMs && ['completed', 'failed', 'cancelled'].includes(String(flow.status ?? ''))) return

    flow.active = false
    flow.completedAtMs = Date.now()

    if (flow.status === 'cancelled') {
      flow.error = null
      authState.status = 'not-authenticated'
      authState.code = 'cancelled'
      authState.message = 'Codex sign-in was cancelled.'
      authState.needsReauth = false
      authState.lastCheckedAtMs = Date.now()
      return
    }

    if (error) {
      flow.status = 'failed'
      flow.error = trimText(error?.message) ?? 'Codex sign-in failed'
    } else if (code === 0) {
      flow.status = 'completed'
      flow.error = null
    } else {
      flow.status = 'failed'
      flow.error = signal
        ? `Codex sign-in stopped with signal ${signal}.`
        : `Codex sign-in exited with code ${String(code ?? 'unknown')}.`
    }

    const flowIssue = detectCodexAuthIssue([flow.output, flow.error].filter(Boolean).join('\n'))
    if (flowIssue) reportCodexAuthIssue([flow.output, flow.error].filter(Boolean).join('\n'))

    const completedWithSuccess = code === 0 || codexDeviceAuthSucceeded(flow.output)
    if (completedWithSuccess) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await refreshCodexAuth({ clearIssue: attempt === 0 }).catch(() => {})
        if (authState.status === 'authenticated') break
        await sleep(250)
      }
    } else {
      await refreshCodexAuth().catch(() => {})
    }

    if (code === 0 && authState.status === 'authenticated') {
      authState.message = authState.provider
        ? `Signed in using ${authState.provider}.`
        : 'Codex is signed in.'
      return
    }

    if (flow.status === 'failed' && !authState.message) {
      authState.message = flow.error ?? 'Codex sign-in failed.'
    }
  }

  function startCodexDeviceAuth() {
    const toolState = state.codex
    const authState = ensureCodexAuthState(toolState)
    if (!toolState.installed || !trimText(toolState.command)) {
      throw httpError(409, 'Install Codex on this runner before signing in.')
    }
    if (codexDeviceAuthProcess && authState.flow?.active) {
      return authState.flow
    }

    const command = trimText(toolState.command)
    if (!command) throw httpError(409, 'Codex is not installed on this runner')

    const flow = {
      active: true,
      method: 'device-auth',
      status: 'waiting',
      output: '',
      verificationUrl: null,
      userCode: null,
      error: null,
      startedAtMs: Date.now(),
      completedAtMs: null
    }
    authState.flow = flow
    authState.status = 'pending-browser-auth'
    authState.code = 'device_auth_pending'
    authState.provider = null
    authState.message = 'Waiting for ChatGPT browser sign-in to complete on this runner.'
    authState.needsReauth = false
    authState.lastCheckedAtMs = Date.now()

    let child
    try {
      child = spawnProcess(command, ['login', '--device-auth'], {
        cwd: process.cwd(),
        env: buildManagedRunnerToolEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      flow.active = false
      flow.status = 'failed'
      flow.error = trimText(err?.message) ?? 'Codex sign-in failed to start'
      flow.completedAtMs = Date.now()
      authState.status = 'not-authenticated'
      authState.code = 'device_auth_start_failed'
      authState.message = flow.error
      throw httpError(500, flow.error)
    }

    codexDeviceAuthProcess = child
    child.stdout?.on('data', (chunk) => {
      updateCodexDeviceAuthFlow(flow, chunk)
      if (flow.verificationUrl || flow.userCode) {
        authState.message = flow.verificationUrl
          ? 'Open the verification URL in your browser and complete ChatGPT sign-in.'
          : authState.message
      }
    })
    child.stderr?.on('data', (chunk) => {
      updateCodexDeviceAuthFlow(flow, chunk)
    })
    child.once('error', (err) => {
      void finalizeCodexDeviceAuthFlow({ error: err })
    })
    child.once('close', (code, signal) => {
      void finalizeCodexDeviceAuthFlow({ code, signal })
    })

    return flow
  }

  function cancelCodexDeviceAuth() {
    const authState = ensureCodexAuthState(state.codex)
    const flow = authState.flow
    if (!flow?.active || !codexDeviceAuthProcess) throw httpError(409, 'Codex browser sign-in is not currently running')
    flow.status = 'cancelled'
    flow.active = false
    flow.completedAtMs = Date.now()
    try { codexDeviceAuthProcess.kill('SIGTERM') } catch {}
    return flow
  }

  async function refreshTool(toolId) {
    const spec = specs.get(toolId)
    const toolState = state[toolId]
    if (!spec || !toolState) return null

    toolState.checking = true
    try {
      const result = await spec.check()
      toolState.installed = Boolean(result?.ok)
      toolState.version = trimText(result?.version)
      toolState.source = trimText(result?.source) ?? 'missing'
      toolState.command = trimText(result?.command)
    } catch {
      toolState.installed = false
      toolState.version = null
      toolState.source = 'missing'
      toolState.command = null
    } finally {
      toolState.checking = false
    }

    if (toolId === 'codex') {
      await refreshCodexAuth().catch(() => {})
    }

    return buildPublicToolState(spec, toolState)
  }

  async function refreshAll() {
    if (refreshPromise) {
      await refreshPromise
      return
    }

    refreshPromise = Promise.all(Array.from(specs.keys()).map((toolId) => refreshTool(toolId)))
      .finally(() => {
        initialized = true
        refreshPromise = null
      })

    await refreshPromise
  }

  async function ensureInitialized() {
    if (initialized) return
    await refreshAll()
  }

  async function getPublicState() {
    await ensureInitialized()

    return Object.fromEntries(
      Array.from(specs.entries()).map(([toolId, spec]) => [toolId, buildPublicToolState(spec, state[toolId])])
    )
  }

  async function upgrade(toolId) {
    await ensureInitialized()

    const safeToolId = String(toolId ?? '').trim()
    const spec = specs.get(safeToolId)
    const toolState = state[safeToolId]
    if (!spec || !toolState) throw httpError(404, 'runner tool not found')
    if (toolState.working) throw httpError(409, `${spec.label} upgrade is already running`)

    toolState.working = true
    toolState.lastError = ''
    toolState.lastStartedAtMs = Date.now()
    toolState.lastCompletedAtMs = null

    try {
      const installResult = await runCommand('/bin/sh', ['-lc', spec.upgradeCommand], {
        cwd: process.cwd(),
        env: buildManagedRunnerToolEnv(process.env)
      })
      const installWarning = summarizeToolInstallWarning(safeToolId, installResult)
      applyManagedRunnerToolEnv(process.env)
      if (safeToolId === 'codeServer') resetCodeServerDetectionCache()
      await refreshTool(safeToolId)
      toolState.lastCompletedAtMs = Date.now()
      toolState.working = false

      const tool = buildPublicToolState(spec, toolState)
      return {
        ok: true,
        tool,
        tools: await getPublicState(),
        message: `${tool.installed
          ? `${spec.label} managed install is now ${tool.version ?? 'installed'}.`
          : `${spec.label} install command completed, but the managed binary is still not available on the runner.`}${installWarning}`
      }
    } catch (err) {
      toolState.lastError = trimText(err?.message) ?? `${spec.label} upgrade failed`
      toolState.lastCompletedAtMs = Date.now()
      await refreshTool(safeToolId).catch(() => {})
      throw (Number(err?.statusCode) ? err : httpError(500, toolState.lastError))
    } finally {
      toolState.working = false
    }
  }

  async function auth(toolId, action, payload = null) {
    await ensureInitialized()

    const safeToolId = String(toolId ?? '').trim()
    const safeAction = String(action ?? '').trim()
    const spec = specs.get(safeToolId)
    const toolState = state[safeToolId]
    if (!spec || !toolState) throw httpError(404, 'runner tool not found')
    if (safeToolId !== 'codex') throw httpError(400, `${spec.label} does not support web auth actions`)
    if (!safeAction) throw httpError(400, 'auth action is required')
    if (toolState.working) throw httpError(409, `${spec.label} action is already running`)

    toolState.working = true
    toolState.lastError = ''
    toolState.lastStartedAtMs = Date.now()
    toolState.lastCompletedAtMs = null

    try {
      let message = ''
      if (safeAction === 'refresh') {
        await refreshCodexAuth({ clearIssue: true })
        message = 'Codex sign-in state was refreshed.'
      } else if (safeAction === 'startDeviceAuth') {
        const flow = startCodexDeviceAuth()
        message = flow?.verificationUrl
          ? 'Open the verification URL and finish ChatGPT sign-in for Codex.'
          : 'ChatGPT sign-in for Codex started on this runner.'
      } else if (safeAction === 'cancelDeviceAuth') {
        cancelCodexDeviceAuth()
        await refreshCodexAuth({ clearIssue: true })
        message = 'Codex browser sign-in was cancelled.'
      } else if (safeAction === 'logout') {
        const result = await runCodexToolCommand(['logout'], { timeoutMs: 30_000 })
        if (!result.ok && result.error) {
          throw (Number(result.error?.statusCode) ? result.error : httpError(500, trimText(result.error?.message) ?? 'Codex logout failed'))
        }
        await refreshCodexAuth({ clearIssue: true })
        message = 'Codex was logged out on this runner.'
      } else if (safeAction === 'loginApiKey') {
        const apiKey = trimText(payload?.apiKey)
        if (!apiKey) throw httpError(400, 'apiKey is required')
        const result = await runCodexToolCommand(['login', '--with-api-key'], {
          input: `${apiKey}\n`,
          timeoutMs: 120_000
        })
        if (!result.ok && result.error) {
          throw (Number(result.error?.statusCode) ? result.error : httpError(500, trimText(result.error?.message) ?? 'Codex login failed'))
        }
        await refreshCodexAuth({ clearIssue: true })
        const provider = trimText(toolState.auth?.provider)
        message = provider
          ? `Codex is now signed in using ${provider}.`
          : 'Codex sign-in completed on this runner.'
      } else {
        throw httpError(400, 'unsupported auth action')
      }

      toolState.lastCompletedAtMs = Date.now()
      toolState.working = false
      return {
        ok: true,
        tool: buildPublicToolState(spec, toolState),
        tools: await getPublicState(),
        message
      }
    } catch (err) {
      toolState.lastError = trimText(err?.message) ?? `${spec.label} auth action failed`
      toolState.lastCompletedAtMs = Date.now()
      await refreshCodexAuth().catch(() => {})
      throw (Number(err?.statusCode) ? err : httpError(500, toolState.lastError))
    } finally {
      toolState.working = false
    }
  }

  return {
    capabilities() {
      return {
        enabled: true,
        upgrades: true,
        auth: true
      }
    },
    getPublicState,
    upgrade,
    refreshAll,
    auth,
    reportCodexAuthIssue
  }
}
