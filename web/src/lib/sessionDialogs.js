import { computed, watch } from 'vue'
import { removeApproval } from './approvalQueue.js'

export function approvalAllowsDecision(approval, decision) {
  const allowed = approval?.availableDecisions
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  return allowed.some((entry) => {
    if (typeof entry === 'string') return entry === decision
    if (entry && typeof entry === 'object') {
      if (decision === 'acceptWithExecpolicyAmendment') return 'acceptWithExecpolicyAmendment' in entry
      if (decision === 'applyNetworkPolicyAmendment') return 'applyNetworkPolicyAmendment' in entry
    }
    return false
  })
}

export function buildApprovalExtraActions(approval) {
  if (!approval || approval.kind !== 'command') return []

  const actions = []
  const allowed = Array.isArray(approval.availableDecisions) ? approval.availableDecisions : null
  if (allowed) {
    for (const decision of allowed) {
      if (!decision || typeof decision !== 'object') continue

      if ('acceptWithExecpolicyAmendment' in decision) {
        actions.push({
          id: 'acceptWithExecpolicyAmendment',
          label: 'Accept + remember',
          decision,
          variant: 'emerald-solid'
        })
      }

      if ('applyNetworkPolicyAmendment' in decision) {
        const amend = decision.applyNetworkPolicyAmendment?.network_policy_amendment ?? null
        const host = String(amend?.host ?? '').trim()
        const action = String(amend?.action ?? '').trim()
        const label = (host && action) ? `Always ${action} ${host}` : 'Apply network rule'
        actions.push({
          id: `applyNetworkPolicyAmendment:${action}:${host}`,
          label,
          decision,
          variant: (action === 'deny') ? 'red-outline' : 'emerald-outline'
        })
      }
    }
    return actions
  }

  if (Array.isArray(approval.proposedExecpolicyAmendment) && approval.proposedExecpolicyAmendment.length) {
    actions.push({
      id: 'acceptWithExecpolicyAmendment:fallback',
      label: 'Accept + remember',
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: approval.proposedExecpolicyAmendment }
      },
      variant: 'emerald-solid'
    })
  }

  if (Array.isArray(approval.proposedNetworkPolicyAmendments)) {
    for (const amend of approval.proposedNetworkPolicyAmendments) {
      const host = String(amend?.host ?? '').trim()
      const action = String(amend?.action ?? '').trim()
      if (!host || (action !== 'allow' && action !== 'deny')) continue
      actions.push({
        id: `applyNetworkPolicyAmendment:fallback:${action}:${host}`,
        label: `Always ${action} ${host}`,
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action, host }
          }
        },
        variant: (action === 'deny') ? 'red-outline' : 'emerald-outline'
      })
    }
  }

  return actions
}

export function resetUserInputFormState({
  approval,
  userInputForm,
  userInputError,
  userInputSubmitting
}) {
  userInputError.value = ''
  userInputSubmitting.value = false
  for (const key of Object.keys(userInputForm)) delete userInputForm[key]

  if (approval?.kind !== 'userInput') return
  const questions = Array.isArray(approval?.questions) ? approval.questions : []
  for (const question of questions) {
    const qid = String(question?.id ?? '')
    if (!qid) continue
    const opts = Array.isArray(question?.options) ? question.options : []
    const first = opts.length ? String(opts[0]?.label ?? '') : ''
    userInputForm[qid] = { choice: first, other: '', text: '' }
  }
}

export function collectUserInputAnswers(approval, userInputForm) {
  const questions = Array.isArray(approval?.questions) ? approval.questions : []
  const answers = {}

  for (const question of questions) {
    const qid = String(question?.id ?? '')
    if (!qid) continue
    const state = userInputForm[qid] ?? null
    const opts = Array.isArray(question?.options) ? question.options : []

    let value = ''
    if (opts.length) {
      const choice = String(state?.choice ?? '')
      value = (choice === '__other__') ? String(state?.other ?? '').trim() : choice
    } else {
      value = String(state?.text ?? '').trim()
    }

    if (!value) {
      return {
        ok: false,
        error: `Please answer: ${String(question?.header ?? qid)}`
      }
    }

    answers[qid] = { answers: [value] }
  }

  return { ok: true, answers }
}

export function createSessionDialogActions({
  apiFetch,
  defaults,
  selectedSession,
  selectedSessionId,
  upsertSessionRow,
  sessionListTitle,
  renameOpen,
  renameSessionId,
  renameTitleValue,
  renameProjectValue,
  renameFocus,
  renameError,
  sessionPolicyOpen,
  sessionPolicySaving,
  sessionPolicyError,
  sessionApprovalDraft,
  sessionSandboxDraft,
  approvalQueue,
  approvalIds = null,
  approvalResponding,
  approvalRespondError,
  userInputSubmitting,
  userInputError,
  userInputForm
}) {
  function openRenameSession(session, { focus = 'title' } = {}) {
    renameError.value = ''
    renameSessionId.value = session?.sessionId ?? null
    renameTitleValue.value = String(session?.title ?? sessionListTitle(session) ?? '')
    renameProjectValue.value = String(session?.projectLabel ?? '')
    renameFocus.value = focus
    renameOpen.value = true
  }

  async function saveRenameSession() {
    renameError.value = ''
    const sessionId = renameSessionId.value
    if (!sessionId) return false

    const title = String(renameTitleValue.value ?? '').trim()
    const projectLabel = String(renameProjectValue.value ?? '').trim()
    const res = await apiFetch(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: title || null,
        projectLabel: projectLabel || null
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      renameError.value = err?.error ?? `HTTP ${res.status}`
      return false
    }

    const data = await res.json().catch(() => null)
    if (data?.session) upsertSessionRow(data.session)
    renameOpen.value = false
    return true
  }

  function openSessionPolicy() {
    sessionPolicyError.value = ''
    const session = selectedSession.value
    if (!session) return
    sessionApprovalDraft.value = String(session.approvalPolicy ?? defaults.approvalPolicy ?? 'on-request')
    sessionSandboxDraft.value = String(session.sandbox ?? defaults.sandbox ?? 'workspace-write')
    sessionPolicyOpen.value = true
  }

  async function saveSessionPolicy() {
    sessionPolicyError.value = ''
    const sessionId = selectedSessionId.value
    if (!sessionId) return false
    if (sessionPolicySaving.value) return false

    sessionPolicySaving.value = true
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/options`, {
        method: 'PUT',
        body: JSON.stringify({
          options: {
            approvalPolicy: sessionApprovalDraft.value,
            sandbox: sessionSandboxDraft.value
          }
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        sessionPolicyError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }

      const data = await res.json().catch(() => null)
      if (data?.session) upsertSessionRow(data.session)
      sessionPolicyOpen.value = false
      return true
    } finally {
      sessionPolicySaving.value = false
    }
  }

  const pendingApproval = computed(() => approvalQueue.value[0] ?? null)

  function approvalAllows(decision) {
    return approvalAllowsDecision(pendingApproval.value, decision)
  }

  const approvalExtraActions = computed(() => buildApprovalExtraActions(pendingApproval.value))

  async function respondApproval(decision) {
    const approval = pendingApproval.value
    if (!approval || approvalResponding.value) return false
    approvalRespondError.value = ''
    approvalResponding.value = true
    try {
      const res = await apiFetch(`/api/approvals/${approval.approvalId}`, {
        method: 'POST',
        body: JSON.stringify({ decision })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        approvalRespondError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      removeApproval(approvalQueue.value, approval.approvalId, approvalIds)
      return true
    } finally {
      approvalResponding.value = false
    }
  }

  function resetUserInputForm(approval) {
    resetUserInputFormState({
      approval,
      userInputForm,
      userInputError,
      userInputSubmitting
    })
  }

  watch(pendingApproval, (approval) => {
    approvalRespondError.value = ''
    resetUserInputForm(approval)
  }, { immediate: true })

  async function submitUserInput() {
    const approval = pendingApproval.value
    if (!approval || approval.kind !== 'userInput' || userInputSubmitting.value) return false
    userInputError.value = ''
    userInputSubmitting.value = true
    try {
      const collected = collectUserInputAnswers(approval, userInputForm)
      if (!collected.ok) {
        userInputError.value = collected.error
        return false
      }

      const res = await apiFetch(`/api/approvals/${approval.approvalId}`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept', answers: collected.answers })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        userInputError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      removeApproval(approvalQueue.value, approval.approvalId, approvalIds)
      return true
    } finally {
      userInputSubmitting.value = false
    }
  }

  async function cancelUserInput() {
    const approval = pendingApproval.value
    if (!approval || approval.kind !== 'userInput' || userInputSubmitting.value) return false
    userInputError.value = ''
    userInputSubmitting.value = true
    try {
      const res = await apiFetch(`/api/approvals/${approval.approvalId}`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'cancel' })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        userInputError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      removeApproval(approvalQueue.value, approval.approvalId, approvalIds)
      return true
    } finally {
      userInputSubmitting.value = false
    }
  }

  return {
    openRenameSession,
    saveRenameSession,
    openSessionPolicy,
    saveSessionPolicy,
    pendingApproval,
    approvalAllows,
    approvalExtraActions,
    respondApproval,
    resetUserInputForm,
    submitUserInput,
    cancelUserInput
  }
}
