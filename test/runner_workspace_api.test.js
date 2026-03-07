import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listCodexModels,
  listWorkspaceDirectories,
  normalizeCodexModelListResult,
  resolveWorkspaceListPath
} from '../src/runner/runnerWorkspaceApi.js'

test('resolveWorkspaceListPath expands home and relative paths', () => {
  const homeDir = '/tmp/rootgrid-home'
  assert.equal(resolveWorkspaceListPath('', { homeDir }), homeDir)
  assert.equal(resolveWorkspaceListPath('~/repo', { homeDir }), join(homeDir, 'repo'))
  assert.equal(resolveWorkspaceListPath('project/subdir', { homeDir }), join(homeDir, 'project/subdir'))
})

test('listWorkspaceDirectories returns sorted directory entries only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-fs-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(join(dir, 'b-dir'))
  await mkdir(join(dir, 'a-dir'))
  await writeFile(join(dir, 'file.txt'), 'not-a-dir')

  const out = await listWorkspaceDirectories(dir)
  assert.equal(out.path, dir)
  assert.deepEqual(out.entries.map((entry) => entry.name), ['a-dir', 'b-dir'])
  assert.ok(out.entries.every((entry) => entry.kind === 'dir'))
})

test('normalizeCodexModelListResult preserves fallback response shapes', () => {
  assert.deepEqual(normalizeCodexModelListResult({ items: [{ id: 'gpt-5' }], cursor: 12 }), {
    models: [{ id: 'gpt-5' }],
    nextCursor: '12'
  })
})

test('listCodexModels retries fallback methods and normalizes the result', async () => {
  class FakeRpc {
    constructor(opts) {
      this.opts = opts
      this.requests = []
      this.started = false
      this.stopped = false
      FakeRpc.instance = this
    }

    async start() {
      this.started = true
    }

    async sendRequest(method, params) {
      this.requests.push({ method, params })
      if (method === 'initialize') return { ok: true }
      if (method === 'model/list') throw new Error('unsupported')
      if (method === 'models/list') {
        return { data: [{ id: 'gpt-5-mini' }], next_cursor: 'cursor-2' }
      }
      throw new Error(`unexpected method: ${method}`)
    }

    sendNotification(method, params) {
      this.notification = { method, params }
    }

    stop() {
      this.stopped = true
    }
  }

  const out = await listCodexModels({
    cwd: '/tmp/workspace',
    limit: 75,
    includeHidden: true,
    JsonRpcClientClass: FakeRpc
  })

  assert.deepEqual(out, {
    models: [{ id: 'gpt-5-mini' }],
    nextCursor: 'cursor-2'
  })
  assert.equal(FakeRpc.instance.started, true)
  assert.equal(FakeRpc.instance.stopped, true)
  assert.deepEqual(FakeRpc.instance.requests.map((req) => req.method), [
    'initialize',
    'model/list',
    'models/list'
  ])
  assert.deepEqual(FakeRpc.instance.requests[1].params, {
    limit: 75,
    includeHidden: true
  })
  assert.deepEqual(FakeRpc.instance.notification, {
    method: 'initialized',
    params: {}
  })
})
