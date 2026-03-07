import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChatMessages,
  diffStepSelectedFile,
  diffStepSelectedPath,
  parseReasoningSections,
  parseUnifiedDiff,
  setDiffStepSelectedPath
} from '../web/src/lib/chatMessages.js'
import { createSessionStoreState } from '../web/src/lib/sessionUi.js'

test('parseReasoningSections groups markdown into titled sections', () => {
  const sections = parseReasoningSections(`
Overview

- **Plan**: inspect the repo
More detail
**Answer** final response
  `)

  assert.deepEqual(sections, [
    { id: 1, title: 'Summary', body: 'Overview' },
    { id: 2, title: 'Plan', body: 'inspect the repo\nMore detail' },
    { id: 3, title: 'Answer', body: 'final response' }
  ])
})

test('parseUnifiedDiff memoizes parsed files and keeps basic hunk counts', () => {
  const diff = [
    'diff --git a/src/a.txt b/src/a.txt',
    '--- a/src/a.txt',
    '+++ b/src/a.txt',
    '@@ -1 +1 @@',
    '-old line',
    '+new line'
  ].join('\n')

  const first = parseUnifiedDiff(diff)
  const second = parseUnifiedDiff(diff)

  assert.strictEqual(second, first)
  assert.equal(first.length, 1)
  assert.equal(first[0].path, 'src/a.txt')
  assert.equal(first[0].added, 1)
  assert.equal(first[0].removed, 1)
  assert.deepEqual(first[0].lines.map((line) => line.kind), ['meta', 'meta', 'meta', 'hunk', 'del', 'add'])
})

test('diff file selection helpers persist the selected file per diff event', () => {
  const store = createSessionStoreState()
  const files = [
    { path: 'src/a.txt', raw: 'a' },
    { path: 'src/b.txt', raw: 'b' }
  ]

  assert.equal(diffStepSelectedPath('diff-1', files, store), 'src/a.txt')

  setDiffStepSelectedPath('diff-1', 'src/b.txt', store)
  assert.equal(diffStepSelectedPath('diff-1', files, store), 'src/b.txt')
  assert.equal(diffStepSelectedFile('diff-1', files, store)?.path, 'src/b.txt')
})

test('buildChatMessages folds exploration + reasoning details and caches by view version', () => {
  const store = createSessionStoreState()
  store.turnHasReasoningLive.add('turn-1')
  store.backgroundExpandedByTurnId.set('turn-1', true)
  store.reasoningByTurnId.set('turn-1', {
    loading: false,
    loaded: true,
    error: '',
    truncated: false,
    sections: [
      { id: 'sec-1', title: 'Plan', body: 'Read foo.js', seq: 5 }
    ]
  })

  store.events.push(
    {
      eventId: 'e-1',
      type: 'session.input',
      payload: { text: 'Hi', attachments: [] }
    },
    {
      eventId: 'e-2',
      type: 'turn.started',
      payload: { turnId: 'turn-1' }
    },
    {
      eventId: 'e-3',
      type: 'tool.started',
      seq: 6,
      tsMs: 6,
      payload: {
        tool: 'CommandExecution',
        itemId: 'item-1',
        commandActions: [{ type: 'read', name: 'foo.js', path: 'foo.js', command: 'cat foo.js' }]
      }
    },
    {
      eventId: 'e-4',
      type: 'tool.completed',
      seq: 8,
      tsMs: 8,
      payload: {
        tool: 'CommandExecution',
        itemId: 'item-1',
        status: 'completed',
        commandActions: [{ type: 'read', name: 'foo.js', path: 'foo.js', command: 'cat foo.js' }]
      }
    },
    {
      eventId: 'e-5',
      type: 'session.output',
      payload: { stream: 'normalized', text: 'Hello there' }
    },
    {
      eventId: 'e-6',
      type: 'turn.completed',
      payload: { turnId: 'turn-1' }
    }
  )

  const first = buildChatMessages(store)
  assert.equal(first.length, 3)
  assert.equal(first[0].role, 'user')
  assert.equal(first[1].stepKind, 'background')
  assert.equal(first[1].title, 'Details — Reasoning · Explored 1 file')
  assert.deepEqual(first[1].timeline[0], {
    kind: 'reasoning',
    id: 'reasoning-sec-1',
    section: { id: 'sec-1', title: 'Plan', body: 'Read foo.js', seq: 5 }
  })
  assert.equal(first[1].timeline[1]?.kind, 'explore')
  assert.equal(first[1].timeline[1]?.label, 'Read foo.js')
  assert.match(String(first[1].timeline[1]?.id ?? ''), /^explorecall-item-1-\d+$/)
  assert.equal(first[2].role, 'assistant')
  assert.equal(first[2].text, 'Hello there')

  const second = buildChatMessages(store)
  assert.strictEqual(second, first)

  store.messageViewVersion += 1
  const third = buildChatMessages(store)
  assert.notStrictEqual(third, first)
  assert.deepEqual(third, first)
})
