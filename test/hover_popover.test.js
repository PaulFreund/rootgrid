import test from 'node:test'
import assert from 'node:assert/strict'

import { createHoverCloseController } from '../web/src/lib/hoverPopover.js'

test('createHoverCloseController schedules a delayed close and cancels prior timers when rescheduled', () => {
  const timers = new Map()
  const cleared = []
  let nextId = 1
  let closed = 0

  const controller = createHoverCloseController({
    delayMs: 150,
    setTimer: (fn, delayMs) => {
      const id = nextId++
      timers.set(id, { fn, delayMs })
      return id
    },
    clearTimer: (id) => {
      cleared.push(id)
      timers.delete(id)
    }
  })

  const first = controller.schedule(() => { closed += 1 })
  const second = controller.schedule(() => { closed += 10 })

  assert.equal(first, 1)
  assert.equal(second, 2)
  assert.deepEqual(cleared, [1])
  assert.equal(timers.has(1), false)
  assert.equal(timers.get(2)?.delayMs, 150)

  timers.get(2)?.fn()
  assert.equal(closed, 10)
})

test('createHoverCloseController cancel and dispose clear any pending close', () => {
  const timers = new Map()
  const cleared = []
  let nextId = 1

  const controller = createHoverCloseController({
    setTimer: (fn) => {
      const id = nextId++
      timers.set(id, fn)
      return id
    },
    clearTimer: (id) => {
      cleared.push(id)
      timers.delete(id)
    }
  })

  controller.schedule(() => {})
  controller.cancel()
  controller.schedule(() => {})
  controller.dispose()

  assert.deepEqual(cleared, [1, 2])
  assert.equal(timers.size, 0)
})
