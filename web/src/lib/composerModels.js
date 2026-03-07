import { computed, ref, watch } from 'vue'

export const FALLBACK_REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' }
])

export function modelIdFor(model) {
  return String(model?.id ?? model?.model ?? '').trim()
}

export function modelLabel(model) {
  return String(model?.displayName ?? model?.display_name ?? modelIdFor(model)).trim() || modelIdFor(model)
}

export function buildRecentModels({
  selectedSession = null,
  defaults = {},
  sessions = [],
  limit = 20
} = {}) {
  const seen = new Set()
  const out = []
  const add = (value) => {
    const next = String(value ?? '').trim()
    if (!next || seen.has(next)) return
    seen.add(next)
    out.push(next)
  }

  add(selectedSession?.model)
  add(defaults?.model)
  for (const session of (Array.isArray(sessions) ? sessions : [])) add(session?.model)

  return out.slice(0, limit)
}

export function resolveComposerModelsMachineId({
  selectedSession = null,
  defaultsMachineId = '',
  machinesForSelect = [],
  machineIsOnline
} = {}) {
  const selectedMachineId = String(selectedSession?.machineId ?? '').trim()
  if (selectedMachineId) return selectedMachineId

  const defaultMachineId = String(defaultsMachineId ?? '').trim()
  if (defaultMachineId) return defaultMachineId

  const online = (Array.isArray(machinesForSelect) ? machinesForSelect : [])
    .find((machine) => machineIsOnline(machine))
  return online?.machineId ?? ''
}

export function composerModelsMachineIsOnline({
  machineId,
  machines = [],
  machineIsOnline
} = {}) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return false
  const row = (Array.isArray(machines) ? machines : []).find((machine) => machine?.machineId === mid) ?? null
  return row ? machineIsOnline(row) : false
}

export function labelReasoningEffort(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const norm = raw.toLowerCase().replace(/[\s_-]+/g, '')
  if (norm === 'none') return 'None'
  if (norm === 'minimal') return 'Minimal'
  if (norm === 'low') return 'Low'
  if (norm === 'medium') return 'Medium'
  if (norm === 'high') return 'High'
  if (norm === 'xhigh' || norm === 'extrahigh') return 'Extra High'
  return raw
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export function findDefaultCodexModel(list) {
  const models = Array.isArray(list) ? list : []
  return models.find((model) => Boolean(model?.isDefault ?? model?.is_default ?? model?.default)) ?? null
}

export function findSelectedCodexModel(list, currentModelId, defaultModel = null) {
  const models = Array.isArray(list) ? list : []
  if (!models.length) return null
  const id = String(currentModelId ?? '').trim()
  if (id) return models.find((model) => modelIdFor(model) === id) ?? null
  return defaultModel ?? findDefaultCodexModel(models)
}

export function modelDefaultReasoningEffort(model) {
  const raw = model?.defaultReasoningEffort ?? model?.default_reasoning_effort ?? null
  const next = String(raw ?? '').trim()
  return next || null
}

function extractReasoningEffortValue(entry) {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.effort === 'string') return entry.effort
  if (entry.effort && typeof entry.effort === 'object') {
    return entry.effort.value ?? entry.effort.id ?? entry.effort.name ?? null
  }
  if (typeof entry.value === 'string') return entry.value
  if (typeof entry.id === 'string') return entry.id
  if (typeof entry.name === 'string') return entry.name
  if (typeof entry.key === 'string') return entry.key
  if (typeof entry.level === 'string') return entry.level
  if (typeof entry.reasoningEffort === 'string') return entry.reasoningEffort
  if (typeof entry.reasoning_effort === 'string') return entry.reasoning_effort
  return null
}

function getReasoningEffortEntries(model) {
  if (Array.isArray(model?.reasoningEffort)) return model.reasoningEffort
  if (Array.isArray(model?.reasoning_effort)) return model.reasoning_effort
  if (Array.isArray(model?.supportedReasoningEfforts)) return model.supportedReasoningEfforts
  if (Array.isArray(model?.supported_reasoning_efforts)) return model.supported_reasoning_efforts
  return null
}

export function buildComposerModelOptions({
  modelCatalog = [],
  recentModels = [],
  currentModel = '',
  defaultModel = null
} = {}) {
  const list = Array.isArray(modelCatalog) ? modelCatalog : []
  const out = []
  const seen = new Set()
  const defaultId = modelIdFor(defaultModel)

  if (list.length) {
    for (const model of list) {
      if (!model || typeof model !== 'object') continue
      const id = modelIdFor(model)
      if (!id || seen.has(id)) continue
      if (defaultId && id === defaultId) continue
      seen.add(id)
      out.push({ value: id, label: modelLabel(model) })
    }
  } else {
    for (const id of (Array.isArray(recentModels) ? recentModels : [])) {
      const next = String(id ?? '').trim()
      if (!next || seen.has(next)) continue
      seen.add(next)
      out.push({ value: next, label: next })
    }
  }

  const current = String(currentModel ?? '').trim()
  if (current && !seen.has(current) && current !== defaultId) {
    out.unshift({ value: current, label: current })
  }

  return out
}

export function buildComposerReasoningEffortOptions({
  selectedModel = null,
  currentReasoningEffort = ''
} = {}) {
  const list = getReasoningEffortEntries(selectedModel)
  if (list && list.length) {
    const out = []
    const seen = new Set()

    for (const entry of list) {
      const effort = String(extractReasoningEffortValue(entry) ?? '').trim()
      if (!effort) continue
      if (effort.toLowerCase() === 'auto') continue
      if (seen.has(effort)) continue
      seen.add(effort)

      const label = (entry && typeof entry === 'object')
        ? String(entry.label ?? entry.displayName ?? entry.display_name ?? '').trim()
        : ''
      const description = (entry && typeof entry === 'object')
        ? String(entry.description ?? '').trim()
        : ''

      out.push({
        value: effort,
        label: label || labelReasoningEffort(effort) || effort,
        description: description || null
      })
    }

    const current = String(currentReasoningEffort ?? '').trim()
    if (current && !seen.has(current)) {
      out.unshift({
        value: current,
        label: labelReasoningEffort(current) || current,
        description: null
      })
    }
    return out
  }

  return FALLBACK_REASONING_EFFORT_OPTIONS.map((option) => ({ ...option }))
}

export function createComposerModelSettings({
  apiFetch,
  authed,
  defaults,
  machines,
  machinesForSelect,
  machineIsOnline,
  selectedSession,
  selectedSessionId,
  sessions,
  upsertSessionRow
}) {
  const modelCatalog = ref([])
  const modelCatalogMachineId = ref('')
  const modelCatalogUpdatedMs = ref(0)
  const modelCatalogLoading = ref(false)
  const modelCatalogError = ref('')
  const composerOptionsError = ref('')

  const recentModels = computed(() => buildRecentModels({
    selectedSession: selectedSession.value,
    defaults,
    sessions: sessions.value
  }))

  const composerModelsMachineId = computed(() => resolveComposerModelsMachineId({
    selectedSession: selectedSession.value,
    defaultsMachineId: defaults.machineId,
    machinesForSelect: machinesForSelect.value,
    machineIsOnline
  }))

  const composerModelsMachineOnline = computed(() => composerModelsMachineIsOnline({
    machineId: composerModelsMachineId.value,
    machines: machines.value,
    machineIsOnline
  }))

  const composerModelValue = computed(() => {
    return String((selectedSession.value ? selectedSession.value.model : defaults.model) ?? '')
  })

  const composerReasoningEffortValue = computed(() => {
    return String((selectedSession.value ? selectedSession.value.reasoningEffort : defaults.reasoningEffort) ?? '')
  })

  async function loadModelCatalog({ force = false } = {}) {
    modelCatalogError.value = ''
    const machineId = String(composerModelsMachineId.value ?? '').trim()
    if (!machineId) return
    if (!composerModelsMachineOnline.value) return

    const now = Date.now()
    if (
      !force &&
      modelCatalogMachineId.value === machineId &&
      modelCatalog.value.length &&
      (now - modelCatalogUpdatedMs.value) < 60_000
    ) {
      return
    }
    if (modelCatalogLoading.value) return

    modelCatalogLoading.value = true
    try {
      const cwd = selectedSession.value?.cwd ?? defaults.cwd ?? ''
      const res = await apiFetch(
        `/api/models?machineId=${encodeURIComponent(machineId)}&cwd=${encodeURIComponent(String(cwd ?? ''))}`
      )
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

      modelCatalog.value = Array.isArray(data?.models) ? data.models : []
      modelCatalogMachineId.value = machineId
      modelCatalogUpdatedMs.value = now
    } catch (err) {
      modelCatalogError.value = String(err?.message ?? err)
    } finally {
      modelCatalogLoading.value = false
    }
  }

  watch(
    [() => authed.value, () => composerModelsMachineId.value, () => composerModelsMachineOnline.value],
    ([isAuthed, machineId, online], prev = []) => {
      const [wasAuthed, prevMachineId, prevOnline] = prev
      if (!isAuthed) return
      if (!machineId || !online) return
      const changed = !wasAuthed || machineId !== prevMachineId || (online && !prevOnline)
      if (changed) loadModelCatalog().catch(() => {})
    },
    { immediate: true }
  )

  const defaultCodexModel = computed(() => findDefaultCodexModel(modelCatalog.value))

  const defaultCodexModelLabel = computed(() => {
    const label = modelLabel(defaultCodexModel.value)
    return label || 'Model'
  })

  const selectedCodexModel = computed(() => findSelectedCodexModel(
    modelCatalog.value,
    composerModelValue.value,
    defaultCodexModel.value
  ))

  const selectedCodexDefaultReasoningEffort = computed(() => {
    return modelDefaultReasoningEffort(selectedCodexModel.value)
  })

  const selectedCodexDefaultReasoningEffortLabel = computed(() => {
    return labelReasoningEffort(selectedCodexDefaultReasoningEffort.value)
  })

  const composerModelOptions = computed(() => buildComposerModelOptions({
    modelCatalog: modelCatalog.value,
    recentModels: recentModels.value,
    currentModel: composerModelValue.value,
    defaultModel: defaultCodexModel.value
  }))

  const composerReasoningEffortOptions = computed(() => buildComposerReasoningEffortOptions({
    selectedModel: selectedCodexModel.value,
    currentReasoningEffort: composerReasoningEffortValue.value
  }))

  async function patchSelectedSessionOptions(patch) {
    composerOptionsError.value = ''
    const sessionId = selectedSessionId.value
    if (!sessionId) return false

    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/options`, {
        method: 'PUT',
        body: JSON.stringify({ options: patch })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        composerOptionsError.value = err?.error ?? `HTTP ${res.status}`
        return false
      }
      const data = await res.json().catch(() => null)
      if (data?.session) upsertSessionRow(data.session)
      return true
    } catch (err) {
      composerOptionsError.value = String(err?.message ?? err)
      return false
    }
  }

  const composerModel = computed({
    get() {
      return composerModelValue.value
    },
    set(value) {
      const next = String(value ?? '').trim()
      const current = String(composerModelValue.value ?? '').trim()
      if (next === current) return
      if (selectedSession.value) patchSelectedSessionOptions({ model: next || null })
      else defaults.model = next
    }
  })

  const composerReasoningEffort = computed({
    get() {
      return composerReasoningEffortValue.value
    },
    set(value) {
      const next = String(value ?? '').trim()
      const current = String(composerReasoningEffortValue.value ?? '').trim()
      if (next === current) return
      if (selectedSession.value) patchSelectedSessionOptions({ reasoningEffort: next || null })
      else defaults.reasoningEffort = next
    }
  })

  const composerApprovalPolicy = computed({
    get() {
      const value = selectedSession.value ? selectedSession.value.approvalPolicy : defaults.approvalPolicy
      return String(value ?? defaults.approvalPolicy ?? 'on-request')
    },
    set(value) {
      const next = String(value ?? '').trim()
      if (!next) return
      const current = String(
        (selectedSession.value ? selectedSession.value.approvalPolicy : defaults.approvalPolicy) ?? ''
      ).trim()
      if (next === current) return
      if (selectedSession.value) patchSelectedSessionOptions({ approvalPolicy: next })
      else defaults.approvalPolicy = next
    }
  })

  const composerSandbox = computed({
    get() {
      const value = selectedSession.value ? selectedSession.value.sandbox : defaults.sandbox
      return String(value ?? defaults.sandbox ?? 'workspace-write')
    },
    set(value) {
      const next = String(value ?? '').trim()
      if (!next) return
      const current = String((selectedSession.value ? selectedSession.value.sandbox : defaults.sandbox) ?? '').trim()
      if (next === current) return
      if (selectedSession.value) patchSelectedSessionOptions({ sandbox: next })
      else defaults.sandbox = next
    }
  })

  return {
    modelCatalog,
    modelCatalogLoading,
    modelCatalogError,
    composerOptionsError,
    defaultCodexModel,
    defaultCodexModelLabel,
    selectedCodexModel,
    selectedCodexDefaultReasoningEffort,
    selectedCodexDefaultReasoningEffortLabel,
    composerModelOptions,
    composerReasoningEffortOptions,
    composerModel,
    composerReasoningEffort,
    composerApprovalPolicy,
    composerSandbox,
    loadModelCatalog,
    patchSelectedSessionOptions
  }
}
