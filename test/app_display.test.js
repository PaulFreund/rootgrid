import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildContextUsageSummary,
  buildRateLimitSummary,
  buildRecentWorkspaces,
  countMachineWorkingSessions,
  finalizeCompletedPlan,
  formatAgeShort,
  formatAgo,
  formatCompactInt,
  machineHasVersionMismatch,
  machineHasUnknownVersion,
  machineIsOnline,
  machineLastSessionUsedMs,
  machineRootgridVersion,
  machineStatusLabel,
  machineSupportsToolAuth,
  machineSupportsToolManagement,
  machineSupportsWebUpgrade,
  machineUpgradeStatusText,
  normalizeTokenUsage,
  planStepIsCompleted,
  sortMachinesForSettings,
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

  const summary = buildContextUsageSummary(map.get('session-1'))
  assert.equal(summary?.usedTokens, 7)
  assert.equal(summary?.usedLabel, '7')
  assert.equal(summary?.totalTokens, 21)
  assert.equal(summary?.totalLabel, '21')
  assert.equal(summary?.lastTokens, 7)
  assert.equal(summary?.lastLabel, '7')
  assert.equal(summary?.modelContextWindow, 64000)
  assert.equal(summary?.windowLabel, '64k')
  assert.equal(summary?.percent, (7 / 64000) * 100)
  assert.equal(summary?.percentLabel, '0% full')
  assert.equal(summary?.usageLabel, '7 / 64k tokens used')

  const changedRateLimits = updateTokenUsageMap(map, 'session-1', {
    rateLimits: {
      limit_id: 'codex',
      plan_type: 'pro',
      primary: { used_percent: 8, window_minutes: 300, resets_at: 1_773_073_557 },
      secondary: { used_percent: 12, window_minutes: 10_080, resets_at: 1_773_557_792 }
    }
  })
  assert.equal(changedRateLimits, true)
  assert.deepEqual(map.get('session-1'), {
    kind: 'v1',
    lastTotalTokens: 7,
    totalTotalTokens: 21,
    modelContextWindow: 64000,
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: {
        usedPercent: 8,
        windowMinutes: 300,
        resetsAtMs: 1773073557000
      },
      secondary: {
        usedPercent: 12,
        windowMinutes: 10080,
        resetsAtMs: 1773557792000
      }
    }
  })

  const rateSummary = buildRateLimitSummary(map.get('session-1'), 1_773_070_000_000)
  assert.equal(rateSummary?.planType, 'pro')
  assert.deepEqual(rateSummary?.items.map((item) => ({
    label: item.label,
    remainingLabel: item.remainingLabel
  })), [
    { label: '5h', remainingLabel: '92%' },
    { label: 'Weekly', remainingLabel: '88%' }
  ])
  assert.equal(typeof rateSummary?.items?.[0]?.resetLabel, 'string')
  assert.equal(rateSummary?.items?.[0]?.resetLabel.length > 0, true)
})

test('machine status and plan helpers derive labels consistently', () => {
  const now = 1_000_000
  assert.equal(machineIsOnline(now, { lastSeenMs: now - 10_000 }), true)
  assert.equal(machineStatusLabel(now, { lastSeenMs: now - 10_000 }), 'online')
  assert.match(machineStatusLabel(now, { lastSeenMs: now - (10 * 60 * 1000) }), /last seen/)
  assert.equal(machineRootgridVersion({ capabilities: { rootgridVersion: '1.2.3' } }), '1.2.3')
  assert.equal(machineHasVersionMismatch({ capabilities: { rootgridVersion: '1.2.3' } }, '1.2.4'), true)
  assert.equal(machineHasUnknownVersion({ capabilities: null }, '1.2.4'), true)
  assert.equal(machineSupportsWebUpgrade({ capabilities: { upgrade: { enabled: true } } }), true)
  assert.equal(machineSupportsToolManagement({ capabilities: { tools: { enabled: true } } }), true)
  assert.equal(machineSupportsToolAuth({ capabilities: { tools: { enabled: true, auth: true } } }), true)
  assert.equal(machineSupportsToolAuth({ capabilities: { tools: { enabled: true, auth: false } } }), false)
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

test('countMachineWorkingSessions only counts running turns on the target machine', () => {
  assert.equal(countMachineWorkingSessions([
    { sessionId: 's-1', machineId: 'machine-1', turnState: 'running', status: 'running' },
    { sessionId: 's-2', machineId: 'machine-1', turnState: 'idle', status: 'starting' },
    { sessionId: 's-3', machineId: 'machine-1', turnState: 'idle', status: 'running' },
    { sessionId: 's-4', machineId: 'machine-2', turnState: 'running', status: 'running' }
  ], 'machine-1'), 2)
})

test('sortMachinesForSettings prefers recent session usage over heartbeat recency', () => {
  const machines = [
    { machineId: 'machine-old-use', lastSeenMs: 9_000, connected: true },
    { machineId: 'machine-new-use', lastSeenMs: 5_000, connected: true },
    { machineId: 'machine-no-session', lastSeenMs: 8_000, connected: true }
  ]
  const sessions = [
    { sessionId: 's-1', machineId: 'machine-old-use', updatedMs: 10, createdMs: 1 },
    { sessionId: 's-2', machineId: 'machine-new-use', updatedMs: 200, createdMs: 2 }
  ]

  assert.equal(machineLastSessionUsedMs(sessions, 'machine-new-use'), 200)
  assert.deepEqual(
    sortMachinesForSettings(machines, sessions, 10_000).map((machine) => machine.machineId),
    ['machine-new-use', 'machine-old-use', 'machine-no-session']
  )
})
