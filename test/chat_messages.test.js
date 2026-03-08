import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChatMessages,
  diffStepSelectedFile,
  diffStepSelectedPath,
  parseReasoningSections,
  parseUnifiedDiff,
  summarizeUnifiedDiff,
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

test('parseUnifiedDiff memoizes parsed files and keeps basic hunk structure', () => {
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
  assert.deepEqual(first[0].lines.map((line) => line.kind), ['meta', 'meta', 'meta', 'hunk', 'del', 'add'])
})

test('summarizeUnifiedDiff counts changed files and line deltas without full render state', () => {
  const diff = [
    'diff --git a/src/a.txt b/src/a.txt',
    '--- a/src/a.txt',
    '+++ b/src/a.txt',
    '@@ -1 +1 @@',
    '-old line',
    '+new line',
    'diff --git a/src/b.txt b/src/b.txt',
    '--- a/src/b.txt',
    '+++ b/src/b.txt',
    '@@ -1,2 +1,3 @@',
    '-a',
    '-b',
    '+c'
  ].join('\n')

  assert.deepEqual(summarizeUnifiedDiff(diff), {
    files: 2,
    added: 2,
    removed: 3,
    paths: ['src/a.txt', 'src/b.txt']
  })
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

test('buildChatMessages folds thinking details and keeps command steps interleaved before the answer', () => {
  const store = createSessionStoreState()
  store.backgroundExpandedByTurnId.set('turn-1', true)
  store.toolExpanded.set('file-1', false)
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
      tsMs: 1_000,
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
      type: 'tool.started',
      seq: 7,
      tsMs: 7,
      payload: {
        tool: 'CommandExecution',
        itemId: 'cmd-1',
        status: 'running',
        command: 'npm test',
        commandActions: [{ type: 'unknown', command: 'npm test' }]
      }
    },
    {
      eventId: 'e-6',
      type: 'tool.completed',
      seq: 8,
      tsMs: 8,
      payload: {
        tool: 'fileChange',
        itemId: 'file-1',
        status: 'completed',
        changes: [{ path: 'src/foo.js' }]
      }
    },
    {
      eventId: 'e-6b',
      type: 'diff.updated',
      seq: 8.5,
      tsMs: 8.5,
      payload: {
        diff: [
          'diff --git a/src/foo.js b/src/foo.js',
          '--- a/src/foo.js',
          '+++ b/src/foo.js',
          '@@ -1 +1 @@',
          '-old',
          '+new'
        ].join('\n')
      }
    },
    {
      eventId: 'e-7',
      type: 'session.output',
      payload: { stream: 'normalized', text: 'Hello there' }
    },
    {
      eventId: 'e-8',
      tsMs: 9_000,
      type: 'turn.completed',
      payload: { turnId: 'turn-1' }
    },
    {
      eventId: 'e-9',
      type: 'tool.completed',
      seq: 9,
      tsMs: 9,
      payload: {
        tool: 'CommandExecution',
        itemId: 'cmd-1',
        status: 'completed',
        exitCode: 0,
        command: 'npm test',
        commandActions: [{ type: 'unknown', command: 'npm test' }]
      }
    }
  )

  const first = buildChatMessages(store)
  assert.equal(first.length, 3)
  assert.equal(first[0].role, 'user')
  assert.equal(first[1].stepKind, 'background')
  assert.equal(first[1].title, 'Thought for 8s')
  assert.equal(first[1].active, false)
  assert.equal(first[1].durationMs, 8_000)
  assert.deepEqual(first[1].timeline[0], {
    kind: 'reasoning',
    id: 'reasoning-sec-1',
    section: { id: 'sec-1', title: 'Plan', body: 'Read foo.js', seq: 5 }
  })
  assert.equal(first[1].timeline[1]?.kind, 'tool')
  assert.equal(first[1].timeline[1]?.itemId, 'cmd-1')
  assert.equal(first[1].timeline[1]?.status, 'completed')
  assert.equal(first[1].timeline[1]?.exitCode, 0)
  assert.equal(first[1].timeline[1]?.command, 'npm test')
  assert.equal(first[1].timeline[2]?.kind, 'explore')
  assert.equal(first[1].timeline[2]?.label, 'Read foo.js')
  assert.match(String(first[1].timeline[2]?.id ?? ''), /^explorecall-item-1-\d+$/)
  assert.equal(first[1].timeline[3]?.kind, 'diff')
  assert.match(String(first[1].timeline[3]?.raw ?? ''), /diff --git a\/src\/foo.js b\/src\/foo.js/)
  assert.equal(first[2].role, 'assistant')
  assert.equal(first[2].text, 'Hello there')

  const second = buildChatMessages(store)
  assert.strictEqual(second, first)

  store.messageViewVersion += 1
  const third = buildChatMessages(store)
  assert.notStrictEqual(third, first)
  assert.deepEqual(third, first)
})

test('buildChatMessages keeps diff steps raw until unfolded', () => {
  const store = createSessionStoreState()
  store.events.push({
    eventId: 'diff-1',
    type: 'diff.updated',
    payload: {
      diff: [
        'diff --git a/src/a.txt b/src/a.txt',
        '--- a/src/a.txt',
        '+++ b/src/a.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new'
      ].join('\n')
    }
  })

  const messages = buildChatMessages(store)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].stepKind, 'diff')
  assert.equal(messages[0].expanded, false)
  assert.equal('files' in messages[0], false)
  assert.match(String(messages[0].raw ?? ''), /diff --git a\/src\/a.txt b\/src\/a.txt/)
})

test('buildChatMessages keeps an empty Thinking group visible while a turn is still running', () => {
  const store = createSessionStoreState()
  store.currentTurnId = 'turn-live'

  store.events.push(
    {
      eventId: 'u-1',
      type: 'session.input',
      payload: { text: 'Do work', attachments: [] }
    },
    {
      eventId: 't-1',
      type: 'turn.started',
      payload: { turnId: 'turn-live' }
    }
  )

  const messages = buildChatMessages(store)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].stepKind, 'background')
  assert.equal(messages[1].title, 'Thinking')
  assert.equal(messages[1].active, true)
  assert.equal(messages[1].expanded, true)
  assert.deepEqual(messages[1].timeline, [])
})

test('buildChatMessages keeps live commentary inside Thinking and hides the final answer until the turn completes', () => {
  const store = createSessionStoreState()
  store.currentTurnId = 'turn-live'

  store.events.push(
    {
      eventId: 'u-1',
      type: 'session.input',
      payload: { text: 'Do work', attachments: [] }
    },
    {
      eventId: 't-1',
      type: 'turn.started',
      payload: { turnId: 'turn-live' }
    },
    {
      eventId: 'o-1',
      seq: 2,
      tsMs: 2,
      type: 'session.output',
      payload: { stream: 'commentary', text: 'Working on it' }
    },
    {
      eventId: 'o-2',
      seq: 3,
      tsMs: 3,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'Final answer in progress' }
    }
  )

  const messages = buildChatMessages(store)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].stepKind, 'background')
  assert.equal(messages[1].title, 'Thinking')
  assert.equal(messages[1].active, true)
  assert.deepEqual(
    messages[1].timeline.map((it) => it.kind),
    ['commentaryText']
  )
  assert.match(messages[1].timeline[0].text, /Working on it/)

  store.currentTurnId = null
  store.events.push({
    eventId: 'done-1',
    seq: 4,
    tsMs: 4,
    type: 'turn.completed',
    payload: { turnId: 'turn-live' }
  })

  const completedMessages = buildChatMessages(store)
  assert.equal(completedMessages.length, 3)
  assert.equal(completedMessages[1].stepKind, 'background')
  assert.equal(completedMessages[2].role, 'assistant')
  assert.equal(completedMessages[2].text, 'Final answer in progress')
})

test('buildChatMessages interleaves live reasoning chunks with command steps by seq', () => {
  const store = createSessionStoreState()
  store.currentTurnId = 'turn-live'

  store.events.push(
    {
      eventId: 'u-1',
      type: 'session.input',
      payload: { text: 'Inspect project', attachments: [] }
    },
    {
      eventId: 't-1',
      type: 'turn.started',
      seq: 1,
      tsMs: 1,
      payload: { turnId: 'turn-live' }
    },
    {
      eventId: 'r-1',
      type: 'session.output',
      seq: 2,
      tsMs: 2,
      payload: { stream: 'reasoning', text: 'Looking for the relevant files.\n' }
    },
    {
      eventId: 'c-1',
      type: 'tool.completed',
      seq: 3,
      tsMs: 3,
      payload: {
        tool: 'CommandExecution',
        itemId: 'read-1',
        status: 'completed',
        commandActions: [{ type: 'read', name: 'README.md', path: 'README.md', command: 'cat README.md' }]
      }
    },
    {
      eventId: 'r-2',
      type: 'session.output',
      seq: 4,
      tsMs: 4,
      payload: { stream: 'reasoning', text: 'Now I know where to make the change.' }
    }
  )

  const messages = buildChatMessages(store)
  assert.equal(messages.length, 2)
  assert.equal(messages[1].stepKind, 'background')
  assert.equal(messages[1].active, true)
  assert.deepEqual(
    messages[1].timeline.map((it) => it.kind),
    ['reasoningText', 'explore', 'reasoningText']
  )
  assert.match(messages[1].timeline[0].text, /Looking for the relevant files/)
  assert.equal(messages[1].timeline[1].label, 'Read README.md')
  assert.match(messages[1].timeline[2].text, /Now I know where to make the change/)
})

test('buildChatMessages keeps completed commentary-only turns in the Thinking history', () => {
  const store = createSessionStoreState()
  store.backgroundExpandedByTurnId.set('turn-1', true)

  store.events.push(
    {
      eventId: 'u-1',
      type: 'session.input',
      payload: { text: 'Fix it', attachments: [] }
    },
    {
      eventId: 't-1',
      seq: 1,
      tsMs: 1,
      type: 'turn.started',
      payload: { turnId: 'turn-1' }
    },
    {
      eventId: 'c-1',
      seq: 2,
      tsMs: 2,
      type: 'session.output',
      payload: { stream: 'commentary', text: 'Checking the files first.' }
    },
    {
      eventId: 'a-1',
      seq: 3,
      tsMs: 3,
      type: 'session.output',
      payload: { stream: 'normalized', text: 'Done.' }
    },
    {
      eventId: 't-2',
      seq: 4,
      tsMs: 4,
      type: 'turn.completed',
      payload: { turnId: 'turn-1' }
    }
  )

  const messages = buildChatMessages(store)
  assert.equal(messages.length, 3)
  assert.equal(messages[1].stepKind, 'background')
  assert.deepEqual(messages[1].timeline.map((it) => it.kind), ['commentaryText'])
  assert.match(messages[1].timeline[0].text, /Checking the files first/)
  assert.equal(messages[2].role, 'assistant')
  assert.equal(messages[2].text, 'Done.')
})

test('buildChatMessages keeps fileChange entries only when no diff summary exists', () => {
  const store = createSessionStoreState()
  store.backgroundExpandedByTurnId.set('turn-1', true)

  store.events.push(
    {
      eventId: 'u-1',
      type: 'session.input',
      payload: { text: 'Update docs', attachments: [] }
    },
    {
      eventId: 't-1',
      seq: 1,
      tsMs: 1,
      type: 'turn.started',
      payload: { turnId: 'turn-1' }
    },
    {
      eventId: 'fc-1',
      seq: 2,
      tsMs: 2,
      type: 'tool.completed',
      payload: {
        tool: 'fileChange',
        itemId: 'file-1',
        status: 'completed',
        changes: [{ path: 'README.md' }]
      }
    },
    {
      eventId: 't-2',
      seq: 3,
      tsMs: 3,
      type: 'turn.completed',
      payload: { turnId: 'turn-1' }
    }
  )

  const messages = buildChatMessages(store)
  assert.equal(messages[1].stepKind, 'background')
  assert.equal(messages[1].timeline.length, 1)
  assert.equal(messages[1].timeline[0]?.kind, 'tool')
  assert.equal(messages[1].timeline[0]?.tool, 'fileChange')
})
