import test from 'node:test'
import assert from 'node:assert/strict'

import { createModelCatalogCache, modelCatalogCacheKey } from '../src/server/modelCatalogCache.js'

test('modelCatalogCacheKey normalizes the lookup tuple', () => {
  assert.equal(
    modelCatalogCacheKey({ machineId: 'machine-1', cwd: '/repo', limit: '200', includeHidden: true }),
    'machine-1\n/repo\n200\n1'
  )
})

test('createModelCatalogCache reuses fresh cached values and deduplicates in-flight loads', async () => {
  let calls = 0
  const cache = createModelCatalogCache({
    now: (() => {
      let value = 1_000
      return () => value
    })(),
    load: async (params) => {
      calls += 1
      return { machineId: params.machineId, models: [{ id: `m-${calls}` }] }
    }
  })

  const params = { machineId: 'machine-1', cwd: '/repo' }
  const [first, second] = await Promise.all([cache.list(params), cache.list(params)])
  assert.equal(calls, 1)
  assert.strictEqual(second, first)

  const third = await cache.list(params)
  assert.equal(calls, 1)
  assert.strictEqual(third, first)
})

test('createModelCatalogCache invalidates per machine and keeps machine caches isolated', async () => {
  let nowMs = 2_000
  let calls = 0
  const cache = createModelCatalogCache({
    now: () => nowMs,
    load: async (params) => {
      calls += 1
      return { machineId: params.machineId, models: [{ id: `m-${calls}` }] }
    }
  })

  const one = await cache.list({ machineId: 'machine-1', cwd: '/repo' })
  const two = await cache.list({ machineId: 'machine-2', cwd: '/repo' })
  assert.equal(calls, 2)
  assert.notStrictEqual(two, one)

  cache.clearMachine('machine-1')
  const three = await cache.list({ machineId: 'machine-1', cwd: '/repo' })
  assert.equal(calls, 3)
  assert.notStrictEqual(three, one)

  nowMs += 60_000
  const four = await cache.list({ machineId: 'machine-2', cwd: '/repo' })
  assert.equal(calls, 4)
  assert.notStrictEqual(four, two)
})
