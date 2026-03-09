import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendCapped,
  addSessionEvent,
  canCoalesceSessionEvent,
  coalesceSessionEvent,
  ensureTurnReasoningBodyLoaded,
  ensureTurnReasoningLoaded,
  loadSessionHistory,
  resetSessionStoreState,
  toolOutputHasMeaningfulText
} from '../web/src/lib/sessionHistory.js'
import { createSessionStoreState } from '../web/src/lib/sessionUi.js'

test('appendCapped keeps the newest tail within the cap', () => {
  assert.equal(appendCapped('abc', 'def', 10), 'abcdef')
  assert.equal(appendCapped('abc', 'defgh', 5), 'defgh')
})

test('toolOutputHasMeaningfulText ignores codex internal terminal markers', () => {
  assert.equal(toolOutputHasMeaningfulText({ stdout: '', stderr: '' }), false)
  assert.equal(toolOutputHasMeaningfulText({ stdout: '[codex] terminal interaction start\n[codex] terminal interaction end' }), false)
  assert.equal(toolOutputHasMeaningfulText({ stdout: 'real output' }), true)
})

test('session output events coalesce safely for consecutive append-only text deltas', () => {
  const first = {
    eventId: 'e-1',
    seq: 1,
    tsMs: 1,
    type: 'session.output',
    payload: { stream: 'normalized', text: 'hel' }
  }
  const second = {
    eventId: 'e-2',
    seq: 2,
    tsMs: 2,
    type: 'session.output',
    payload: { stream: 'normalized', text: 'lo' }
  }

  assert.equal(canCoalesceSessionEvent(first, second), true)
  coalesceSessionEvent(first, second)
  assert.equal(first.payload.text, 'hello')
  assert.equal(first.seq, 2)
  assert.equal(first.tsMs, 2)
  assert.equal(canCoalesceSessionEvent({
    eventId: 'e-3',
    type: 'session.output',
    payload: { stream: 'commentary', text: 'thin' }
  }, {
    eventId: 'e-4',
    type: 'session.output',
    payload: { stream: 'commentary', text: 'king' }
  }), true)
  assert.equal(canCoalesceSessionEvent(first, {
    eventId: 'e-3',
    type: 'session.output',
    payload: { stream: 'stdout', text: 'x' }
  }), false)
})

test('resetSessionStoreState clears derived session store state', () => {
  const store = {
    events: [{ eventId: 'e-1' }],
    seen: new Set(['e-1']),
    queuedPrompts: [{ id: 'qp-1' }],
    queueSending: true,
    diff: 'changed',
    plan: [{ step: 'x' }],
    planExplanation: 'because',
    currentTurnId: 'turn-1',
    turnHasReasoningLive: new Set(['turn-1']),
    turnHasReasoningHistory: new Set(['turn-1']),
    turnHasReasoningTokens: new Set(['turn-1']),
    backgroundExpandedByTurnId: new Map([['turn-1', true]]),
    reasoningByTurnId: new Map([['turn-1', { loaded: true }]]),
    hasMoreBefore: false,
    nextBeforeSeq: 10,
    loadingBefore: true,
    loadingAfter: true,
    lastRealtimeSeqSeen: 99,
    pendingAfter: [{ eventId: 'e-2' }],
    toolOutputByItemId: new Map([['item-1', { stdout: 'x' }]]),
    toolExpanded: new Map([['item-1', true]]),
    diffSelectedFileByEventId: new Map([['e-1', 'file.txt']])
  }

  resetSessionStoreState(store)

  assert.deepEqual(store.events, [])
  assert.equal(store.seen.size, 0)
  assert.deepEqual(store.queuedPrompts, [])
  assert.equal(store.queueSending, false)
  assert.equal(store.diff, '')
  assert.equal(store.plan, null)
  assert.equal(store.planExplanation, null)
  assert.equal(store.currentTurnId, null)
  assert.equal(store.turnHasReasoningLive.size, 0)
  assert.equal(store.turnHasReasoningHistory.size, 0)
  assert.equal(store.turnHasReasoningTokens.size, 0)
  assert.equal(store.backgroundExpandedByTurnId.size, 0)
  assert.equal(store.reasoningByTurnId.size, 0)
  assert.equal(store.hasMoreBefore, true)
  assert.equal(store.nextBeforeSeq, null)
  assert.equal(store.loadingBefore, false)
  assert.equal(store.loadingAfter, false)
  assert.equal(store.lastRealtimeSeqSeen, 0)
  assert.deepEqual(store.pendingAfter, [])
  assert.equal(store.toolOutputByItemId.size, 0)
  assert.equal(store.toolExpanded.size, 0)
  assert.equal(store.diffSelectedFileByEventId.size, 0)
})

test('loadSessionHistory uses bootstrap payload for the initial render in one request', async () => {
  const sessionStores = new Map()
  const getSessionStore = (sessionId) => {
    let store = sessionStores.get(sessionId)
    if (!store) {
      store = createSessionStoreState()
      sessionStores.set(sessionId, store)
    }
    return store
  }

  const requested = []
  const upserts = []
  const scheduled = []
  const addSessionEvent = ({ sessionId, event, atStart = false }) => {
    const store = getSessionStore(sessionId)
    if (store.seen.has(event.eventId)) return
    store.seen.add(event.eventId)
    if (atStart) store.events.unshift(event)
    else store.events.push(event)
  }

  await loadSessionHistory({
    apiFetch: async (path) => {
      requested.push(path)
      return {
        ok: true,
        async json() {
          return {
            session: { sessionId: 's-1', title: 'Bootstrap', lastSeq: 3 },
            queuedPrompts: [{ id: 'qp-1', promptId: 'qp-1', text: 'later', attachments: [] }],
            events: [
              { eventId: 'e-1', seq: 1, type: 'session.input', payload: { text: 'hello' } },
              { eventId: 'e-2', seq: 2, type: 'turn.started', payload: { turnId: 'turn-1' } },
              { eventId: 'e-3', seq: 3, type: 'session.output', payload: { stream: 'normalized', text: 'world' } }
            ],
            reasoningTurnIds: ['turn-1'],
            hasMoreBefore: false,
            nextBeforeSeq: 1,
            containsInput: true
          }
        }
      }
    },
    upsertSessionRow: (row) => upserts.push(row),
    getSessionStore,
    addSessionEvent,
    chatScrollEl: { value: null },
    loadSessionNonce: { value: 0 },
    sessionLoading: { value: false },
    sessionId: 's-1',
    schedule: (fn) => {
      scheduled.push(fn)
      return 1
    }
  })

  assert.deepEqual(requested, ['/api/sessions/s-1?bootstrap=1&limit=800&prefetchPages=2&prefetchLimit=800'])
  assert.deepEqual(upserts, [{ sessionId: 's-1', title: 'Bootstrap', lastSeq: 3 }])
  const store = getSessionStore('s-1')
  assert.deepEqual(store.events.map((event) => event.eventId), ['e-1', 'e-2', 'e-3'])
  assert.equal(store.queuedPrompts.length, 1)
  assert.equal(store.currentTurnId, 'turn-1')
  assert.equal(store.turnHasReasoningHistory.has('turn-1'), true)
  assert.equal(store.hasMoreBefore, false)
  assert.equal(store.nextBeforeSeq, 1)
  assert.equal(scheduled.length, 1)
})

test('reasoning history loads metadata first and full body only on demand', async () => {
  const stores = new Map()
  const getSessionStore = (sessionId) => {
    let store = stores.get(sessionId)
    if (!store) {
      store = createSessionStoreState()
      stores.set(sessionId, store)
    }
    return store
  }

  const requested = []
  const apiFetch = async (path) => {
    requested.push(path)
    if (String(path).includes('&meta=1')) {
      return {
        ok: true,
        async json() {
          return {
            sections: [
              { id: 'r-1', title: 'Reasoning', startSeq: 2, tsMs: 2 }
            ],
            truncated: false
          }
        }
      }
    }
    return {
      ok: true,
      async json() {
        return {
          sections: [
            { id: 'r-1', title: 'Reasoning', body: 'Detailed reasoning', startSeq: 2, tsMs: 2 }
          ],
          truncated: false
        }
      }
    }
  }

  await ensureTurnReasoningLoaded({
    apiFetch,
    getSessionStore,
    parseReasoningSections: () => [],
    sessionId: 's-1',
    turnId: 'turn-1'
  })

  const store = getSessionStore('s-1')
  const state = store.reasoningByTurnId.get('turn-1')
  assert.equal(state.loaded, true)
  assert.equal(state.bodyLoaded, false)
  assert.equal(state.sections[0].body, undefined)

  await ensureTurnReasoningBodyLoaded({
    apiFetch,
    getSessionStore,
    parseReasoningSections: () => [],
    sessionId: 's-1',
    turnId: 'turn-1'
  })

  assert.equal(state.bodyLoaded, true)
  assert.equal(state.sections[0].body, 'Detailed reasoning')
  assert.deepEqual(requested, [
    '/api/sessions/s-1/turns/turn-1/reasoning?maxChars=400000&meta=1',
    '/api/sessions/s-1/turns/turn-1/reasoning?maxChars=400000'
  ])
})

test('addSessionEvent merges consecutive session output text into the previous stored event', () => {
  const stores = new Map()
  const getSessionStore = (sessionId) => {
    let store = stores.get(sessionId)
    if (!store) {
      store = createSessionStoreState()
      stores.set(sessionId, store)
    }
    return store
  }

  addSessionEvent({
    getSessionStore,
    sessionId: 's-1',
    event: {
      eventId: 'e-1',
      seq: 1,
      tsMs: 1,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'hel' }
    }
  })
  addSessionEvent({
    getSessionStore,
    sessionId: 's-1',
    event: {
      eventId: 'e-2',
      seq: 2,
      tsMs: 2,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'lo' }
    }
  })

  const store = getSessionStore('s-1')
  assert.equal(store.events.length, 1)
  assert.equal(store.events[0].payload.text, 'hello')
  assert.equal(store.events[0].seq, 2)
  assert.equal(store.seen.size, 2)
})
