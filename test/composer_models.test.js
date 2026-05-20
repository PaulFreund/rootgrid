import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'

import {
  buildComposerModelOptions,
  buildComposerReasoningEffortOptions,
  buildRecentModels,
  composerModelsMachineIsOnline,
  createComposerModelSettings,
  labelReasoningEffort,
  normalizeServiceTier,
  resolveComposerModelFallbackLabel,
  resolveComposerModelsMachineId
} from '../web/src/lib/composerModels.js'

test('buildRecentModels prefers current session and defaults before older sessions', () => {
  const out = buildRecentModels({
    selectedSession: { model: 'gpt-5' },
    defaults: { model: 'o4-mini' },
    sessions: [
      { model: 'gpt-5' },
      { model: 'gpt-4.1' },
      { model: 'o4-mini' },
      { model: 'gpt-5-codex' }
    ]
  })

  assert.deepEqual(out, ['gpt-5', 'o4-mini', 'gpt-4.1', 'gpt-5-codex'])
})

test('resolveComposerModelsMachineId falls back from selected session to defaults to online machine', () => {
  const machineIsOnline = (machine) => Boolean(machine?.online)

  assert.equal(resolveComposerModelsMachineId({
    selectedSession: { machineId: 'session-machine' },
    defaultsMachineId: 'default-machine',
    machinesForSelect: [{ machineId: 'online-machine', online: true }],
    machineIsOnline
  }), 'session-machine')

  assert.equal(resolveComposerModelsMachineId({
    selectedSession: null,
    defaultsMachineId: 'default-machine',
    machinesForSelect: [{ machineId: 'online-machine', online: true }],
    machineIsOnline
  }), 'default-machine')

  assert.equal(resolveComposerModelsMachineId({
    selectedSession: null,
    defaultsMachineId: '',
    machinesForSelect: [
      { machineId: 'offline-machine', online: false },
      { machineId: 'online-machine', online: true }
    ],
    machineIsOnline
  }), 'online-machine')
})

test('composerModelsMachineIsOnline checks the selected machine against registry rows', () => {
  const machineIsOnline = (machine) => Boolean(machine?.connected)

  assert.equal(composerModelsMachineIsOnline({
    machineId: 'machine-1',
    machines: [{ machineId: 'machine-1', connected: true }],
    machineIsOnline
  }), true)

  assert.equal(composerModelsMachineIsOnline({
    machineId: 'machine-2',
    machines: [{ machineId: 'machine-1', connected: true }],
    machineIsOnline
  }), false)
})

test('buildComposerModelOptions excludes the default catalog entry and keeps a missing current model visible', () => {
  const out = buildComposerModelOptions({
    modelCatalog: [
      { id: 'gpt-5', displayName: 'GPT-5', isDefault: true },
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
      { model: 'o4-mini', display_name: 'o4-mini' }
    ],
    currentModel: 'custom-model',
    defaultModel: { id: 'gpt-5', isDefault: true }
  })

  assert.deepEqual(out, [
    { value: 'custom-model', label: 'custom-model' },
    { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { value: 'o4-mini', label: 'o4-mini' }
  ])
})

test('buildComposerReasoningEffortOptions normalizes supported effort entries and preserves current custom effort', () => {
  const out = buildComposerReasoningEffortOptions({
    selectedModel: {
      supportedReasoningEfforts: [
        { value: 'low', description: 'Fastest' },
        { effort: { id: 'medium' }, displayName: 'Balanced' },
        'auto',
        { reasoning_effort: 'high' }
      ]
    },
    currentReasoningEffort: 'custom'
  })

  assert.deepEqual(out, [
    { value: 'custom', label: 'Custom', description: null },
    { value: 'low', label: 'Low', description: 'Fastest' },
    { value: 'medium', label: 'Balanced', description: null },
    { value: 'high', label: 'High', description: null }
  ])
  assert.equal(labelReasoningEffort('extra_high'), 'Extra High')
})

test('normalizeServiceTier canonicalizes supported tiers', () => {
  assert.equal(normalizeServiceTier(' Fast '), 'fast')
  assert.equal(normalizeServiceTier(' Flex '), 'flex')
  assert.equal(normalizeServiceTier('priority'), 'priority')
  assert.equal(normalizeServiceTier(null), '')
})

test('resolveComposerModelFallbackLabel uses the default model label for explicit default ids', () => {
  assert.equal(resolveComposerModelFallbackLabel({
    currentModel: 'gpt-5-codex',
    defaultModel: { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
    defaultLabel: 'GPT-5 Codex'
  }), 'GPT-5 Codex')

  assert.equal(resolveComposerModelFallbackLabel({
    currentModel: 'custom-model',
    defaultModel: { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
    defaultLabel: 'GPT-5 Codex'
  }), '')
})

test('composer option changes in a selected session also update remembered defaults for new sessions', async () => {
  const defaults = reactive({
    machineId: 'machine-1',
    cwd: '/workspace',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    serviceTier: '',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
  const selectedSession = ref({
    sessionId: 'session-1',
    machineId: 'machine-1',
    cwd: '/workspace',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    serviceTier: '',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
  const patchedBodies = []

  const settings = createComposerModelSettings({
    apiFetch: async (_path, init = {}) => {
      patchedBodies.push(JSON.parse(String(init.body ?? '{}')))
      return {
        ok: true,
        async json() {
          return {
            session: {
              ...selectedSession.value,
              ...(patchedBodies.at(-1)?.options ?? {})
            }
          }
        }
      }
    },
    authed: ref(false),
    defaults,
    machines: ref([{ machineId: 'machine-1', connected: true }]),
    machinesForSelect: ref([{ machineId: 'machine-1', connected: true }]),
    machineIsOnline: (machine) => Boolean(machine?.connected),
    selectedSession,
    selectedSessionId: ref('session-1'),
    sessions: ref([]),
    upsertSessionRow: () => {}
  })

  settings.composerModel.value = 'gpt-5.4'
  settings.composerReasoningEffort.value = 'xhigh'
  settings.composerFastMode.value = true
  settings.composerApprovalPolicy.value = 'never'
  settings.composerSandbox.value = 'danger-full-access'

  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(defaults.model, 'gpt-5.4')
  assert.equal(defaults.reasoningEffort, 'xhigh')
  assert.equal(defaults.serviceTier, 'fast')
  assert.equal(defaults.approvalPolicy, 'never')
  assert.equal(defaults.sandbox, 'danger-full-access')
  assert.deepEqual(patchedBodies.map((entry) => entry.options), [
    { model: 'gpt-5.4' },
    { reasoningEffort: 'xhigh' },
    { serviceTier: 'fast' },
    { approvalPolicy: 'never' },
    { sandbox: 'danger-full-access' }
  ])
})

test('composer fast mode toggles the Codex service tier on and off', async () => {
  const defaults = reactive({
    machineId: 'machine-1',
    cwd: '/workspace',
    model: 'gpt-5-codex',
    reasoningEffort: '',
    serviceTier: '',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
  const selectedSession = ref({
    sessionId: 'session-1',
    machineId: 'machine-1',
    cwd: '/workspace',
    model: 'gpt-5-codex',
    reasoningEffort: '',
    serviceTier: null,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
  const patchedBodies = []

  const settings = createComposerModelSettings({
    apiFetch: async (_path, init = {}) => {
      patchedBodies.push(JSON.parse(String(init.body ?? '{}')))
      const options = patchedBodies.at(-1)?.options ?? {}
      selectedSession.value = {
        ...selectedSession.value,
        ...options
      }
      return {
        ok: true,
        async json() {
          return { session: selectedSession.value }
        }
      }
    },
    authed: ref(false),
    defaults,
    machines: ref([{ machineId: 'machine-1', connected: true }]),
    machinesForSelect: ref([{ machineId: 'machine-1', connected: true }]),
    machineIsOnline: (machine) => Boolean(machine?.connected),
    selectedSession,
    selectedSessionId: ref('session-1'),
    sessions: ref([]),
    upsertSessionRow: () => {}
  })

  settings.composerFastMode.value = true
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(defaults.serviceTier, 'fast')
  assert.equal(settings.composerFastMode.value, true)

  settings.composerFastMode.value = false
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(defaults.serviceTier, '')
  assert.equal(settings.composerFastMode.value, false)
  assert.deepEqual(patchedBodies.map((entry) => entry.options), [
    { serviceTier: 'fast' },
    { serviceTier: null }
  ])
})
