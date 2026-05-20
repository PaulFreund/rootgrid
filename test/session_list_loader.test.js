import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionListPagePath,
  createSessionListLoader,
  readSessionPageInfo
} from '../web/src/lib/sessionListLoader.js'

test('session list loader builds cursor paths and reads snapshot paging metadata', () => {
  assert.equal(buildSessionListPagePath({
    archived: true,
    limit: 150,
    beforeUpdatedMs: 123,
    beforeSessionId: 's-1'
  }), '/api/sessions?archived=1&limit=150&beforeUpdatedMs=123&beforeSessionId=s-1')

  assert.deepEqual(readSessionPageInfo({
    sessionsHasMore: true,
    sessionsNextBeforeUpdatedMs: 55,
    sessionsNextBeforeSessionId: 's-2'
  }), {
    hasMoreBefore: true,
    nextBeforeUpdatedMs: 55,
    nextBeforeSessionId: 's-2'
  })
})

test('session list loader appends older pages and can fetch all archived pages', async () => {
  const requested = []
  const sessionListLoading = { value: false }
  const sessionListHasMore = { value: false }
  const sessionListNextBeforeUpdatedMs = { value: null }
  const sessionListNextBeforeSessionId = { value: null }
  const rows = []

  const pageByPath = new Map([
    ['/api/sessions?limit=200&beforeUpdatedMs=10&beforeSessionId=s-2', {
      sessions: [{ sessionId: 's-1' }],
      hasMoreBefore: false,
      nextBeforeUpdatedMs: 9,
      nextBeforeSessionId: 's-1'
    }],
    ['/api/sessions?archived=1&limit=200', {
      sessions: [{ sessionId: 'a-2' }],
      hasMoreBefore: true,
      nextBeforeUpdatedMs: 5,
      nextBeforeSessionId: 'a-2'
    }],
    ['/api/sessions?archived=1&limit=200&beforeUpdatedMs=5&beforeSessionId=a-2', {
      sessions: [{ sessionId: 'a-1' }],
      hasMoreBefore: false,
      nextBeforeUpdatedMs: 4,
      nextBeforeSessionId: 'a-1'
    }]
  ])

  const loader = createSessionListLoader({
    apiFetch: async (path) => {
      requested.push(path)
      const data = pageByPath.get(path)
      return {
        ok: Boolean(data),
        status: data ? 200 : 404,
        async json() {
          return data
        }
      }
    },
    appendSessionRows: (pageRows) => rows.push(...pageRows),
    sessionListLoading,
    sessionListHasMore,
    sessionListNextBeforeUpdatedMs,
    sessionListNextBeforeSessionId,
    schedule: (fn) => fn()
  })

  loader.applySessionPageInfo({
    sessionsHasMore: true,
    sessionsNextBeforeUpdatedMs: 10,
    sessionsNextBeforeSessionId: 's-2'
  })
  const loaded = await loader.loadMoreSessions()
  assert.equal(loaded, true)
  assert.deepEqual(rows.map((row) => row.sessionId), ['s-1'])
  assert.equal(sessionListHasMore.value, false)

  const archived = []
  await loader.fetchAllSessionPages({
    archived: true,
    onPage: (pageRows) => archived.push(...pageRows)
  })
  assert.deepEqual(archived.map((row) => row.sessionId), ['a-2', 'a-1'])
  assert.deepEqual(requested, [
    '/api/sessions?limit=200&beforeUpdatedMs=10&beforeSessionId=s-2',
    '/api/sessions?archived=1&limit=200',
    '/api/sessions?archived=1&limit=200&beforeUpdatedMs=5&beforeSessionId=a-2'
  ])
})
