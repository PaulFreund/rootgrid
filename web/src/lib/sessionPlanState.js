export function reduceSessionPlanState(state, event) {
  const current = {
    plan: Array.isArray(state?.plan) ? state.plan : null,
    planExplanation: state?.planExplanation ?? null
  }
  const type = String(event?.type ?? '').trim()

  if (type === 'turn.started' || type === 'turn.completed') {
    return {
      plan: null,
      planExplanation: null
    }
  }

  if (type === 'plan.updated') {
    return {
      plan: Array.isArray(event?.payload?.plan) ? event.payload.plan : null,
      planExplanation: event?.payload?.explanation ?? null
    }
  }

  return current
}

export function applySessionPlanState(store, event) {
  const next = reduceSessionPlanState(store, event)
  store.plan = next.plan
  store.planExplanation = next.planExplanation
}
