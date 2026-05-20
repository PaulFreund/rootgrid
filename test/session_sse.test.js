import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEventsStreamPath,
  createSessionSseActions,
  currentVisibilityState,
  inferSseDisconnectReason,
  readStoredSseEventId,
  writeStoredSseEventId
} from '../web/src/lib/sessionSse.js'

test('currentVisibilityState defaults to visible and respects document visibilityState', () => {
  assert.equal(currentVisibilityState({ visibilityState: 'visible' }), 'visible')
  assert.equal(currentVisibilityState({ visibilityState: 'hidden' }), 'hidden')
  assert.equal(currentVisibilityState(null), 'visible')
})

test('buildEventsStreamPath includes visibility and optional session filter', () => {
  assert.equal(buildEventsStreamPath({ visibility: 'hidden' }), '/api/events?visibility=hidden')
  assert.equal(
    buildEventsStreamPath({ visibility: 'visible', sessionId: 'session-1' }),
    '/api/events?visibility=visible&sessionId=session-1'
  )
  assert.equal(
    buildEventsStreamPath({ visibility: 'visible', machineId: 'machine-1' }),
    '/api/events?visibility=visible&machineId=machine-1'
  )
  assert.equal(
    buildEventsStreamPath({ visibility: 'visible', sessionId: 'session-1', machineId: 'machine-1', lastEventId: 42 }),
    '/api/events?visibility=visible&sessionId=session-1&machineId=machine-1&lastEventId=42'
  )
  assert.equal(
    buildEventsStreamPath({ visibility: 'visible', lastEventId: 42, resume: true }),
    '/api/events?visibility=visible&lastEventId=42&resume=1'
  )
})

test('inferSseDisconnectReason returns closed only for CLOSED readyState', () => {
  const fakeCtor = { CLOSED: 2 }
  assert.equal(inferSseDisconnectReason({ readyState: 2 }, { eventSourceCtor: fakeCtor, fallback: 'error' }), 'closed')
  assert.equal(inferSseDisconnectReason({ readyState: 1 }, { eventSourceCtor: fakeCtor, fallback: 'error' }), 'error')
})

test('stored SSE cursor helpers persist positive ids and clear invalid ones', () => {
  const storage = new Map()
  const fakeStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    }
  }

  assert.equal(readStoredSseEventId({ storage: fakeStorage }), 0)
  assert.equal(writeStoredSseEventId(15, { storage: fakeStorage }), 15)
  assert.equal(readStoredSseEventId({ storage: fakeStorage }), 15)
  assert.equal(writeStoredSseEventId(0, { storage: fakeStorage }), 0)
  assert.equal(readStoredSseEventId({ storage: fakeStorage }), 0)
})

test('createSessionSseActions carries forward the last SSE event id across reconnects', () => {
  class FakeEventSource {
    static instances = []

    constructor(url) {
      this.url = url
      this.readyState = 0
      FakeEventSource.instances.push(this)
    }

    close() {
      this.closed = true
      this.readyState = FakeEventSource.CLOSED
    }
  }
  FakeEventSource.CLOSED = 2

  const sseConnectionId = { value: null }
  const lastSseEventId = { value: 9 }
  const selectedSessionId = { value: 'session-1' }
  const selectedMachineId = { value: 'machine-1' }
  const stickToBottom = { value: true }
  const sseStatus = { value: 'disconnected' }
  const sseDisconnectReason = { value: null }
  const lastSseMessageAt = { value: 0 }
  const everConnected = { value: false }
  const hasSnapshot = { value: true }
  const persisted = []
  let handled = null

  const originalEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const actions = createSessionSseActions({
      apiFetch: async () => ({ ok: true }),
      sseConnectionId,
      lastSseEventId,
      persistLastEventId: (value) => persisted.push(value),
      flushDelayMs: 0,
      hasSnapshot,
      selectedSessionId,
      selectedMachineId,
      stickToBottom,
      scheduleMarkRead: () => {},
      clearScheduledMarkRead: () => {},
      onVisible: () => {},
      sseStatus,
      sseDisconnectReason,
      lastSseMessageAt,
      everConnected,
      handleEnvelope: (env) => { handled = env },
      currentVisibility: () => 'visible'
    })

    actions.connectSse()
    assert.match(FakeEventSource.instances[0].url, /lastEventId=9/)
    assert.match(FakeEventSource.instances[0].url, /resume=1/)
    assert.match(FakeEventSource.instances[0].url, /machineId=machine-1/)

    FakeEventSource.instances[0].onmessage({
      lastEventId: '11',
      data: JSON.stringify({ type: 'registry.machine.upsert', payload: { machineId: 'm1' } })
    })
    assert.equal(lastSseEventId.value, 11)
    assert.deepEqual(persisted, [11])
    assert.deepEqual(handled, { type: 'registry.machine.upsert', payload: { machineId: 'm1' } })

    actions.connectSse()
    assert.match(FakeEventSource.instances[1].url, /lastEventId=11/)
  } finally {
    globalThis.EventSource = originalEventSource
  }
})

test('createSessionSseActions batches non-snapshot envelopes briefly before handling', async () => {
  class FakeEventSource {
    static instances = []

    constructor(url) {
      this.url = url
      this.readyState = 0
      FakeEventSource.instances.push(this)
    }

    close() {}
  }

  const handled = []
  const originalEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const actions = createSessionSseActions({
      apiFetch: async () => ({ ok: true }),
      sseConnectionId: { value: null },
      lastSseEventId: { value: 0 },
      hasSnapshot: { value: false },
      selectedSessionId: { value: null },
      selectedMachineId: { value: null },
      stickToBottom: { value: true },
      scheduleMarkRead: () => {},
      clearScheduledMarkRead: () => {},
      onVisible: () => {},
      sseStatus: { value: 'disconnected' },
      sseDisconnectReason: { value: null },
      lastSseMessageAt: { value: 0 },
      everConnected: { value: false },
      flushDelayMs: 5,
      handleEnvelope: (env) => handled.push(env.type),
      currentVisibility: () => 'visible'
    })

    actions.connectSse()
    const source = FakeEventSource.instances[0]
    source.onmessage({ lastEventId: '1', data: JSON.stringify({ type: 'session.output', sseId: 1 }) })
    source.onmessage({ lastEventId: '2', data: JSON.stringify({ type: 'session.output', sseId: 2 }) })
    assert.deepEqual(handled, [])

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(handled, ['session.output', 'session.output'])
  } finally {
    globalThis.EventSource = originalEventSource
  }
})

test('createSessionSseActions retries a closed SSE stream on the configured cadence', async () => {
  class FakeEventSource {
    static CLOSED = 2
    static instances = []

    constructor(url) {
      this.url = url
      this.readyState = 0
      this.closeCalls = 0
      FakeEventSource.instances.push(this)
    }

    close() {
      this.closeCalls += 1
      this.readyState = FakeEventSource.CLOSED
    }
  }

  const sseStatus = { value: 'disconnected' }
  const sseDisconnectReason = { value: null }
  const originalEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const actions = createSessionSseActions({
      apiFetch: async () => ({ ok: true }),
      sseConnectionId: { value: null },
      lastSseEventId: { value: 0 },
      hasSnapshot: { value: false },
      selectedSessionId: { value: null },
      selectedMachineId: { value: null },
      stickToBottom: { value: true },
      scheduleMarkRead: () => {},
      clearScheduledMarkRead: () => {},
      onVisible: () => {},
      sseStatus,
      sseDisconnectReason,
      lastSseMessageAt: { value: 0 },
      everConnected: { value: false },
      reconnectDelayMs: 5,
      shouldReconnect: () => true,
      handleEnvelope: () => {},
      currentVisibility: () => 'visible'
    })

    actions.connectSse()
    const first = FakeEventSource.instances[0]
    first.readyState = FakeEventSource.CLOSED
    first.onerror()
    assert.equal(sseStatus.value, 'error')
    assert.equal(sseDisconnectReason.value, 'closed')

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(FakeEventSource.instances.length, 2)
    assert.equal(first.closeCalls, 1)
  } finally {
    globalThis.EventSource = originalEventSource
  }
})

test('createSessionSseActions does not schedule retries when reconnect is disabled', async () => {
  class FakeEventSource {
    static CLOSED = 2
    static instances = []

    constructor(url) {
      this.url = url
      this.readyState = 0
      FakeEventSource.instances.push(this)
    }

    close() {
      this.readyState = FakeEventSource.CLOSED
    }
  }

  const originalEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const actions = createSessionSseActions({
      apiFetch: async () => ({ ok: true }),
      sseConnectionId: { value: null },
      lastSseEventId: { value: 0 },
      hasSnapshot: { value: false },
      selectedSessionId: { value: null },
      selectedMachineId: { value: null },
      stickToBottom: { value: true },
      scheduleMarkRead: () => {},
      clearScheduledMarkRead: () => {},
      onVisible: () => {},
      sseStatus: { value: 'disconnected' },
      sseDisconnectReason: { value: null },
      lastSseMessageAt: { value: 0 },
      everConnected: { value: false },
      reconnectDelayMs: 5,
      shouldReconnect: () => false,
      handleEnvelope: () => {},
      currentVisibility: () => 'visible'
    })

    actions.connectSse()
    const first = FakeEventSource.instances[0]
    first.readyState = FakeEventSource.CLOSED
    first.onerror()

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(FakeEventSource.instances.length, 1)
  } finally {
    globalThis.EventSource = originalEventSource
  }
})

test('createSessionSseActions stops reposting visibility for the same connection after a 404', async () => {
  const calls = []
  const actions = createSessionSseActions({
    apiFetch: async (path, options) => {
      calls.push({ path, options })
      return { ok: false, status: 404 }
    },
    sseConnectionId: { value: 'conn-1' },
    lastSseEventId: { value: 0 },
    hasSnapshot: { value: false },
    selectedSessionId: { value: 'session-1' },
    selectedMachineId: { value: 'machine-1' },
    stickToBottom: { value: true },
    scheduleMarkRead: () => {},
    clearScheduledMarkRead: () => {},
    onVisible: () => {},
    sseStatus: { value: 'connected' },
    sseDisconnectReason: { value: null },
    lastSseMessageAt: { value: 0 },
    everConnected: { value: true },
    handleEnvelope: () => {},
    currentVisibility: () => 'visible'
  })

  await actions.postVisibilityNow()
  await actions.postVisibilityNow()

  assert.equal(calls.length, 1)

  actions.disposeSse()
})

test('createSessionSseActions retries visibility posts after the SSE connection id changes', async () => {
  const calls = []
  const sseConnectionId = { value: 'conn-1' }
  const actions = createSessionSseActions({
    apiFetch: async (path, options) => {
      calls.push({ path, options })
      return { ok: false, status: 404 }
    },
    sseConnectionId,
    lastSseEventId: { value: 0 },
    hasSnapshot: { value: false },
    selectedSessionId: { value: 'session-1' },
    selectedMachineId: { value: 'machine-1' },
    stickToBottom: { value: true },
    scheduleMarkRead: () => {},
    clearScheduledMarkRead: () => {},
    onVisible: () => {},
    sseStatus: { value: 'connected' },
    sseDisconnectReason: { value: null },
    lastSseMessageAt: { value: 0 },
    everConnected: { value: true },
    handleEnvelope: () => {},
    currentVisibility: () => 'visible'
  })

  await actions.postVisibilityNow()
  sseConnectionId.value = 'conn-2'
  await actions.postVisibilityNow()

  assert.equal(calls.length, 2)

  actions.disposeSse()
})

test('createSessionSseActions reconnects immediately when visibility returns while SSE is in error', async () => {
  class FakeEventSource {
    static instances = []

    constructor(url) {
      this.url = url
      this.readyState = 0
      FakeEventSource.instances.push(this)
    }

    close() {}
  }

  const originalEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const actions = createSessionSseActions({
      apiFetch: async () => ({ ok: true }),
      sseConnectionId: { value: null },
      lastSseEventId: { value: 0 },
      hasSnapshot: { value: false },
      selectedSessionId: { value: 'session-1' },
      selectedMachineId: { value: 'machine-1' },
      stickToBottom: { value: true },
      scheduleMarkRead: () => {},
      clearScheduledMarkRead: () => {},
      onVisible: () => {},
      sseStatus: { value: 'error' },
      sseDisconnectReason: { value: 'closed' },
      lastSseMessageAt: { value: 0 },
      everConnected: { value: true },
      handleEnvelope: () => {},
      currentVisibility: () => 'visible',
      shouldReconnect: () => true
    })

    actions.schedulePostVisibility()
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(FakeEventSource.instances.length, 1)

    actions.disposeSse()
  } finally {
    globalThis.EventSource = originalEventSource
  }
})

test('createSessionSseActions does not reconnect on hidden visibility changes without a connection id', async () => {
  class FakeEventSource {
    static instances = []

    constructor(url) {
      this.url = url
      this.readyState = 0
      FakeEventSource.instances.push(this)
    }

    close() {}
  }

  const originalEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    const cleared = []
    const actions = createSessionSseActions({
      apiFetch: async () => ({ ok: true }),
      sseConnectionId: { value: null },
      lastSseEventId: { value: 0 },
      hasSnapshot: { value: false },
      selectedSessionId: { value: 'session-1' },
      selectedMachineId: { value: 'machine-1' },
      stickToBottom: { value: true },
      scheduleMarkRead: () => {},
      clearScheduledMarkRead: () => { cleared.push(true) },
      onVisible: () => {},
      sseStatus: { value: 'error' },
      sseDisconnectReason: { value: 'closed' },
      lastSseMessageAt: { value: 0 },
      everConnected: { value: true },
      handleEnvelope: () => {},
      currentVisibility: () => 'hidden',
      shouldReconnect: () => true
    })

    actions.schedulePostVisibility()
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(FakeEventSource.instances.length, 0)
    assert.equal(cleared.length, 1)

    actions.disposeSse()
  } finally {
    globalThis.EventSource = originalEventSource
  }
})
