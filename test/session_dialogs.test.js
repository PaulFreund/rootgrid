import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'

import {
  approvalAllowsDecision,
  buildApprovalExtraActions,
  collectUserInputAnswers,
  createSessionDialogActions,
  resetUserInputFormState
} from '../web/src/lib/sessionDialogs.js'

test('approval dialog helpers expose allowed actions and collect user input answers', () => {
  assert.equal(approvalAllowsDecision({
    availableDecisions: [
      'accept',
      { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.com' } } }
    ]
  }, 'accept'), true)
  assert.equal(approvalAllowsDecision({
    availableDecisions: ['accept']
  }, 'decline'), false)

  assert.deepEqual(buildApprovalExtraActions({
    kind: 'command',
    availableDecisions: [
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cmd'] } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'api.example.test' } } }
    ]
  }).map((action) => ({ id: action.id, label: action.label, variant: action.variant })), [
    {
      id: 'acceptWithExecpolicyAmendment',
      label: 'Accept + remember',
      variant: 'emerald-solid'
    },
    {
      id: 'applyNetworkPolicyAmendment:deny:api.example.test',
      label: 'Always deny api.example.test',
      variant: 'red-outline'
    }
  ])

  assert.deepEqual(collectUserInputAnswers({
    kind: 'userInput',
    questions: [
      { id: 'color', header: 'Color', options: [{ label: 'Blue' }, { label: 'Green' }] },
      { id: 'notes', header: 'Notes' }
    ]
  }, {
    color: { choice: 'Blue', other: '', text: '' },
    notes: { choice: '', other: '', text: 'Ship it' }
  }), {
    ok: true,
    answers: {
      color: { answers: ['Blue'] },
      notes: { answers: ['Ship it'] }
    }
  })
})

test('resetUserInputFormState seeds first options for userInput approvals', () => {
  const userInputForm = reactive({
    stale: { choice: 'x', other: '', text: '' }
  })
  const userInputError = ref('bad')
  const userInputSubmitting = ref(true)

  resetUserInputFormState({
    approval: {
      kind: 'userInput',
      questions: [
        { id: 'q1', options: [{ label: 'One' }, { label: 'Two' }] },
        { id: 'q2', options: [] }
      ]
    },
    userInputForm,
    userInputError,
    userInputSubmitting
  })

  assert.equal(userInputError.value, '')
  assert.equal(userInputSubmitting.value, false)
  assert.deepEqual(JSON.parse(JSON.stringify(userInputForm)), {
    q1: { choice: 'One', other: '', text: '' },
    q2: { choice: '', other: '', text: '' }
  })
})

test('createSessionDialogActions opens and saves rename + session policy dialogs', async () => {
  const requests = []
  const selectedSession = ref({
    sessionId: 'session-1',
    title: '',
    projectLabel: '',
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write'
  })
  const renameOpen = ref(false)
  const renameSessionId = ref(null)
  const renameTitleValue = ref('')
  const renameProjectValue = ref('')
  const renameFocus = ref('title')
  const renameError = ref('')
  const sessionPolicyOpen = ref(false)
  const sessionPolicySaving = ref(false)
  const sessionPolicyError = ref('')
  const sessionApprovalDraft = ref('')
  const sessionSandboxDraft = ref('')

  const actions = createSessionDialogActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/sessions/session-1') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              session: {
                sessionId: 'session-1',
                title: 'Renamed',
                projectLabel: 'Project Mercury'
              }
            }
          }
        }
      }
      if (path === '/api/sessions/session-1/options') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              session: {
                sessionId: 'session-1',
                approvalPolicy: 'never',
                sandbox: 'danger-full-access'
              }
            }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    defaults: reactive({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    selectedSession,
    selectedSessionId: ref('session-1'),
    upsertSessionRow: (session) => {
      selectedSession.value = { ...selectedSession.value, ...session }
    },
    sessionListTitle: () => 'New thread',
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
    approvalQueue: ref([]),
    approvalResponding: ref(false),
    approvalRespondError: ref(''),
    userInputSubmitting: ref(false),
    userInputError: ref(''),
    userInputForm: reactive({})
  })

  actions.openRenameSession(selectedSession.value, { focus: 'project' })
  assert.equal(renameOpen.value, true)
  assert.equal(renameSessionId.value, 'session-1')
  assert.equal(renameTitleValue.value, '')
  assert.equal(renameFocus.value, 'project')
  renameTitleValue.value = '  Renamed  '
  renameProjectValue.value = '  Project Mercury  '
  assert.equal(actions.pendingApproval.value, null)
  assert.equal(await actions.saveRenameSession(), true)
  assert.equal(renameOpen.value, false)
  assert.equal(renameError.value, '')
  assert.equal(selectedSession.value.title, 'Renamed')
  assert.equal(selectedSession.value.projectLabel, 'Project Mercury')

  actions.openSessionPolicy()
  assert.equal(sessionPolicyOpen.value, true)
  assert.equal(sessionApprovalDraft.value, 'untrusted')
  assert.equal(sessionSandboxDraft.value, 'workspace-write')
  sessionApprovalDraft.value = 'never'
  sessionSandboxDraft.value = 'danger-full-access'
  assert.equal(await actions.saveSessionPolicy(), true)
  assert.equal(sessionPolicyOpen.value, false)
  assert.equal(sessionPolicySaving.value, false)
  assert.equal(selectedSession.value.approvalPolicy, 'never')
  assert.equal(selectedSession.value.sandbox, 'danger-full-access')

  assert.deepEqual(requests.map((req) => req.path), [
    '/api/sessions/session-1',
    '/api/sessions/session-1/options'
  ])
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    title: 'Renamed',
    projectLabel: 'Project Mercury'
  })
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    options: {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    }
  })
})
