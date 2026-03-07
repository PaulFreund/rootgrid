import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCreateSessionRow,
  buildDerivedSessionEventUpdate,
  buildUpdateSessionStatement,
  normalizeSessionOptionValues,
  normalizeStoredEventPayload
} from '../src/db/storeSessionWrites.js'

test('normalizeSessionOptionValues trims string options and clears empty values', () => {
  assert.deepEqual(normalizeSessionOptionValues({
    model: ' gpt-5 ',
    reasoningEffort: ' medium ',
    approvalPolicy: ' ',
    sandbox: ' workspace-write '
  }), {
    model: 'gpt-5',
    reasoningEffort: 'medium',
    approvalPolicy: null,
    sandbox: 'workspace-write'
  })
})

test('buildCreateSessionRow fills the expected session defaults', () => {
  const row = buildCreateSessionRow({
    sessionId: 'session-1',
    machineId: 'machine-1',
    cwd: '/repo',
    status: 'starting',
    codexThreadId: 'thread-1',
    options: { model: 'gpt-5' },
    now: 123
  })

  assert.deepEqual(row, [
    'session-1',
    'machine-1',
    '/repo',
    null,
    null,
    null,
    'starting',
    'idle',
    0,
    0,
    0,
    123,
    123,
    'thread-1',
    'gpt-5',
    null,
    null,
    null,
    null
  ])
})

test('buildUpdateSessionStatement emits only changed columns plus updated timestamp', () => {
  const out = buildUpdateSessionStatement({
    status: 'running',
    preview: 'hello',
    sandbox: 'danger-full-access',
    now: 999
  })

  assert.deepEqual(out, {
    sets: ['status=?', 'preview=?', 'sandbox_mode=?', 'updated_ms=?'],
    params: ['running', 'hello', 'danger-full-access', 999]
  })
})

test('normalizeStoredEventPayload rewrites session output seq while preserving runnerSeq', () => {
  const out = normalizeStoredEventPayload({
    type: 'session.output',
    seq: 7,
    payload: {
      seq: 2,
      stream: 'stdout',
      itemId: 'item-1',
      text: 'hello'
    }
  })

  assert.deepEqual(out.payload, {
    seq: 7,
    runnerSeq: 2,
    stream: 'stdout',
    itemId: 'item-1',
    text: 'hello'
  })
  assert.equal(out.stream, 'stdout')
  assert.equal(out.itemId, 'item-1')
})

test('buildDerivedSessionEventUpdate captures preview/title/status/approval derived metadata', () => {
  assert.deepEqual(buildDerivedSessionEventUpdate({
    type: 'session.input',
    payload: { text: '  first message  ', isInitial: true },
    tsMs: 10,
    seq: 1
  }), {
    sets: ['updated_ms=?', 'last_seq=?', 'preview=?', "title = CASE WHEN title IS NULL OR title='' THEN ? ELSE title END"],
    params: [10, 1, 'first message', 'first message']
  })

  assert.deepEqual(buildDerivedSessionEventUpdate({
    type: 'session.status',
    payload: { status: 'failed', codexThreadId: 'thread-1' },
    tsMs: 20,
    seq: 2
  }), {
    sets: ['updated_ms=?', 'last_seq=?', 'status=?', 'turn_state=?', 'codex_thread_id=?'],
    params: [20, 2, 'failed', 'idle', 'thread-1']
  })

  assert.deepEqual(buildDerivedSessionEventUpdate({
    type: 'approval.resolved',
    payload: {},
    tsMs: 30,
    seq: 3
  }), {
    sets: ['updated_ms=?', 'last_seq=?', 'pending_approvals = MAX(pending_approvals - 1, 0)'],
    params: [30, 3]
  })
})
