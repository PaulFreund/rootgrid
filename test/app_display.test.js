import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildContextUsageSummary,
  buildRecentWorkspaces,
  finalizeCompletedPlan,
  formatAgeShort,
  formatAgo,
  formatCompactInt,
  machineHasVersionMismatch,
  machineIsOnline,
  machineRootgridVersion,
  machineStatusLabel,
  machineSupportsWebUpgrade,
  machineUpgradeStatusText,
  normalizeTokenUsage,
  planStepIsCompleted,
  updateTokenUsageMap
} from '../web/src/lib/appDisplay.js'

test('buildRecentWorkspaces deduplicates cwd values and prefers newest sessions', () => {
  const rows = [
    { sessionId: '1', machineId: 'm1', cwd: '/a', updatedMs: 5, archivedMs: null, projectLabel: 'A newest' },
    { sessionId: '2', machineId: 'm1', cwd: '/b', updatedMs: 4, archivedMs: null, projectLabel: 'B' },
    { sessionId: '3', machineId: 'm1', cwd: '/a', updatedMs: 3, archivedMs: null, projectLabel: 'A older' },
    { sessionId: '4', machineId: 'm2', cwd: '/c', updatedMs: 10, archivedMs: null, projectLabel: 'Other machine' },
    { sessionId: '5', machineId: 'm1', cwd: '/archived', updatedMs: 20, archivedMs: 1, projectLabel: 'Archived' }
  ]

  const out = buildRecentWorkspaces(rows, 'm1', (row) => row.projectLabel)
  assert.deepEqual(out, [
    { cwd: '/a', label: 'A newest' },
    { cwd: '/b', label: 'B' }
  ])
})

test('display formatting helpers normalize age and compact integers', () => {
  const now = 10_000_000
  assert.equal(formatAgo(now, now - 2_000), 'just now')
  assert.equal(formatAgeShort(now, now - 3_600_000), '1h')
  assert.equal(formatCompactInt(12_500), '13k')
})

test('token usage helpers normalize payloads and update the reactive map', () => {
  assert.deepEqual(normalizeTokenUsage({
    tokenUsage: {
      last: { totalTokens: 12 },
      total: { totalTokens: 48 },
      modelContextWindow: 128_000
    }
  }), {
    kind: 'v2',
    lastTotalTokens: 12,
    totalTotalTokens: 48,
    modelContextWindow: 128000
  })

  const map = new Map()
  const changed = updateTokenUsageMap(map, 'session-1', {
    info: {
      last_token_usage: { total_tokens: 7 },
      total_token_usage: { total_tokens: 21 },
      model_context_window: 64_000
    }
  })
  assert.equal(changed, true)
  assert.deepEqual(map.get('session-1'), {
    kind: 'v1',
    lastTotalTokens: 7,
    totalTotalTokens: 21,
    modelContextWindow: 64000
  })

  assert.deepEqual(buildContextUsageSummary(map.get('session-1')), {
    usedTokens: 21,
    usedLabel: '21',
    lastTokens: 7,
    lastLabel: '7',
    modelContextWindow: 64000,
    windowLabel: '64k',
    percent: 0.0328125,
    percentLabel: '0% full',
    usageLabel: '21 / 64k tokens used'
  })
})

test('machine status and plan helpers derive labels consistently', () => {
  const now = 1_000_000
  assert.equal(machineIsOnline(now, { lastSeenMs: now - 10_000 }), true)
  assert.equal(machineStatusLabel(now, { lastSeenMs: now - 10_000 }), 'online')
  assert.match(machineStatusLabel(now, { lastSeenMs: now - (10 * 60 * 1000) }), /last seen/)
  assert.equal(machineRootgridVersion({ capabilities: { rootgridVersion: '1.2.3' } }), '1.2.3')
  assert.equal(machineHasVersionMismatch({ capabilities: { rootgridVersion: '1.2.3' } }, '1.2.4'), true)
  assert.equal(machineSupportsWebUpgrade({ capabilities: { upgrade: { enabled: true } } }), true)
  assert.equal(machineUpgradeStatusText({ upgrade: { state: 'failed', message: 'boom' } }), 'Upgrade failed: boom')
  assert.equal(planStepIsCompleted({ status: 'Completed' }), true)
  assert.equal(planStepIsCompleted({ status: 'in_progress' }), false)
  assert.deepEqual(finalizeCompletedPlan([
    { step: 'a', status: 'completed' },
    { step: 'b', status: 'inProgress' }
  ], 'completed'), [
    { step: 'a', status: 'completed' },
    { step: 'b', status: 'completed' }
  ])
  const pendingPlan = [
    { step: 'a', status: 'completed' },
    { step: 'b', status: 'pending' }
  ]
  assert.strictEqual(finalizeCompletedPlan(pendingPlan, 'completed'), pendingPlan)
  assert.strictEqual(finalizeCompletedPlan(pendingPlan, 'interrupted'), pendingPlan)
})
