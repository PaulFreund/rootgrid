import test from 'node:test'
import assert from 'node:assert/strict'

import {
  reduceSessionPlanState
} from '../web/src/lib/sessionPlanState.js'

test('reduceSessionPlanState only keeps task lists for the active turn', () => {
  const initial = {
    plan: [{ step: 'old task', status: 'pending' }],
    planExplanation: 'old plan'
  }

  assert.deepEqual(
    reduceSessionPlanState(initial, { type: 'turn.started', payload: { turnId: 'turn-1' } }),
    { plan: null, planExplanation: null }
  )

  const runningPlan = reduceSessionPlanState(initial, {
    type: 'plan.updated',
    payload: {
      explanation: 'work in progress',
      plan: [{ step: 'new task', status: 'pending' }]
    }
  })
  assert.deepEqual(runningPlan, {
    plan: [{ step: 'new task', status: 'pending' }],
    planExplanation: 'work in progress'
  })

  assert.deepEqual(
    reduceSessionPlanState(runningPlan, { type: 'turn.completed', payload: { status: 'completed' } }),
    { plan: null, planExplanation: null }
  )
})

test('reduceSessionPlanState leaves unrelated events alone', () => {
  const state = {
    plan: [{ step: 'keep me', status: 'pending' }],
    planExplanation: 'still active'
  }

  assert.deepEqual(
    reduceSessionPlanState(state, { type: 'session.output', payload: { text: 'hello' } }),
    state
  )
})
