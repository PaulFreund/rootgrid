import test from 'node:test'
import assert from 'node:assert/strict'

import {
  eventRowToRecord,
  parseJsonCell,
  sessionRowToRecord,
  summarizeTextSnippet,
  SUMMARY_SESSION_EVENTS_WHERE
} from '../src/db/storeRows.js'

test('parseJsonCell returns fallback on invalid JSON', () => {
  assert.deepEqual(parseJsonCell('{"ok":true}', null), { ok: true })
  assert.equal(parseJsonCell('{bad json}', 'fallback'), 'fallback')
})

test('sessionRowToRecord normalizes nullable DB columns', () => {
  const session = sessionRowToRecord({
    session_id: 'session-1',
    machine_id: 'machine-1',
    cwd: '/repo',
    project_label: null,
    title: 'Title',
    preview: null,
    status: 'running',
    turn_state: 'idle',
    pending_approvals: 2,
    last_seq: 9,
    last_read_seq: 4,
    created_ms: 10,
    updated_ms: 11,
    codex_thread_id: 'thread-1',
    model: 'gpt-5',
    reasoning_effort: 'medium',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    archived_ms: null
  })

  assert.deepEqual(session, {
    sessionId: 'session-1',
    machineId: 'machine-1',
    cwd: '/repo',
    projectLabel: null,
    title: 'Title',
    preview: null,
    status: 'running',
    turnState: 'idle',
    pendingApprovals: 2,
    lastSeq: 9,
    lastReadSeq: 4,
    createdMs: 10,
    updatedMs: 11,
    codexThreadId: 'thread-1',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    archivedMs: null
  })
})

test('eventRowToRecord parses payload and summarizeTextSnippet collapses whitespace', () => {
  assert.deepEqual(eventRowToRecord({
    event_id: 'e-1',
    seq: 3,
    ts_ms: 100,
    type: 'session.input',
    payload_json: '{"text":"hello"}'
  }), {
    eventId: 'e-1',
    seq: 3,
    tsMs: 100,
    type: 'session.input',
    payload: { text: 'hello' }
  })

  assert.equal(summarizeTextSnippet('  hello   there  '), 'hello there')
  assert.match(SUMMARY_SESSION_EVENTS_WHERE, /session\.output|normalized|stderr/)
})
