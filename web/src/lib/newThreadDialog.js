export function buildSessionDraftOptions(defaults) {
  return {
    ...(String(defaults?.model ?? '').trim() ? { model: String(defaults.model).trim() } : {}),
    ...(String(defaults?.reasoningEffort ?? '').trim() ? { reasoningEffort: String(defaults.reasoningEffort).trim() } : {}),
    approvalPolicy: defaults?.approvalPolicy,
    sandbox: defaults?.sandbox
  }
}

export function chooseInitialNewThreadMachine({
  preferredMachineId,
  machines,
  machinesForSelect,
  machineIsOnline
}) {
  const preferred = String(preferredMachineId ?? '').trim()
  const preferredRow = preferred ? ((Array.isArray(machines) ? machines : []).find((m) => m?.machineId === preferred) ?? null) : null
  const preferredOnline = preferredRow ? machineIsOnline(preferredRow) : false
  if (preferredOnline) return preferred
  return (Array.isArray(machinesForSelect) ? machinesForSelect : [])[0]?.machineId ?? ''
}

export function validateNewThreadSelection({ machineId, machineOnline, cwd = null }) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return 'Machine is required.'
  if (!machineOnline) return 'Runner not connected for this machine. Choose an online machine.'
  if (cwd !== null && !String(cwd ?? '').trim()) return 'Workspace is required.'
  return ''
}

export function createNewThreadDialogActions({
  apiFetch,
  defaults,
  machines,
  machinesForSelect,
  machineIsOnline,
  newThreadMachineId,
  newThreadCwd,
  newThreadOpen,
  newThreadError,
  newThreadCreating,
  newThreadBrowseOpen,
  newThreadBrowsePath,
  newThreadBrowseParent,
  newThreadBrowseEntries,
  newThreadBrowseLoading,
  newThreadBrowseError,
  newThreadSelectedMachineOnline,
  upsertSessionRow,
  clearComposerAttachments,
  selectedSessionId
}) {
  async function loadNewThreadBrowse(path) {
    newThreadBrowseLoading.value = true
    newThreadBrowseError.value = ''
    try {
      const machineId = String(newThreadMachineId.value ?? '').trim()
      const machineErr = validateNewThreadSelection({
        machineId,
        machineOnline: Boolean(newThreadSelectedMachineOnline.value)
      })
      if (machineErr) throw new Error(machineErr === 'Machine is required.' ? 'Select a machine first.' : 'runner not connected')

      const res = await apiFetch(`/api/fs/list?machineId=${encodeURIComponent(machineId)}&path=${encodeURIComponent(String(path ?? ''))}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

      newThreadBrowsePath.value = String(data?.path ?? '')
      newThreadBrowseParent.value = (data?.parent === null || data?.parent === undefined) ? null : String(data.parent)
      newThreadBrowseEntries.value = Array.isArray(data?.entries) ? data.entries : []
    } catch (err) {
      newThreadBrowseError.value = String(err?.message ?? err)
    } finally {
      newThreadBrowseLoading.value = false
    }
  }

  function openNewThreadDialog() {
    newThreadError.value = ''
    newThreadBrowseError.value = ''
    newThreadBrowseOpen.value = false
    newThreadBrowsePath.value = ''
    newThreadBrowseParent.value = null
    newThreadBrowseEntries.value = []

    newThreadMachineId.value = chooseInitialNewThreadMachine({
      preferredMachineId: defaults.machineId,
      machines: machines.value,
      machinesForSelect: machinesForSelect.value,
      machineIsOnline
    })

    newThreadCwd.value = String(defaults.cwd ?? '')
    newThreadOpen.value = true
  }

  function closeNewThreadDialog() {
    newThreadOpen.value = false
    newThreadError.value = ''
    newThreadBrowseOpen.value = false
    newThreadBrowseError.value = ''
  }

  function openNewThreadBrowse() {
    const err = validateNewThreadSelection({
      machineId: newThreadMachineId.value,
      machineOnline: Boolean(newThreadSelectedMachineOnline.value)
    })
    if (err) {
      newThreadError.value = err
      return
    }
    newThreadBrowseOpen.value = true
    loadNewThreadBrowse(newThreadCwd.value || '').catch(() => {})
  }

  function selectNewThreadBrowseFolder() {
    if (!newThreadBrowsePath.value) return
    newThreadCwd.value = newThreadBrowsePath.value
    newThreadBrowseOpen.value = false
  }

  async function confirmNewThreadDialog() {
    if (newThreadCreating.value) return
    newThreadError.value = ''
    const machineId = String(newThreadMachineId.value ?? '').trim()
    const cwd = String(newThreadCwd.value ?? '').trim()

    const err = validateNewThreadSelection({
      machineId,
      machineOnline: Boolean(newThreadSelectedMachineOnline.value),
      cwd
    })
    if (err) {
      newThreadError.value = err
      return
    }

    defaults.machineId = machineId
    defaults.cwd = cwd

    const options = buildSessionDraftOptions(defaults)

    newThreadCreating.value = true
    try {
      const res = await apiFetch('/api/sessions/draft', {
        method: 'POST',
        body: JSON.stringify({ cwd, machineId, options })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)

      const session = data?.session ?? null
      if (session) upsertSessionRow(session)
      const sessionId = data?.sessionId ?? session?.sessionId ?? null
      if (!sessionId) throw new Error('missing sessionId')

      clearComposerAttachments()
      closeNewThreadDialog()
      selectedSessionId.value = sessionId
    } catch (err) {
      newThreadError.value = String(err?.message ?? err)
    } finally {
      newThreadCreating.value = false
    }
  }

  function onNewThreadMachineChanged() {
    if (!newThreadBrowseOpen.value) return
    loadNewThreadBrowse('').catch(() => {})
  }

  return {
    openNewThreadDialog,
    closeNewThreadDialog,
    loadNewThreadBrowse,
    openNewThreadBrowse,
    selectNewThreadBrowseFolder,
    confirmNewThreadDialog,
    onNewThreadMachineChanged
  }
}
