import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import {
  commitGitChanges,
  createGitBranch,
  execTerminalCommand,
  getGitStatus,
  listCodexModels,
  listGitBranches,
  listWorkspaceEntries,
  listWorkspaceDirectories,
  normalizeCodexModelListResult,
  parseGitStatusOutput,
  pushGitBranch,
  readWorkspaceFile,
  resolveWorkspaceListPath,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths
} from '../src/runner/runnerWorkspaceApi.js'

async function run(cmd, args, { cwd } = {}) {
  await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk ?? '')
    })
    proc.once('error', reject)
    proc.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `${cmd} exited ${code}`))
    })
  })
}

async function runOutput(cmd, args, { cwd } = {}) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk ?? '')
    })
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk ?? '')
    })
    proc.once('error', reject)
    proc.once('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `${cmd} exited ${code}`))
    })
  })
}

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

test('listWorkspaceEntries can include files and sort directories first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-fs-all-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(join(dir, 'b-dir'))
  await writeFile(join(dir, 'z-file.txt'), 'z')
  await mkdir(join(dir, 'a-dir'))
  await writeFile(join(dir, 'a-file.txt'), 'alpha')

  const out = await listWorkspaceEntries(dir, { includeFiles: true })
  assert.deepEqual(out.entries.map((entry) => [entry.kind, entry.name]), [
    ['dir', 'a-dir'],
    ['dir', 'b-dir'],
    ['file', 'a-file.txt'],
    ['file', 'z-file.txt']
  ])
})

test('readWorkspaceFile reads text files and flags truncation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-read-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const filePath = join(dir, 'note.txt')
  await writeFile(filePath, 'hello world')

  const out = await readWorkspaceFile(filePath, { maxBytes: 5 })
  assert.equal(out.path, filePath)
  assert.equal(out.binary, false)
  assert.equal(out.truncated, true)
  assert.equal(out.text, 'hello')
})

test('parseGitStatusOutput parses branch metadata and entries', () => {
  const out = parseGitStatusOutput('## main...origin/main [ahead 2, behind 1]\n M src/file.js\n?? new.txt\n', { cwd: '/repo' })
  assert.equal(out.cwd, '/repo')
  assert.equal(out.branch, 'main')
  assert.equal(out.upstream, 'origin/main')
  assert.equal(out.ahead, 2)
  assert.equal(out.behind, 1)
  assert.deepEqual(out.entries.map((entry) => ({ path: entry.path, label: entry.label })), [
    { path: 'src/file.js', label: 'M' },
    { path: 'new.txt', label: '??' }
  ])
})

test('getGitStatus reports repo state for workspace changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-git-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await run('git', ['init'], { cwd: dir })
  await writeFile(join(dir, 'untracked.txt'), 'hello')

  const out = await getGitStatus({ cwd: dir })
  assert.equal(out.cwd, dir)
  assert.equal(out.notRepo, false)
  assert.ok(Array.isArray(out.entries))
  assert.equal(out.entries.some((entry) => entry.path === 'untracked.txt'), true)
  assert.equal(typeof out.unstagedDiff, 'string')
  assert.equal(typeof out.stagedDiff, 'string')
})

test('git stage/unstage helpers update repository status', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-git-stage-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await run('git', ['init'], { cwd: dir })
  await run('git', ['config', 'user.email', 'rootgrid@example.test'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Rootgrid Test'], { cwd: dir })
  await writeFile(join(dir, 'tracked.txt'), 'base\n')
  await run('git', ['add', 'tracked.txt'], { cwd: dir })
  await run('git', ['commit', '-m', 'init'], { cwd: dir })

  await writeFile(join(dir, 'tracked.txt'), 'base\nchange\n')
  let out = await stageGitPaths({ cwd: dir, paths: ['tracked.txt'] })
  assert.deepEqual(out.paths, ['tracked.txt'])
  assert.equal(out.entries.some((entry) => entry.path === 'tracked.txt' && entry.x === 'M'), true)
  assert.match(out.stagedDiff, /tracked\.txt/)

  out = await unstageGitPaths({ cwd: dir, paths: ['tracked.txt'] })
  assert.deepEqual(out.paths, ['tracked.txt'])
  assert.equal(out.entries.some((entry) => entry.path === 'tracked.txt' && entry.y === 'M'), true)
  assert.match(out.unstagedDiff, /tracked\.txt/)
})

test('git branch helpers create and switch branches', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-git-branch-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await run('git', ['init'], { cwd: dir })
  await run('git', ['config', 'user.email', 'rootgrid@example.test'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Rootgrid Test'], { cwd: dir })
  await writeFile(join(dir, 'tracked.txt'), 'base\n')
  await run('git', ['add', 'tracked.txt'], { cwd: dir })
  await run('git', ['commit', '-m', 'init'], { cwd: dir })

  await createGitBranch({ cwd: dir, branch: 'feature/test-branch' })
  let status = await getGitStatus({ cwd: dir })
  assert.equal(status.branch, 'feature/test-branch')

  await switchGitBranch({ cwd: dir, branch: 'master' })
  status = await getGitStatus({ cwd: dir })
  assert.equal(['master', 'main'].includes(status.branch), true)

  const branches = await listGitBranches({ cwd: dir })
  assert.equal(branches.branches.some((branch) => branch.name === 'feature/test-branch'), true)
})

test('git commit helper creates a commit from staged changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-git-commit-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await run('git', ['init'], { cwd: dir })
  await run('git', ['config', 'user.email', 'rootgrid@example.test'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Rootgrid Test'], { cwd: dir })
  await writeFile(join(dir, 'tracked.txt'), 'base\n')
  await run('git', ['add', 'tracked.txt'], { cwd: dir })
  await run('git', ['commit', '-m', 'init'], { cwd: dir })

  await writeFile(join(dir, 'tracked.txt'), 'base\nchange\n')
  await run('git', ['add', 'tracked.txt'], { cwd: dir })

  const out = await commitGitChanges({ cwd: dir, message: 'feat: update tracked file' })
  assert.equal(out.message, 'feat: update tracked file')
  assert.deepEqual(out.entries, [])

  const subject = await runOutput('git', ['log', '-1', '--pretty=%s'], { cwd: dir })
  assert.equal(subject.trim(), 'feat: update tracked file')
})

test('git push helper publishes a branch and records upstream', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-git-push-'))
  const remoteDir = await mkdtemp(join(tmpdir(), 'rootgrid-runner-git-remote-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(remoteDir, { recursive: true, force: true })
  })

  await run('git', ['init'], { cwd: dir })
  await run('git', ['config', 'user.email', 'rootgrid@example.test'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Rootgrid Test'], { cwd: dir })
  await run('git', ['init', '--bare'], { cwd: remoteDir })
  await run('git', ['remote', 'add', 'origin', remoteDir], { cwd: dir })
  await writeFile(join(dir, 'tracked.txt'), 'base\n')
  await run('git', ['add', 'tracked.txt'], { cwd: dir })
  await run('git', ['commit', '-m', 'init'], { cwd: dir })

  const out = await pushGitBranch({ cwd: dir })
  assert.equal(out.remote, 'origin')
  assert.equal(out.setUpstream, true)
  assert.match(String(out.upstream ?? ''), /^origin\//)

  const branchRef = await runOutput('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir })
  const remoteHead = await runOutput('git', ['--git-dir', remoteDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: dir })
  assert.equal(remoteHead.split(/\r?\n/).filter(Boolean).includes(branchRef.trim()), true)
})

test('execTerminalCommand captures stdout and exit status', async () => {
  const out = await execTerminalCommand({
    cwd: tmpdir(),
    command: 'printf "hello terminal"',
    timeoutMs: 5_000
  })
  assert.equal(out.exitCode, 0)
  assert.equal(out.stdout, 'hello terminal')
  assert.equal(out.timedOut, false)
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
