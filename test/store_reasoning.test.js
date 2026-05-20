import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectReasoningSegments,
  parseReasoningSectionsWithStart
} from '../src/db/storeReasoning.js'

test('collectReasoningSegments deduplicates repeated chunks and tracks segment ranges', () => {
  const out = collectReasoningSegments([
    { seq: 10, ts_ms: 100, payload_json: '{"text":"Hello"}' },
    { seq: 11, ts_ms: 110, payload_json: '{"text":"Hello"}' },
    { seq: 12, ts_ms: 120, payload_json: '{"text":"\\nWorld"}' }
  ])

  assert.equal(out.text, 'Hello\nWorld')
  assert.equal(out.truncated, false)
  assert.deepEqual(out.segments, [
    { start: 0, end: 5, seq: 10, tsMs: 100 },
    { start: 5, end: 11, seq: 12, tsMs: 120 }
  ])
})

test('collectReasoningSegments applies maxChars truncation', () => {
  const out = collectReasoningSegments([
    { seq: 1, ts_ms: 1, payload_json: JSON.stringify({ text: 'a'.repeat(1200) }) }
  ], { maxChars: 1000 })

  assert.equal(out.text.length, 1000)
  assert.equal(out.truncated, true)
  assert.deepEqual(out.segments, [
    { start: 0, end: 1000, seq: 1, tsMs: 1 }
  ])
})

test('parseReasoningSectionsWithStart keeps start offsets for markdown sections', () => {
  const sections = parseReasoningSectionsWithStart([
    '**Plan**',
    'Inspect the repo',
    '',
    '- **Answer** done'
  ].join('\n'))

  assert.deepEqual(sections, [
    { title: 'Plan', body: 'Inspect the repo\n', startIndex: 0 },
    { title: 'Answer done', body: '', startIndex: 27 }
  ])
})
