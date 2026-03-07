import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { SSEManager } from '../src/server/sseManager.js'

class FakeResponse extends EventEmitter {
  constructor({ writeReturn = true } = {}) {
    super()
    this.writeReturn = writeReturn
    this.writes = []
    this.ended = false
  }

  write(chunk) {
    this.writes.push(String(chunk))
    return this.writeReturn
  }

  end() {
    this.ended = true
    this.emit('close')
  }
}

test('SSEManager drops slow clients when write backpressure occurs', (t) => {
  const sse = new SSEManager({ heartbeatMs: 60_000 })
  t.after(() => sse.close())

  const res = new FakeResponse({ writeReturn: false })
  sse.addClient({ id: 'client-1', res })
  sse.send({ type: 'registry.machine.upsert', payload: { machineId: 'machine-1' } })

  assert.equal(res.ended, true)
  assert.equal(sse.clients.size, 0)
})

test('SSEManager sendToast respects visibility policy', (t) => {
  const sse = new SSEManager({ heartbeatMs: 60_000 })
  t.after(() => sse.close())

  const visible = new FakeResponse()
  const hidden = new FakeResponse()
  sse.addClient({ id: 'visible', res: visible, visibility: 'visible' })
  sse.addClient({ id: 'hidden', res: hidden, visibility: 'hidden' })

  const delivered = sse.sendToast({ type: 'toast', payload: { title: 'hello' } }, { policy: 'if-not-visible' })
  assert.equal(delivered, 1)
  assert.equal(visible.writes.length, 0)
  assert.equal(hidden.writes.length, 1)
})

test('SSEManager replays buffered events after the provided SSE id before activating the client', (t) => {
  const sse = new SSEManager({ heartbeatMs: 60_000, historySize: 10 })
  t.after(() => sse.close())

  sse.send({ type: 'registry.machine.upsert', payload: { machineId: 'm1' } })
  sse.send({ type: 'toast', payload: { title: 'hello' } })

  const res = new FakeResponse()
  sse.addClient({ id: 'replay', res, active: false, sessionId: 'session-1' })

  assert.equal(res.writes.length, 0)
  sse.activateClient('replay', { replayAfter: 1 })

  assert.equal(res.writes.length, 1)
  assert.match(res.writes[0], /^id: 2\n/)
  assert.match(res.writes[0], /"type":"toast"/)
})

test('SSEManager canReplayFrom only when the requested cursor is covered by history', (t) => {
  const sse = new SSEManager({ heartbeatMs: 60_000, historySize: 3 })
  t.after(() => sse.close())

  sse.send({ type: 'registry.machine.upsert', payload: { machineId: 'm1' } }) // 1
  sse.send({ type: 'registry.machine.upsert', payload: { machineId: 'm2' } }) // 2
  sse.send({ type: 'registry.machine.upsert', payload: { machineId: 'm3' } }) // 3

  assert.equal(sse.canReplayFrom(0), false)
  assert.equal(sse.canReplayFrom(1), true)
  assert.equal(sse.canReplayFrom(2), true)

  sse.send({ type: 'registry.machine.upsert', payload: { machineId: 'm4' } }) // history now 2..4
  assert.equal(sse.canReplayFrom(0), false)
  assert.equal(sse.canReplayFrom(1), true)
  assert.equal(sse.canReplayFrom(2), true)
  assert.equal(sse.canReplayFrom(4), true)
})
