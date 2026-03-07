import test from 'node:test'
import assert from 'node:assert/strict'

import { computeVirtualWindow } from '../web/src/lib/virtualList.js'

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
