import test from 'node:test'
import assert from 'node:assert/strict'

import { computeVirtualWindow, computeVirtualWindowVariable } from '../web/src/lib/virtualList.js'

test('computeVirtualWindow returns a stable overscanned slice and spacer sizes', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))
  const windowed = computeVirtualWindow(items, {
    scrollTop: 680,
    viewportHeight: 340,
    rowHeight: 68,
    overscan: 2
  })

  assert.equal(windowed.start, 8)
  assert.equal(windowed.end, 17)
  assert.equal(windowed.offsetTop, 544)
  assert.equal(windowed.offsetBottom, (100 - 17) * 68)
  assert.deepEqual(windowed.items.map((item) => item.id), [9, 10, 11, 12, 13, 14, 15, 16, 17])
})

test('computeVirtualWindowVariable supports mixed item heights such as session groups', () => {
  const items = [
    { id: 'g1', kind: 'group' },
    { id: 's1', kind: 'session' },
    { id: 's2', kind: 'session' },
    { id: 'g2', kind: 'group' },
    { id: 's3', kind: 'session' }
  ]

  const windowed = computeVirtualWindowVariable(items, {
    scrollTop: 40,
    viewportHeight: 90,
    overscanPx: 20,
    defaultItemHeight: 56,
    getItemHeight: (item) => item.kind === 'group' ? 28 : 56
  })

  assert.equal(windowed.start, 0)
  assert.equal(windowed.end, 4)
  assert.equal(windowed.offsetTop, 0)
  assert.equal(windowed.offsetBottom, 56)
  assert.deepEqual(windowed.items.map((item) => item.id), ['g1', 's1', 's2', 'g2'])
})
