import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { JsonRpcStdioClient } from './sessions/JsonRpcStdioClient.js'

export function resolveWorkspaceListPath(input, { homeDir = homedir() } = {}) {
  let dir = String(input ?? '').trim()
  if (!dir || dir === '~') {
    dir = homeDir
  } else if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    dir = join(homeDir, dir.slice(2))
  } else if (!dir.startsWith('/')) {
    dir = resolve(homeDir, dir)
  }
  return resolve(dir)
}

export async function listWorkspaceEntries(dir, { limit = 500, includeFiles = false } = {}) {
  const resolvedDir = resolveWorkspaceListPath(dir)
  const raw = await readdir(resolvedDir, { withFileTypes: true })
  const entries = []
  for (const ent of raw) {
    const entryPath = join(resolvedDir, ent.name)
    if (ent?.isDirectory?.()) {
      entries.push({
        name: ent.name,
        path: entryPath,
        kind: 'dir'
      })
      continue
    }
    if (!includeFiles) continue
    if (!ent?.isFile?.()) continue
    let sizeBytes = null
    try {
      const info = await stat(entryPath)
      sizeBytes = Number.isFinite(Number(info?.size)) ? Number(info.size) : null
    } catch {
    }
    entries.push({
      name: ent.name,
      path: entryPath,
      kind: 'file',
      ...(sizeBytes === null ? {} : { sizeBytes })
    })
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return String(a.name).localeCompare(String(b.name))
  })

  let parent = null
  try {
    const nextParent = dirname(resolvedDir)
    if (nextParent && nextParent !== resolvedDir) parent = nextParent
  } catch {
  }

  return {
    path: resolvedDir,
    parent,
    entries: entries.slice(0, limit)
  }
}

export async function listWorkspaceDirectories(dir, { limit = 500 } = {}) {
  return await listWorkspaceEntries(dir, { limit, includeFiles: false })
}

function detectBinaryBuffer(buffer) {
  if (!buffer || !buffer.length) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

export async function readWorkspaceFile(filePath, { maxBytes = 200_000 } = {}) {
  const resolvedPath = resolveWorkspaceListPath(filePath)
  const info = await stat(resolvedPath)
  if (!info?.isFile?.()) throw new Error('path is not a file')
  const max = Math.max(1, Math.min(Number(maxBytes) || 200_000, 1_000_000))
  const sizeBytes = Number.isFinite(Number(info?.size)) ? Number(info.size) : 0
  const handle = await open(resolvedPath, 'r')
  try {
    const bytesToRead = Math.min(sizeBytes, max + 1)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const chunk = buffer.subarray(0, bytesRead)
    const binary = detectBinaryBuffer(chunk)
    const truncated = sizeBytes > max
    return {
      path: resolvedPath,
      sizeBytes,
      truncated,
      binary,
      text: binary ? '' : chunk.subarray(0, max).toString('utf8')
    }
  } finally {
    try { await handle.close() } catch { }
  }
}

function appendOutputTail(current, chunk, maxChars = 400_000) {
  const next = `${current}${String(chunk ?? '')}`
  return next.length <= maxChars ? next : next.slice(-maxChars)
}

async function runCommandCapture(command, args, { cwd = homedir(), timeoutMs = 20_000, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try { proc.kill('SIGKILL') } catch { }
      }, timeoutMs)
      : null

    proc.stdout?.on('data', (chunk) => {
      stdout = appendOutputTail(stdout, chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      stderr = appendOutputTail(stderr, chunk)
    })
    proc.once('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    proc.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: signal ? String(signal) : null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    })
  })
}

export function parseGitStatusOutput(stdout, { cwd = '' } = {}) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter(Boolean)
  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  const entries = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim()
      const [leftPart, rightPart = ''] = head.split(' [')
      const [branchPart, upstreamPart] = leftPart.split('...')
      branch = branchPart ? branchPart.trim() : null
      upstream = upstreamPart ? upstreamPart.trim() : null
      const statusBits = rightPart.replace(/\]$/, '').split(',').map((bit) => bit.trim()).filter(Boolean)
      for (const bit of statusBits) {
        if (bit.startsWith('ahead ')) ahead = Number.parseInt(bit.slice(6), 10) || 0
        if (bit.startsWith('behind ')) behind = Number.parseInt(bit.slice(7), 10) || 0
      }
      continue
    }
    if (line.length < 3) continue
    const x = line[0]
    const y = line[1]
    const pathText = line.slice(3).trim()
    if (!pathText) continue
    const renameParts = pathText.split(' -> ')
    entries.push({
      path: renameParts[renameParts.length - 1],
      ...(renameParts.length > 1 ? { originalPath: renameParts[0] } : {}),
      x,
      y,
      label: `${x}${y}`.trim() || '??'
    })
  }

  return {
    cwd: String(cwd ?? '').trim(),
    branch,
    upstream,
    ahead,
    behind,
    entries
  }
}

async function runGitCommand(args, { cwd = '', timeoutMs = 10_000 } = {}) {
  const resolvedCwd = resolveWorkspaceListPath(cwd)
  const result = await runCommandCapture('git', ['-C', resolvedCwd, ...args], {
    cwd: resolvedCwd,
    timeoutMs
  })
  if (result.code !== 0) {
    throw new Error(String(result.stderr ?? result.stdout ?? 'git command failed').trim() || 'git command failed')
  }
  return {
    cwd: resolvedCwd,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs
  }
}

export function parseGitBranchesOutput(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [nameRaw = '', currentRaw = ''] = line.split('\t')
      const name = String(nameRaw).trim()
      if (!name) return null
      return {
        name,
        current: String(currentRaw).trim() === '*'
      }
    })
    .filter(Boolean)
}

export async function listGitBranches({ cwd = '', timeoutMs = 10_000 } = {}) {
  const result = await runGitCommand([
    'for-each-ref',
    '--format=%(refname:short)\t%(if)%(HEAD)%(then)*%(end)',
    'refs/heads'
  ], { cwd, timeoutMs })
  return {
    cwd: result.cwd,
    branches: parseGitBranchesOutput(result.stdout)
  }
}

export async function getGitStatus({ cwd = '', timeoutMs = 10_000 } = {}) {
  const resolvedCwd = resolveWorkspaceListPath(cwd)
  const check = await runCommandCapture('git', ['-C', resolvedCwd, 'rev-parse', '--show-toplevel'], {
    cwd: resolvedCwd,
    timeoutMs
  })
  if (check.code !== 0) {
    const stderr = String(check.stderr ?? '').trim()
    const notRepo = /not a git repository/i.test(stderr)
    return {
      cwd: resolvedCwd,
      rootPath: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
      notRepo,
      ...(stderr ? { error: stderr } : {})
    }
  }
  const rootPath = String(check.stdout ?? '').trim() || resolvedCwd
  const result = await runCommandCapture('git', ['-C', resolvedCwd, 'status', '--short', '--branch', '--untracked-files=all'], {
    cwd: resolvedCwd,
    timeoutMs
  })
  if (result.code !== 0) {
    throw new Error(String(result.stderr ?? result.stdout ?? 'git status failed').trim() || 'git status failed')
  }
  let branches = []
  try {
    const branchInfo = await listGitBranches({ cwd: resolvedCwd, timeoutMs })
    branches = Array.isArray(branchInfo?.branches) ? branchInfo.branches : []
  } catch {
  }
  return {
    ...parseGitStatusOutput(result.stdout, { cwd: resolvedCwd }),
    rootPath,
    branches,
    notRepo: false
  }
}

export async function stageGitPaths({ cwd = '', paths = [], timeoutMs = 10_000 } = {}) {
  const safePaths = (Array.isArray(paths) ? paths : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (!safePaths.length) throw new Error('paths are required')
  const result = await runGitCommand(['add', '--', ...safePaths], { cwd, timeoutMs })
  return {
    cwd: result.cwd,
    paths: safePaths
  }
}

export async function unstageGitPaths({ cwd = '', paths = [], timeoutMs = 10_000 } = {}) {
  const safePaths = (Array.isArray(paths) ? paths : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (!safePaths.length) throw new Error('paths are required')
  try {
    const result = await runGitCommand(['restore', '--staged', '--', ...safePaths], { cwd, timeoutMs })
    return {
      cwd: result.cwd,
      paths: safePaths
    }
  } catch {
    const result = await runGitCommand(['reset', 'HEAD', '--', ...safePaths], { cwd, timeoutMs })
    return {
      cwd: result.cwd,
      paths: safePaths
    }
  }
}

async function switchGitWithFallback({ cwd = '', branch, timeoutMs = 10_000, create = false } = {}) {
  const safeBranch = String(branch ?? '').trim()
  if (!safeBranch) throw new Error('branch is required')
  const argsPrimary = create ? ['switch', '-c', safeBranch] : ['switch', safeBranch]
  const argsFallback = create ? ['checkout', '-b', safeBranch] : ['checkout', safeBranch]
  try {
    const result = await runGitCommand(argsPrimary, { cwd, timeoutMs })
    return {
      cwd: result.cwd,
      branch: safeBranch
    }
  } catch {
    const result = await runGitCommand(argsFallback, { cwd, timeoutMs })
    return {
      cwd: result.cwd,
      branch: safeBranch
    }
  }
}

export async function switchGitBranch({ cwd = '', branch, timeoutMs = 10_000 } = {}) {
  return await switchGitWithFallback({ cwd, branch, timeoutMs, create: false })
}

export async function createGitBranch({ cwd = '', branch, timeoutMs = 10_000 } = {}) {
  return await switchGitWithFallback({ cwd, branch, timeoutMs, create: true })
}

export async function execTerminalCommand({ cwd = '', command, timeoutMs = 60_000 } = {}) {
  const resolvedCwd = resolveWorkspaceListPath(cwd)
  const text = String(command ?? '').trim()
  if (!text) throw new Error('command is required')
  const shell = String(process.env.SHELL ?? '').trim() || '/bin/sh'
  const result = await runCommandCapture(shell, ['-lc', text], {
    cwd: resolvedCwd,
    timeoutMs: Math.max(1_000, Math.min(Number(timeoutMs) || 60_000, 10 * 60_000))
  })
  return {
    cwd: resolvedCwd,
    command: text,
    exitCode: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  }
}

export function normalizeCodexModelListResult(result) {
  const models = Array.isArray(result?.models)
    ? result.models
    : (Array.isArray(result?.data) ? result.data : (Array.isArray(result?.items) ? result.items : []))
  const nextCursorRaw = result?.nextCursor ?? result?.next_cursor ?? result?.cursor ?? null
  return {
    models,
    nextCursor: (nextCursorRaw === null || nextCursorRaw === undefined) ? null : String(nextCursorRaw)
  }
}

export async function listCodexModels({
  cwd = '',
  limit = 200,
  includeHidden = false,
  JsonRpcClientClass = JsonRpcStdioClient
} = {}) {
  const rpc = new JsonRpcClientClass({
    command: 'codex',
    args: ['app-server'],
    cwd: (typeof cwd === 'string' && cwd.trim()) ? cwd.trim() : homedir(),
    env: process.env,
    onNotification: () => {},
    onRequest: async () => null,
    onStderr: () => {}
  })

  try {
    await rpc.start()
    await rpc.sendRequest('initialize', {
      clientInfo: {
        name: 'rootgrid',
        title: 'Rootgrid',
        version: '0.0.0'
      }
    })
    rpc.sendNotification('initialized', {})

    const params = {
      limit: Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200,
      includeHidden: Boolean(includeHidden)
    }

    let result = null
    let lastErr = null
    for (const method of ['model/list', 'models/list']) {
      try {
        result = await rpc.sendRequest(method, params)
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!result) throw lastErr ?? new Error('model list failed')
    return normalizeCodexModelListResult(result)
  } finally {
    try { rpc.stop({ signal: 'SIGTERM' }) } catch { }
  }
}
