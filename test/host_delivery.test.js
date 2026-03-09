import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'

import WebSocket from 'ws'

import { buildDefaultConfig } from '../src/config/defaultConfig.js'
import { Store } from '../src/db/store.js'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = (addr && typeof addr === 'object') ? addr.port : null
      srv.close(() => resolve(port))
    })
  })
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const value = await check()
      if (value) return value
    } catch {
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function startHostProcess({ cwd }) {
  const base = await mkdtemp(join(tmpdir(), 'rootgrid-test-'))
  const home = join(base, 'home')
  await mkdir(join(home, '.rootgrid'), { recursive: true, mode: 0o700 })

  const config = buildDefaultConfig()
  config.host.listen.host = '127.0.0.1'
  config.host.listen.port = await getFreePort()
  config.runner.enabled = false

  await writeFile(join(home, '.rootgrid', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

  const child = spawn(process.execPath, ['src/cli.js'], {
    cwd,
    env: { ...process.env, HOME: home, ROOTGRID_DISABLE_AUTO_MANAGED_RUNTIME: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${config.host.listen.port}/`).catch(() => null)
    return Boolean(res)
  }, { timeoutMs: 10_000, intervalMs: 150 })

  const stop = async () => {
    try { child.kill('SIGTERM') } catch { }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ])
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { }
    }
    await rm(base, { recursive: true, force: true })
  }

  return { base, home, config, child, stop }
}

async function login({ port, token }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  })
  assert.equal(res.status, 200)
  const cookie = res.headers.get('set-cookie')
  assert.ok(cookie)
  return cookie
}

test('auth logout clears the session cookie client-side', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  assert.match(cookie, /rootgrid_session=/)

  const res = await fetch(`http://127.0.0.1:${port}/api/auth`, {
    method: 'DELETE',
    headers: {
      cookie
    }
  })

  assert.equal(res.status, 200)
  assert.match(String(res.headers.get('set-cookie') ?? ''), /Max-Age=0/)
})

async function apiJson({ port, path, method = 'GET', cookie = null, body = null }) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (body !== null) headers['Content-Type'] = 'application/json'
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {})
  })
  const data = await res.json().catch(() => null)
  return { res, data }
}

async function connectRunner({ port, token, machineId, capabilities = {} }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/runner/ws`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  ws.send(JSON.stringify({
    v: 1,
    type: 'hello',
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope: { machineId },
    payload: {
      token,
      machine: {
        id: machineId,
        name: 'fake-runner',
        platform: 'linux',
        capabilities
      }
    }
  }))

  const welcome = await new Promise((resolve, reject) => {
    ws.once('message', (buf) => {
      try {
        resolve(JSON.parse(String(buf)))
      } catch (err) {
        reject(err)
      }
    })
    ws.once('error', reject)
  })
  assert.equal(welcome.type, 'welcome')
  return ws
}

test('message POST does not persist a phantom user input when runner is disconnected', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-test-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  runner.close()
  await waitFor(async () => {
    const out = await apiJson({ port, path: '/api/machines', cookie })
    const row = Array.isArray(out.data?.machines) ? out.data.machines.find((m) => m.machineId === machineId) : null
    return row && row.connected === false
  }, { timeoutMs: 5_000, intervalMs: 100 })

  const text = 'this should not be persisted'
  const send = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/messages`,
    method: 'POST',
    cookie,
    body: { text }
  })
  assert.equal(send.res.status, 503)

  const events = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/events?mode=full&limit=100`,
    cookie
  })
  assert.equal(events.res.status, 200)
  const found = (Array.isArray(events.data?.events) ? events.data.events : []).some((e) => {
    return e?.type === 'session.input' && e?.payload?.text === text
  })
  assert.equal(found, false)
})

test('session bootstrap endpoint returns session metadata plus a prefetched summary window', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-bootstrap-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }

    if (msg.type !== 'session.send') return

    runner.send(JSON.stringify({
      v: 1,
      type: 'session.command.accepted',
      ts: Date.now(),
      id: crypto.randomUUID(),
      scope: { machineId, sessionId: msg.payload.sessionId },
      payload: {
        requestId: msg.payload.requestId,
        sessionId: msg.payload.sessionId,
        kind: 'send'
      }
    }))

    runner.send(JSON.stringify({
      v: 1,
      type: 'session.output',
      ts: Date.now(),
      id: crypto.randomUUID(),
      scope: { machineId, sessionId: msg.payload.sessionId },
      payload: {
        sessionId: msg.payload.sessionId,
        stream: 'normalized',
        text: 'world'
      }
    }))
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const send = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/messages`,
    method: 'POST',
    cookie,
    body: { text: 'hello' }
  })
  assert.equal(send.res.status, 200)

  await waitFor(async () => {
    const out = await apiJson({
      port,
      path: `/api/sessions/${sessionId}/events?mode=full&limit=10`,
      cookie
    })
    return (out.data?.events ?? []).some((event) => event?.type === 'session.output')
  }, { timeoutMs: 5_000, intervalMs: 50 })

  const bootstrap = await apiJson({
    port,
    path: `/api/sessions/${sessionId}?bootstrap=1&limit=1&prefetchPages=2&prefetchLimit=1`,
    cookie
  })
  assert.equal(bootstrap.res.status, 200)
  assert.equal(bootstrap.data?.session?.sessionId, sessionId)
  assert.deepEqual((bootstrap.data?.events ?? []).map((event) => event?.type), ['session.input', 'session.output'])
  assert.equal(bootstrap.data?.containsInput, true)
  assert.equal(bootstrap.data?.hasMoreBefore, false)
  assert.equal(bootstrap.data?.pagesFetched, 2)
})

test('raw upload endpoint streams bytes and messages can reference uploaded files', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-upload-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  /** @type {Map<string, { chunks: Buffer[], filename: string, mimeType: string, done: boolean }>} */
  const uploads = new Map()
  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }

    if (msg.type === 'session.upload.begin') {
      uploads.set(String(msg.payload.uploadId), {
        chunks: [],
        filename: String(msg.payload.filename ?? ''),
        mimeType: String(msg.payload.mimeType ?? ''),
        done: false
      })
      return
    }

    if (msg.type === 'session.upload.chunk') {
      const state = uploads.get(String(msg.payload.uploadId))
      if (!state) return
      state.chunks.push(Buffer.from(String(msg.payload.chunkBase64 ?? ''), 'base64'))
      return
    }

    if (msg.type === 'session.upload.end') {
      const uploadId = String(msg.payload.uploadId)
      const sessionId = String(msg.payload.sessionId)
      const state = uploads.get(uploadId)
      if (!state) return
      state.done = true
      runner.send(JSON.stringify({
        v: 1,
        type: 'session.uploaded',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId, sessionId },
        payload: {
          sessionId,
          uploadId,
          path: `/runner/${uploadId}/${state.filename}`,
          filename: state.filename,
          mimeType: state.mimeType,
          sizeBytes: Buffer.concat(state.chunks).length
        }
      }))
      return
    }

    if (msg.type === 'session.send') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'session.command.accepted',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId, sessionId: msg.payload.sessionId },
        payload: {
          requestId: msg.payload.requestId,
          sessionId: msg.payload.sessionId,
          kind: 'send'
        }
      }))
    }
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const bytes = Buffer.from('hello streamed upload')
  const uploadRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/uploads?filename=${encodeURIComponent('note.txt')}`, {
    method: 'POST',
    headers: {
      cookie,
      'Content-Type': 'text/plain'
    },
    body: bytes
  })
  assert.equal(uploadRes.status, 200)
  const upload = await uploadRes.json()
  assert.ok(upload?.uploadId)

  await waitFor(() => {
    const state = uploads.get(String(upload.uploadId))
    return state?.done ? state : null
  }, { timeoutMs: 5_000, intervalMs: 50 })

  const uploadedState = uploads.get(String(upload.uploadId))
  assert.ok(uploadedState)
  assert.equal(Buffer.concat(uploadedState.chunks).toString('utf8'), bytes.toString('utf8'))

  const send = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/messages`,
    method: 'POST',
    cookie,
    body: {
      text: 'see attachment',
      attachments: [{ uploadId: upload.uploadId }]
    }
  })
  assert.equal(send.res.status, 200)

  const events = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/events?mode=full&limit=100`,
    cookie
  })
  assert.equal(events.res.status, 200)
  const inputEvent = (Array.isArray(events.data?.events) ? events.data.events : []).find((e) => {
    return e?.type === 'session.input' && e?.payload?.text === 'see attachment'
  })
  assert.ok(inputEvent)
  assert.deepEqual(inputEvent.payload.attachments, [
    {
      uploadId: upload.uploadId,
      filename: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      url: `/api/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(upload.uploadId)}`
    }
  ])
})

test('legacy inline base64 attachments still upload and persist as reusable refs', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-upload-inline-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  /** @type {Map<string, { chunks: Buffer[], filename: string, done: boolean }>} */
  const uploads = new Map()
  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }

    if (msg.type === 'session.upload.begin') {
      uploads.set(String(msg.payload.uploadId), {
        chunks: [],
        filename: String(msg.payload.filename ?? ''),
        done: false
      })
      return
    }

    if (msg.type === 'session.upload.chunk') {
      const state = uploads.get(String(msg.payload.uploadId))
      if (!state) return
      state.chunks.push(Buffer.from(String(msg.payload.chunkBase64 ?? ''), 'base64'))
      return
    }

    if (msg.type === 'session.upload.end') {
      const uploadId = String(msg.payload.uploadId)
      const sessionId = String(msg.payload.sessionId)
      const state = uploads.get(uploadId)
      if (!state) return
      state.done = true
      runner.send(JSON.stringify({
        v: 1,
        type: 'session.uploaded',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId, sessionId },
        payload: {
          sessionId,
          uploadId,
          path: `/runner/${uploadId}/${state.filename}`,
          filename: state.filename,
          mimeType: 'text/plain',
          sizeBytes: Buffer.concat(state.chunks).length
        }
      }))
      return
    }

    if (msg.type === 'session.send') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'session.command.accepted',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId, sessionId: msg.payload.sessionId },
        payload: {
          requestId: msg.payload.requestId,
          sessionId: msg.payload.sessionId,
          kind: 'send'
        }
      }))
    }
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const bytes = Buffer.from('legacy inline attachment')
  const send = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/messages`,
    method: 'POST',
    cookie,
    body: {
      text: 'inline attachment fallback',
      attachments: [{
        filename: 'legacy.txt',
        mimeType: 'text/plain',
        contentBase64: bytes.toString('base64')
      }]
    }
  })
  assert.equal(send.res.status, 200)

  const uploadedState = await waitFor(() => {
    for (const state of uploads.values()) {
      if (state?.done) return state
    }
    return null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.equal(Buffer.concat(uploadedState.chunks).toString('utf8'), bytes.toString('utf8'))

  const events = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/events?mode=full&limit=100`,
    cookie
  })
  assert.equal(events.res.status, 200)
  const inputEvent = (Array.isArray(events.data?.events) ? events.data.events : []).find((e) => {
    return e?.type === 'session.input' && e?.payload?.text === 'inline attachment fallback'
  })
  assert.ok(inputEvent)
  assert.equal(Array.isArray(inputEvent.payload.attachments), true)
  assert.equal(inputEvent.payload.attachments[0].filename, 'legacy.txt')
  assert.equal(inputEvent.payload.attachments[0].mimeType, 'text/plain')
  assert.equal(inputEvent.payload.attachments[0].sizeBytes, bytes.length)
  assert.ok(typeof inputEvent.payload.attachments[0].uploadId === 'string')
})

test('queued prompts persist in bootstrap payloads and auto-drain after turn completion', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-queue-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  let sendCount = 0
  let drainedText = null
  let sessionId = null
  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }

    if (msg.type !== 'session.send') return
    sendCount += 1
    if (sendCount >= 2) drainedText = String(msg.payload?.text ?? '')

    runner.send(JSON.stringify({
      v: 1,
      type: 'session.command.accepted',
      ts: Date.now(),
      id: crypto.randomUUID(),
      scope: { machineId, sessionId: msg.payload.sessionId },
      payload: {
        requestId: msg.payload.requestId,
        sessionId: msg.payload.sessionId,
        kind: 'send'
      }
    }))
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const firstSend = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/messages`,
    method: 'POST',
    cookie,
    body: { text: 'first turn' }
  })
  assert.equal(firstSend.res.status, 200)

  const queueCreate = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/queued-prompts`,
    method: 'POST',
    cookie,
    body: { text: 'after completion' }
  })
  assert.equal(queueCreate.res.status, 200)
  assert.equal(Array.isArray(queueCreate.data?.queuedPrompts), true)
  assert.equal(queueCreate.data?.queuedPrompts?.length, 1)

  const bootstrapBefore = await apiJson({
    port,
    path: `/api/sessions/${sessionId}?bootstrap=1`,
    cookie
  })
  assert.equal(bootstrapBefore.res.status, 200)
  assert.equal(bootstrapBefore.data?.queuedPrompts?.length, 1)
  assert.equal(bootstrapBefore.data?.queuedPrompts?.[0]?.text, 'after completion')

  runner.send(JSON.stringify({
    v: 1,
    type: 'turn.completed',
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope: { machineId, sessionId },
    payload: {
      sessionId,
      turnId: 'turn-1',
      status: 'completed',
      preview: 'done'
    }
  }))

  await waitFor(() => drainedText === 'after completion', { timeoutMs: 5_000, intervalMs: 50 })

  const bootstrapAfter = await apiJson({
    port,
    path: `/api/sessions/${sessionId}?bootstrap=1`,
    cookie
  })
  assert.equal(bootstrapAfter.res.status, 200)
  assert.deepEqual(bootstrapAfter.data?.queuedPrompts, [])

  const events = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/events?mode=full&limit=100`,
    cookie
  })
  assert.equal(events.res.status, 200)
  const inputs = (Array.isArray(events.data?.events) ? events.data.events : [])
    .filter((event) => event?.type === 'session.input')
    .map((event) => String(event?.payload?.text ?? ''))
  assert.deepEqual(inputs, ['first turn', 'after completion'])
})

test('session metadata routes rename, patch options, archive, unarchive, and delete sessions', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-session-metadata-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  const runnerMessages = []
  runner.on('message', (buf) => {
    try {
      runnerMessages.push(JSON.parse(String(buf)))
    } catch {
    }
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const rename = await apiJson({
    port,
    path: `/api/sessions/${sessionId}`,
    method: 'PUT',
    cookie,
    body: {
      title: '  Renamed session  ',
      projectLabel: '  Project Atlas  '
    }
  })
  assert.equal(rename.res.status, 200)
  assert.equal(rename.data?.session?.title, 'Renamed session')
  assert.equal(rename.data?.session?.projectLabel, 'Project Atlas')

  const options = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/options`,
    method: 'PUT',
    cookie,
    body: {
      options: {
        model: 'gpt-5-codex',
        reasoningEffort: 'medium',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access'
      }
    }
  })
  assert.equal(options.res.status, 200)
  assert.equal(options.data?.runnerOk, true)
  assert.equal(options.data?.session?.model, 'gpt-5-codex')
  assert.equal(options.data?.session?.reasoningEffort, 'medium')
  assert.equal(options.data?.session?.approvalPolicy, 'never')
  assert.equal(options.data?.session?.sandbox, 'danger-full-access')

  const optionsMsg = await waitFor(() => {
    return runnerMessages.find((msg) => msg?.type === 'session.options.update' && msg?.payload?.sessionId === sessionId) ?? null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.deepEqual(optionsMsg.payload.options, {
    model: 'gpt-5-codex',
    reasoningEffort: 'medium',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access'
  })

  const archive = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/archive`,
    method: 'POST',
    cookie
  })
  assert.equal(archive.res.status, 200)
  assert.ok(Number(archive.data?.session?.archivedMs) > 0)

  const listActiveAfterArchive = await apiJson({
    port,
    path: '/api/sessions',
    cookie
  })
  assert.equal(listActiveAfterArchive.res.status, 200)
  assert.equal((listActiveAfterArchive.data?.sessions ?? []).some((row) => row?.sessionId === sessionId), false)

  const listArchived = await apiJson({
    port,
    path: '/api/sessions?archived=true',
    cookie
  })
  assert.equal(listArchived.res.status, 200)
  assert.equal((listArchived.data?.sessions ?? []).some((row) => row?.sessionId === sessionId), true)

  const unarchive = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/unarchive`,
    method: 'POST',
    cookie
  })
  assert.equal(unarchive.res.status, 200)
  assert.equal(Number(unarchive.data?.session?.archivedMs ?? 0), 0)

  const sessionGet = await apiJson({
    port,
    path: `/api/sessions/${sessionId}`,
    cookie
  })
  assert.equal(sessionGet.res.status, 200)
  assert.equal(sessionGet.data?.session?.title, 'Renamed session')
  assert.equal(sessionGet.data?.session?.projectLabel, 'Project Atlas')
  assert.equal(sessionGet.data?.session?.model, 'gpt-5-codex')

  const del = await apiJson({
    port,
    path: `/api/sessions/${sessionId}`,
    method: 'DELETE',
    cookie
  })
  assert.equal(del.res.status, 200)
  assert.equal(del.data?.ok, true)

  const cleanupMsg = await waitFor(() => {
    return runnerMessages.find((msg) => msg?.type === 'session.cleanup' && msg?.payload?.sessionId === sessionId) ?? null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.equal(cleanupMsg.payload.sessionId, sessionId)

  const afterDelete = await apiJson({
    port,
    path: `/api/sessions/${sessionId}`,
    cookie
  })
  assert.equal(afterDelete.res.status, 404)
})

test('auto-managed session titles update from runner signals until explicitly overridden', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-session-title-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  runner.send(JSON.stringify({
    v: 1,
    type: 'session.status',
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope: { machineId, sessionId },
    payload: {
      sessionId,
      status: 'running',
      codexThreadId: 'thread-title-1',
      threadName: 'Repository overview',
      threadPreview: 'Summarize the repo'
    }
  }))

  await waitFor(async () => {
    const out = await apiJson({ port, path: `/api/sessions/${sessionId}`, cookie })
    return out.data?.session?.title === 'Repository overview' ? out.data.session : null
  }, { timeoutMs: 5_000, intervalMs: 50 })

  const preserveAuto = await apiJson({
    port,
    path: `/api/sessions/${sessionId}`,
    method: 'PUT',
    cookie,
    body: {
      title: 'Repository overview',
      projectLabel: 'Project Alias'
    }
  })
  assert.equal(preserveAuto.res.status, 200)
  assert.equal(preserveAuto.data?.session?.titleSource, 'auto')
  assert.equal(preserveAuto.data?.session?.projectLabel, 'Project Alias')

  runner.send(JSON.stringify({
    v: 1,
    type: 'turn.completed',
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope: { machineId, sessionId },
    payload: {
      sessionId,
      status: 'completed',
      preview: 'Final repository summary'
    }
  }))

  const updated = await waitFor(async () => {
    const out = await apiJson({ port, path: `/api/sessions/${sessionId}`, cookie })
    return out.data?.session?.title === 'Final repository summary' ? out.data.session : null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.equal(updated?.titleSource, 'auto')

  const manual = await apiJson({
    port,
    path: `/api/sessions/${sessionId}`,
    method: 'PUT',
    cookie,
    body: {
      title: 'Pinned title'
    }
  })
  assert.equal(manual.res.status, 200)
  assert.equal(manual.data?.session?.titleSource, 'user')

  runner.send(JSON.stringify({
    v: 1,
    type: 'turn.completed',
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope: { machineId, sessionId },
    payload: {
      sessionId,
      status: 'completed',
      preview: 'Should not overwrite pinned title'
    }
  }))

  await new Promise((resolve) => setTimeout(resolve, 150))
  const final = await apiJson({ port, path: `/api/sessions/${sessionId}`, cookie })
  assert.equal(final.data?.session?.title, 'Pinned title')
  assert.equal(final.data?.session?.titleSource, 'user')
})

test('machine delete requires a disconnected runner and removes machine sessions', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-delete-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const connectedDelete = await apiJson({
    port,
    path: `/api/machines/${machineId}`,
    method: 'DELETE',
    cookie
  })
  assert.equal(connectedDelete.res.status, 409)

  runner.close()
  await waitFor(async () => {
    const out = await apiJson({ port, path: '/api/machines', cookie })
    const row = Array.isArray(out.data?.machines) ? out.data.machines.find((m) => m.machineId === machineId) : null
    return row && row.connected === false
  }, { timeoutMs: 5_000, intervalMs: 100 })

  const deleted = await apiJson({
    port,
    path: `/api/machines/${machineId}`,
    method: 'DELETE',
    cookie
  })
  assert.equal(deleted.res.status, 200)
  assert.equal(deleted.data?.machineId, machineId)
  assert.equal(deleted.data?.deletedSessions, 1)

  const machines = await apiJson({
    port,
    path: '/api/machines',
    cookie
  })
  assert.equal(machines.res.status, 200)
  assert.equal((machines.data?.machines ?? []).some((row) => row?.machineId === machineId), false)

  const sessions = await apiJson({
    port,
    path: '/api/sessions?archived=all',
    cookie
  })
  assert.equal(sessions.res.status, 200)
  assert.equal((sessions.data?.sessions ?? []).some((row) => row?.sessionId === sessionId), false)
})

test('IDE session routes start and stop a runner-backed IDE session', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-ide-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  const ideMessages = []
  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }
    ideMessages.push(msg)

    if (msg.type === 'ide.start') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'ide.started',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          ideId: msg.payload.ideId,
          cwd: msg.payload.cwd,
          port: 12345,
          basePath: '/code-server/'
        }
      }))
    }
  })

  const started = await apiJson({
    port,
    path: '/api/ide-sessions',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(started.res.status, 200)
  assert.ok(started.data?.ideId)
  assert.equal(started.data?.urlPath, `/vscode/${started.data.ideId}/`)

  const startMsg = await waitFor(() => {
    return ideMessages.find((msg) => msg?.type === 'ide.start' && msg?.payload?.ideId === started.data.ideId) ?? null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.equal(startMsg.payload.cwd, process.cwd())

  const stopped = await apiJson({
    port,
    path: `/api/ide-sessions/${started.data.ideId}/stop`,
    method: 'POST',
    cookie
  })
  assert.equal(stopped.res.status, 200)
  assert.equal(stopped.data?.ok, true)

  const stopMsg = await waitFor(() => {
    return ideMessages.find((msg) => msg?.type === 'ide.stop' && msg?.payload?.ideId === started.data.ideId) ?? null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.equal(stopMsg.payload.ideId, started.data.ideId)

  const stopAgain = await apiJson({
    port,
    path: `/api/ide-sessions/${started.data.ideId}/stop`,
    method: 'POST',
    cookie
  })
  assert.equal(stopAgain.res.status, 404)
})

test('workspace helper routes proxy fs, git, and terminal requests to the runner', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-workspace-tools-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }

    if (msg.type === 'fs.list') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'fs.list.result',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          requestId: msg.payload.requestId,
          ok: true,
          path: '/repo',
          parent: '/',
          entries: [
            { name: 'src', path: '/repo/src', kind: 'dir' },
            { name: 'README.md', path: '/repo/README.md', kind: 'file', sizeBytes: 12 }
          ]
        }
      }))
      return
    }

    if (msg.type === 'fs.read') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'fs.read.result',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          requestId: msg.payload.requestId,
          ok: true,
          path: msg.payload.path,
          sizeBytes: 12,
          truncated: false,
          binary: false,
          text: 'hello world\n'
        }
      }))
      return
    }

    if (msg.type === 'git.status') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'git.status.result',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          requestId: msg.payload.requestId,
          ok: true,
          cwd: '/repo',
          rootPath: '/repo',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          notRepo: false,
          entries: [
            { path: 'src/app.js', x: 'M', y: ' ', label: 'M' }
          ]
        }
      }))
      return
    }

    if (msg.type === 'terminal.exec') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'terminal.exec.result',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          requestId: msg.payload.requestId,
          ok: true,
          cwd: '/repo',
          command: msg.payload.command,
          exitCode: 0,
          signal: null,
          stdout: 'terminal output\n',
          stderr: '',
          timedOut: false,
          durationMs: 9
        }
      }))
    }
  })

  const listRes = await fetch(`http://127.0.0.1:${port}/api/fs/list?machineId=${encodeURIComponent(machineId)}&path=${encodeURIComponent('/repo')}&includeFiles=1`, {
    headers: { cookie }
  })
  assert.equal(listRes.status, 200)
  const listData = await listRes.json()
  assert.deepEqual(listData.entries.map((entry) => entry.kind), ['dir', 'file'])

  const readRes = await fetch(`http://127.0.0.1:${port}/api/fs/read?machineId=${encodeURIComponent(machineId)}&path=${encodeURIComponent('/repo/README.md')}`, {
    headers: { cookie }
  })
  assert.equal(readRes.status, 200)
  const readData = await readRes.json()
  assert.equal(readData.text, 'hello world\n')

  const gitRes = await fetch(`http://127.0.0.1:${port}/api/git/status?machineId=${encodeURIComponent(machineId)}&cwd=${encodeURIComponent('/repo')}`, {
    headers: { cookie }
  })
  assert.equal(gitRes.status, 200)
  const gitData = await gitRes.json()
  assert.equal(gitData.branch, 'main')
  assert.equal(gitData.entries[0]?.path, 'src/app.js')

  const term = await apiJson({
    port,
    path: '/api/terminal/exec',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: '/repo',
      command: 'pwd'
    }
  })
  assert.equal(term.res.status, 200)
  assert.equal(term.data?.stdout, 'terminal output\n')
})

test('machine upgrade route waits for runner acceptance', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-upgrade-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId,
    capabilities: {
      rootgridVersion: '0.0.0-old',
      upgrade: { enabled: true }
    }
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  runner.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }
    if (msg.type === 'machine.upgrade.start') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'machine.upgrade.accepted',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          requestId: msg.payload.requestId,
          machineId
        }
      }))
      return
    }

    if (msg.type === 'machine.upgrade.end') {
      runner.send(JSON.stringify({
        v: 1,
        type: 'machine.upgrade.bundle.received',
        ts: Date.now(),
        id: crypto.randomUUID(),
        scope: { machineId },
        payload: {
          requestId: msg.payload.requestId,
          machineId,
          releaseId: 'release-test-1',
          version: '0.0.0'
        }
      }))
    }
  })

  const out = await apiJson({
    port,
    path: `/api/machines/${machineId}/upgrade`,
    method: 'POST',
    cookie,
    body: { hostVersion: '0.0.0-new' }
  })

  assert.equal(out.res.status, 200)
  assert.equal(out.data?.ok, true)
  assert.equal(out.data?.machineId, machineId)
  assert.equal(out.data?.accepted, true)
})

test('system settings and push subscription routes persist config + subscriptions', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const configPath = join(svc.home, '.rootgrid', 'config.json')
  const dbPath = join(svc.home, '.rootgrid', 'rootgrid.db')

  const settingsBefore = await apiJson({
    port,
    path: '/api/settings',
    cookie
  })
  assert.equal(settingsBefore.res.status, 200)
  assert.ok(typeof settingsBefore.data?.appVersion === 'string')
  assert.equal(settingsBefore.data?.retentionDays, svc.config.retentionDays)

  const update = await apiJson({
    port,
    path: '/api/settings',
    method: 'PUT',
    cookie,
    body: {
      retentionDays: 90,
      notifications: {
        sseToasts: 'always',
        webPush: 'never'
      }
    }
  })
  assert.equal(update.res.status, 200)
  assert.equal(update.data?.retentionDays, 90)
  assert.equal(update.data?.notifications?.sseToasts, 'always')
  assert.equal(update.data?.notifications?.webPush, 'never')

  const savedConfig = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(savedConfig.retentionDays, 90)
  assert.equal(savedConfig.notifications?.sseToasts, 'always')
  assert.equal(savedConfig.notifications?.webPush, 'never')

  const vapid = await apiJson({
    port,
    path: '/api/push/vapid-public-key',
    cookie
  })
  assert.equal(vapid.res.status, 200)
  assert.ok(typeof vapid.data?.publicKey === 'string')
  assert.ok(vapid.data.publicKey.length > 20)

  const endpoint = 'https://push.example.test/sub-1'
  const subscribe = await apiJson({
    port,
    path: '/api/push/subscribe',
    method: 'POST',
    cookie,
    body: {
      endpoint,
      keys: {
        p256dh: 'p256dh-token',
        auth: 'auth-token'
      }
    }
  })
  assert.equal(subscribe.res.status, 200)
  assert.equal(subscribe.data?.ok, true)

  const store = new Store({ dbPath })
  const subs = store.listPushSubscriptions()
  assert.equal(subs.length, 1)
  assert.equal(subs[0]?.endpoint, endpoint)
  assert.equal(subs[0]?.p256dh, 'p256dh-token')
  assert.equal(subs[0]?.auth, 'auth-token')
  assert.ok(Number(subs[0]?.createdMs) > 0)
  assert.ok(Number(subs[0]?.updatedMs) > 0)

  const unsubscribe = await apiJson({
    port,
    path: '/api/push/subscribe',
    method: 'DELETE',
    cookie,
    body: { endpoint }
  })
  assert.equal(unsubscribe.res.status, 200)
  assert.equal(unsubscribe.data?.ok, true)
  assert.deepEqual(store.listPushSubscriptions(), [])
})

test('approval response route forwards userInput answers and persists approval resolution', async (t) => {
  const svc = await startHostProcess({ cwd: process.cwd() })
  t.after(async () => {
    await svc.stop()
  })

  const port = svc.config.host.listen.port
  const cookie = await login({ port, token: svc.config.host.auth.clientToken })
  const machineId = 'machine-approval-1'
  const runner = await connectRunner({
    port,
    token: svc.config.host.auth.runnerToken,
    machineId
  })
  t.after(() => {
    try { runner.close() } catch {}
  })

  const runnerMessages = []
  runner.on('message', (buf) => {
    try {
      runnerMessages.push(JSON.parse(String(buf)))
    } catch {
    }
  })

  const draft = await apiJson({
    port,
    path: '/api/sessions/draft',
    method: 'POST',
    cookie,
    body: {
      machineId,
      cwd: process.cwd()
    }
  })
  assert.equal(draft.res.status, 200)
  const sessionId = draft.data?.sessionId
  assert.ok(sessionId)

  const approvalId = crypto.randomUUID()
  runner.send(JSON.stringify({
    v: 1,
    type: 'approval.request',
    ts: Date.now(),
    id: crypto.randomUUID(),
    scope: { machineId, sessionId },
    payload: {
      approvalId,
      sessionId,
      kind: 'userInput',
      title: 'Need deploy target',
      questions: [
        {
          id: 'env',
          prompt: 'Environment',
          options: [
            { label: 'Prod', value: 'prod' },
            { label: 'Stage', value: 'stage' }
          ]
        }
      ]
    }
  }))

  await waitFor(async () => {
    const out = await apiJson({
      port,
      path: `/api/sessions/${sessionId}/events?mode=full&limit=100`,
      cookie
    })
    return (out.data?.events ?? []).find((event) => event?.type === 'approval.request' && event?.payload?.approvalId === approvalId) ?? null
  }, { timeoutMs: 5_000, intervalMs: 50 })

  const respond = await apiJson({
    port,
    path: `/api/approvals/${approvalId}`,
    method: 'POST',
    cookie,
    body: {
      decision: 'accept',
      answers: {
        env: 'prod'
      }
    }
  })
  assert.equal(respond.res.status, 200)
  assert.equal(respond.data?.ok, true)

  const approvalRespond = await waitFor(() => {
    return runnerMessages.find((msg) => msg?.type === 'approval.respond' && msg?.payload?.approvalId === approvalId) ?? null
  }, { timeoutMs: 5_000, intervalMs: 50 })
  assert.equal(approvalRespond.payload?.decision, 'accept')
  assert.deepEqual(approvalRespond.payload?.answers, { env: 'prod' })

  const events = await apiJson({
    port,
    path: `/api/sessions/${sessionId}/events?mode=full&limit=100`,
    cookie
  })
  assert.equal(events.res.status, 200)
  const resolved = (events.data?.events ?? []).find((event) => event?.type === 'approval.resolved' && event?.payload?.approvalId === approvalId)
  assert.ok(resolved)
  assert.equal(resolved.payload?.decision, 'accept')

  const respondAgain = await apiJson({
    port,
    path: `/api/approvals/${approvalId}`,
    method: 'POST',
    cookie,
    body: {
      decision: 'accept',
      answers: {
        env: 'prod'
      }
    }
  })
  assert.equal(respondAgain.res.status, 404)
})
