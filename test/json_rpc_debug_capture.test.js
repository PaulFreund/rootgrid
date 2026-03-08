import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonRpcDebugCapture } from '../src/runner/sessions/JsonRpcDebugCapture.js'

test('JsonRpcDebugCapture writes raw rpc, stderr, and process records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-codex-debug-'))

  try {
    const capture = new JsonRpcDebugCapture({
      sessionId: 'session-123',
      cwd: '/tmp/work',
      command: 'codex',
      args: ['app-server'],
      dir
    })

    await capture.start()
    capture.recordProcess('spawn', { pid: 4242 })
    capture.recordOutbound({ id: 1, method: 'thread/start', params: { prompt: 'hello' } }, '{"id":1,"method":"thread/start","params":{"prompt":"hello"}}')
    capture.recordIncoming('{"method":"item/reasoning/textDelta","params":{"delta":"hi"}}', { method: 'item/reasoning/textDelta', params: { delta: 'hi' } })
    capture.recordIncoming('not-json', null)
    capture.recordStderr('warning on stderr\n')
    capture.recordProcess('exit', { code: 0, signal: null })
    await capture.close()

    const raw = await readFile(capture.filePath, 'utf8')
    const rows = raw.trim().split('\n').map((line) => JSON.parse(line))

    assert.equal(rows[0].channel, 'capture')
    assert.equal(rows[0].event, 'start')
    assert.equal(rows[1].channel, 'process')
    assert.equal(rows[1].event, 'spawn')

    const outbound = rows.find((row) => row.channel === 'rpc' && row.direction === 'out')
    assert.equal(outbound.kind, 'request')
    assert.equal(outbound.message.method, 'thread/start')

    const inbound = rows.find((row) => row.channel === 'rpc' && row.direction === 'in' && row.kind === 'notification')
    assert.equal(inbound.message.method, 'item/reasoning/textDelta')

    const invalid = rows.find((row) => row.channel === 'rpc' && row.kind === 'invalid-json')
    assert.equal(invalid.raw, 'not-json')

    const stderr = rows.find((row) => row.channel === 'stderr')
    assert.match(stderr.text, /warning on stderr/)

    const exit = rows.find((row) => row.channel === 'process' && row.event === 'exit')
    assert.equal(exit.code, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
