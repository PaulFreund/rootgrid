import test from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/db/store.js'
import {
  getTurnReasoningSections,
  getTurnReasoningText,
  getTurnSeqRange,
  listItemOutputEvents,
  listSessionEventsPage,
  listTurnsWithReasoning
} from '../src/db/storeEvents.js'

function buildStore() {
  const store = new Store({ dbPath: ':memory:' })
  store.upsertMachine({
    machineId: 'm-1',
    machineName: 'runner',
    platform: 'linux',
    capabilities: null
  })
  store.createSession({
    sessionId: 's-1',
    machineId: 'm-1',
    cwd: '/tmp',
    status: 'idle'
  })
  return store
}

test('listSessionEventsPage summary mode keeps normalized/commentary and unattributed stderr/stdout only', () => {
  const store = buildStore()

  store.appendEvent({
    eventId: 'e-1',
    sessionId: 's-1',
    tsMs: 1,
    type: 'session.input',
    payload: { text: 'hello' }
  })
  store.appendEvent({
    eventId: 'e-2',
    sessionId: 's-1',
    tsMs: 2,
    type: 'session.output',
    payload: { stream: 'normalized', text: 'answer' }
  })
  store.appendEvent({
    eventId: 'e-3',
    sessionId: 's-1',
    tsMs: 3,
    type: 'session.output',
    payload: { stream: 'commentary', text: 'thinking aloud' }
  })
  store.appendEvent({
    eventId: 'e-4',
    sessionId: 's-1',
    tsMs: 4,
    type: 'session.output',
    payload: { stream: 'reasoning', text: 'hidden reasoning' }
  })
  store.appendEvent({
    eventId: 'e-5',
    sessionId: 's-1',
    tsMs: 5,
    type: 'session.output',
    payload: { stream: 'stdout', itemId: 'tool-1', text: 'hidden tool output' }
  })
  store.appendEvent({
    eventId: 'e-6',
    sessionId: 's-1',
    tsMs: 6,
    type: 'session.output',
    payload: { stream: 'stderr', text: 'visible error' }
  })

  const summary = listSessionEventsPage(store.db, 's-1', { mode: 'summary', limit: 20 })
  assert.deepEqual(summary.events.map((event) => event.eventId), ['e-1', 'e-2', 'e-3', 'e-6'])
})

test('turn reasoning helpers resolve range, dedupe chunks, and attach section ordering', () => {
  const store = buildStore()

  store.appendEvent({
    eventId: 'e-1',
    sessionId: 's-1',
    tsMs: 1,
    type: 'turn.started',
    payload: { turnId: 'turn-1' }
  })
  store.appendEvent({
    eventId: 'e-2',
    sessionId: 's-1',
    tsMs: 2,
    type: 'session.output',
    payload: { stream: 'reasoning', text: '**Plan**\nInspect files\n' }
  })
  store.appendEvent({
    eventId: 'e-3',
    sessionId: 's-1',
    tsMs: 3,
    type: 'session.output',
    payload: { stream: 'reasoning', text: '**Plan**\nInspect files\n' }
  })
  store.appendEvent({
    eventId: 'e-4',
    sessionId: 's-1',
    tsMs: 4,
    type: 'session.output',
    payload: { stream: 'reasoning', text: '- **Answer** done' }
  })
  store.appendEvent({
    eventId: 'e-5',
    sessionId: 's-1',
    tsMs: 5,
    type: 'turn.completed',
    payload: { turnId: 'turn-1', status: 'completed' }
  })

  assert.deepEqual(getTurnSeqRange(store.db, 's-1', 'turn-1'), {
    startSeq: 1,
    endSeq: 5
  })

  assert.deepEqual(getTurnReasoningText(store.db, {
    sessionId: 's-1',
    turnId: 'turn-1',
    lastSeq: 5
  }), {
    turnId: 'turn-1',
    startSeq: 1,
    endSeq: 5,
    text: '**Plan**\nInspect files\n- **Answer** done',
    truncated: false
  })

  assert.deepEqual(getTurnReasoningSections(store.db, {
    sessionId: 's-1',
    turnId: 'turn-1',
    lastSeq: 5
  }), {
    turnId: 'turn-1',
    startSeq: 1,
    endSeq: 5,
    truncated: false,
    sections: [
      { id: 'r-1', title: 'Plan', body: 'Inspect files\n', startSeq: 2, tsMs: 2 },
      { id: 'r-2', title: 'Answer done', body: '', startSeq: 4, tsMs: 4 }
    ]
  })

  assert.deepEqual(getTurnReasoningSections(store.db, {
    sessionId: 's-1',
    turnId: 'turn-1',
    lastSeq: 5,
    includeBody: false
  }), {
    turnId: 'turn-1',
    startSeq: 1,
    endSeq: 5,
    truncated: false,
    sections: [
      { id: 'r-1', title: 'Plan', startSeq: 2, tsMs: 2 },
      { id: 'r-2', title: 'Answer done', startSeq: 4, tsMs: 4 }
    ]
  })

  assert.deepEqual(listTurnsWithReasoning(store.db, {
    sessionId: 's-1',
    turnIds: ['turn-1', 'turn-missing'],
    lastSeq: 5
  }), ['turn-1'])
})

test('event pagination uses limit-plus-one lookahead for history and tool output pages', () => {
  const store = buildStore()

  store.appendEvent({
    eventId: 'e-1',
    sessionId: 's-1',
    tsMs: 1,
    type: 'session.input',
    payload: { text: 'hello' }
  })
  store.appendEvent({
    eventId: 'e-2',
    sessionId: 's-1',
    tsMs: 2,
    type: 'session.output',
    payload: { stream: 'stdout', itemId: 'tool-1', text: 'a' }
  })
  store.appendEvent({
    eventId: 'e-3',
    sessionId: 's-1',
    tsMs: 3,
    type: 'session.output',
    payload: { stream: 'stdout', itemId: 'tool-1', text: 'b' }
  })
  store.appendEvent({
    eventId: 'e-4',
    sessionId: 's-1',
    tsMs: 4,
    type: 'session.output',
    payload: { stream: 'normalized', text: 'done' }
  })

  const page = listSessionEventsPage(store.db, 's-1', { mode: 'full', limit: 2 })
  assert.deepEqual(page.events.map((event) => event.eventId), ['e-3', 'e-4'])
  assert.equal(page.hasMoreBefore, true)
  assert.equal(page.oldestSeq, 3)

  const toolPage = listItemOutputEvents(store.db, 's-1', 'tool-1', { limit: 1 })
  assert.deepEqual(toolPage.events.map((event) => event.eventId), ['e-3'])
  assert.equal(toolPage.hasMoreBefore, true)
  assert.equal(toolPage.oldestSeq, 3)

  const toolPage2 = listItemOutputEvents(store.db, 's-1', 'tool-1', { limit: 1, beforeSeq: toolPage.oldestSeq })
  assert.deepEqual(toolPage2.events.map((event) => event.eventId), ['e-2'])
  assert.equal(toolPage2.hasMoreBefore, false)
  assert.equal(toolPage2.oldestSeq, 2)
})
