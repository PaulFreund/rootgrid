import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

export async function listWorkspaceDirectories(dir, { limit = 500 } = {}) {
  const resolvedDir = resolveWorkspaceListPath(dir)
  const raw = await readdir(resolvedDir, { withFileTypes: true })
  const entries = raw
    .filter((ent) => Boolean(ent?.isDirectory?.()))
    .map((ent) => ({
      name: ent.name,
      path: join(resolvedDir, ent.name),
      kind: 'dir'
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)

  let parent = null
  try {
    const nextParent = dirname(resolvedDir)
    if (nextParent && nextParent !== resolvedDir) parent = nextParent
  } catch {
  }

  return {
    path: resolvedDir,
    parent,
    entries
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
