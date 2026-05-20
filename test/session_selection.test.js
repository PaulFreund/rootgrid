import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSessionLoadStrategy } from '../web/src/lib/sessionSelection.js'

test('resolveSessionLoadStrategy loads when no cached history exists', () => {
  assert.deepEqual(resolveSessionLoadStrategy(null, { lastSeq: 10 }), {
    action: 'load',
    knownSeq: 0,
    targetSeq: 10
  })
})

test('resolveSessionLoadStrategy reuses fully loaded history', () => {
  assert.deepEqual(resolveSessionLoadStrategy({
    historyLoaded: true,
    lastLoadedSeq: 8,
    events: [{ seq: 1 }, { seq: 8 }]
  }, { lastSeq: 8 }), {
    action: 'reuse',
    knownSeq: 8,
    targetSeq: 8
  })
})

test('resolveSessionLoadStrategy prefers backfill when cached history is only slightly behind', () => {
  assert.deepEqual(resolveSessionLoadStrategy({
    historyLoaded: true,
    lastLoadedSeq: 8,
    events: [{ seq: 1 }, { seq: 8 }]
  }, { lastSeq: 10 }), {
    action: 'backfill',
    knownSeq: 8,
    targetSeq: 10
  })
})

