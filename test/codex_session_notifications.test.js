import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCodexErrorOutputText,
  buildPlanUpdatedEvent,
  buildTerminalInteractionOutputText,
  buildThreadTokenUsageEvent,
  buildToolCompletedEvent,
  buildToolStartedEvent,
  normalizeWrappedNotification
} from '../src/runner/sessions/codexSessionNotifications.js'

test('normalizeWrappedNotification remaps wrapped deltas and token counts', () => {
  const wrappedDelta = normalizeWrappedNotification({
    method: 'codex/event/message',
    params: {
      msg: {
        type: 'agent_message_delta',
        item_id: 'item-1',
        delta: 'hello'
      }
    },
    sessionId: 'session-1'
  })
  assert.deepEqual(wrappedDelta, {
    kind: 'forward',
    notifications: [{
      method: 'item/agentMessage/delta',
      params: {
        __rgFromWrapped: true,
        itemId: 'item-1',
        delta: 'hello'
      }
    }]
  })

  const wrappedTokenCount = normalizeWrappedNotification({
    method: 'codex/event/message',
    params: {
      msg: {
        type: 'token_count',
        info: { total: 12 },
        rate_limits: { reset_seconds: 9 }
      }
    },
    sessionId: 'session-1'
  })
  assert.deepEqual(wrappedTokenCount, {
    kind: 'emit',
    eventType: 'token.count',
    payload: {
      sessionId: 'session-1',
      info: { total: 12 },
      rateLimits: { reset_seconds: 9 }
    }
  })
})

test('notification helpers build stderr/plan/thread/tool payloads', () => {
  assert.equal(
    buildCodexErrorOutputText({
      error: {
        message: 'boom',
        additionalDetails: 'details'
      }
    }),
    '[codex] boom\ndetails\n'
  )
  assert.equal(buildCodexErrorOutputText({ willRetry: true }), null)

  assert.deepEqual(buildThreadTokenUsageEvent({
    sessionId: 'session-1',
    params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: 1 } }
  }), {
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: { total: 1 }
  })

  assert.deepEqual(buildPlanUpdatedEvent({
    sessionId: 'session-1',
    params: { threadId: 'thread-1', explanation: 'why', plan: [{ step: 'x' }] }
  }), {
    sessionId: 'session-1',
    threadId: 'thread-1',
    explanation: 'why',
    plan: [{ step: 'x' }]
  })

  assert.equal(
    buildTerminalInteractionOutputText({ itemId: 'tool-1', stdin: 'y' }),
    '[codex] terminal interaction (tool-1): y\n'
  )

  assert.deepEqual(buildToolStartedEvent({
    sessionId: 'session-1',
    item: { id: 'tool-1', type: 'command_execution', command: 'ls', cwd: '/repo' }
  }), {
    dedupeKey: 'commandexecution:tool-1',
    payload: {
      sessionId: 'session-1',
      tool: 'commandExecution',
      itemId: 'tool-1',
      command: 'ls',
      cwd: '/repo',
      commandActions: null,
      status: null
    }
  })

  assert.deepEqual(buildToolCompletedEvent({
    sessionId: 'session-1',
    hadOutput: true,
    item: { id: 'patch-1', type: 'file_change', changes: [{ path: 'a.js', kind: 'edit' }] }
  }), {
    dedupeKey: 'filechange:patch-1',
    itemId: 'patch-1',
    payload: {
      sessionId: 'session-1',
      tool: 'fileChange',
      itemId: 'patch-1',
      changes: [{ path: 'a.js', kind: 'edit' }],
      status: null,
      hadOutput: true
    }
  })
})
