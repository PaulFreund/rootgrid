import test from 'node:test'
import assert from 'node:assert/strict'

import { createPendingRequestBook } from '../src/server/pendingRequestBook.js'

test('pending request book resolves created requests and clears them', async () => {
  const book = createPendingRequestBook()
  const requestP = book.create('req-1', {
    machineId: 'machine-1',
    timeoutMs: 5_000,
    onTimeout: () => new Error('timed out')
  })

  queueMicrotask(() => {
    book.resolve('req-1', { ok: true })
  })

  await assert.doesNotReject(async () => {
    const out = await requestP
    assert.deepEqual(out, { ok: true })
  })
})

test('pending request book rejects matching machine requests on disconnect', async () => {
  const book = createPendingRequestBook()
  const matchingP = book.create('req-1', { machineId: 'machine-1', timeoutMs: 5_000 })
  const otherP = book.create('req-2', { machineId: 'machine-2', timeoutMs: 5_000 })

  const matchingResultP = matchingP.then(
    () => 'resolved',
    (err) => err
  )

  const rejected = book.rejectByMachine('machine-1', new Error('runner disconnected'))
  assert.equal(rejected, 1)

  const err = await matchingResultP
  assert.match(String(err?.message ?? err), /runner disconnected/i)

  queueMicrotask(() => {
    book.resolve('req-2', { ok: true })
  })
  assert.deepEqual(await otherP, { ok: true })
})
