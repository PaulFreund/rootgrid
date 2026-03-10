<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Archive, ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, ChevronDown, ChevronUp, Circle, Code, Copy, FileText, FolderClosed, GitBranch, Loader2, Menu, MoreHorizontal, Pencil, Plus, Settings, Sidebar, Square, Terminal, Trash2, X } from 'lucide-vue-next'

import MarkdownView from './components/MarkdownView.vue'
import ComposerPillSelect from './components/ComposerPillSelect.vue'
import WorkspaceFolderTreeNode from './components/WorkspaceFolderTreeNode.vue'
import WorkspaceFilesPane from './components/WorkspaceFilesPane.vue'
import WorkspaceGitPane from './components/WorkspaceGitPane.vue'
import WorkspaceTerminalPane from './components/WorkspaceTerminalPane.vue'
import {
  DEFAULT_WORKSPACE_CHAT_WIDTH,
  clampWorkspaceChatWidth,
  persistWorkspaceChatWidth,
  readStoredWorkspaceChatWidth
} from './lib/workspacePaneResize.js'
import {
  buildContextUsageSummary,
  buildRecentWorkspaces,
  countMachineWorkingSessions as countMachineWorkingSessionsAt,
  formatAgeShort as formatAgeShortValue,
  formatCompactInt,
  finalizeCompletedPlan,
  indicatorDotClass,
  machineDisplayName as machineDisplayNameAt,
  machineIsOnline as machineIsOnlineAt,
  machineHasUnknownVersion as machineHasUnknownVersionAt,
  machineHasVersionMismatch as machineHasVersionMismatchAt,
  machineRootgridVersion as machineRootgridVersionAt,
  machineShowLastSeen as machineShowLastSeenAt,
  machineStatusLabel as machineStatusLabelAt,
  machineSupportsWebUpgrade as machineSupportsWebUpgradeAt,
  machineUpgradeStatusText as machineUpgradeStatusTextAt,
  planStepIsCompleted,
  statusChipClass,
  toastBorderClass,
  updateTokenUsageMap
} from './lib/appDisplay.js'
import {
  copyTextToClipboard,
  dismissToastById,
  replaceUrlSessionParam,
  scheduleToastDismiss,
  showBrowserNotification
} from './lib/browserUi.js'
import {
  appendSessionRowsPage,
  bumpSessionRowToTop,
  getOrCreateSessionStore,
  removeMachineLocalState,
  removeSessionRowInList,
  replaceMachineRows,
  replaceSessionRows,
  upsertMachineRowInList,
  upsertSessionRowInList
} from './lib/appSessionState.js'
import {
  buildChatMessages,
  diffStepSelectedFile as diffStepSelectedFileHelper,
  diffStepSelectedPath as diffStepSelectedPathHelper,
  parseUnifiedDiff,
  parseReasoningSections,
  summarizeUnifiedDiff,
  setDiffStepSelectedPath as setDiffStepSelectedPathHelper
} from './lib/chatMessages.js'
import {
  createAppSettingsActions
} from './lib/appSettings.js'
import {
  createComposerModelSettings
} from './lib/composerModels.js'
import {
  createComposerSessionActions
} from './lib/composerSessionActions.js'
import {
  buildComposerAttachmentRefs,
  clearComposerAttachments as clearComposerAttachmentList,
  isImageMimeType
} from './lib/composerAttachments.js'
import {
  createMachineControlActions
} from './lib/machineControls.js'
import {
  createNewThreadDialogActions
} from './lib/newThreadDialog.js'
import {
  createSessionEnvelopeHandler
} from './lib/sessionEnvelopeHandler.js'
import {
  buildSessionListEntries,
  normalizeSessionListGroupingMode
} from './lib/sessionListGrouping.js'
import {
  createSessionListLoader
} from './lib/sessionListLoader.js'
import {
  addSessionEvent as addSessionEventHelper,
  appendToolOutput as appendToolOutputHelper,
  backfillSessionAfter as backfillSessionAfterHelper,
  ensureToolOutputLoaded as ensureToolOutputLoadedHelper,
  ensureTurnReasoningBodyLoaded as ensureTurnReasoningBodyLoadedHelper,
  ensureTurnReasoningLoaded as ensureTurnReasoningLoadedHelper,
  loadMoreSessionHistoryBefore as loadMoreSessionHistoryBeforeHelper,
  loadMoreToolOutputBefore as loadMoreToolOutputBeforeHelper,
  loadSessionHistory as loadSessionHistoryHelper
} from './lib/sessionHistory.js'
import {
  resolveSessionLoadStrategy
} from './lib/sessionSelection.js'
import {
  countApprovalsOutsideSession,
  createSessionDialogActions,
  findApprovalForSession,
  findApprovalOutsideSession
} from './lib/sessionDialogs.js'
import {
  createSessionSseActions,
  currentVisibilityState,
  readStoredSseEventId,
  writeStoredSseEventId
} from './lib/sessionSse.js'
import {
  createSystemSettingsActions
} from './lib/systemSettings.js'
import {
  createPwaInstallPromptActions
} from './lib/pwaInstallPrompt.js'
import {
  createSessionAdminActions
} from './lib/sessionAdminActions.js'
import {
  createSessionStoreState,
  sessionHostName as sessionHostNameForRow,
  sessionIndicator,
  sessionInitial,
  sessionListTitle,
  sessionProject,
  sessionTooltip as sessionTooltipForRow
} from './lib/sessionUi.js'
import {
  DEFAULT_DESKTOP_SIDEBAR_MODE,
  COMPACT_SESSION_SIDEBAR_WIDTH,
  clampSessionSidebarWidth,
  DEFAULT_SESSION_SIDEBAR_WIDTH,
  persistDesktopSidebarMode,
  persistSessionSidebarWidth,
  readStoredDesktopSidebarMode,
  readStoredSessionSidebarWidth
} from './lib/sidebarResize.js'
import {
  appendWorkspaceTerminalOutput,
  buildWorkspaceTerminalExitNotice,
  createWorkspaceTerminalSession,
  normalizeTerminalGeometry,
  workspaceTerminalSessionMatchesContext
} from './lib/workspaceTerminal.js'
import {
  isMobileViewportWidth,
  preferredMobilePane
} from './lib/mobileLayout.js'
import {
  resolveMainPaneMode,
  shouldAutoOpenNewThreadScreen
} from './lib/mainPaneMode.js'
import {
  computeVirtualWindowVariable
} from './lib/virtualList.js'

const authed = ref(false)
const authToken = ref('')
const authError = ref('')

const sseStatus = ref('disconnected') // disconnected|connecting|connected|error
const everConnected = ref(false)
const networkOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
const sseDisconnectReason = ref(null) // heartbeat-timeout|closed|error|null
const lastSseMessageAt = ref(Date.now())
const lastSseEventId = ref(readStoredSseEventId())
let heartbeatCheckTimer = null
const sseConnectionId = ref(null)
let onlineHandler = null
let offlineHandler = null

const layoutShellEl = ref(null)
const workspaceSplitEl = ref(null)
const appViewportHeight = ref(null)
const machines = ref([])
const sessions = ref([])
const machineRowsById = reactive(new Map())
const sessionRowsById = reactive(new Map())
const selectedSessionId = ref(null)
const hasSnapshot = ref(false)
const activeThinkingLabelChars = Array.from('Thinking...')
const sessionListScrollEl = ref(null)
const sessionListScrollTop = ref(0)
const sessionListViewportHeight = ref(720)
const sessionSidebarWidth = ref(DEFAULT_SESSION_SIDEBAR_WIDTH)
const sessionSidebarDragging = ref(false)
const workspaceChatWidth = ref(DEFAULT_WORKSPACE_CHAT_WIDTH)
const workspaceSplitDragging = ref(false)
const isMobileLayout = ref(false)
const desktopSidebarMode = ref(DEFAULT_DESKTOP_SIDEBAR_MODE)
const desktopSidebarFlyoutOpen = ref(false)
const desktopSidebarModeMenuOpen = ref(false)
const mobilePane = ref('list')
const sessionListGroupingMode = ref(readSessionListGroupingMode())
const sessionListLoading = ref(false)
const sessionListHasMore = ref(false)
const sessionListNextBeforeUpdatedMs = ref(null)
const sessionListNextBeforeSessionId = ref(null)
const NEW_THREAD_ROOT_PATH = '/'
const desktopSidebarModeOptions = Object.freeze([
  { value: 'expanded', label: 'Expanded' },
  { value: 'collapsed', label: 'Collapsed' },
  { value: 'hover', label: 'Expand on hover' }
])

const visibleSessions = computed(() => sessions.value.filter((s) => !s?.archivedMs))

const newThreadRecentWorkspaces = computed(() => {
  return buildRecentWorkspaces(sessions.value, newThreadMachineId.value, sessionProject)
})

const composerDragging = ref(false)

const connectionBanner = computed(() => {
  if (!authed.value) return null
  if (!networkOnline.value) {
    return { tone: 'error', text: 'Offline. Reconnecting when back online…' }
  }
  if (sseStatus.value === 'connected') return null
  const reason = sseDisconnectReason.value
  const reasonSuffix = reason ? ` (${String(reason)})` : ''
  if (sseStatus.value === 'connecting') {
    return { tone: 'warning', text: (everConnected.value ? 'Reconnecting…' : 'Connecting…') + reasonSuffix }
  }
  if (sseStatus.value === 'error') {
    return { tone: 'warning', text: (everConnected.value ? 'Connection lost. Retrying…' : 'Unable to connect. Retrying…') + reasonSuffix }
  }
  return { tone: 'warning', text: 'Disconnected.' + reasonSuffix }
})
const composerContextPopoverOpen = ref(false)
const composerContextPopoverHover = ref(false)
const composerMachinePopoverOpen = ref(false)
const composerMachinePopoverHover = ref(false)
const mobileWorkspaceMenuOpen = ref(false)

function isImageType(mimeType) {
  return isImageMimeType(mimeType)
}

// sessionId -> { events: [], diff: string, seen: Set<string> }
const sessionStores = reactive(new Map())
// sessionId -> { tokenUsage?: any, info?: any }
const tokenUsageBySessionId = reactive(new Map())
const approvalQueue = ref([]) // [{ approvalId, sessionId, kind, ... }]
const approvalIds = new Set()

const approvalResponding = ref(false)
const approvalRespondError = ref('')

const userInputSubmitting = ref(false)
const userInputError = ref('')
// questionId -> { choice: string, other: string, text: string }
const userInputForm = reactive({})

const defaultsOpen = ref(false)
const defaultsError = ref('')
const defaults = reactive({
  cwd: '',
  machineId: '',
  model: '',
  reasoningEffort: '',
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write'
})

// New thread screen (pick machine + workspace before starting).
const newThreadOpen = ref(false)
const suppressAutoNewThreadScreen = ref(false)
const newThreadMachineId = ref('')
const newThreadCwd = ref('')
const newThreadError = ref('')
const newThreadCreating = ref(false)

const newThreadBrowseOpen = ref(false)
const newThreadBrowsePath = ref('')
const newThreadBrowseParent = ref(null)
const newThreadBrowseEntries = ref([]) // [{ name, path, kind }]
const newThreadBrowseLoading = ref(false)
const newThreadBrowseError = ref('')
const newThreadTreeDirectoryEntries = reactive(new Map())
const newThreadTreeExpandedDirs = reactive(new Set())
const newThreadTreeLoadingDirs = reactive(new Set())

const settingsTab = ref('machines') // machines|threads|system
const forceEmptyHomeScreen = ref(false)

const machinesForSelect = computed(() => {
  return machines.value
    .slice()
    .sort((a, b) => {
      const ao = machineIsOnline(a) ? 1 : 0
      const bo = machineIsOnline(b) ? 1 : 0
      if (ao !== bo) return bo - ao
      return Number(b?.lastSeenMs ?? 0) - Number(a?.lastSeenMs ?? 0)
    })
})

const newThreadSelectedMachine = computed(() => {
  const mid = String(newThreadMachineId.value ?? '').trim()
  if (!mid) return null
  return machineRowsById.get(mid) ?? null
})

const newThreadSelectedMachineOnline = computed(() => {
  const m = newThreadSelectedMachine.value
  return m ? machineIsOnline(m) : false
})

const defaultsSelectedMachine = computed(() => {
  const mid = String(defaults.machineId ?? '').trim()
  if (!mid) return null
  return machineRowsById.get(mid) ?? null
})
const hasCompleteDefaultWorkspaceSelection = computed(() => {
  return Boolean(String(defaults.cwd ?? '').trim() && defaultsSelectedMachine.value)
})

const deleteMachineRow = computed(() => {
  const mid = String(deleteMachineId.value ?? '').trim()
  if (!mid) return null
  return machineRowsById.get(mid) ?? null
})

const appSettingsLoaded = ref(false)
const appSettingsError = ref('')
const appSettingsSaving = ref(false)
const hostSelfUpdateWorking = ref(false)
const hostSelfUpdateError = ref('')
const hostSelfUpdateStatus = ref('')
const runnerInstallCommand = ref('')
const runnerInstallUrl = ref('')
const runnerInstallExpiresAtMs = ref(null)
const runnerInstallLoading = ref(false)
const runnerInstallError = ref('')
const runnerInstallStatusText = ref('')
const machineAliasDrafts = reactive({})
const machineAliasSavingId = ref(null)
const machineAliasError = ref('')
const retentionDraft = ref('')
const sseToastsDraft = ref('if-not-visible') // always|never|if-not-visible
const webPushDraft = ref('if-not-visible') // always|never|if-not-visible
const appSettings = reactive({
  appVersion: null,
  retentionDays: 30,
  notifications: { sseToasts: 'if-not-visible', webPush: 'if-not-visible' },
  host: null,
  runner: null
})
const hostSelfUpdateInfo = computed(() => appSettings.host?.selfUpdate ?? null)
const hostSelfUpdateEnabled = computed(() => Boolean(hostSelfUpdateInfo.value?.enabled))

const deepLinkSessionId = ref(null)

const nowMs = ref(Date.now())
let nowTimer = null

const messageDraft = ref('')
const attachments = ref([]) // [{ id, filename, mimeType, sizeBytes, file, previewUrl }]
const fileInputEl = ref(null)
const sendError = ref('')
const ideError = ref('')
const sending = ref(false)
const ideStarting = ref(false)
const activeIdeSession = ref(null)
const ideFrameLoading = ref(false)
const workspacePaneOpen = ref(false)
const workspacePaneTab = ref('code')
const workspaceFilesPath = ref('')
const workspaceDirectoryEntries = reactive(new Map())
const workspaceExpandedDirs = reactive(new Set())
const workspaceLoadingDirs = reactive(new Set())
const workspaceFilesLoading = ref(false)
const workspaceFilesError = ref('')
const workspaceSelectedFilePath = ref('')
const workspaceSelectedFile = ref(null)
const workspaceFileLoading = ref(false)
const workspaceFileError = ref('')
const workspaceGitStatus = ref(null)
const workspaceGitLoading = ref(false)
const workspaceGitError = ref('')
const workspaceGitActionWorking = ref(false)
const workspaceGitBranchWorking = ref(false)
const workspaceGitBranchDraft = ref('')
const workspaceTerminalError = ref('')
const workspaceTerminalSession = ref(null)
const workspaceTerminalStarting = ref(false)
let workspaceTerminalInputBuffer = ''
let workspaceTerminalInputFlushTimer = null
let workspaceTerminalResizeTimer = null
let workspaceTerminalPendingResize = null

const chatScrollEl = ref(null)
const stickToBottom = ref(true)

// Toast notifications delivered via SSE (host-generated).
const toasts = ref([]) // [{ id, level, title, message, sessionId?, stickyUntilVisible? }]

const renameOpen = ref(false)
const renameSessionId = ref(null)
const renameTitleValue = ref('')
const renameProjectValue = ref('')
const renameFocus = ref('title') // title|project
const renameError = ref('')

const sessionPolicyOpen = ref(false)
const sessionPolicySaving = ref(false)
const sessionPolicyError = ref('')
const sessionApprovalDraft = ref('on-request')
const sessionSandboxDraft = ref('workspace-write')

const archiveOpen = ref(false)
const archivedSessions = ref([])
const archiveLoading = ref(false)
const archiveError = ref('')
const sessionMenuId = ref(null)

const deleteOpen = ref(false)
const deleteSessionId = ref(null)
const deleteWorking = ref(false)
const deleteError = ref('')

const deleteMachineOpen = ref(false)
const deleteMachineId = ref(null)
const deleteMachineWorking = ref(false)
const deleteMachineError = ref('')

const machineDisconnectWorkingId = ref(null)
const machineDisconnectError = ref('')
const machineUpgradeWorkingId = ref(null)
const machineUpgradeError = ref('')

let markReadTimer = null
const sessionLoading = ref(false)
const loadSessionNonce = ref(0)
let keydownHandler = null
let visibilityHandler = null
let swMessageHandler = null
let windowResizeHandler = null
let windowPageShowHandler = null
let visualViewportHandler = null
let viewportSyncTimer = null
let sidebarDragMoveHandler = null
let sidebarDragUpHandler = null
let workspaceDragMoveHandler = null
let workspaceDragUpHandler = null
let sessionListResizeObserver = null
let chatResizeObserver = null
let sessionMenuOutsideHandler = null

function getSessionStore(sessionId) {
  return getOrCreateSessionStore(sessionStores, sessionId, createSessionStoreState, reactive)
}

function upsertSessionRow(value) {
  upsertSessionRowInList(sessions.value, value, sessionRowsById)
}

function syncMachineAliasDraft(machine, { force = false } = {}) {
  const machineId = String(machine?.machineId ?? '').trim()
  if (!machineId) return
  if (!force && machineAliasDrafts[machineId] !== undefined) return
  machineAliasDrafts[machineId] = String(machine?.machineAlias ?? '')
}

function upsertMachineRow(value) {
  upsertMachineRowInList(machines.value, value, machineRowsById)
  syncMachineAliasDraft(value)
}

function replaceAllSessionRows(rows) {
  replaceSessionRows(sessions.value, sessionRowsById, rows)
}

function appendOlderSessionRows(rows) {
  appendSessionRowsPage(sessions.value, sessionRowsById, rows)
}

function replaceAllMachineRows(rows) {
  replaceMachineRows(machines.value, machineRowsById, rows)
  const keepIds = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const machineId = String(row?.machineId ?? '').trim()
    if (!machineId) continue
    keepIds.add(machineId)
    syncMachineAliasDraft(row)
  }
  for (const machineId of Object.keys(machineAliasDrafts)) {
    if (!keepIds.has(machineId)) delete machineAliasDrafts[machineId]
  }
}

function removeSessionRow(sessionId) {
  removeSessionRowInList(sessions.value, sessionId, sessionRowsById)
  try { tokenUsageBySessionId.delete(sessionId) } catch {}
  try { sessionStores.delete(sessionId) } catch {}
}

function bumpSessionToTop(sessionId) {
  bumpSessionRowToTop(sessions.value, sessionId)
}

function removeMachineLocal(machineId) {
  removeMachineLocalState({
    machineId,
    sessionRows: sessions.value,
    sessionRowsById,
    selectedSessionId,
    sessionStores,
    sessionDataMaps: [tokenUsageBySessionId],
    machineRows: machines.value,
    machineRowsById,
    defaults,
    newThreadMachineId,
    fallbackMachineId: machinesForSelect.value[0]?.machineId ?? ''
  })
}

function sessionHostName(s) {
  return sessionHostNameForRow(s, machineRowsById)
}

function sessionTooltip(s) {
  return sessionTooltipForRow(s, machineRowsById)
}

function approvalCardTitle(approval) {
  const kind = String(approval?.kind ?? '').trim()
  if (kind === 'userInput') return 'Input requested'
  if (kind === 'fileChange') return 'File change approval'
  if (kind === 'command') return 'Command approval'
  return 'Approval requested'
}

function closeSessionMenu() {
  sessionMenuId.value = null
}

function toggleSessionListGrouping() {
  sessionListGroupingMode.value = sessionListGroupingMode.value === 'project' ? 'flat' : 'project'
}

function toggleSessionMenu(sessionId) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return
  sessionMenuId.value = (sessionMenuId.value === sid) ? null : sid
}

async function apiFetch(path, opts = {}) {
  const headers = {
    ...(opts.headers ?? {})
  }
  const body = opts.body
  const hasJsonContentType = Object.keys(headers).some((k) => String(k).toLowerCase() === 'content-type')
  if (typeof body === 'string' && !hasJsonContentType) {
    headers['Content-Type'] = 'application/json'
  }
  return await fetch(path, {
    ...opts,
    credentials: 'include',
    headers
  })
}

function currentVisibility() {
  return currentVisibilityState()
}

function readSessionListGroupingMode() {
  try {
    if (typeof localStorage === 'undefined') return 'project'
    return normalizeSessionListGroupingMode(localStorage.getItem('rootgrid.sessionListGrouping'))
  } catch {
    return 'project'
  }
}

function persistSessionListGroupingMode(value) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem('rootgrid.sessionListGrouping', normalizeSessionListGroupingMode(value))
  } catch {
  }
}

function readSessionSidebarWidth() {
  const viewportWidth = Number(layoutShellEl.value?.clientWidth ?? window.innerWidth ?? 0)
  return readStoredSessionSidebarWidth(globalThis.localStorage, viewportWidth)
}

function readWorkspaceChatPaneWidth() {
  const viewportWidth = Number(workspaceSplitEl.value?.clientWidth ?? layoutShellEl.value?.clientWidth ?? window.innerWidth ?? 0)
  return readStoredWorkspaceChatWidth(globalThis.localStorage, viewportWidth)
}

function applySessionSidebarWidth(value) {
  const viewportWidth = Number(layoutShellEl.value?.clientWidth ?? window.innerWidth ?? 0)
  sessionSidebarWidth.value = clampSessionSidebarWidth(value, viewportWidth)
  return sessionSidebarWidth.value
}

function applyWorkspaceChatPaneWidth(value) {
  const viewportWidth = Number(workspaceSplitEl.value?.clientWidth ?? layoutShellEl.value?.clientWidth ?? window.innerWidth ?? 0)
  workspaceChatWidth.value = clampWorkspaceChatWidth(value, viewportWidth)
  return workspaceChatWidth.value
}

function persistSidebarWidth() {
  persistSessionSidebarWidth(sessionSidebarWidth.value)
}

function persistWorkspaceWidth() {
  persistWorkspaceChatWidth(workspaceChatWidth.value)
}

function refreshMobileLayout() {
  const viewportWidth = Number(layoutShellEl.value?.clientWidth ?? window.innerWidth ?? 0)
  isMobileLayout.value = isMobileViewportWidth(viewportWidth)
}

const appShellStyle = computed(() => {
  const px = Number(appViewportHeight.value ?? 0)
  if (!Number.isFinite(px) || px <= 0) return null
  return {
    height: `${px}px`,
    minHeight: `${px}px`
  }
})

function syncAppViewportHeight() {
  const visualHeight = Number(window.visualViewport?.height ?? NaN)
  const innerHeight = Number(window.innerHeight ?? NaN)
  const docHeight = Number(document.documentElement?.clientHeight ?? NaN)
  const candidates = [visualHeight, innerHeight, docHeight]
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!candidates.length) return null
  const nextHeight = Math.max(1, Math.round(Math.min(...candidates)))
  appViewportHeight.value = nextHeight
  return nextHeight
}

function queueAppViewportSync() {
  syncAppViewportHeight()
  try {
    window.requestAnimationFrame(() => {
      syncAppViewportHeight()
    })
  } catch {
  }
  if (viewportSyncTimer) {
    try { clearTimeout(viewportSyncTimer) } catch {}
  }
  viewportSyncTimer = setTimeout(() => {
    viewportSyncTimer = null
    syncAppViewportHeight()
  }, 240)
}

function stopSessionSidebarDrag() {
  sessionSidebarDragging.value = false
  if (sidebarDragMoveHandler) {
    try { window.removeEventListener('pointermove', sidebarDragMoveHandler) } catch {}
    sidebarDragMoveHandler = null
  }
  if (sidebarDragUpHandler) {
    try { window.removeEventListener('pointerup', sidebarDragUpHandler) } catch {}
    try { window.removeEventListener('pointercancel', sidebarDragUpHandler) } catch {}
    sidebarDragUpHandler = null
  }
  try { document.body.classList.remove('rootgrid-col-resize-active') } catch {}
  persistSidebarWidth()
}

function stopWorkspacePaneDrag() {
  workspaceSplitDragging.value = false
  if (workspaceDragMoveHandler) {
    try { window.removeEventListener('pointermove', workspaceDragMoveHandler) } catch {}
    workspaceDragMoveHandler = null
  }
  if (workspaceDragUpHandler) {
    try { window.removeEventListener('pointerup', workspaceDragUpHandler) } catch {}
    try { window.removeEventListener('pointercancel', workspaceDragUpHandler) } catch {}
    workspaceDragUpHandler = null
  }
  try { document.body.classList.remove('rootgrid-col-resize-active') } catch {}
  persistWorkspaceWidth()
}

function updateSessionSidebarWidthFromClientX(clientX) {
  const rect = layoutShellEl.value?.getBoundingClientRect?.()
  const left = Number(rect?.left ?? 0)
  const width = clientX - left
  applySessionSidebarWidth(width)
}

function updateWorkspacePaneWidthFromClientX(clientX) {
  const rect = workspaceSplitEl.value?.getBoundingClientRect?.()
  const left = Number(rect?.left ?? 0)
  const width = clientX - left
  applyWorkspaceChatPaneWidth(width)
}

function beginSessionSidebarDrag(ev) {
  if (isMobileLayout.value || desktopSidebarCompact.value) return
  const clientX = Number(ev?.clientX)
  if (!Number.isFinite(clientX)) return
  stopSessionSidebarDrag()
  sessionSidebarDragging.value = true
  try { document.body.classList.add('rootgrid-col-resize-active') } catch {}
  updateSessionSidebarWidthFromClientX(clientX)

  const onMove = (moveEv) => {
    updateSessionSidebarWidthFromClientX(Number(moveEv?.clientX))
  }
  const onUp = () => {
    stopSessionSidebarDrag()
  }

  sidebarDragMoveHandler = onMove
  sidebarDragUpHandler = onUp
  try { window.addEventListener('pointermove', onMove) } catch {}
  try { window.addEventListener('pointerup', onUp, { once: true }) } catch {}
  try { window.addEventListener('pointercancel', onUp, { once: true }) } catch {}
}

function beginWorkspacePaneDrag(ev) {
  if (isMobileLayout.value || !showWorkspacePane.value) return
  const clientX = Number(ev?.clientX)
  if (!Number.isFinite(clientX)) return
  stopWorkspacePaneDrag()
  workspaceSplitDragging.value = true
  try { document.body.classList.add('rootgrid-col-resize-active') } catch {}
  updateWorkspacePaneWidthFromClientX(clientX)

  const onMove = (moveEv) => {
    updateWorkspacePaneWidthFromClientX(Number(moveEv?.clientX))
  }
  const onUp = () => {
    stopWorkspacePaneDrag()
  }

  workspaceDragMoveHandler = onMove
  workspaceDragUpHandler = onUp
  try { window.addEventListener('pointermove', onMove) } catch {}
  try { window.addEventListener('pointerup', onUp, { once: true }) } catch {}
  try { window.addEventListener('pointercancel', onUp, { once: true }) } catch {}
}

function showMobileSessionList() {
  if (!isMobileLayout.value) return
  mobileWorkspaceMenuOpen.value = false
  workspacePaneOpen.value = false
  mobilePane.value = 'list'
}

function closeMainPaneScreen() {
  if (newThreadOpen.value) closeNewThreadDialogBase()
  if (defaultsOpen.value) defaultsOpen.value = false
  if (!String(selectedSessionId.value ?? '').trim()) forceEmptyHomeScreen.value = true
  if (isMobileLayout.value) showMobileSessionList()
}

function openSession(sessionId) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return
  forceEmptyHomeScreen.value = false
  suppressAutoNewThreadScreen.value = true
  newThreadOpen.value = false
  defaultsOpen.value = false
  selectedSessionId.value = sid
  if (isMobileLayout.value) mobilePane.value = 'session'
}

function openDesktopSidebarFlyout() {
  if (!desktopSidebarExpandOnHover.value) return
  desktopSidebarFlyoutOpen.value = true
}

function closeDesktopSidebarFlyout(ev = null) {
  if (ev?.currentTarget?.contains?.(ev?.relatedTarget)) return
  desktopSidebarFlyoutOpen.value = false
}

function toggleDesktopSidebarModeMenu() {
  if (isMobileLayout.value) return
  desktopSidebarModeMenuOpen.value = !desktopSidebarModeMenuOpen.value
}

function setDesktopSidebarMode(mode) {
  desktopSidebarMode.value = persistDesktopSidebarMode(mode)
  desktopSidebarModeMenuOpen.value = false
  desktopSidebarFlyoutOpen.value = false
}

const {
  applySessionPageInfo,
  loadMoreSessions,
  warmSessionListInBackground,
  fetchAllSessionPages
} = createSessionListLoader({
  apiFetch,
  appendSessionRows: appendOlderSessionRows,
  sessionListLoading,
  sessionListHasMore,
  sessionListNextBeforeUpdatedMs,
  sessionListNextBeforeSessionId
})

let onLoginConnect = () => {}

const {
  loadAppSettings,
  checkAuth,
  saveRetentionDays,
  startHostSelfUpdate,
  login
} = createAppSettingsActions({
  apiFetch,
  authed,
  authToken,
  authError,
  appSettings,
  appSettingsLoaded,
  appSettingsError,
  appSettingsSaving,
  retentionDraft,
  sseToastsDraft,
  webPushDraft,
  hostSelfUpdateWorking,
  hostSelfUpdateError,
  hostSelfUpdateStatus,
  onLogin: () => onLoginConnect()
})

const {
  notificationSupported,
  notificationPermission,
  pushSupported,
  pushStatus,
  pushEndpoint,
  pushWorking,
  pushError,
  refreshNotificationPermission,
  requestNotificationPermission,
  refreshPushSubscription,
  enablePush,
  autoEnablePushOnLoad,
  disablePush,
  openSettings: openSettingsBase
} = createSystemSettingsActions({
  apiFetch,
  authed,
  appSettings,
  appSettingsLoaded,
  loadAppSettings,
  settingsTab,
  defaultsOpen
})

const {
  pwaInstallCanPrompt,
  pwaInstallMessage,
  pwaInstallWorking,
  showPwaInstallPrompt,
  dismissPwaInstallPrompt,
  attachPwaInstallPrompt,
  disposePwaInstallPrompt,
  triggerPwaInstallPrompt
} = createPwaInstallPromptActions({
  isMobileLayout
})

function openSettings(tab = 'machines') {
  const nextTab = tab === 'defaults' ? 'machines' : tab
  forceEmptyHomeScreen.value = false
  suppressAutoNewThreadScreen.value = true
  newThreadOpen.value = false
  workspacePaneOpen.value = false
  openSettingsBase(nextTab)
  if (nextTab === 'threads') {
    loadArchivedSessions().catch(() => {})
  }
  if (isMobileLayout.value) mobilePane.value = 'session'
}

function dismissToast(id) {
  dismissToastById(toasts.value, id)
}

function scheduleDismissToast(id, ms = 6_000) {
  scheduleToastDismiss({ id, dismiss: dismissToast, ms })
}

function showBrowserToast(toast) {
  return showBrowserNotification({
    notificationSupported: notificationSupported.value,
    permission: notificationPermission.value,
    toast,
    focusWindow: () => window.focus(),
    onSessionSelected: (sessionId) => {
      openSession(sessionId)
    }
  })
}

function formatAgeShort(ts) {
  return formatAgeShortValue(nowMs.value, ts)
}

function maybeUpdateTokenUsage(sessionId, payload) {
  updateTokenUsageMap(tokenUsageBySessionId, sessionId, payload)
}

function machineIsOnline(m) {
  return machineIsOnlineAt(nowMs.value, m)
}

function machineDisplayName(m) {
  return machineDisplayNameAt(m)
}

function machineShowLastSeen(m) {
  return machineShowLastSeenAt(nowMs.value, m)
}

function machineStatusLabel(m) {
  return machineStatusLabelAt(nowMs.value, m)
}

function machineRootgridVersion(m) {
  return machineRootgridVersionAt(m)
}

function machineHasVersionMismatch(m) {
  return machineHasVersionMismatchAt(m, appSettings.appVersion)
}

function machineHasUnknownVersion(m) {
  return machineHasUnknownVersionAt(m, appSettings.appVersion)
}

function machineSupportsWebUpgrade(m) {
  return machineSupportsWebUpgradeAt(m)
}

function machineUpgradeStatusText(m) {
  return machineUpgradeStatusTextAt(m)
}

function machineWorkingSessionCount(machineId) {
  return countMachineWorkingSessionsAt(sessions.value, machineId)
}

function machineUpgradeBusy(m) {
  return ['starting', 'receiving', 'installing', 'updating', 'restarting'].includes(String(m?.upgrade?.state ?? ''))
}

function machineUpgradeLockReason(m) {
  const count = machineWorkingSessionCount(m?.machineId)
  if (count <= 0) return ''
  return `Finish ${count} running ${pluralize(count, 'session')} before upgrading this runner.`
}

function machineUpgradeButtonTitle(m) {
  const lockReason = machineUpgradeLockReason(m)
  if (lockReason) return lockReason
  return machineHasUnknownVersion(m)
    ? 'Try a remote runner upgrade. If this legacy runner does not support it, update it manually.'
    : 'Pull, rebuild, and restart this runner using its configured upgrade commands.'
}

async function markSessionRead(sessionId) {
  if (!sessionId) return
  const res = await apiFetch(`/api/sessions/${sessionId}/read`, { method: 'POST' })
  if (!res.ok) return
  const data = await res.json().catch(() => null)
  if (data?.session) upsertSessionRow(data.session)
}

function scheduleMarkRead(sessionId) {
  if (!sessionId) return
  if (currentVisibility() !== 'visible') {
    clearScheduledMarkRead()
    return
  }
  clearScheduledMarkRead()
  markReadTimer = setTimeout(() => {
    markReadTimer = null
    markSessionRead(sessionId)
  }, 500)
}

function clearScheduledMarkRead() {
  if (markReadTimer) clearTimeout(markReadTimer)
  markReadTimer = null
}

function applyDerivedSessionEvent(sessionId, event, store) {
  if (event.type === 'diff.updated' && typeof event.payload?.diff === 'string') {
    store.diff = event.payload.diff
  }

  if (event.type === 'plan.updated') {
    store.plan = Array.isArray(event.payload?.plan) ? event.payload.plan : null
    store.planExplanation = event.payload?.explanation ?? null
  }

  if (event.type === 'turn.completed') {
    store.plan = finalizeCompletedPlan(store.plan, event.payload?.status ?? null)
  }

  if (event.type === 'thread.tokenUsage.updated' || event.type === 'token.count') {
    maybeUpdateTokenUsage(sessionId, event.payload)
    const turnId = String(event.payload?.turnId ?? '').trim()
    const reasoningTokens = Number(event.payload?.tokenUsage?.last?.reasoningOutputTokens ?? 0)
    if (turnId && Number.isFinite(reasoningTokens) && reasoningTokens > 0) {
      store.turnHasReasoningTokens.add(turnId)
    }
  }
}

function addSessionEvent(sessionId, event, { atStart = false, applyDerived = true } = {}) {
  addSessionEventHelper({
    getSessionStore,
    onDerivedEvent: applyDerivedSessionEvent,
    sessionId,
    event,
    atStart,
    applyDerived
  })
}

function addSessionEventRecord({ sessionId, event, atStart = false, applyDerived = true }) {
  addSessionEventHelper({
    getSessionStore,
    onDerivedEvent: applyDerivedSessionEvent,
    sessionId,
    event,
    atStart,
    applyDerived
  })
}

function appendToolOutput(sessionId, itemId, stream, text) {
  appendToolOutputHelper({ getSessionStore, sessionId, itemId, stream, text })
}

async function ensureToolOutputLoaded(sessionId, itemId) {
  await ensureToolOutputLoadedHelper({ apiFetch, getSessionStore, sessionId, itemId })
}

async function loadMoreToolOutputBefore(sessionId, itemId) {
  await loadMoreToolOutputBeforeHelper({ apiFetch, getSessionStore, sessionId, itemId })
}

function toggleToolExpanded(itemId) {
  const sid = selectedSessionId.value
  if (!sid || !itemId) return
  const store = getSessionStore(sid)
  const key = String(itemId)
  const next = !Boolean(store.toolExpanded.get(key))
  store.toolExpanded.set(key, next)
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  if (next) ensureToolOutputLoaded(sid, key).catch(() => {})
}

function onToolDetailsToggle(itemId, ev) {
  const sid = selectedSessionId.value
  if (!sid || !itemId) return
  const open = Boolean(ev?.target?.open)
  const store = getSessionStore(sid)
  const key = String(itemId)
  const current = Boolean(store.toolExpanded.get(key))
  if (current === open) return
  store.toolExpanded.set(key, open)
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  if (open) ensureToolOutputLoaded(sid, key).catch(() => {})
}

function onDiffDetailsToggle(stepId, ev) {
  const sid = selectedSessionId.value
  if (!sid || !stepId) return
  const open = Boolean(ev?.target?.open)
  const store = getSessionStore(sid)
  const key = String(stepId)
  const current = Boolean(store.diffExpandedByEventId.get(key))
  if (current === open) return
  store.diffExpandedByEventId.set(key, open)
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
}

async function ensureTurnReasoningLoaded(sessionId, turnId) {
  await ensureTurnReasoningLoadedHelper({
    apiFetch,
    getSessionStore,
    parseReasoningSections,
    sessionId,
    turnId
  })
}

async function ensureTurnReasoningBodyLoaded(sessionId, turnId) {
  await ensureTurnReasoningBodyLoadedHelper({
    apiFetch,
    getSessionStore,
    parseReasoningSections,
    sessionId,
    turnId
  })
}

function setBackgroundExpanded(turnId, open) {
  const sid = selectedSessionId.value
  if (!sid || !turnId) return
  const store = getSessionStore(sid)
  const key = String(turnId)
  const current = Boolean(store.backgroundExpandedByTurnId.get(key))
  if (current === open) return
  store.backgroundExpandedByTurnId.set(key, open)
  store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  if (open) ensureTurnReasoningLoaded(sid, key).catch(() => {})
}

function toggleBackgroundExpanded(message) {
  const turnId = String(message?.turnId ?? '').trim()
  if (!turnId || message?.active) return
  setBackgroundExpanded(turnId, !Boolean(message?.expanded))
}

function onReasoningSectionToggle(turnId, ev) {
  const sid = selectedSessionId.value
  if (!sid || !turnId) return
  const open = Boolean(ev?.target?.open)
  if (!open) return
  ensureTurnReasoningBodyLoaded(sid, turnId).catch(() => {})
}

function toolDisplayCommand(m) {
  const actions = Array.isArray(m?.commandActions) ? m.commandActions : null
  if (actions) {
    for (const a of actions) {
      const c = (a && typeof a === 'object' && typeof a.command === 'string') ? a.command.trim() : ''
      if (c) return c
    }
  }
  const cmd = String(m?.command ?? '').trim()
  return cmd
}

function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count) === 1 ? singular : plural
}

function splitHistoryLabelParts(label, fallbackLead = '') {
  const text = String(label ?? '').trim()
  if (!text) return { lead: String(fallbackLead ?? '').trim(), detail: '' }
  const match = text.match(/^(\S+)(?:\s+(.+))?$/)
  if (!match) return { lead: text, detail: '' }
  return {
    lead: String(match[1] ?? '').trim(),
    detail: String(match[2] ?? '').trim()
  }
}

function timelineToolSummary(m) {
  const tool = String(m?.tool ?? '')
  if (tool === 'commandExecution') {
    const cmd = toolDisplayCommand(m)
    return cmd ? `Ran ${cmd}` : 'Ran command'
  }
  if (tool === 'fileChange') {
    const count = Array.isArray(m?.changes) ? m.changes.length : 0
    if (count === 1) {
      const path = String(m?.changes?.[0]?.path ?? '').trim()
      if (path) return `Changed ${path}`
    }
    if (count > 0) return `Changed ${count} ${pluralize(count, 'file')}`
    return 'Changed files'
  }
  return String(tool || 'Tool')
}

function timelineToolSummaryParts(m) {
  return splitHistoryLabelParts(timelineToolSummary(m), 'Tool')
}

function timelineToolMeta(m) {
  const tool = String(m?.tool ?? '').trim()
  const exitCode = Number(m?.exitCode ?? NaN)
  if (tool === 'commandExecution' && Number.isFinite(exitCode) && exitCode !== 0) return `Exit ${exitCode}`
  return ''
}

function diffStepSummary(step) {
  const summary = summarizeUnifiedDiff(String(step?.raw ?? ''))
  const files = Array.isArray(summary?.paths) ? summary.paths : []
  let detail = 'files'
  if (files.length === 1) detail = files[0]
  else if (files.length > 1) detail = `${files.length} ${pluralize(files.length, 'file')}`
  const label = detail ? `Changed ${detail}` : 'Changed files'
  return {
    label,
    lead: 'Changed',
    detail,
    added: Number(summary?.added ?? 0) || 0,
    removed: Number(summary?.removed ?? 0) || 0
  }
}

function reasoningSectionSummaryParts(section) {
  const title = String(section?.title ?? '').trim()
  if (!title || title.toLowerCase() === 'reasoning') {
    return { lead: 'Reasoning', detail: '' }
  }
  return { lead: 'Reasoning', detail: title }
}

function exploreSummaryParts(item) {
  return splitHistoryLabelParts(item?.label, 'Step')
}

async function loadSession(sessionId) {
  await loadSessionHistoryHelper({
    apiFetch,
    upsertSessionRow,
    getSessionStore,
    addSessionEvent: addSessionEventRecord,
    chatScrollEl,
    loadSessionNonce,
    sessionLoading,
    sessionId
  })
}

async function loadMoreBefore(sessionId, { pages = 1, limit = 200 } = {}) {
  await loadMoreSessionHistoryBeforeHelper({
    apiFetch,
    getSessionStore,
    addSessionEvent: addSessionEventRecord,
    chatScrollEl,
    sessionId,
    pages,
    limit
  })
}

async function backfillSessionAfter(sessionId, { afterSeq, limit = 500 } = {}) {
  await backfillSessionAfterHelper({
    apiFetch,
    getSessionStore,
    onEnvelope: handleEnvelope,
    sessionId,
    afterSeq,
    limit
  })
}

let handleEnvelope = () => {}
let schedulePostVisibility = () => {}

function handleSelectedSessionDeleted(session = null) {
  const deletedCwd = String(session?.cwd ?? '').trim()
  if (deletedCwd && String(defaults.cwd ?? '').trim() === deletedCwd) {
    defaults.cwd = ''
  }
  suppressAutoNewThreadScreen.value = true
  forceEmptyHomeScreen.value = true
  newThreadOpen.value = false
  defaultsOpen.value = false
  messageDraft.value = ''
  queuedPromptEditingId.value = null
  queuedPromptEditDraft.value = ''
  composerContextPopoverOpen.value = false
  composerContextPopoverHover.value = false
  workspacePaneOpen.value = false
  activeIdeSession.value = null
  ideFrameLoading.value = false
  try { clearComposerAttachments?.() } catch {}
  if (isMobileLayout.value) showMobileSessionList()
}

function applyRestoredQueuedPromptToComposer({ sessionId, prompt = null, error = '' } = {}) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return false
  if (String(selectedSessionId.value ?? '').trim() !== sid) return false
  const store = getSessionStore(sid)
  const restoredPrompt = (prompt && typeof prompt === 'object') ? prompt : store?.restoredPrompt
  if (!restoredPrompt || typeof restoredPrompt !== 'object') return false

  const nextError = String(error ?? store?.restoredPromptError ?? '').trim()
  messageDraft.value = String(restoredPrompt?.text ?? '')
  queuedPromptEditingId.value = null
  queuedPromptEditDraft.value = ''
  clearComposerAttachmentList(attachments.value)
  attachments.value.push(...buildComposerAttachmentRefs(restoredPrompt?.attachments, sid))
  if (nextError) sendError.value = nextError
  if (store) {
    store.restoredPrompt = null
    store.restoredPromptError = ''
    store.messageViewVersion = Number(store.messageViewVersion ?? 0) + 1
  }
  return true
}

const baseHandleEnvelope = createSessionEnvelopeHandler({
  currentVisibility,
  notificationPermission,
  showBrowserToast,
  toasts,
  scheduleDismissToast,
  sseConnectionId,
  replaceMachineRows: replaceAllMachineRows,
  replaceSessionRows: replaceAllSessionRows,
  applySessionPageInfo: (payload) => {
    applySessionPageInfo(payload)
    if (payload?.sessionsHasMore) warmSessionListInBackground()
  },
  sessionRowsById,
  approvalQueue,
  approvalIds,
  hasSnapshot,
  schedulePostVisibility: (...args) => schedulePostVisibility(...args),
  selectedSessionId,
  sessionStores,
  backfillSessionAfter,
  onSelectedSessionDeleted: handleSelectedSessionDeleted,
  upsertMachineRow,
  removeMachineLocal,
  removeSessionRow,
  upsertSessionRow,
  getSessionStore,
  stickToBottom,
  scheduleMarkRead,
  bumpSessionToTop,
  updateTokenUsage: maybeUpdateTokenUsage,
  appendToolOutput,
  addSessionEvent,
  onQueuedPromptRestoreRequested: ({ sessionId, prompt, error }) => {
    applyRestoredQueuedPromptToComposer({ sessionId, prompt, error })
  }
})

function handleTerminalEnvelope(env) {
  if (!env || typeof env.type !== 'string') return false
  if (env.type === 'terminal.pty.output') {
    const terminalId = String(env.payload?.terminalId ?? env.scope?.terminalId ?? '').trim()
    if (!terminalId || workspaceTerminalSession.value?.terminalId !== terminalId) return true
    const next = workspaceTerminalSession.value
    const chunk = String(env.payload?.data ?? '')
    next.outputText = appendWorkspaceTerminalOutput(next.outputText, chunk)
    next.outputVersion = Number(next.outputVersion ?? 0) + 1
    next.chunkText = chunk
    next.chunkVersion = Number(next.chunkVersion ?? 0) + 1
    return true
  }
  if (env.type === 'terminal.pty.exit') {
    const terminalId = String(env.payload?.terminalId ?? env.scope?.terminalId ?? '').trim()
    if (!terminalId || workspaceTerminalSession.value?.terminalId !== terminalId) return true
    const next = workspaceTerminalSession.value
    next.connected = false
    const exitCode = env.payload?.exitCode
    const signal = env.payload?.signal
    next.exitCode = (exitCode === null || exitCode === undefined || exitCode === '')
      ? null
      : (Number.isFinite(Number(exitCode)) ? Number(exitCode) : null)
    next.signal = (signal === null || signal === undefined || signal === '')
      ? null
      : (Number.isFinite(Number(signal)) ? Number(signal) : null)
    const exitNotice = Boolean(env.payload?.disconnected)
      ? '\r\n[terminal disconnected]\r\n'
      : buildWorkspaceTerminalExitNotice({
          exitCode: next.exitCode,
          signal: next.signal
        })
    next.outputText = appendWorkspaceTerminalOutput(next.outputText, exitNotice)
    next.outputVersion = Number(next.outputVersion ?? 0) + 1
    next.chunkText = exitNotice
    next.chunkVersion = Number(next.chunkVersion ?? 0) + 1
    return true
  }
  return false
}

handleEnvelope = (env) => {
  if (handleTerminalEnvelope(env)) return
  baseHandleEnvelope(env)
}

const selectedSession = computed(() => {
  const sid = String(selectedSessionId.value ?? '').trim()
  if (!sid) return null
  return sessionRowsById.get(sid) ?? null
})
const compactSidebarPreviewSessions = computed(() => {
  const out = []
  const seen = new Set()
  const push = (session) => {
    const sid = String(session?.sessionId ?? '').trim()
    if (!sid || seen.has(sid)) return
    seen.add(sid)
    out.push(session)
  }

  push(selectedSession.value)
  for (const session of visibleSessions.value) {
    push(session)
    if (out.length >= 8) break
  }
  return out
})
const compactSidebarOverflowCount = computed(() => Math.max(0, visibleSessions.value.length - compactSidebarPreviewSessions.value.length))
const selectedComposerApproval = computed(() => {
  return findApprovalForSession(approvalQueue.value, selectedSessionId.value)
})
const nextOtherPendingApproval = computed(() => {
  return findApprovalOutsideSession(approvalQueue.value, selectedSessionId.value)
})
const otherPendingApprovalsCount = computed(() => {
  return countApprovalsOutsideSession(approvalQueue.value, selectedSessionId.value)
})
const nextOtherPendingApprovalLabel = computed(() => {
  const count = Number(otherPendingApprovalsCount.value ?? 0)
  if (!count) return ''
  if (count > 1) return `${count} approvals are waiting in other threads.`
  const next = nextOtherPendingApproval.value
  const sid = String(next?.sessionId ?? '').trim()
  const session = sid ? (sessionRowsById.get(sid) ?? { sessionId: sid }) : null
  return `Approval waiting in ${session ? sessionListTitle(session) : 'another thread'}.`
})
const selectedStore = computed(() => selectedSessionId.value ? sessionStores.get(selectedSessionId.value) : null)
const selectedTokenUsage = computed(() => selectedSessionId.value ? (tokenUsageBySessionId.get(selectedSessionId.value) ?? null) : null)
const selectedQueuedPrompts = computed(() => {
  const list = selectedStore.value?.queuedPrompts
  return Array.isArray(list) ? list : []
})
const selectedQueueSending = computed(() => Boolean(selectedStore.value?.queueSending))
const queuedPromptEditingId = ref(null)
const queuedPromptEditDraft = ref('')
const workspaceRootEntries = computed(() => {
  const rootPath = String(workspaceFilesPath.value ?? '').trim()
  if (!rootPath) return []
  return workspaceDirectoryEntries.get(rootPath) ?? []
})

const currentWorkspaceContext = computed(() => {
  const cwd = String(selectedSession.value?.cwd ?? defaults.cwd ?? '').trim()
  const machineId = String(selectedSession.value?.machineId ?? defaults.machineId ?? '').trim()
  return {
    cwd,
    machineId
  }
})

const selectedMachineIdForSse = computed(() => {
  if (workspacePaneOpen.value && workspacePaneTab.value === 'terminal') {
    const terminalMachineId = String(workspaceTerminalSession.value?.machineId ?? '').trim()
    if (terminalMachineId) return terminalMachineId
  }
  const workspaceMachineId = String(currentWorkspaceContext.value?.machineId ?? '').trim()
  return workspaceMachineId || null
})

const {
  connectSse,
  schedulePostVisibility: schedulePostVisibilityImpl,
  disposeSse
} = createSessionSseActions({
  apiFetch,
  sseConnectionId,
  lastSseEventId,
  persistLastEventId: (value) => writeStoredSseEventId(value),
  hasSnapshot,
  selectedSessionId,
  selectedMachineId: selectedMachineIdForSse,
  stickToBottom,
  scheduleMarkRead,
  clearScheduledMarkRead,
  onVisible: () => {
    for (const t of toasts.value) {
      if (!t?.stickyUntilVisible) continue
      t.stickyUntilVisible = false
      scheduleDismissToast(t.id, 7_500)
    }
  },
  sseStatus,
  sseDisconnectReason,
  lastSseMessageAt,
  everConnected,
  handleEnvelope: (env) => handleEnvelope(env),
  currentVisibility
})

schedulePostVisibility = schedulePostVisibilityImpl
onLoginConnect = () => {
  connectSse()
}

watch(selectedSessionId, async (sid, prevSid) => {
  mobileWorkspaceMenuOpen.value = false
  if (String(prevSid ?? '').trim()) {
    rememberChatScrollState(prevSid)
  }
  closeSessionMenu()
  composerContextPopoverOpen.value = false
  composerContextPopoverHover.value = false
  if (!String(sid ?? '').trim() && String(prevSid ?? '').trim()) suppressAutoNewThreadScreen.value = true
  if (String(sid ?? '').trim()) forceEmptyHomeScreen.value = false
  if (!sid) {
    replaceUrlSessionParam(null)
    if (authed.value) schedulePostVisibility()
    loadSessionNonce.value += 1
    sessionLoading.value = false
    return
  }

  replaceUrlSessionParam(sid)
  if (authed.value) schedulePostVisibility()
  const s = sessionRowsById.get(sid) ?? null
  const existingStore = sessionStores.get(sid) ?? null
  const loadStrategy = resolveSessionLoadStrategy(existingStore, s)
  if (loadStrategy.action === 'load') {
    await loadSession(sid)
  } else if (loadStrategy.action === 'backfill') {
    backfillSessionAfter(sid, { afterSeq: loadStrategy.knownSeq }).catch(() => {
      loadSession(sid).catch(() => {})
    })
  }
  if (s?.cwd) defaults.cwd = s.cwd
  const nextStore = getSessionStore(sid)
  stickToBottom.value = Boolean(nextStore.chatStickToBottom ?? true)
  await restoreChatScrollState(sid)
  applyRestoredQueuedPromptToComposer({ sessionId: sid })
  scheduleMarkRead(sid)
})

watch(
  () => [String(selectedSessionId.value ?? ''), selectedQueuedPrompts.value.map((queued) => String(queued?.promptId ?? queued?.id ?? '')).join(',')],
  ([sid, promptIds]) => {
    const editId = String(queuedPromptEditingId.value ?? '').trim()
    if (!sid || !editId) {
      queuedPromptEditingId.value = null
      queuedPromptEditDraft.value = ''
      return
    }
    const list = String(promptIds ?? '').split(',').filter(Boolean)
    if (!list.includes(editId)) {
      queuedPromptEditingId.value = null
      queuedPromptEditDraft.value = ''
    }
  }
)

watch(defaultsOpen, (open) => {
  if (!open) return
  refreshPushSubscription().catch(() => {})
  if (!runnerInstallCommand.value || Number(runnerInstallExpiresAtMs.value ?? 0) <= nowMs.value) {
    loadRunnerInstallBootstrap().catch(() => {})
  }
  loadArchivedSessions().catch(() => {})
})

watch(selectedSessionId, (sid, prevSid) => {
  if (!isMobileLayout.value) return
  if (!String(sid ?? '').trim()) {
    mobilePane.value = 'list'
    return
  }
  if (sid !== prevSid && mobilePane.value !== 'workspace') {
    mobilePane.value = 'session'
  }
})

watch(isMobileLayout, (mobile) => {
  mobileWorkspaceMenuOpen.value = false
  if (mobile) {
    mobilePane.value = preferredMobilePane(selectedSessionId.value)
    nextTick(() => updateSessionListMetrics())
    return
  }
  mobilePane.value = 'session'
})

watch(sessionListGroupingMode, (value) => {
  persistSessionListGroupingMode(value)
})

const sessionListEntries = computed(() => buildSessionListEntries(visibleSessions.value, {
  groupingMode: sessionListGroupingMode.value,
  getHostName: (session) => sessionHostName(session),
  getProjectName: (session) => sessionProject(session)
}))
const visibleSessionWindow = computed(() => computeVirtualWindowVariable(sessionListEntries.value, {
  scrollTop: sessionListScrollTop.value,
  viewportHeight: sessionListViewportHeight.value,
  defaultItemHeight: 56,
  overscanPx: 280,
  getItemHeight: (entry) => entry?.kind === 'group' ? 28 : 56
}))
const layoutTrackStyle = computed(() => {
  if (!isMobileLayout.value) return null
  return {
    width: '200%',
    transform: mobilePane.value === 'list' ? 'translateX(0%)' : 'translateX(-50%)'
  }
})
const sessionSidebarStyle = computed(() => {
  if (isMobileLayout.value) return null
  return { width: `${desktopSidebarCompact.value ? COMPACT_SESSION_SIDEBAR_WIDTH : sessionSidebarWidth.value}px` }
})
const sessionSidebarPanelStyle = computed(() => {
  if (!desktopSidebarCompact.value) return null
  return { width: `${sessionSidebarWidth.value}px` }
})
const workspaceMainStyle = computed(() => {
  if (isMobileLayout.value || !showWorkspacePane.value) return null
  return { width: `${workspaceChatWidth.value}px` }
})
const composerMachineLabel = computed(() => {
  if (selectedSession.value) {
    const host = sessionHostName(selectedSession.value) || 'Local'
    const project = sessionProject(selectedSession.value)
    return project ? `${host} / ${project}` : host
  }
  const machine = defaultsSelectedMachine.value
  return machineDisplayName(machine) || 'Local'
})
const composerMachine = computed(() => {
  if (selectedSession.value) {
    const mid = String(selectedSession.value.machineId ?? '').trim()
    return mid ? (machineRowsById.get(mid) ?? null) : null
  }
  return defaultsSelectedMachine.value ?? null
})
const composerMachineOnline = computed(() => {
  if (selectedSession.value) {
    const mid = String(selectedSession.value.machineId ?? '').trim()
    if (!mid) return true
    const machine = machineRowsById.get(mid) ?? null
    return machine ? machineIsOnline(machine) : false
  }
  if (!defaultsSelectedMachine.value) return true
  return machineIsOnline(defaultsSelectedMachine.value)
})
const composerMachineVersionMismatch = computed(() => machineHasVersionMismatch(composerMachine.value))
const composerMachineUnknownVersion = computed(() => machineHasUnknownVersion(composerMachine.value))
const composerMachineRunnerVersion = computed(() => machineRootgridVersion(composerMachine.value) ?? 'unknown')
const composerMachineUpgradeSupported = computed(() => machineSupportsWebUpgrade(composerMachine.value))
const composerMachineUpgradeAvailable = computed(() => (
  Boolean(composerMachine.value)
  && composerMachineOnline.value
  && (composerMachineVersionMismatch.value || composerMachineUnknownVersion.value)
  && (composerMachineUpgradeSupported.value || composerMachineUnknownVersion.value)
))
const composerMachineUpgradeLockedReason = computed(() => machineUpgradeLockReason(composerMachine.value))
const composerMachineUpgradeLocked = computed(() => Boolean(composerMachineUpgradeLockedReason.value))
const composerMachineUpgradeBusy = computed(() => machineUpgradeBusy(composerMachine.value))
const composerMachineUpgradeWorking = computed(() => {
  const machineId = String(composerMachine.value?.machineId ?? '').trim()
  return Boolean(machineId && machineUpgradeWorkingId.value === machineId)
})
const composerMachineUpgradePopoverVisible = computed(() => (
  (composerMachineVersionMismatch.value || composerMachineUnknownVersion.value)
  && (composerMachinePopoverOpen.value || composerMachinePopoverHover.value)
))
const composerMachineUpgradeStatus = computed(() => machineUpgradeStatusText(composerMachine.value))
const composerMachineUpgradeErrorText = computed(() => String(machineUpgradeError.value ?? '').trim())
const runnerInstallExpiryLabel = computed(() => {
  const expiresAtMs = Number(runnerInstallExpiresAtMs.value ?? 0)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return ''
  const deltaMs = expiresAtMs - nowMs.value
  if (deltaMs <= 0) return 'expired'
  const minutes = Math.max(1, Math.round(deltaMs / 60_000))
  if (minutes < 60) return `expires in ~${minutes}m`
  const hours = Math.max(1, Math.round(minutes / 60))
  return `expires in ~${hours}h`
})
const runnerInstallNeedsReachableUrl = computed(() => {
  const raw = String(runnerInstallUrl.value ?? '').trim()
  if (!raw) return false
  try {
    const parsed = new URL(raw)
    const host = String(parsed.hostname ?? '').trim().toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
})
const mainPaneMode = computed(() => {
  return resolveMainPaneMode({
    newThreadOpen: newThreadOpen.value,
    defaultsOpen: defaultsOpen.value,
    authed: authed.value,
    suppressAutoNewThreadScreen: suppressAutoNewThreadScreen.value,
    selectedSessionId: selectedSessionId.value,
    deepLinkSessionId: deepLinkSessionId.value,
    hasCompleteDefaultWorkspaceSelection: hasCompleteDefaultWorkspaceSelection.value,
    isMobileLayout: isMobileLayout.value,
    forceEmptyHomeScreen: forceEmptyHomeScreen.value
  })
})
const showWorkspacePane = computed(() => {
  if (isMobileLayout.value) return false
  if (mainPaneMode.value !== 'chat') return false
  return workspacePaneOpen.value
})
const desktopSidebarCompact = computed(() => {
  if (isMobileLayout.value) return false
  return desktopSidebarMode.value !== 'expanded'
})
const desktopSidebarExpandOnHover = computed(() => (
  desktopSidebarCompact.value && desktopSidebarMode.value === 'hover'
))
const desktopSidebarFlyoutVisible = computed(() => (
  desktopSidebarCompact.value && desktopSidebarExpandOnHover.value && desktopSidebarFlyoutOpen.value
))
watch(desktopSidebarMode, () => {
  desktopSidebarModeMenuOpen.value = false
  desktopSidebarFlyoutOpen.value = false
  nextTick(() => updateSessionListMetrics())
})
watch(desktopSidebarCompact, (compact) => {
  if (!compact) {
    desktopSidebarFlyoutOpen.value = false
    desktopSidebarModeMenuOpen.value = false
  }
  nextTick(() => updateSessionListMetrics())
})
const composerContextUsage = computed(() => buildContextUsageSummary(selectedTokenUsage.value))
const composerContextPopoverVisible = computed(() => (
  Boolean(composerContextUsage.value) && (composerContextPopoverOpen.value || composerContextPopoverHover.value)
))
const composerContextRingStrokeStyle = computed(() => {
  const percent = Number(composerContextUsage.value?.percent ?? 0)
  const clamped = Math.max(0, Math.min(100, percent))
  const radius = 7.5
  const circumference = 2 * Math.PI * radius
  return {
    strokeDasharray: `${circumference}`,
    strokeDashoffset: `${circumference * (1 - (clamped / 100))}`
  }
})
const workspacePaneTitle = computed(() => {
  if (workspacePaneTab.value === 'terminal') return 'Terminal'
  if (workspacePaneTab.value === 'files') return 'Files'
  if (workspacePaneTab.value === 'git') return 'Git'
  return 'Workspace'
})
const workspaceTerminalOpening = computed(() => (
  workspacePaneTab.value === 'terminal'
  && workspacePaneOpen.value
  && !workspaceTerminalError.value
  && (workspaceTerminalStarting.value || !workspaceTerminalSession.value?.terminalId)
))

function handleComposerMachineMouseEnter() {
  if (!composerMachineVersionMismatch.value && !composerMachineUnknownVersion.value) return
  composerMachinePopoverHover.value = true
}

function toggleComposerMachinePopover() {
  if (!composerMachineVersionMismatch.value && !composerMachineUnknownVersion.value) return
  composerMachinePopoverOpen.value = !composerMachinePopoverOpen.value
}

watch(
  () => [composerMachineVersionMismatch.value, composerMachineUnknownVersion.value, String(composerMachine.value?.machineId ?? '')],
  ([hasMismatch, hasUnknown]) => {
    if (hasMismatch || hasUnknown) return
    composerMachinePopoverOpen.value = false
    composerMachinePopoverHover.value = false
  }
)

const pinnedPlanSteps = computed(() => {
  const plan = selectedStore.value?.plan
  return Array.isArray(plan) ? plan : []
})

const pinnedPlanCompletedCount = computed(() => {
  let n = 0
  for (const step of pinnedPlanSteps.value) {
    if (planStepIsCompleted(step)) n++
  }
  return n
})

const pinnedPlanHasUnchecked = computed(() => {
  if (!pinnedPlanSteps.value.length) return false
  return pinnedPlanSteps.value.some((s) => !planStepIsCompleted(s))
})

const pinnedPlanSummary = computed(() => {
  const total = pinnedPlanSteps.value.length
  const done = pinnedPlanCompletedCount.value
  if (!total) return ''
  return `${done} out of ${total} tasks completed`
})

function togglePinnedPlanOpen() {
  const store = selectedStore.value
  if (!store) return
  store.planPinnedOpen = !store.planPinnedOpen
}

const {
  modelCatalogLoading,
  modelCatalogError,
  composerOptionsError,
  defaultCodexModelLabel,
  selectedCodexDefaultReasoningEffortLabel,
  composerModelOptions,
  composerReasoningEffortOptions,
  composerModel,
  composerReasoningEffort,
  composerApprovalPolicy,
  composerSandbox
} = createComposerModelSettings({
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
})

const composerModelSelectOptions = computed(() => ([
  { value: '', label: defaultCodexModelLabel.value || 'Default' },
  ...composerModelOptions.value
]))

const composerReasoningSelectOptions = computed(() => ([
  {
    value: '',
    label: selectedCodexDefaultReasoningEffortLabel.value
      ? `Auto (${selectedCodexDefaultReasoningEffortLabel.value})`
      : 'Auto',
    description: 'Use the model default.'
  },
  ...composerReasoningEffortOptions.value
]))

const composerApprovalSelectOptions = Object.freeze([
  { value: 'untrusted', label: 'Untrusted', description: 'Ask unless the action is trusted.' },
  { value: 'on-request', label: 'On request', description: 'Ask before actions that need approval.' },
  { value: 'never', label: 'Never', description: 'Never ask for approval.' },
  { value: 'on-failure', label: 'On failure', description: 'Ask only after blocked or failing actions.' }
])

const composerSandboxSelectOptions = Object.freeze([
  { value: 'read-only', label: 'Read only', description: 'No filesystem writes.' },
  { value: 'workspace-write', label: 'Workspace write', description: 'Allow writes in the workspace.' },
  { value: 'danger-full-access', label: 'Full access', description: 'Allow unrestricted local access.' }
])

async function copyText(text) {
  await copyTextToClipboard(text)
}

async function loadRunnerInstallBootstrap({ force = false } = {}) {
  if (runnerInstallLoading.value) return false
  if (!force) {
    const expiresAtMs = Number(runnerInstallExpiresAtMs.value ?? 0)
    if (runnerInstallCommand.value && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs.value) {
      return true
    }
  }

  runnerInstallLoading.value = true
  runnerInstallError.value = ''
  runnerInstallStatusText.value = runnerInstallCommand.value
    ? 'Refreshing install command…'
    : 'Preparing runner bundle…'
  try {
    const res = await apiFetch('/api/install/runner-bootstrap', {
      method: 'POST',
      body: '{}'
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      runnerInstallError.value = err?.error ?? `HTTP ${res.status}`
      return false
    }

    const data = await res.json().catch(() => null)
    runnerInstallCommand.value = String(data?.installCommand ?? '').trim()
    runnerInstallUrl.value = String(data?.installUrl ?? '').trim()
    runnerInstallExpiresAtMs.value = Number(data?.expiresAtMs ?? 0) || null
    if (!runnerInstallCommand.value || !runnerInstallUrl.value) {
      runnerInstallError.value = 'Install bootstrap did not return a command.'
      return false
    }
    runnerInstallStatusText.value = ''
    return true
  } catch (err) {
    runnerInstallError.value = String(err?.message ?? err)
    return false
  } finally {
    if (runnerInstallError.value) runnerInstallStatusText.value = ''
    runnerInstallLoading.value = false
  }
}

async function copyRunnerInstallCommand() {
  if (!runnerInstallCommand.value) {
    const ok = await loadRunnerInstallBootstrap().catch(() => false)
    if (!ok || !runnerInstallCommand.value) return false
  }
  await copyText(runnerInstallCommand.value)
  return true
}

async function copyRunnerInstallUrl() {
  if (!runnerInstallUrl.value) {
    const ok = await loadRunnerInstallBootstrap().catch(() => false)
    if (!ok || !runnerInstallUrl.value) return false
  }
  await copyText(runnerInstallUrl.value)
  return true
}

async function saveMachineAlias(machineId) {
  const mid = String(machineId ?? '').trim()
  if (!mid) return false
  const machine = machineRowsById.get(mid) ?? null
  if (!machine) return false
  const alias = String(machineAliasDrafts[mid] ?? '').trim()
  const currentAlias = String(machine?.machineAlias ?? '').trim()
  if (alias === currentAlias) return true

  machineAliasSavingId.value = mid
  machineAliasError.value = ''
  try {
    const res = await apiFetch(`/api/machines/${encodeURIComponent(mid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ alias })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
    if (data?.machine) {
      upsertMachineRow(data.machine)
      machineAliasDrafts[mid] = String(data.machine?.machineAlias ?? '')
    } else {
      machineAliasDrafts[mid] = alias
    }
    return true
  } catch (err) {
    machineAliasError.value = String(err?.message ?? err)
    return false
  } finally {
    machineAliasSavingId.value = null
  }
}

async function steerQueuedPrompt(promptId) {
  const sessionId = String(selectedSessionId.value ?? '').trim()
  if (!sessionId || !promptId) return false
  return await sendQueuedPromptNow(sessionId, promptId)
}

function queuedPromptId(queued) {
  return String(queued?.promptId ?? queued?.id ?? '').trim()
}

function queuedPromptAttachmentSummary(queued) {
  const attachments = Array.isArray(queued?.attachments) ? queued.attachments : []
  if (!attachments.length) return ''
  const filenames = attachments
    .map((attachment) => String(attachment?.filename ?? '').trim())
    .filter(Boolean)
  const label = filenames.slice(0, 2).join(', ')
  if (attachments.length <= 2) return label
  return label ? `${label}, +${attachments.length - 2} more` : `${attachments.length} attachments`
}

function beginQueuedPromptEdit(queued) {
  const promptId = queuedPromptId(queued)
  if (!promptId) return
  queuedPromptEditingId.value = promptId
  queuedPromptEditDraft.value = String(queued?.text ?? '')
}

function cancelQueuedPromptEdit() {
  queuedPromptEditingId.value = null
  queuedPromptEditDraft.value = ''
}

function isQueuedPromptEditing(queued) {
  return queuedPromptId(queued) === String(queuedPromptEditingId.value ?? '').trim()
}

async function saveQueuedPromptText(queued) {
  const sessionId = String(selectedSessionId.value ?? '').trim()
  const promptId = queuedPromptId(queued)
  if (!sessionId || !promptId) return false
  const ok = await updateQueuedPromptText(sessionId, promptId, queuedPromptEditDraft.value)
  if (ok) cancelQueuedPromptEdit()
  return ok
}

async function deleteQueuedPrompt(promptId) {
  const sessionId = String(selectedSessionId.value ?? '').trim()
  if (!sessionId || !promptId) return false
  return await removeQueuedPrompt(sessionId, promptId)
}

function diffStepSelectedPath(stepId, files) {
  return diffStepSelectedPathHelper(stepId, files, selectedStore.value)
}

function setDiffStepSelectedPath(stepId, path) {
  setDiffStepSelectedPathHelper(stepId, path, selectedStore.value)
}

function diffStepSelectedFile(stepId, files) {
  return diffStepSelectedFileHelper(stepId, files, selectedStore.value)
}

function diffStepFiles(step) {
  return parseUnifiedDiff(String(step?.raw ?? ''))
}

const chatMessages = computed(() => buildChatMessages(selectedStore.value ?? null))

watch(
  () => [selectedSessionId.value, Number(selectedStore.value?.messageViewVersion ?? 0)],
  ([sessionId]) => {
    if (!sessionId) return
    for (const message of chatMessages.value) {
      if (message?.stepKind !== 'background') continue
      if (!message.expanded || !message.hasReasoning || !message.turnId) continue
      const reasoning = message.reasoning
      if (reasoning?.loaded || reasoning?.loading) continue
      ensureTurnReasoningLoaded(sessionId, message.turnId).catch(() => {})
    }
  },
  { flush: 'post' }
)

const {
  ensureDefaultsReady,
  clearComposerAttachments,
  openFilePicker,
  onFilesPicked,
  onComposerPaste,
  onComposerDragEnter,
  onComposerDragLeave,
  onComposerDrop,
  removeAttachment,
  createSessionFromDraft,
  sendQueuedPromptNow,
  updateQueuedPromptText,
  removeQueuedPrompt,
  submit,
  stopSession,
  stopGenerating
} = createComposerSessionActions({
  apiFetch,
  defaults,
  defaultsError,
  openSettings,
  attachments,
  composerDragging,
  fileInputEl,
  sendError,
  messageDraft,
  sending,
  getSessionStore,
  selectedSession,
  selectedSessionId
})

const {
  openNewThreadDialog: openNewThreadDialogBase,
  closeNewThreadDialog: closeNewThreadDialogBase,
  loadNewThreadBrowse: loadNewThreadBrowseBase,
  openNewThreadBrowse,
  selectNewThreadBrowseFolder,
  confirmNewThreadDialog,
  onNewThreadMachineChanged
} = createNewThreadDialogActions({
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
})

function normalizeDirectoryPath(path) {
  const text = String(path ?? '').trim()
  if (!text) return ''
  if (text === '/') return '/'
  return text.replace(/\/+$/, '') || '/'
}

function parentDirectoryPath(path) {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized || normalized === '/') return ''
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx) || '/'
}

function buildAncestorDirectories(path) {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized || normalized === '/') return []
  const parts = normalized.split('/').filter(Boolean)
  const out = []
  let current = ''
  for (let i = 0; i < Math.max(0, parts.length - 1); i += 1) {
    current += `/${parts[i]}`
    out.push(current)
  }
  return out
}

function syncNewThreadTreeRoot() {
  const rootPath = String(newThreadBrowsePath.value ?? '').trim()
  newThreadTreeDirectoryEntries.clear()
  newThreadTreeExpandedDirs.clear()
  newThreadTreeLoadingDirs.clear()
  if (!rootPath) return
  newThreadTreeDirectoryEntries.set(rootPath, Array.isArray(newThreadBrowseEntries.value) ? newThreadBrowseEntries.value : [])
  newThreadTreeExpandedDirs.add(rootPath)
}

async function loadNewThreadBrowse(path) {
  await loadNewThreadBrowseBase(path)
  syncNewThreadTreeRoot()
}

async function ensureNewThreadTreeDirLoaded(path) {
  const machineId = String(newThreadMachineId.value ?? '').trim()
  const targetPath = normalizeDirectoryPath(path)
  if (!machineId || !targetPath || newThreadTreeDirectoryEntries.has(targetPath) || newThreadTreeLoadingDirs.has(targetPath)) return
  newThreadTreeLoadingDirs.add(targetPath)
  try {
    newThreadBrowseError.value = ''
    const res = await apiFetch(`/api/fs/list?machineId=${encodeURIComponent(machineId)}&path=${encodeURIComponent(targetPath)}`)
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
    newThreadTreeDirectoryEntries.set(targetPath, Array.isArray(data?.entries) ? data.entries : [])
  } catch (err) {
    newThreadBrowseError.value = String(err?.message ?? err)
  } finally {
    newThreadTreeLoadingDirs.delete(targetPath)
  }
}

async function toggleNewThreadTreeDir(path) {
  const targetPath = normalizeDirectoryPath(path)
  if (!targetPath) return
  if (newThreadTreeExpandedDirs.has(targetPath)) {
    newThreadTreeExpandedDirs.delete(targetPath)
    return
  }
  newThreadTreeExpandedDirs.add(targetPath)
  await ensureNewThreadTreeDirLoaded(targetPath)
}

function scrollNewThreadFolderIntoView(path) {
  const targetPath = normalizeDirectoryPath(path)
  if (!targetPath) return
  nextTick(() => {
    const escape = (globalThis.CSS && typeof globalThis.CSS.escape === 'function')
      ? globalThis.CSS.escape
      : (value) => String(value).replace(/["\\]/g, '\\$&')
    const el = document.querySelector(`[data-folder-path="${escape(targetPath)}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  })
}

async function focusNewThreadFolder(path) {
  const targetPath = normalizeDirectoryPath(path)
  if (!targetPath) {
    newThreadCwd.value = ''
    await loadNewThreadBrowse(NEW_THREAD_ROOT_PATH)
    return
  }
  await loadNewThreadBrowse(NEW_THREAD_ROOT_PATH)
  for (const dirPath of buildAncestorDirectories(targetPath)) {
    newThreadTreeExpandedDirs.add(dirPath)
    await ensureNewThreadTreeDirLoaded(dirPath)
  }
  newThreadCwd.value = targetPath
  scrollNewThreadFolderIntoView(targetPath)
}

async function selectNewThreadFolder(path) {
  const targetPath = normalizeDirectoryPath(path)
  if (!targetPath) return
  newThreadCwd.value = targetPath
  newThreadTreeExpandedDirs.add(targetPath)
  await ensureNewThreadTreeDirLoaded(targetPath)
  scrollNewThreadFolderIntoView(targetPath)
}

function useRecentWorkspaceForNewThread(path) {
  focusNewThreadFolder(path).catch(() => {})
}

function openNewThreadDialog() {
  forceEmptyHomeScreen.value = false
  suppressAutoNewThreadScreen.value = false
  defaultsOpen.value = false
  workspacePaneOpen.value = false
  openNewThreadDialogBase()
  syncNewThreadTreeRoot()
  if (String(newThreadCwd.value ?? '').trim()) {
    focusNewThreadFolder(newThreadCwd.value).catch(() => {})
  } else {
    loadNewThreadBrowse(NEW_THREAD_ROOT_PATH).catch(() => {})
  }
  if (isMobileLayout.value) mobilePane.value = 'session'
}

function closeNewThreadDialog() {
  suppressAutoNewThreadScreen.value = true
  if (!String(selectedSessionId.value ?? '').trim()) forceEmptyHomeScreen.value = true
  closeNewThreadDialogBase()
  newThreadTreeDirectoryEntries.clear()
  newThreadTreeExpandedDirs.clear()
  newThreadTreeLoadingDirs.clear()
  if (isMobileLayout.value) showMobileSessionList()
}

function showInitialNewThreadIfNeeded() {
  if (!shouldAutoOpenNewThreadScreen({
    authed: authed.value,
    suppressAutoNewThreadScreen: suppressAutoNewThreadScreen.value,
    selectedSessionId: selectedSessionId.value,
    deepLinkSessionId: deepLinkSessionId.value,
    hasCompleteDefaultWorkspaceSelection: hasCompleteDefaultWorkspaceSelection.value,
    isMobileLayout: isMobileLayout.value,
    forceEmptyHomeScreen: forceEmptyHomeScreen.value
  })) return
  if (newThreadOpen.value || defaultsOpen.value) return
  openNewThreadDialog()
}

onLoginConnect = () => {
  connectSse()
  if (deepLinkSessionId.value) {
    openSession(deepLinkSessionId.value)
    deepLinkSessionId.value = null
    return
  }
  showInitialNewThreadIfNeeded()
}

watch(
  () => [authed.value, appSettingsLoaded.value, String(appSettings.notifications?.webPush ?? '')],
  ([isAuthed, settingsLoaded, webPushPolicy]) => {
    if (!isAuthed || !settingsLoaded) return
    if (String(webPushPolicy ?? '').trim() === 'never') return
    autoEnablePushOnLoad({ force: true }).catch(() => {})
  },
  { immediate: true }
)

watch(
  () => mainPaneMode.value,
  (mode) => {
    if (mode !== 'new-thread') return
    if (newThreadOpen.value) return
    openNewThreadDialog()
  },
  { immediate: true, flush: 'post' }
)

watch(newThreadMachineId, () => {
  onNewThreadMachineChanged()
  if (!String(newThreadMachineId.value ?? '').trim()) {
    newThreadBrowsePath.value = ''
    newThreadBrowseParent.value = null
    newThreadBrowseEntries.value = []
    newThreadBrowseError.value = ''
    newThreadTreeDirectoryEntries.clear()
    newThreadTreeExpandedDirs.clear()
    newThreadTreeLoadingDirs.clear()
    return
  }
  const targetPath = String(newThreadCwd.value ?? '').trim()
  if (targetPath) {
    focusNewThreadFolder(targetPath).catch(() => {})
    return
  }
  loadNewThreadBrowse(NEW_THREAD_ROOT_PATH).catch(() => {})
})

function updateSessionListMetrics() {
  const el = sessionListScrollEl.value
  if (!el) return
  sessionListScrollTop.value = el.scrollTop
  sessionListViewportHeight.value = Math.max(240, Number(el.clientHeight) || 720)
  if (sessionListHasMore.value && (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 800)) {
    loadMoreSessions().catch(() => {})
  }
}

function onSessionListScroll() {
  updateSessionListMetrics()
}

function chatNearBottom(el, threshold = 80) {
  if (!el) return true
  return (el.scrollTop + el.clientHeight) >= (el.scrollHeight - threshold)
}

function clampChatScrollTop(el, value) {
  if (!el) return 0
  const maxTop = Math.max(0, Number(el.scrollHeight ?? 0) - Number(el.clientHeight ?? 0))
  const top = Number(value ?? 0)
  return Math.max(0, Math.min(maxTop, Number.isFinite(top) ? top : 0))
}

function captureChatScrollSnapshot(sessionId = selectedSessionId.value) {
  const sid = String(sessionId ?? '').trim()
  const el = chatScrollEl.value
  if (!sid || !el) return null
  return {
    sessionId: sid,
    scrollTop: Number(el.scrollTop ?? 0) || 0,
    stickToBottom: Boolean(stickToBottom.value)
  }
}

function rememberChatScrollState(sessionId = selectedSessionId.value, snapshot = null) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return null
  const store = getSessionStore(sid)
  const state = snapshot ?? captureChatScrollSnapshot(sid)
  if (!state) return store
  store.chatScrollTop = Math.max(0, Number(state.scrollTop ?? 0) || 0)
  store.chatStickToBottom = Boolean(state.stickToBottom)
  return store
}

async function restoreChatScrollState(sessionId = selectedSessionId.value, snapshot = null) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return
  await nextTick()
  await waitForNextPaint()
  const el = chatScrollEl.value
  if (!el) return

  const store = getSessionStore(sid)
  const state = (snapshot && String(snapshot.sessionId ?? '').trim() === sid)
    ? snapshot
    : {
        sessionId: sid,
        scrollTop: Number(store.chatScrollTop ?? 0) || 0,
        stickToBottom: Boolean(store.chatStickToBottom ?? true)
      }

  if (state.stickToBottom) {
    el.scrollTop = el.scrollHeight
    await waitForNextPaint()
    el.scrollTop = el.scrollHeight
    stickToBottom.value = true
  } else {
    const top = clampChatScrollTop(el, state.scrollTop)
    el.scrollTop = top
    await waitForNextPaint()
    el.scrollTop = clampChatScrollTop(el, top)
    stickToBottom.value = chatNearBottom(el)
  }

  store.chatScrollTop = Math.max(0, Number(el.scrollTop ?? 0) || 0)
  store.chatStickToBottom = Boolean(stickToBottom.value)
}

function onChatScroll() {
  const el = chatScrollEl.value
  if (!el) return
  // Preload earlier history before the user hits the top so it feels instant.
  if (selectedSessionId.value && el.scrollTop <= 500) {
    loadMoreBefore(selectedSessionId.value, { pages: 3, limit: 500 }).catch(() => {})
  }
  const nearBottom = chatNearBottom(el)
  const was = stickToBottom.value
  stickToBottom.value = nearBottom
  rememberChatScrollState(selectedSessionId.value, {
    sessionId: selectedSessionId.value,
    scrollTop: el.scrollTop,
    stickToBottom: nearBottom
  })
  if (!was && nearBottom && selectedSessionId.value) {
    scheduleMarkRead(selectedSessionId.value)
  }
}

function scrollToBottom() {
  const el = chatScrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  stickToBottom.value = true
  rememberChatScrollState(selectedSessionId.value, {
    sessionId: selectedSessionId.value,
    scrollTop: el.scrollTop,
    stickToBottom: true
  })
  if (selectedSessionId.value) scheduleMarkRead(selectedSessionId.value)
}

async function waitForNextPaint() {
  await new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

async function onChatAssetLoad() {
  if (!stickToBottom.value) return
  await nextTick()
  await waitForNextPaint()
  const el = chatScrollEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  await waitForNextPaint()
  el.scrollTop = el.scrollHeight
  rememberChatScrollState(selectedSessionId.value, {
    sessionId: selectedSessionId.value,
    scrollTop: el.scrollTop,
    stickToBottom: true
  })
}

watch(
  () => [selectedSessionId.value, Number(selectedStore.value?.messageViewVersion ?? 0)],
  async ([sessionId]) => {
    if (!sessionId || !stickToBottom.value) return
    await nextTick()
    await waitForNextPaint()
    const el = chatScrollEl.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    await waitForNextPaint()
    el.scrollTop = el.scrollHeight
    rememberChatScrollState(sessionId, {
      sessionId,
      scrollTop: el.scrollTop,
      stickToBottom: true
    })
    scheduleMarkRead(sessionId)
  },
  { flush: 'post' }
)

const {
  archiveSessionById,
  archiveCurrentSession,
  unarchiveSessionById,
  unarchiveFromArchiveModal,
  loadArchivedSessions,
  openDeleteModal,
  confirmDeleteSession,
  openDeleteMachineModal,
  confirmDeleteMachine
} = createSessionAdminActions({
  apiFetch,
  fetchAllSessionPages,
  machineIsOnline,
  machineRowsById,
  removeMachineLocal,
  removeSessionRow,
  onSelectedSessionDeleted: handleSelectedSessionDeleted,
  upsertSessionRow,
  selectedSessionId,
  sessions,
  archivedSessions,
  machines,
  archiveOpen,
  archiveLoading,
  archiveError,
  deleteOpen,
  deleteSessionId,
  deleteWorking,
  deleteError,
  deleteMachineOpen,
  deleteMachineId,
  deleteMachineWorking,
  deleteMachineError
})

function openSessionMenuEdit(session) {
  closeSessionMenu()
  openRenameSession(session)
}

function openSessionMenuDelete(sessionId) {
  closeSessionMenu()
  openDeleteModal(sessionId)
}

async function archiveFromSessionMenu(sessionId) {
  closeSessionMenu()
  await archiveSessionById(sessionId)
}

const {
  disconnectMachine,
  upgradeMachine,
  openVSCode,
  stopVSCode
} = createMachineControlActions({
  apiFetch,
  defaults,
  openSettings,
  selectedSession,
  machineDisconnectWorkingId,
  machineDisconnectError,
  machineUpgradeWorkingId,
  machineUpgradeError,
  appSettings,
  ideError,
  ideStarting,
  onIdeSessionStarted: (ideSession) => {
    if (!ideSession?.urlPath) return
    activeIdeSession.value = {
      ideId: ideSession.ideId ?? null,
      urlPath: ideSession.urlPath,
      cwd: ideSession.cwd ?? '',
      machineId: ideSession.machineId ?? null
    }
    workspacePaneOpen.value = true
    workspacePaneTab.value = 'code'
    ideFrameLoading.value = true
    if (isMobileLayout.value) mobilePane.value = 'workspace'
  }
})

function activateWorkspacePane(tab) {
  mobileWorkspaceMenuOpen.value = false
  workspacePaneOpen.value = true
  workspacePaneTab.value = tab
  if (isMobileLayout.value) mobilePane.value = 'workspace'
}

function restoreMobileSessionPane() {
  if (!isMobileLayout.value) return
  mobileWorkspaceMenuOpen.value = false
  workspacePaneOpen.value = false
  mobilePane.value = preferredMobilePane(selectedSessionId.value)
}

function buildWorkspaceQuery(pathname, { cwd = '', machineId = '', path = '', maxBytes = null } = {}) {
  const params = new URLSearchParams()
  const safeCwd = String(cwd ?? '').trim()
  const safeMachineId = String(machineId ?? '').trim()
  const safePath = String(path ?? '').trim()
  if (safeMachineId) params.set('machineId', safeMachineId)
  if (safeCwd) params.set('cwd', safeCwd)
  if (safePath) params.set('path', safePath)
  if (Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0) params.set('maxBytes', String(Number(maxBytes)))
  return `${pathname}?${params.toString()}`
}

function resolveWorkspaceContext() {
  const ctx = currentWorkspaceContext.value
  const cwd = String(ctx?.cwd ?? '').trim()
  if (!cwd) {
    ideError.value = 'Workspace (cwd) is required.'
    openSettings('machines')
    return null
  }
  return {
    cwd,
    machineId: String(ctx?.machineId ?? '').trim()
  }
}

async function loadWorkspaceFiles(path = null) {
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  workspaceFilesError.value = ''
  workspaceFilesLoading.value = true
  activateWorkspacePane('files')
  const targetPath = String(path ?? workspaceFilesPath.value ?? ctx.cwd).trim() || ctx.cwd
  try {
    const res = await apiFetch(buildWorkspaceQuery('/api/fs/list', {
      machineId: ctx.machineId,
      path: targetPath
    }) + '&includeFiles=1')
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      workspaceFilesError.value = data?.error ?? `HTTP ${res.status}`
      return false
    }
    workspaceFilesPath.value = String(data?.path ?? targetPath)
    const nextEntries = Array.isArray(data?.entries) ? data.entries : []
    workspaceDirectoryEntries.clear()
    workspaceExpandedDirs.clear()
    workspaceLoadingDirs.clear()
    workspaceDirectoryEntries.set(workspaceFilesPath.value, nextEntries)
    workspaceExpandedDirs.add(workspaceFilesPath.value)
    return true
  } catch (err) {
    workspaceFilesError.value = String(err?.message ?? err)
    return false
  } finally {
    workspaceFilesLoading.value = false
  }
}

async function ensureWorkspaceDirectoryLoaded(path, { activate = false } = {}) {
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  const targetPath = String(path ?? '').trim()
  if (!targetPath) return false
  if (workspaceDirectoryEntries.has(targetPath)) return true
  if (workspaceLoadingDirs.has(targetPath)) return true
  if (activate) activateWorkspacePane('files')
  workspaceLoadingDirs.add(targetPath)
  workspaceFilesError.value = ''
  try {
    const res = await apiFetch(buildWorkspaceQuery('/api/fs/list', {
      machineId: ctx.machineId,
      path: targetPath
    }) + '&includeFiles=1')
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      workspaceFilesError.value = data?.error ?? `HTTP ${res.status}`
      return false
    }
    workspaceDirectoryEntries.set(targetPath, Array.isArray(data?.entries) ? data.entries : [])
    return true
  } catch (err) {
    workspaceFilesError.value = String(err?.message ?? err)
    return false
  } finally {
    workspaceLoadingDirs.delete(targetPath)
  }
}

async function toggleWorkspaceDirectory(path) {
  const targetPath = String(path ?? '').trim()
  if (!targetPath) return false
  if (workspaceExpandedDirs.has(targetPath)) {
    workspaceExpandedDirs.delete(targetPath)
    return true
  }
  workspaceExpandedDirs.add(targetPath)
  return ensureWorkspaceDirectoryLoaded(targetPath)
}

async function loadWorkspaceFile(path) {
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  const targetPath = String(path ?? '').trim()
  if (!targetPath) return false
  workspaceFileError.value = ''
  workspaceFileLoading.value = true
  workspaceSelectedFilePath.value = targetPath
  try {
    const res = await apiFetch(buildWorkspaceQuery('/api/fs/read', {
      machineId: ctx.machineId,
      path: targetPath,
      maxBytes: 200_000
    }))
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      workspaceFileError.value = data?.error ?? `HTTP ${res.status}`
      workspaceSelectedFile.value = null
      return false
    }
    workspaceSelectedFile.value = data
    return true
  } catch (err) {
    workspaceFileError.value = String(err?.message ?? err)
    workspaceSelectedFile.value = null
    return false
  } finally {
    workspaceFileLoading.value = false
  }
}

async function refreshWorkspaceGit() {
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  workspaceGitError.value = ''
  workspaceGitLoading.value = true
  activateWorkspacePane('git')
  try {
    const res = await apiFetch(buildWorkspaceQuery('/api/git/status', {
      machineId: ctx.machineId,
      cwd: ctx.cwd
    }))
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      workspaceGitError.value = data?.error ?? `HTTP ${res.status}`
      return false
    }
    workspaceGitStatus.value = data
    return true
  } catch (err) {
    workspaceGitError.value = String(err?.message ?? err)
    return false
  } finally {
    workspaceGitLoading.value = false
  }
}

async function runWorkspaceGitMutation(pathname, body, { branch = false } = {}) {
  const workingRef = branch ? workspaceGitBranchWorking : workspaceGitActionWorking
  if (workingRef.value) return false
  workingRef.value = true
  workspaceGitError.value = ''
  try {
    const res = await apiFetch(pathname, {
      method: 'POST',
      body: JSON.stringify(body)
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
    await refreshWorkspaceGit()
    return true
  } catch (err) {
    workspaceGitError.value = String(err?.message ?? err)
    return false
  } finally {
    workingRef.value = false
  }
}

async function stageWorkspaceGitPaths(paths) {
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  return await runWorkspaceGitMutation('/api/git/stage', {
    machineId: ctx.machineId,
    cwd: ctx.cwd,
    paths
  })
}

async function unstageWorkspaceGitPaths(paths) {
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  return await runWorkspaceGitMutation('/api/git/unstage', {
    machineId: ctx.machineId,
    cwd: ctx.cwd,
    paths
  })
}

async function switchWorkspaceGitBranch(branchName) {
  const ctx = resolveWorkspaceContext()
  const branch = String(branchName ?? '').trim()
  if (!ctx || !branch) return false
  return await runWorkspaceGitMutation('/api/git/branch/switch', {
    machineId: ctx.machineId,
    cwd: ctx.cwd,
    branch
  }, { branch: true })
}

async function createWorkspaceGitBranch() {
  const ctx = resolveWorkspaceContext()
  const branch = String(workspaceGitBranchDraft.value ?? '').trim()
  if (!ctx || !branch) return false
  const ok = await runWorkspaceGitMutation('/api/git/branch/create', {
    machineId: ctx.machineId,
    cwd: ctx.cwd,
    branch
  }, { branch: true })
  if (ok) workspaceGitBranchDraft.value = ''
  return ok
}

function openGitFile(entry) {
  const ctx = resolveWorkspaceContext()
  const relPath = String(entry?.path ?? '').trim()
  if (!ctx || !relPath) return
  activateWorkspacePane('files')
  const absolutePath = relPath.startsWith('/') ? relPath : `${ctx.cwd.replace(/\/+$/, '')}/${relPath}`
  loadWorkspaceFiles(ctx.cwd).then(() => loadWorkspaceFile(absolutePath)).catch(() => {})
}

async function closeWorkspaceTerminalSession() {
  const terminalId = String(workspaceTerminalSession.value?.terminalId ?? '').trim()
  if (!terminalId) {
    workspaceTerminalSession.value = null
    return
  }
  const closing = terminalId
  workspaceTerminalSession.value = null
  workspaceTerminalInputBuffer = ''
  if (workspaceTerminalInputFlushTimer) {
    try { clearTimeout(workspaceTerminalInputFlushTimer) } catch {}
    workspaceTerminalInputFlushTimer = null
  }
  if (workspaceTerminalResizeTimer) {
    try { clearTimeout(workspaceTerminalResizeTimer) } catch {}
    workspaceTerminalResizeTimer = null
  }
  workspaceTerminalPendingResize = null
  try {
    await apiFetch(`/api/terminal/sessions/${encodeURIComponent(closing)}`, {
      method: 'DELETE'
    })
  } catch {
  }
}

function buildWorkspaceTerminalSessionFromPayload(data, fallback = null) {
  return createWorkspaceTerminalSession({
    terminalId: data?.terminalId ?? fallback?.terminalId ?? '',
    machineId: data?.machineId ?? fallback?.machineId ?? '',
    cwd: data?.cwd ?? fallback?.cwd ?? '',
    shell: data?.shell ?? fallback?.shell ?? '',
    cols: data?.cols ?? fallback?.cols ?? 80,
    rows: data?.rows ?? fallback?.rows ?? 24,
    outputText: data?.outputText ?? fallback?.outputText ?? '',
    outputVersion: data?.outputVersion ?? fallback?.outputVersion ?? 0,
    connected: data?.connected ?? fallback?.connected ?? false,
    exitCode: data?.exitCode ?? fallback?.exitCode ?? null,
    signal: data?.signal ?? fallback?.signal ?? null
  })
}

async function ensureWorkspaceTerminal({ cols = 80, rows = 24, reuse = true } = {}) {
  if (workspaceTerminalStarting.value) return false
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  workspaceTerminalError.value = ''
  activateWorkspacePane('terminal')

  if (
    workspaceTerminalSessionMatchesContext(workspaceTerminalSession.value, ctx)
    && workspaceTerminalSession.value?.connected
  ) {
    queueWorkspaceTerminalResize({ cols, rows })
    return true
  }

  await closeWorkspaceTerminalSession()

  const size = normalizeTerminalGeometry(cols, rows)
  const session = createWorkspaceTerminalSession({
    machineId: ctx.machineId,
    cwd: ctx.cwd,
    cols: size.cols,
    rows: size.rows
  })
  workspaceTerminalStarting.value = true
  workspaceTerminalSession.value = session
  try {
    const res = await apiFetch('/api/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify({
        ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
        cwd: ctx.cwd,
        cols: size.cols,
        rows: size.rows,
        reuse
      })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      workspaceTerminalError.value = data?.error ?? `HTTP ${res.status}`
      workspaceTerminalSession.value = null
      return false
    }
    workspaceTerminalSession.value = buildWorkspaceTerminalSessionFromPayload(data, session)
    return true
  } catch (err) {
    workspaceTerminalError.value = String(err?.message ?? err)
    workspaceTerminalSession.value = null
    return false
  } finally {
    workspaceTerminalStarting.value = false
  }
}

function scheduleWorkspaceTerminalInputFlush() {
  if (workspaceTerminalInputFlushTimer) return
  workspaceTerminalInputFlushTimer = setTimeout(async () => {
    workspaceTerminalInputFlushTimer = null
    const terminalId = String(workspaceTerminalSession.value?.terminalId ?? '').trim()
    const data = workspaceTerminalInputBuffer
    workspaceTerminalInputBuffer = ''
    if (!terminalId || !data) return
    try {
      await apiFetch(`/api/terminal/sessions/${encodeURIComponent(terminalId)}/input`, {
        method: 'POST',
        body: JSON.stringify({ data })
      })
    } catch {
    }
  }, 8)
}

function sendWorkspaceTerminalInput(data) {
  const text = String(data ?? '')
  if (!text || !workspaceTerminalSession.value?.connected) return
  workspaceTerminalInputBuffer += text
  scheduleWorkspaceTerminalInputFlush()
}

function queueWorkspaceTerminalResize({ cols, rows }) {
  if (!workspaceTerminalSession.value?.terminalId) return
  workspaceTerminalPendingResize = normalizeTerminalGeometry(cols, rows)
  if (workspaceTerminalResizeTimer) return
  workspaceTerminalResizeTimer = setTimeout(async () => {
    workspaceTerminalResizeTimer = null
    const terminalId = String(workspaceTerminalSession.value?.terminalId ?? '').trim()
    const nextSize = workspaceTerminalPendingResize
    workspaceTerminalPendingResize = null
    if (!terminalId || !nextSize) return
    workspaceTerminalSession.value.cols = nextSize.cols
    workspaceTerminalSession.value.rows = nextSize.rows
    try {
      await apiFetch(`/api/terminal/sessions/${encodeURIComponent(terminalId)}/resize`, {
        method: 'POST',
        body: JSON.stringify(nextSize)
      })
    } catch {
    }
  }, 40)
}

async function onWorkspaceTerminalReady(size) {
  await ensureWorkspaceTerminal(size)
}

async function reopenWorkspaceTerminal() {
  const size = normalizeTerminalGeometry(
    workspaceTerminalSession.value?.cols,
    workspaceTerminalSession.value?.rows
  )
  await closeWorkspaceTerminalSession()
  await ensureWorkspaceTerminal({ ...size, reuse: false })
}

async function openWorkspaceTool(tab) {
  mobileWorkspaceMenuOpen.value = false
  if (tab === 'files') {
    await loadWorkspaceFiles()
    return
  }
  if (tab === 'git') {
    await refreshWorkspaceGit()
    return
  }
  if (tab === 'terminal') {
    workspaceTerminalError.value = ''
    activateWorkspacePane('terminal')
    if (workspaceTerminalSession.value?.terminalId && workspaceTerminalSession.value?.connected) return
    if (workspaceTerminalSession.value?.terminalId && !workspaceTerminalSession.value?.connected) {
      await reopenWorkspaceTerminal()
      return
    }
    return
  }
  await openWorkspace()
}

function workspaceToolButtonClass(tab) {
  const active = showWorkspacePane.value && workspacePaneTab.value === tab
  return active
    ? 'border-black bg-black text-white hover:bg-black'
    : 'border-black/[0.06] bg-white text-slate-700 hover:bg-black/[0.03]'
}

function mobileWorkspaceMenuItemClass(tab) {
  const active = workspacePaneOpen.value && workspacePaneTab.value === tab
  return active
    ? 'bg-slate-900 text-white'
    : 'text-slate-700 hover:bg-black/[0.04]'
}

async function openWorkspace() {
  mobileWorkspaceMenuOpen.value = false
  ideError.value = ''
  activateWorkspacePane('code')
  const ctx = resolveWorkspaceContext()
  if (!ctx) return false
  if (
    activeIdeSession.value
    && String(activeIdeSession.value.cwd ?? '') === ctx.cwd
    && String(activeIdeSession.value.machineId ?? '') === ctx.machineId
  ) {
    ideFrameLoading.value = false
    return true
  }
  const existingIdeId = String(activeIdeSession.value?.ideId ?? '').trim()
  if (existingIdeId) {
    await stopVSCode(existingIdeId)
    activeIdeSession.value = null
    ideFrameLoading.value = false
  }
  return await openVSCode()
}

async function closeWorkspacePane() {
  mobileWorkspaceMenuOpen.value = false
  ideError.value = ''
  const existingIdeId = String(activeIdeSession.value?.ideId ?? '').trim()
  await closeWorkspaceTerminalSession()
  workspacePaneOpen.value = false
  activeIdeSession.value = null
  ideFrameLoading.value = false
  if (isMobileLayout.value) restoreMobileSessionPane()
  if (existingIdeId) await stopVSCode(existingIdeId)
}

function onIdeFrameLoad() {
  ideFrameLoading.value = false
}

const {
  openRenameSession,
  saveRenameSession,
  approvalAllows,
  approvalExtraActions,
  respondApproval,
  submitUserInput,
  cancelUserInput
} = createSessionDialogActions({
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
  activeApproval: selectedComposerApproval,
  approvalQueue,
  approvalIds,
  approvalResponding,
  approvalRespondError,
  userInputSubmitting,
  userInputError,
  userInputForm
})

onMounted(async () => {
  refreshNotificationPermission()
  attachPwaInstallPrompt()
  try {
    const u = new URL(window.location.href)
    const sid = u.searchParams.get('session')
    if (sid) deepLinkSessionId.value = sid
  } catch {
  }

  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const onMsg = (ev) => {
      const data = ev?.data ?? null
      if (!data || typeof data !== 'object') return
      if (data.type !== 'navigate') return
      const sid = data.sessionId
      if (typeof sid === 'string' && sid) {
        openSession(sid)
      } else if (typeof data.url === 'string' && data.url) {
        try { window.location.href = data.url } catch { }
      }
    }
    swMessageHandler = onMsg
    try { navigator.serviceWorker.addEventListener('message', onMsg) } catch { }
  }

  try {
    const raw = localStorage.getItem('rootgrid.defaults')
    if (raw) Object.assign(defaults, JSON.parse(raw))
  } catch {
  }
  // Transient panes should never persist across a fresh app load.
  newThreadOpen.value = false
  defaultsOpen.value = false
  workspacePaneOpen.value = false
  queueAppViewportSync()
  refreshMobileLayout()
  desktopSidebarMode.value = readStoredDesktopSidebarMode()
  sessionSidebarWidth.value = readSessionSidebarWidth()
  workspaceChatWidth.value = readWorkspaceChatPaneWidth()

  watch(defaults, () => {
    try {
      localStorage.setItem('rootgrid.defaults', JSON.stringify(defaults))
    } catch {
    }
  }, { deep: true })

  // Network offline/online banner support.
  try {
    networkOnline.value = navigator.onLine
  } catch {
  }
  const onOnline = () => {
    networkOnline.value = true
    if (authed.value) connectSse()
  }
  const onOffline = () => {
    networkOnline.value = false
  }
  onlineHandler = onOnline
  offlineHandler = onOffline
  try { window.addEventListener('online', onOnline) } catch {}
  try { window.addEventListener('offline', onOffline) } catch {}
  const onResize = () => {
    const chatSnapshot = captureChatScrollSnapshot()
    queueAppViewportSync()
    refreshMobileLayout()
    applySessionSidebarWidth(sessionSidebarWidth.value)
    applyWorkspaceChatPaneWidth(workspaceChatWidth.value)
    updateSessionListMetrics()
    if (chatSnapshot) {
      restoreChatScrollState(chatSnapshot.sessionId, chatSnapshot).catch(() => {})
    }
  }
  windowResizeHandler = onResize
  try { window.addEventListener('resize', onResize) } catch {}
  const onPageShow = () => {
    queueAppViewportSync()
  }
  windowPageShowHandler = onPageShow
  try { window.addEventListener('pageshow', onPageShow) } catch {}
  if (window.visualViewport) {
    const onVisualViewportChange = () => {
      queueAppViewportSync()
    }
    visualViewportHandler = onVisualViewportChange
    try { window.visualViewport.addEventListener('resize', onVisualViewportChange) } catch {}
    try { window.visualViewport.addEventListener('scroll', onVisualViewportChange) } catch {}
  }

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      const hadMobileWorkspaceMenuOpen = mobileWorkspaceMenuOpen.value
      mobileWorkspaceMenuOpen.value = false
      composerContextPopoverOpen.value = false
      composerContextPopoverHover.value = false
      composerMachinePopoverOpen.value = false
      composerMachinePopoverHover.value = false
      desktopSidebarModeMenuOpen.value = false
      desktopSidebarFlyoutOpen.value = false
      if (hadMobileWorkspaceMenuOpen) return
      if (sessionSidebarDragging.value) stopSessionSidebarDrag()
      else if (workspaceSplitDragging.value) stopWorkspacePaneDrag()
      else if (workspacePaneOpen.value) closeWorkspacePane()
      if (sessionMenuId.value) closeSessionMenu()
      else if (renameOpen.value) renameOpen.value = false
      else if (newThreadOpen.value) closeNewThreadDialog()
      else if (defaultsOpen.value) defaultsOpen.value = false
      else if (deleteOpen.value) deleteOpen.value = false
      else if (deleteMachineOpen.value) deleteMachineOpen.value = false
    }
  }
  keydownHandler = onKeyDown
  window.addEventListener('keydown', onKeyDown)

  const onSessionMenuOutside = (ev) => {
    const target = ev?.target
    const inSessionMenu = Boolean(target?.closest?.('[data-session-menu-root="true"]'))
    const inContextPopover = Boolean(target?.closest?.('[data-context-usage-root="true"]'))
    const inMachinePopover = Boolean(target?.closest?.('[data-machine-upgrade-root="true"]'))
    const inSidebarModeMenu = Boolean(target?.closest?.('[data-sidebar-mode-root="true"]'))
    const inMobileWorkspaceMenu = Boolean(target?.closest?.('[data-mobile-workspace-menu-root="true"]'))
    if (!inSessionMenu) closeSessionMenu()
    if (!inContextPopover) {
      composerContextPopoverOpen.value = false
      composerContextPopoverHover.value = false
    }
    if (!inMachinePopover) {
      composerMachinePopoverOpen.value = false
      composerMachinePopoverHover.value = false
    }
    if (!inSidebarModeMenu) desktopSidebarModeMenuOpen.value = false
    if (!inMobileWorkspaceMenu) mobileWorkspaceMenuOpen.value = false
  }
  sessionMenuOutsideHandler = onSessionMenuOutside
  try { document.addEventListener('pointerdown', onSessionMenuOutside) } catch {}

  await nextTick()
  queueAppViewportSync()
  updateSessionListMetrics()
  if (typeof ResizeObserver === 'function') {
    try {
      sessionListResizeObserver = new ResizeObserver(() => updateSessionListMetrics())
      if (sessionListScrollEl.value) sessionListResizeObserver.observe(sessionListScrollEl.value)
    } catch {
    }
    try {
      chatResizeObserver = new ResizeObserver(() => {
        const sid = String(selectedSessionId.value ?? '').trim()
        if (!sid) return
        restoreChatScrollState(sid).catch(() => {})
      })
      if (chatScrollEl.value) chatResizeObserver.observe(chatScrollEl.value)
    } catch {
    }
  }

  const onVisibility = () => schedulePostVisibility()
  visibilityHandler = onVisibility
  try { document.addEventListener('visibilitychange', onVisibility) } catch {}
  try { window.addEventListener('focus', onVisibility) } catch {}
  try { window.addEventListener('blur', onVisibility) } catch {}

  nowTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 10_000)
  nowTimer.unref?.()

  heartbeatCheckTimer = setInterval(() => {
    if (!authed.value) return
    if (!networkOnline.value) return
    if (sseStatus.value !== 'connected') return
    const age = Date.now() - Number(lastSseMessageAt.value ?? 0)
    if (age > 95_000) {
      sseDisconnectReason.value = 'heartbeat-timeout'
      connectSse()
    }
  }, 5_000)

  await checkAuth()
  if (authed.value) {
    onLoginConnect()
  }
})

onBeforeUnmount(() => {
  clearComposerAttachments()
  disposeSse()
  disposePwaInstallPrompt()
  stopSessionSidebarDrag()
  stopWorkspacePaneDrag()
  if (workspaceTerminalInputFlushTimer) {
    try { clearTimeout(workspaceTerminalInputFlushTimer) } catch {}
    workspaceTerminalInputFlushTimer = null
  }
  if (workspaceTerminalResizeTimer) {
    try { clearTimeout(workspaceTerminalResizeTimer) } catch {}
    workspaceTerminalResizeTimer = null
  }
  try { sessionListResizeObserver?.disconnect?.() } catch {}
  sessionListResizeObserver = null
  try { chatResizeObserver?.disconnect?.() } catch {}
  chatResizeObserver = null
  if (nowTimer) {
    try { clearInterval(nowTimer) } catch {}
    nowTimer = null
  }
  if (heartbeatCheckTimer) {
    try { clearInterval(heartbeatCheckTimer) } catch {}
    heartbeatCheckTimer = null
  }
  if (keydownHandler) {
    window.removeEventListener('keydown', keydownHandler)
    keydownHandler = null
  }

  if (onlineHandler) {
    try { window.removeEventListener('online', onlineHandler) } catch {}
    onlineHandler = null
  }
  if (offlineHandler) {
    try { window.removeEventListener('offline', offlineHandler) } catch {}
    offlineHandler = null
  }
  if (windowResizeHandler) {
    try { window.removeEventListener('resize', windowResizeHandler) } catch {}
    windowResizeHandler = null
  }
  if (windowPageShowHandler) {
    try { window.removeEventListener('pageshow', windowPageShowHandler) } catch {}
    windowPageShowHandler = null
  }
  if (visualViewportHandler && window.visualViewport) {
    try { window.visualViewport.removeEventListener('resize', visualViewportHandler) } catch {}
    try { window.visualViewport.removeEventListener('scroll', visualViewportHandler) } catch {}
    visualViewportHandler = null
  }
  if (viewportSyncTimer) {
    try { clearTimeout(viewportSyncTimer) } catch {}
    viewportSyncTimer = null
  }

  if (visibilityHandler) {
    try { document.removeEventListener('visibilitychange', visibilityHandler) } catch {}
    try { window.removeEventListener('focus', visibilityHandler) } catch {}
    try { window.removeEventListener('blur', visibilityHandler) } catch {}
    visibilityHandler = null
  }

  if (swMessageHandler && typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try { navigator.serviceWorker.removeEventListener('message', swMessageHandler) } catch {}
    swMessageHandler = null
  }
  if (sessionMenuOutsideHandler) {
    try { document.removeEventListener('pointerdown', sessionMenuOutsideHandler) } catch {}
    sessionMenuOutsideHandler = null
  }
})

watch(
  () => visibleSessions.value.length,
  async () => {
    await nextTick()
    updateSessionListMetrics()
  }
)

watch(
  () => [currentWorkspaceContext.value.machineId, currentWorkspaceContext.value.cwd],
  ([machineId, cwd], [prevMachineId, prevCwd]) => {
    if (machineId === prevMachineId && cwd === prevCwd) return
    workspaceFilesPath.value = ''
    workspaceDirectoryEntries.clear()
    workspaceExpandedDirs.clear()
    workspaceLoadingDirs.clear()
    workspaceSelectedFilePath.value = ''
    workspaceSelectedFile.value = null
    workspaceFileError.value = ''
    const terminalSession = workspaceTerminalSession.value
    if (!terminalSession) return
    if (workspaceTerminalSessionMatchesContext(terminalSession, { machineId, cwd })) return
    const size = normalizeTerminalGeometry(terminalSession.cols, terminalSession.rows)
    closeWorkspaceTerminalSession().then(() => {
      if (workspacePaneOpen.value && workspacePaneTab.value === 'terminal' && String(cwd ?? '').trim()) {
        ensureWorkspaceTerminal(size).catch(() => {})
      }
    }).catch(() => {})
  }
)
</script>

<template>
  <div class="rg-app-shell bg-[#f7f7f4] text-slate-900" :style="appShellStyle">
    <div v-if="!authed" class="h-full flex flex-col">
      <div v-if="showPwaInstallPrompt" class="shrink-0 px-4 pt-4">
        <div class="mx-auto flex max-w-xl items-start justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/80 px-4 py-3 text-left shadow-sm">
          <div class="min-w-0">
            <div class="text-sm font-medium text-slate-900">Install Rootgrid</div>
            <div class="mt-0.5 text-xs leading-5 text-slate-600">{{ pwaInstallMessage }}</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              v-if="pwaInstallCanPrompt"
              class="inline-flex items-center rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="pwaInstallWorking"
              @click="triggerPwaInstallPrompt"
            >
              {{ pwaInstallWorking ? 'Opening…' : 'Install' }}
            </button>
            <button
              class="inline-flex items-center justify-center rounded-full p-1.5 text-slate-400 transition-colors hover:bg-black/[0.04] hover:text-slate-600"
              @click="dismissPwaInstallPrompt"
              aria-label="Dismiss install prompt"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div class="flex flex-1 items-center justify-center px-6 pb-6">
        <div class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div class="text-xl font-semibold tracking-tight text-slate-900">Rootgrid</div>
          <div class="mt-1 text-sm text-slate-600">Enter your client token to connect.</div>

          <div class="mt-6">
            <label class="text-xs uppercase tracking-wider text-slate-500">Client token</label>
            <input
              v-model="authToken"
              type="password"
              class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="paste token from ~/.rootgrid/config.json"
              @keydown.enter.prevent="login"
            />
            <div v-if="authError" class="mt-2 text-sm text-red-600">{{ authError }}</div>
          </div>

          <button
            class="mt-4 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
            @click="login"
          >
            Connect
          </button>
        </div>
      </div>
    </div>

    <div v-else class="h-full flex flex-col bg-white">
      <div
        v-if="showPwaInstallPrompt"
        class="shrink-0 border-b border-black/5 bg-indigo-50/70"
      >
        <div class="mx-auto flex max-w-3xl items-start justify-between gap-3 px-4 py-3 sm:px-6">
          <div class="min-w-0">
            <div class="text-sm font-medium text-slate-900">Install Rootgrid</div>
            <div class="mt-0.5 text-xs leading-5 text-slate-600">{{ pwaInstallMessage }}</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              v-if="pwaInstallCanPrompt"
              class="inline-flex items-center rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="pwaInstallWorking"
              @click="triggerPwaInstallPrompt"
            >
              {{ pwaInstallWorking ? 'Opening…' : 'Install' }}
            </button>
            <button
              class="inline-flex items-center justify-center rounded-full p-1.5 text-slate-400 transition-colors hover:bg-black/[0.04] hover:text-slate-600"
              @click="dismissPwaInstallPrompt"
              aria-label="Dismiss install prompt"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="connectionBanner"
        class="shrink-0 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60"
      >
        <div class="flex items-center justify-between gap-3 px-4 py-2 text-xs">
          <div class="min-w-0 truncate" :class="connectionBanner.tone === 'error' ? 'text-red-700' : 'text-amber-700'">
            {{ connectionBanner.text }}
          </div>
          <button
            class="shrink-0 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            @click="connectSse"
            :disabled="!networkOnline"
          >
            Reconnect
          </button>
        </div>
      </div>

      <div ref="layoutShellEl" class="flex flex-1 min-h-0 overflow-hidden">
        <div
          class="flex min-h-0 flex-1"
          :class="isMobileLayout ? 'h-full w-full flex-none shrink-0 overflow-hidden transition-transform duration-300 ease-out' : ''"
          :style="layoutTrackStyle"
        >
        <!-- Sidebar -->
        <aside
          class="relative bg-[#efefec]"
          :class="isMobileLayout
            ? 'min-h-0 h-full w-1/2 min-w-0 shrink-0 basis-1/2 overflow-hidden'
            : (desktopSidebarCompact ? 'min-h-0 shrink-0 overflow-visible' : 'min-h-0 shrink-0 overflow-hidden')"
          :style="sessionSidebarStyle"
          @mouseenter="openDesktopSidebarFlyout"
          @mouseleave="closeDesktopSidebarFlyout"
          @focusin="openDesktopSidebarFlyout"
          @focusout="closeDesktopSidebarFlyout"
        >
          <div
            v-if="desktopSidebarCompact"
            class="flex h-full w-full flex-col items-center gap-2 border-r border-black/[0.05] bg-[#efefec] px-1.5 py-3"
          >
            <button
              class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white text-slate-700 ring-1 ring-black/[0.06] transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
              @click="openNewThreadDialog"
              title="New thread"
            >
              <Plus class="h-4 w-4" />
            </button>

            <div class="flex-1 overflow-hidden pt-1">
              <div class="flex h-full flex-col items-center gap-2 overflow-y-auto pb-1">
                <button
                  v-for="session in compactSidebarPreviewSessions"
                  :key="session.sessionId"
                  class="relative inline-flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-semibold uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  :class="selectedSessionId === session.sessionId
                    ? 'bg-white text-slate-800 shadow-sm ring-1 ring-black/[0.08]'
                    : 'text-slate-500 hover:bg-white/75'"
                  :title="sessionTooltip(session)"
                  @click="openSession(session.sessionId)"
                >
                  <span>{{ sessionInitial(session) }}</span>
                  <span
                    class="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-2 ring-[#efefec]"
                    :class="indicatorDotClass(sessionIndicator(session))"
                  />
                </button>

                <div
                  v-if="compactSidebarOverflowCount"
                  class="pt-0.5 text-[10px] font-medium text-slate-400"
                  :title="`${compactSidebarOverflowCount} more threads`"
                >
                  +{{ compactSidebarOverflowCount }}
                </div>
              </div>
            </div>

            <button
              class="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white/75 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
              @click="openSettings('machines')"
              title="Settings"
            >
              <Settings class="h-4 w-4" />
            </button>

            <div class="relative" data-sidebar-mode-root="true">
              <button
                type="button"
                class="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white/75 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                title="Sidebar control"
                @click.stop="toggleDesktopSidebarModeMenu"
              >
                <Sidebar class="h-4 w-4" />
              </button>

              <div
                v-if="desktopSidebarModeMenuOpen"
                class="absolute bottom-0 left-full z-40 ml-2 w-44 rounded-2xl border border-black/[0.08] bg-white p-2 shadow-[0_12px_30px_rgba(15,23,42,0.14)]"
              >
                <div class="px-2 pb-1.5 text-[11px] font-medium text-slate-500">Sidebar control</div>
                <button
                  v-for="option in desktopSidebarModeOptions"
                  :key="option.value"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-[12px] text-slate-700 transition-colors hover:bg-black/[0.04]"
                  @click.stop="setDesktopSidebarMode(option.value)"
                >
                  <span class="inline-flex h-4 w-4 items-center justify-center">
                    <span
                      class="h-2 w-2 rounded-full"
                      :class="desktopSidebarMode === option.value ? 'bg-slate-800' : 'bg-transparent ring-1 ring-slate-300'"
                    />
                  </span>
                  <span class="truncate">{{ option.label }}</span>
                </button>
              </div>
            </div>
          </div>

          <div
            class="flex h-full flex-col bg-[#efefec]"
            :class="desktopSidebarCompact
              ? (desktopSidebarFlyoutVisible
                ? 'absolute inset-y-0 left-0 z-30 overflow-hidden rounded-r-[18px] border-r border-black/[0.05] opacity-100 shadow-[0_14px_32px_rgba(15,23,42,0.16)] pointer-events-auto translate-x-0 transition-all duration-150 ease-out'
                : 'absolute inset-y-0 left-0 z-30 overflow-hidden rounded-r-[18px] border-r border-black/[0.05] opacity-0 shadow-[0_14px_32px_rgba(15,23,42,0.16)] pointer-events-none -translate-x-2 transition-all duration-150 ease-out')
              : 'relative w-full'"
            :style="sessionSidebarPanelStyle"
          >
            <div class="shrink-0 px-3 pb-2 pt-3">
              <div class="space-y-0.5">
                <button
                  class="w-full inline-flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-700 transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  @click="openNewThreadDialog"
                >
                  <Plus class="h-3.5 w-3.5 text-slate-400" />
                  New thread
                </button>
              </div>
            </div>

            <div class="shrink-0 px-2 pb-2 pt-3">
              <div class="flex items-center justify-between gap-2 px-2">
                <div class="flex h-7 items-center text-[11px] text-slate-400">Threads</div>
                <button
                  class="inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-[11px] text-slate-400 transition-colors hover:bg-black/[0.04] hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  :class="sessionListGroupingMode === 'project' ? 'bg-black/[0.05] text-slate-700' : ''"
                  :title="sessionListGroupingMode === 'project' ? 'Show a flat thread list' : 'Group by host + project'"
                  @click="toggleSessionListGrouping"
                >
                  <FolderClosed class="h-3.5 w-3.5" />
                  {{ sessionListGroupingMode === 'project' ? 'Grouped' : 'Flat' }}
                </button>
              </div>
            </div>

            <div
              ref="sessionListScrollEl"
              class="flex-1 overflow-auto px-2 pb-2"
              @scroll="onSessionListScroll"
            >
              <div v-if="!hasSnapshot" class="space-y-2 px-2 py-2">
                <div
                  v-for="i in 7"
                  :key="i"
                  class="h-11 animate-pulse rounded-lg bg-slate-100"
                />
              </div>

              <div v-else>
                <div v-if="!visibleSessions.length" class="px-3 py-10 text-center text-xs text-slate-500">
                  No threads yet.
                </div>

                <div v-else>
                  <div v-if="visibleSessionWindow.offsetTop > 0" :style="{ height: `${visibleSessionWindow.offsetTop}px` }" />

                  <template v-for="entry in visibleSessionWindow.items" :key="entry.key">
                    <div
                      v-if="entry.kind === 'group'"
                      class="px-2.5 pb-1 pt-3"
                    >
                      <div
                        class="inline-flex min-w-0 max-w-full items-center rounded-full border border-black/[0.08] px-2 py-0.5 text-[10px] font-medium text-slate-500"
                        :title="`${entry.host} / ${entry.project}`"
                      >
                        <span class="truncate">{{ entry.host }} / {{ entry.project }}</span>
                      </div>
                    </div>

                    <button
                      v-else
                      class="group w-full rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400/30"
                      :class="selectedSessionId === entry.session.sessionId ? 'bg-[#ecece8]' : 'hover:bg-black/[0.035]'"
                      :title="sessionTooltip(entry.session)"
                      @click="openSession(entry.session.sessionId)"
                    >
                      <div class="flex items-start gap-2.5">
                        <span
                          class="mt-[0.38rem] h-2 w-2 shrink-0 rounded-full"
                          :class="indicatorDotClass(sessionIndicator(entry.session))"
                        />

                        <div class="min-w-0 flex-1">
                          <div class="flex items-center justify-between gap-2">
                            <div class="truncate text-[13px] font-medium text-slate-700">{{ sessionListTitle(entry.session) }}</div>
                            <div class="flex shrink-0 items-center gap-1">
                              <div
                                v-if="sessionListGroupingMode === 'project'"
                                class="text-[11px] text-slate-400"
                              >
                                {{ formatAgeShort(entry.session.updatedMs) }}
                              </div>
                              <div class="relative shrink-0" data-session-menu-root="true">
                                <button
                                  class="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-black/[0.05] hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                                  :class="sessionMenuId === entry.session.sessionId ? 'bg-black/[0.05] text-slate-600 opacity-100' : (isMobileLayout ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')"
                                  title="Thread actions"
                                  @click.stop="toggleSessionMenu(entry.session.sessionId)"
                                >
                                  <MoreHorizontal class="h-3.5 w-3.5" />
                                </button>

                                <div
                                  v-if="sessionMenuId === entry.session.sessionId"
                                  class="absolute right-0 top-7 z-20 w-44 rounded-xl border border-black/[0.06] bg-white p-1 shadow-lg shadow-black/10"
                                >
                                  <button
                                    class="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100"
                                    @click.stop="openSessionMenuEdit(entry.session)"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    class="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100"
                                    @click.stop="archiveFromSessionMenu(entry.session.sessionId)"
                                  >
                                    Archive
                                  </button>
                                  <button
                                    class="w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
                                    @click.stop="openSessionMenuDelete(entry.session.sessionId)"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div
                            v-if="sessionListGroupingMode !== 'project'"
                            class="mt-1 flex min-w-0 items-center justify-between gap-2 text-[11px] text-slate-400"
                          >
                            <span
                              class="inline-flex min-w-0 max-w-[170px] shrink-0 items-center rounded-full border border-black/[0.08] px-2 py-0.5 text-[10px] font-medium text-slate-500"
                              :title="`${sessionHostName(entry.session)} / ${sessionProject(entry.session)}`"
                            >
                              <span class="truncate">{{ sessionHostName(entry.session) }} / {{ sessionProject(entry.session) }}</span>
                            </span>
                            <span class="shrink-0 text-right">{{ formatAgeShort(entry.session.updatedMs) }}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  </template>

                  <div v-if="visibleSessionWindow.offsetBottom > 0" :style="{ height: `${visibleSessionWindow.offsetBottom}px` }" />
                  <div v-if="sessionListLoading || sessionListHasMore" class="px-3 py-2 text-center text-[11px] text-slate-400">
                    {{ sessionListLoading ? 'Loading more threads…' : 'Scroll for older threads' }}
                  </div>
                </div>
              </div>
            </div>

            <div class="relative z-20 shrink-0 p-2">
              <div class="space-y-1.5">
                <button
                  class="min-w-0 inline-flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  @click="openSettings('machines')"
                >
                  <Settings class="h-3.5 w-3.5" />
                  Settings
                </button>

                <div v-if="!isMobileLayout" class="relative w-full" data-sidebar-mode-root="true">
                  <button
                    type="button"
                    class="inline-flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                    title="Sidebar control"
                    @click.stop="toggleDesktopSidebarModeMenu"
                  >
                    <Sidebar class="h-3.5 w-3.5" />
                    Sidebar
                  </button>

                  <div
                    v-if="desktopSidebarModeMenuOpen"
                    class="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-2xl border border-black/[0.08] bg-white p-2 shadow-[0_12px_30px_rgba(15,23,42,0.14)]"
                  >
                    <div class="px-2 pb-1.5 text-[11px] font-medium text-slate-500">Sidebar control</div>
                    <button
                      v-for="option in desktopSidebarModeOptions"
                      :key="option.value"
                      type="button"
                      class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-[12px] text-slate-700 transition-colors hover:bg-black/[0.04]"
                      @click.stop="setDesktopSidebarMode(option.value)"
                    >
                      <span class="inline-flex h-4 w-4 items-center justify-center">
                        <span
                          class="h-2 w-2 rounded-full"
                          :class="desktopSidebarMode === option.value ? 'bg-slate-800' : 'bg-transparent ring-1 ring-slate-300'"
                        />
                      </span>
                      <span class="truncate">{{ option.label }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <div
          v-if="!isMobileLayout && !desktopSidebarCompact"
          class="group relative shrink-0 w-3 cursor-col-resize touch-none"
          title="Drag to resize the thread sidebar"
          @pointerdown.prevent="beginSessionSidebarDrag"
        >
          <div
            class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full transition-colors"
            :class="sessionSidebarDragging ? 'bg-slate-400/70' : 'bg-transparent group-hover:bg-slate-300/70'"
          />
        </div>

      <!-- Main -->
      <div
        ref="workspaceSplitEl"
        class="flex min-h-0 bg-white"
        :class="isMobileLayout ? 'min-h-0 h-full w-1/2 min-w-0 shrink-0 basis-1/2 overflow-hidden p-0' : 'flex-1 gap-1.5 p-1.5'"
      >
      <main
        class="min-h-0"
        :class="isMobileLayout
          ? 'h-full w-full min-w-0 max-w-full flex-1 overflow-hidden'
          : (showWorkspacePane ? 'min-w-0 shrink-0 grow-0' : 'min-w-0 flex-1')"
        :style="workspaceMainStyle"
      >
        <section
          v-if="!(isMobileLayout && mobilePane === 'workspace')"
          class="flex h-full min-w-0 flex-col overflow-hidden bg-white"
          :class="isMobileLayout ? 'w-full rounded-none shadow-none' : 'rounded-[16px] shadow-[0_1px_2px_rgba(0,0,0,0.03)]'"
        >
          <header class="bg-white px-4 py-2.5">
            <div v-if="mainPaneMode === 'chat'" class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex min-w-0 items-center gap-2">
                  <button
                    v-if="isMobileLayout"
                    class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                    title="Back to threads"
                    @click="showMobileSessionList"
                  >
                    <ArrowLeft class="h-4 w-4" />
                  </button>
                  <div v-if="selectedSession" class="min-w-0 flex items-center gap-2">
                    <button
                      class="truncate rounded text-[13px] font-semibold text-slate-800 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                      title="Rename thread"
                      @click="openRenameSession(selectedSession, { focus: 'title' })"
                    >
                      {{ sessionListTitle(selectedSession) }}
                    </button>
                  </div>
                  <div v-else class="truncate text-[13px] font-semibold text-slate-800">New thread</div>
                </div>
              </div>

              <div
                v-if="isMobileLayout"
                class="relative shrink-0"
                data-mobile-workspace-menu-root="true"
              >
                <button
                  class="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  title="Open workspace tools"
                  @click.stop="mobileWorkspaceMenuOpen = !mobileWorkspaceMenuOpen"
                >
                  <Menu class="h-4 w-4" />
                </button>

                <div
                  v-if="mobileWorkspaceMenuOpen"
                  class="absolute right-0 top-full z-30 mt-2 w-44 rounded-2xl border border-black/[0.08] bg-white p-2 shadow-[0_14px_36px_rgba(15,23,42,0.16)]"
                >
                  <button
                    class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    :class="mobileWorkspaceMenuItemClass('code')"
                    :disabled="ideStarting"
                    @click="openWorkspaceTool('code')"
                  >
                    <Loader2 v-if="ideStarting" class="h-3.5 w-3.5 animate-spin" />
                    <Code v-else class="h-3.5 w-3.5" />
                    Workspace
                  </button>
                  <button
                    class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] font-medium transition-colors"
                    :class="mobileWorkspaceMenuItemClass('terminal')"
                    @click="openWorkspaceTool('terminal')"
                  >
                    <Terminal class="h-3.5 w-3.5" />
                    Terminal
                  </button>
                  <button
                    class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] font-medium transition-colors"
                    :class="mobileWorkspaceMenuItemClass('files')"
                    @click="openWorkspaceTool('files')"
                  >
                    <FileText class="h-3.5 w-3.5" />
                    Files
                  </button>
                  <button
                    class="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12px] font-medium transition-colors"
                    :class="mobileWorkspaceMenuItemClass('git')"
                    @click="openWorkspaceTool('git')"
                  >
                    <GitBranch class="h-3.5 w-3.5" />
                    Git
                  </button>
                </div>
              </div>

              <div v-else class="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                <button
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  :class="workspaceToolButtonClass('code')"
                  @click="openWorkspace"
                  title="Open VS Code web (code-server)"
                  :disabled="ideStarting"
                >
                  <Loader2 v-if="ideStarting" class="h-3 w-3 animate-spin" />
                  <Code v-else class="h-3 w-3" />
                  Open
                </button>
                <button
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  :class="workspaceToolButtonClass('terminal')"
                  @click="openWorkspaceTool('terminal')"
                  title="Open terminal"
                >
                  <Terminal class="h-3 w-3" />
                  <span class="hidden sm:inline">Terminal</span>
                </button>
                <button
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  :class="workspaceToolButtonClass('files')"
                  @click="openWorkspaceTool('files')"
                  title="Open file viewer"
                >
                  <FileText class="h-3 w-3" />
                  <span class="hidden sm:inline">Files</span>
                </button>
                <button
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  :class="workspaceToolButtonClass('git')"
                  @click="openWorkspaceTool('git')"
                  title="Open git viewer"
                >
                  <GitBranch class="h-3 w-3" />
                  <span class="hidden sm:inline">Git</span>
                </button>
              </div>
            </div>

            <div v-else-if="mainPaneMode === 'new-thread' || mainPaneMode === 'settings'" class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex items-start gap-2">
                <button
                  v-if="isMobileLayout"
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  title="Back to threads"
                  @click="closeMainPaneScreen"
                >
                  <ArrowLeft class="h-4 w-4" />
                </button>
                <div class="min-w-0">
                  <div class="truncate text-[13px] font-semibold text-slate-800">
                    {{ mainPaneMode === 'new-thread' ? 'New thread' : 'Settings' }}
                  </div>
                  <div class="mt-0.5 truncate text-[11px] text-slate-500">
                    {{ mainPaneMode === 'new-thread' ? 'Choose a machine and workspace before starting.' : 'System, machines, and archived thread settings.' }}
                  </div>
                </div>
              </div>

              <button
                v-if="!isMobileLayout"
                class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                title="Close"
                @click="closeMainPaneScreen"
              >
                <X class="h-4 w-4" />
              </button>
            </div>

            <div v-else-if="mainPaneMode === 'empty'" class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex items-start gap-2">
                <button
                  v-if="isMobileLayout"
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  title="Back to threads"
                  @click="showMobileSessionList"
                >
                  <ArrowLeft class="h-4 w-4" />
                </button>
                <div class="min-w-0">
                  <div class="truncate text-[13px] font-semibold text-slate-800">Rootgrid</div>
                </div>
              </div>
            </div>
          </header>

          <div v-if="mainPaneMode === 'chat'" class="relative flex-1 min-h-0">
            <div
              ref="chatScrollEl"
              class="rg-chat-scroll absolute inset-0 overflow-x-hidden overflow-y-auto px-3 py-6 sm:px-4 sm:py-8 lg:px-6"
              :class="isMobileLayout ? 'rg-chat-scroll-mobile' : ''"
              @scroll="onChatScroll"
            >
              <div class="rg-chat-scroll-inner mx-auto w-full min-w-0 max-w-[700px]">
              <div v-if="selectedSessionId && sessionLoading" class="py-10">
                <div class="space-y-3 animate-pulse">
                  <div class="h-8 w-2/3 rounded-xl bg-slate-100" />
                  <div class="h-6 w-1/3 rounded-xl bg-slate-100" />
                  <div class="h-20 w-full rounded-2xl bg-slate-100" />
                  <div class="h-20 w-11/12 rounded-2xl bg-slate-100" />
                </div>
              </div>

              <div v-else-if="!selectedSessionId && !chatMessages.length" class="py-24 text-center">
                <div class="text-lg font-semibold text-slate-800">Start a thread</div>
                <div class="mt-2 text-sm text-slate-500">
                  Type a message below to start a new Codex session in your workspace.
                </div>
              </div>

              <div v-else-if="selectedSessionId && !chatMessages.length" class="py-24 text-center">
                <div class="text-sm font-medium text-slate-800">No messages yet</div>
                <div class="mt-2 text-sm text-slate-500">Waiting for events…</div>
              </div>

              <div v-else>
              <div v-if="selectedStore?.loadingBefore" class="pb-4 text-center text-xs text-slate-400">Loading earlier…</div>
              <transition-group :css="!selectedStore?.loadingBefore" name="rg-msg" tag="div" class="space-y-6">
                <div
                  v-for="m in chatMessages"
                  :key="m.id"
                  class="flex w-full min-w-0 max-w-full overflow-hidden"
                  :class="[
                    m.role === 'user' ? 'justify-end' : 'justify-start',
                    (m.stepKind === 'background' && m.active) ? '-mt-2' : ''
                  ]"
                >
                  <!-- Interleaved "step lines" (reasoning sections + tools) -->
                  <div v-if="m.role === 'step'" class="min-w-0 w-full">
                    <!-- Per-turn "Details" fold (reasoning + exploration) -->
                    <div
                      v-if="m.stepKind === 'background'"
                      class="group w-full"
                    >
                      <div v-if="m.expanded" class="mb-2 space-y-4 border-l border-slate-200 pl-4">
                        <div v-if="m.reasoning?.loading" class="text-xs text-slate-500">Loading reasoning…</div>
                        <div v-else-if="m.reasoning?.error" class="text-xs text-rose-700">{{ m.reasoning.error }}</div>

                        <div v-if="Array.isArray(m.timeline) && m.timeline.length" class="space-y-2">
                          <template v-for="it in m.timeline" :key="it.id">
                            <div
                              v-if="it.kind === 'reasoningText' || it.kind === 'commentaryText'"
                              class="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700"
                            >
                              {{ it.text }}
                            </div>
                            <details
                              v-else-if="it.kind === 'reasoning'"
                              class="group"
                              @toggle="onReasoningSectionToggle(m.turnId, $event)"
                            >
                              <summary class="cursor-pointer list-none select-none rounded-xl bg-black/[0.03] px-3 py-2 transition-colors hover:bg-black/[0.045]">
                                <div class="flex items-center justify-between gap-4">
                                  <div class="min-w-0 truncate text-sm">
                                    <span class="text-slate-800">{{ reasoningSectionSummaryParts(it.section).lead }}</span>
                                    <span v-if="reasoningSectionSummaryParts(it.section).detail" class="ml-1 text-slate-500">
                                      {{ reasoningSectionSummaryParts(it.section).detail }}
                                    </span>
                                  </div>
                                  <div class="shrink-0 text-slate-300 transition-colors group-hover:text-slate-400">
                                    <ChevronDown class="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                                  </div>
                                </div>
                              </summary>
                              <div
                                v-if="m.reasoning?.loadingBody && !String(it.section?.body ?? '').trim()"
                                class="mt-2 border-l border-slate-200 pl-4 text-xs text-slate-500"
                              >
                                Loading reasoning…
                              </div>
                              <div v-if="String(it.section?.body ?? '').trim()" class="mt-2 border-l border-slate-200 pl-4">
                                <MarkdownView :source="it.section.body" />
                              </div>
                            </details>
                            <details
                              v-else-if="it.kind === 'tool'"
                              class="group"
                              :open="it.expanded"
                              @toggle="onToolDetailsToggle(it.itemId, $event)"
                            >
                              <summary class="cursor-pointer list-none select-none rounded-xl bg-black/[0.03] px-3 py-2 transition-colors hover:bg-black/[0.045]">
                                <div class="flex items-center justify-between gap-4">
                                  <div class="min-w-0 truncate text-sm" :title="timelineToolSummary(it)">
                                    <span class="text-slate-800">{{ timelineToolSummaryParts(it).lead }}</span>
                                    <span v-if="timelineToolSummaryParts(it).detail" class="ml-1 text-slate-500">
                                      {{ timelineToolSummaryParts(it).detail }}
                                    </span>
                                  </div>
                                  <div v-if="timelineToolMeta(it)" class="shrink-0 text-xs text-slate-500">
                                    {{ timelineToolMeta(it) }}
                                  </div>
                                  <div v-else class="shrink-0 text-slate-300 transition-colors group-hover:text-slate-400">
                                    <ChevronDown class="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                                  </div>
                                </div>
                              </summary>

                              <div class="mt-2 space-y-3 border-l border-slate-200 pl-4">
                                <div
                                  v-if="it.tool === 'fileChange' && Array.isArray(it.changes) && it.changes.length"
                                  class="rounded-2xl border border-black/[0.06] bg-[#f3f3f0] p-3"
                                >
                                  <div class="text-[11px] uppercase tracking-wider text-slate-500">Files</div>
                                  <div class="mt-2 space-y-1 text-xs font-mono text-slate-800">
                                    <div v-for="(c, idx) in it.changes.slice(0, 50)" :key="idx" class="truncate" :title="c.path">{{ c.path }}</div>
                                    <div v-if="it.changes.length > 50" class="text-[11px] text-slate-500">…and {{ it.changes.length - 50 }} more</div>
                                  </div>
                                </div>

                                <div class="rounded-2xl border border-black/[0.06] bg-[#f3f3f0] p-3">
                                  <div class="flex items-center justify-between gap-3">
                                    <div class="text-[11px] uppercase tracking-wider text-slate-500">Output</div>
                                    <button
                                      v-if="it.output?.hasMoreBefore"
                                      class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                                      :disabled="it.output?.loading"
                                      @click="loadMoreToolOutputBefore(selectedSessionId, it.itemId)"
                                    >
                                      Load more
                                    </button>
                                  </div>

                                  <div v-if="!it.output" class="mt-2 text-xs text-slate-500">Loading…</div>
                                  <div v-else>
                                    <div v-if="it.output.loading" class="mt-2 text-xs text-slate-500">Loading…</div>

                                    <div v-if="it.output.stdout" class="mt-2">
                                      <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stdout</div>
                                      <pre class="rg-chat-local-x-scroll m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-black/[0.06] bg-white p-2 text-xs font-mono text-slate-800">{{ it.output.stdout }}</pre>
                                    </div>

                                    <div v-if="it.output.stderr" class="mt-2">
                                      <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stderr</div>
                                      <pre class="rg-chat-local-x-scroll m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-black/[0.06] bg-white p-2 text-xs font-mono text-slate-800">{{ it.output.stderr }}</pre>
                                    </div>

                                    <div v-if="!it.output.loading && !it.output.stdout && !it.output.stderr" class="mt-2 text-xs text-slate-500">
                                      (no output)
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </details>
                            <details
                              v-else-if="it.kind === 'diff'"
                              class="group"
                              :open="it.expanded"
                              @toggle="onDiffDetailsToggle(it.id, $event)"
                            >
                              <summary class="cursor-pointer list-none select-none rounded-xl bg-black/[0.03] px-3 py-2 transition-colors hover:bg-black/[0.045]">
                                <div class="flex items-center justify-between gap-4">
                                  <div class="min-w-0 truncate text-sm" :title="diffStepSummary(it).label">
                                    <span class="text-slate-800">{{ diffStepSummary(it).lead }}</span>
                                    <span v-if="diffStepSummary(it).detail" class="ml-1 text-slate-500">
                                      {{ diffStepSummary(it).detail }}
                                    </span>
                                  </div>
                                  <div
                                    v-if="diffStepSummary(it).added || diffStepSummary(it).removed"
                                    class="shrink-0 text-xs font-mono tabular-nums"
                                  >
                                    <span class="text-emerald-700">+{{ diffStepSummary(it).added }}</span>
                                    <span class="ml-2 text-rose-700">-{{ diffStepSummary(it).removed }}</span>
                                  </div>
                                </div>
                              </summary>

                              <div v-if="it.expanded" class="mt-2 overflow-hidden rounded-[20px] border border-black/[0.06] bg-[#f7f7f4]">
                                <div class="flex items-center gap-2 border-b border-black/[0.05] bg-[#f1f1ee] px-3 py-2">
                                  <div class="shrink-0 text-[11px] uppercase tracking-wider text-slate-500">Edited file</div>
                                  <select
                                    v-if="diffStepFiles(it).length > 1"
                                    :value="diffStepSelectedPath(it.id, diffStepFiles(it))"
                                    class="min-w-0 flex-1 rounded-md border border-black/[0.06] bg-white px-2 py-1 text-xs text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-400/20"
                                    @change="setDiffStepSelectedPath(it.id, $event.target.value)"
                                  >
                                    <option v-for="f in diffStepFiles(it)" :key="f.path" :value="f.path">{{ f.path }}</option>
                                  </select>
                                  <div v-else class="min-w-0 flex-1 truncate text-xs font-mono text-slate-800">
                                    {{ diffStepSelectedFile(it.id, diffStepFiles(it))?.path ?? '' }}
                                  </div>
                                  <button
                                    class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30"
                                    title="Copy diff"
                                    @click="copyText(diffStepSelectedFile(it.id, diffStepFiles(it))?.raw ?? it.raw ?? '')"
                                  >
                                    <Copy class="h-3.5 w-3.5" />
                                  </button>
                                </div>

                                <div v-if="!diffStepFiles(it).length" class="p-3">
                                  <pre class="m-0 whitespace-pre-wrap break-words text-xs font-mono text-slate-800">{{ it.raw ?? '' }}</pre>
                                </div>

                                <template v-else>
                                  <div class="border-b border-black/[0.05] px-3 py-2">
                                    <div class="min-w-0 truncate text-xs font-mono text-slate-800">
                                      {{ diffStepSelectedFile(it.id, diffStepFiles(it))?.path ?? '' }}
                                    </div>
                                  </div>

                                  <div class="rg-chat-local-x-scroll max-h-[520px] overflow-auto">
                                    <table class="w-full border-collapse text-xs font-mono">
                                      <tbody>
                                        <tr
                                          v-for="(l, idx) in (diffStepSelectedFile(it.id, diffStepFiles(it))?.lines ?? [])"
                                          :key="idx"
                                          :class="l.kind === 'add'
                                            ? 'bg-emerald-50/70'
                                            : (l.kind === 'del'
                                              ? 'bg-rose-50/70'
                                              : (l.kind === 'hunk' ? 'bg-[#f0f0ed]' : 'bg-[#fbfbfa]'))"
                                        >
                                          <td class="w-12 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400">{{ l.oldLine ?? '' }}</td>
                                          <td class="w-12 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400">{{ l.newLine ?? '' }}</td>
                                          <td class="pr-3 align-top">
                                            <pre
                                              class="m-0 whitespace-pre text-slate-800"
                                              :class="l.kind === 'hunk' ? 'text-slate-600' : ''"
                                            >{{ l.kind === 'hunk' ? l.text : l.text }}</pre>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                </template>
                              </div>
                            </details>
                            <div
                              v-else-if="it.kind === 'explore'"
                              class="flex items-center justify-between gap-4 rounded-xl bg-black/[0.03] px-3 py-2 text-sm"
                              :title="it.label"
                            >
                              <div class="min-w-0 truncate">
                                <span class="text-slate-800">{{ exploreSummaryParts(it).lead }}</span>
                                <span v-if="exploreSummaryParts(it).detail" class="ml-1 text-slate-500">
                                  {{ exploreSummaryParts(it).detail }}
                                </span>
                              </div>
                            </div>
                            <div
                              v-else-if="it.kind === 'error'"
                              class="rounded-xl bg-rose-50 px-3 py-2 text-sm"
                              :title="it.message"
                            >
                              <div class="min-w-0">
                                <span class="text-rose-800">{{ it.message || 'Error' }}</span>
                                <span v-if="it.willRetry" class="ml-1 text-rose-500">retrying…</span>
                              </div>
                              <div v-if="it.details" class="mt-1 whitespace-pre-wrap break-words text-xs text-rose-600">
                                {{ it.details }}
                              </div>
                              <div v-if="it.meta" class="mt-1 whitespace-pre-wrap break-words text-[11px] text-rose-500">
                                {{ it.meta }}
                              </div>
                            </div>
                          </template>

                          <div v-if="m.reasoning?.truncated" class="text-xs text-slate-500">(reasoning truncated)</div>
                        </div>

                        <div v-else-if="m.explore?.active" class="text-xs text-slate-500">
                          Exploring…
                        </div>
                      </div>

                      <button
                        type="button"
                        class="flex w-full items-center gap-2 text-left text-sm font-semibold leading-7 text-slate-700 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                        :class="m.active ? 'cursor-default' : 'cursor-pointer'"
                        @click="toggleBackgroundExpanded(m)"
                      >
                        <span>
                          <span v-if="m.active" class="rg-thinking-rainbow" aria-label="Thinking...">
                            <span
                              v-for="(ch, idx) in activeThinkingLabelChars"
                              :key="`thinking-char-${idx}`"
                              :style="{ animationDelay: `${(activeThinkingLabelChars.length - 1 - idx) * -90}ms` }"
                            >{{ ch }}</span>
                          </span>
                          <span v-else>{{ m.title || 'Thinking' }}</span>
                        </span>
                        <span v-if="!m.active" class="ml-auto inline-flex items-center text-slate-400 opacity-0 transition-opacity group-hover:opacity-100">
                          <ChevronUp v-if="m.expanded" class="h-3.5 w-3.5" />
                          <ChevronDown v-else class="h-3.5 w-3.5" />
                        </span>
                      </button>
                    </div>

                    <!-- Inline diffs (VS Code-like) -->
                    <details
                      v-else-if="m.stepKind === 'diff'"
                      class="group w-full"
                      :open="m.expanded"
                      @toggle="onDiffDetailsToggle(m.id, $event)"
                    >
                      <summary class="cursor-pointer select-none py-0.5">
                        <div class="flex items-center justify-between gap-4" :title="diffStepSummary(m).label">
                          <div class="min-w-0 truncate text-sm text-slate-800">
                            {{ diffStepSummary(m).label }}
                          </div>
                          <div
                            v-if="diffStepSummary(m).added || diffStepSummary(m).removed"
                            class="shrink-0 text-xs font-mono tabular-nums"
                          >
                            <span class="text-emerald-700">+{{ diffStepSummary(m).added }}</span>
                            <span class="ml-2 text-rose-700">-{{ diffStepSummary(m).removed }}</span>
                          </div>
                        </div>
                      </summary>

                      <div v-if="m.expanded" class="mt-2 overflow-hidden rounded-[20px] border border-black/[0.06] bg-[#f7f7f4]">
                        <div class="flex items-center gap-2 border-b border-black/[0.05] bg-[#f1f1ee] px-3 py-2">
                          <div class="shrink-0 text-[11px] uppercase tracking-wider text-slate-500">Edited file</div>
                          <select
                            v-if="diffStepFiles(m).length > 1"
                            :value="diffStepSelectedPath(m.id, diffStepFiles(m))"
                            class="min-w-0 flex-1 rounded-md border border-black/[0.06] bg-white px-2 py-1 text-xs text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-400/20"
                            @change="setDiffStepSelectedPath(m.id, $event.target.value)"
                          >
                            <option v-for="f in diffStepFiles(m)" :key="f.path" :value="f.path">{{ f.path }}</option>
                          </select>
                          <div v-else class="min-w-0 flex-1 truncate text-xs font-mono text-slate-800">
                            {{ diffStepSelectedFile(m.id, diffStepFiles(m))?.path ?? '' }}
                          </div>
                          <button
                            class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30"
                            title="Copy diff"
                            @click="copyText(diffStepSelectedFile(m.id, diffStepFiles(m))?.raw ?? m.raw ?? '')"
                          >
                            <Copy class="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div v-if="!diffStepFiles(m).length" class="p-3">
                          <pre class="m-0 whitespace-pre-wrap break-words text-xs font-mono text-slate-800">{{ m.raw ?? '' }}</pre>
                        </div>

                        <template v-else>
                          <div class="border-b border-black/[0.05] px-3 py-2">
                            <div class="min-w-0 truncate text-xs font-mono text-slate-800">
                              {{ diffStepSelectedFile(m.id, diffStepFiles(m))?.path ?? '' }}
                            </div>
                          </div>

                          <div class="rg-chat-local-x-scroll max-h-[520px] overflow-auto">
                            <table class="w-full border-collapse text-xs font-mono">
                              <tbody>
                                <tr
                                  v-for="(l, idx) in (diffStepSelectedFile(m.id, diffStepFiles(m))?.lines ?? [])"
                                  :key="idx"
                                  :class="l.kind === 'add'
                                    ? 'bg-emerald-50/70'
                                    : (l.kind === 'del'
                                      ? 'bg-rose-50/70'
                                      : (l.kind === 'hunk' ? 'bg-[#f0f0ed]' : 'bg-[#fbfbfa]'))"
                                >
                                  <td class="w-12 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400">{{ l.oldLine ?? '' }}</td>
                                  <td class="w-12 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400">{{ l.newLine ?? '' }}</td>
                                  <td class="pr-3 align-top">
                                    <pre
                                      class="m-0 whitespace-pre text-slate-800"
                                      :class="l.kind === 'hunk' ? 'text-slate-600' : ''"
                                    >{{ l.kind === 'hunk' ? l.text : l.text }}</pre>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </template>
                      </div>
                    </details>

                    <!-- Tool step -->
                    <details
                      v-else
                      class="group w-full"
                      :open="m.expanded"
                      @toggle="onToolDetailsToggle(m.itemId, $event)"
                    >
                      <summary class="cursor-pointer select-none flex items-center justify-between gap-4 py-0.5">
                        <div class="min-w-0 truncate text-sm text-slate-800" :title="timelineToolSummary(m)">
                          {{ timelineToolSummary(m) }}
                        </div>
                        <div class="shrink-0 text-xs text-slate-500">
                          {{ timelineToolMeta(m) }}
                        </div>
                      </summary>

                      <div class="mt-2 space-y-3 border-l border-slate-200 pl-4">
                        <div
                          v-if="m.tool === 'fileChange' && Array.isArray(m.changes) && m.changes.length"
                          class="rounded-2xl border border-black/[0.06] bg-[#f3f3f0] p-3"
                        >
                          <div class="text-[11px] uppercase tracking-wider text-slate-500">Files</div>
                          <div class="mt-2 space-y-1 text-xs font-mono text-slate-800">
                            <div v-for="(c, idx) in m.changes.slice(0, 50)" :key="idx" class="truncate" :title="c.path">{{ c.path }}</div>
                            <div v-if="m.changes.length > 50" class="text-[11px] text-slate-500">…and {{ m.changes.length - 50 }} more</div>
                          </div>
                        </div>

                        <div class="rounded-2xl border border-black/[0.06] bg-[#f3f3f0] p-3">
                          <div class="flex items-center justify-between gap-3">
                            <div class="text-[11px] uppercase tracking-wider text-slate-500">Output</div>
                            <button
                              v-if="m.output?.hasMoreBefore"
                              class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                              :disabled="m.output?.loading"
                              @click="loadMoreToolOutputBefore(selectedSessionId, m.itemId)"
                            >
                              Load more
                            </button>
                          </div>

                          <div v-if="!m.output" class="mt-2 text-xs text-slate-500">Loading…</div>
                          <div v-else>
                            <div v-if="m.output.loading" class="mt-2 text-xs text-slate-500">Loading…</div>

                            <div v-if="m.output.stdout" class="mt-2">
                              <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stdout</div>
                              <pre class="rg-chat-local-x-scroll m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-black/[0.06] bg-white p-2 text-xs font-mono text-slate-800">{{ m.output.stdout }}</pre>
                            </div>

                            <div v-if="m.output.stderr" class="mt-2">
                              <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">stderr</div>
                              <pre class="rg-chat-local-x-scroll m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-black/[0.06] bg-white p-2 text-xs font-mono text-slate-800">{{ m.output.stderr }}</pre>
                            </div>

                            <div v-if="!m.output.loading && !m.output.stdout && !m.output.stderr" class="mt-2 text-xs text-slate-500">
                              (no output)
                            </div>
                          </div>
                        </div>
                      </div>
                    </details>
                  </div>

                  <!-- System lines -->
                  <div v-else-if="m.role === 'system'" class="min-w-0 w-full text-xs">
                    <div
                      class="rounded-xl px-3 py-2"
                      :class="m.tone === 'error'
                        ? 'bg-rose-50 text-rose-700'
                        : 'text-slate-500'"
                    >
                      <div
                        class="mb-1 text-[10px] uppercase tracking-wider"
                        :class="m.tone === 'error' ? 'text-rose-500' : 'text-slate-400'"
                      >
                        {{ m.stream ?? 'system' }}
                      </div>
                      <pre class="m-0 whitespace-pre-wrap">{{ m.text }}</pre>
                    </div>
                  </div>

                  <!-- User + assistant bubbles -->
                  <div
                    v-else
                    class="min-w-0 max-w-full overflow-hidden text-sm leading-7 text-slate-700 transition-colors"
                    :class="m.role === 'user'
                      ? 'w-full max-w-full rounded-2xl bg-[#efefec] px-4 py-3 text-slate-700 shadow-sm sm:w-auto sm:max-w-[640px]'
                      : 'w-full min-w-0 max-w-full px-0 py-0 text-slate-700 sm:max-w-[640px]'"
                  >
                    <div v-if="m.role === 'assistant'" class="min-w-0 max-w-full overflow-hidden">
                      <div v-if="String(m.text ?? '').trim()" class="min-w-0 max-w-full overflow-hidden">
                        <MarkdownView :source="m.text" />
                      </div>
                    </div>
                    <div v-else class="min-w-0 max-w-full overflow-hidden">
                      <div v-if="Array.isArray(m.attachments) && m.attachments.length" class="mb-2 flex flex-wrap gap-2">
                        <a
                          v-for="a in m.attachments"
                          :key="a.uploadId ?? a.url ?? a.filename"
                          :href="a.url"
                          class="block max-w-[240px] sm:max-w-[320px]"
                          target="_blank"
                          rel="noopener noreferrer"
                          :title="a.filename"
                        >
                          <div
                            v-if="isImageType(a.mimeType)"
                            class="inline-flex max-w-full rounded-2xl bg-white p-1 ring-1 ring-slate-200 transition-colors hover:ring-slate-300"
                          >
                            <img
                              :src="a.url"
                              :alt="a.filename"
                              class="block max-h-44 max-w-full rounded-xl object-contain"
                              @load="onChatAssetLoad"
                            />
                          </div>
                          <div
                            v-else
                            class="flex h-12 max-w-[220px] items-center justify-center rounded-xl bg-white px-3 text-xs text-slate-800 ring-1 ring-slate-200 hover:ring-slate-300"
                          >
                            <div class="truncate">{{ a.filename }}</div>
                          </div>
                        </a>
                      </div>
                      <div v-if="String(m.text ?? '').trim()" class="whitespace-pre-wrap">{{ m.text }}</div>
                    </div>
                  </div>
                </div>
              </transition-group>
              </div>
              </div>
            </div>

            <button
              v-if="selectedSessionId && !stickToBottom"
              class="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 shadow-lg transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99]"
              @click="scrollToBottom"
              title="Scroll to bottom"
            >
              <ArrowDown class="h-4 w-4" />
              <span class="hidden sm:inline">New messages</span>
	            </button>
	          </div>

          <!-- Pinned plan checklist (Codex-style) -->
          <div v-if="mainPaneMode === 'chat' && pinnedPlanHasUnchecked" class="shrink-0 bg-white px-6 pb-3">
            <div class="mx-auto w-full max-w-[700px]">
              <div class="overflow-hidden rounded-[20px] border border-black/[0.05] bg-[#f5f5f2]">
                <button
                  class="flex w-full items-center justify-between gap-3 bg-[#f5f5f2] px-4 py-2 text-left text-xs text-slate-700 transition-colors hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                  type="button"
                  @click="togglePinnedPlanOpen"
                >
                  <div class="flex items-center gap-2">
                    <span class="inline-flex h-5 w-5 items-center justify-center rounded-md bg-white text-slate-700 ring-1 ring-black/5">
                      <CheckCircle2 class="h-3.5 w-3.5" />
                    </span>
                    <span class="font-medium">{{ pinnedPlanSummary }}</span>
                  </div>
                  <ChevronDown v-if="selectedStore?.planPinnedOpen" class="h-4 w-4 text-slate-500" />
                  <ChevronUp v-else class="h-4 w-4 text-slate-500" />
                </button>

                <div v-if="selectedStore?.planPinnedOpen" class="border-t border-black/[0.05] bg-[#fbfbfa] px-4 py-3">
                  <div class="space-y-2">
                    <div
                      v-for="(step, idx) in pinnedPlanSteps"
                      :key="idx"
                      class="flex items-start gap-2 text-sm"
                    >
                      <span class="mt-0.5 shrink-0">
                        <CheckCircle2 v-if="planStepIsCompleted(step)" class="h-4 w-4 text-emerald-600" />
                        <Circle v-else class="h-4 w-4 text-slate-400" />
                      </span>
                      <div class="min-w-0 flex-1">
                        <span class="mr-2 text-xs tabular-nums text-slate-500">{{ idx + 1 }}.</span>
                        <span
                          class="whitespace-pre-wrap"
                          :class="planStepIsCompleted(step) ? 'line-through text-slate-500' : 'text-slate-900'"
                        >
                          {{ step.step }}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else-if="mainPaneMode === 'empty'" class="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6 sm:py-8">
            <div class="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center text-center">
              <div class="text-lg font-semibold text-slate-800">No thread selected</div>
              <div class="mt-2 max-w-md text-sm text-slate-500">
                Choose a thread from the sidebar or start a new one.
              </div>
              <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30"
                  @click="openNewThreadDialog"
                >
                  <Plus class="h-4 w-4" />
                  New thread
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                  @click="openSettings('machines')"
                >
                  <Settings class="h-4 w-4" />
                  Settings
                </button>
              </div>
            </div>
          </div>

          <footer
            v-if="mainPaneMode === 'chat'"
            class="relative bg-white px-3 pb-3 pt-2 sm:px-4 sm:pb-4 lg:px-6"
            @dragenter.prevent="onComposerDragEnter"
            @dragleave.prevent="onComposerDragLeave"
            @dragover.prevent
            @drop.prevent="onComposerDrop"
          >
            <div class="mx-auto w-full max-w-[700px]">
              <div
                v-if="composerDragging"
                class="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-slate-900/30 bg-slate-900/5 text-sm font-medium text-slate-700"
              >
                Drop files to attach
              </div>
              <div v-if="ideError" class="mb-2 text-sm text-red-600">{{ ideError }}</div>
              <div v-if="sendError" class="mb-2 text-sm text-red-600">{{ sendError }}</div>
              <div v-if="composerOptionsError" class="mb-2 text-sm text-red-600">{{ composerOptionsError }}</div>
              <div v-if="modelCatalogError" class="mb-2 text-sm text-red-600">{{ modelCatalogError }}</div>
              <div
                v-if="!selectedComposerApproval && nextOtherPendingApproval"
                class="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm"
              >
                <div class="min-w-0">
                  <div class="text-[11px] font-semibold uppercase tracking-wider text-amber-700">Approval waiting elsewhere</div>
                  <div class="mt-1 text-amber-950">{{ nextOtherPendingApprovalLabel }}</div>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded-full bg-white px-3 py-1.5 text-[12px] font-medium text-amber-900 ring-1 ring-amber-200 transition-colors hover:bg-amber-100"
                  @click="nextOtherPendingApproval?.sessionId ? openSession(nextOtherPendingApproval.sessionId) : null"
                >
                  Open thread
                </button>
              </div>

              <div class="overflow-hidden rounded-[24px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-colors focus-within:border-black/[0.12] focus-within:ring-2 focus-within:ring-slate-400/20">
                <div
                  v-if="selectedComposerApproval"
                  class="border-b border-black/[0.06] bg-[#f5f5f2]"
                >
                  <div class="flex items-center justify-between gap-3 px-4 py-2 text-left text-xs text-slate-700">
                    <div class="min-w-0">
                      <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                        {{ approvalCardTitle(selectedComposerApproval) }}
                      </div>
                    </div>
                    <div
                      class="shrink-0"
                      :class="selectedComposerApproval.kind === 'userInput' ? 'text-right' : 'flex flex-wrap items-center justify-end gap-1'"
                    >
                      <template v-if="selectedComposerApproval.kind !== 'userInput'">
                        <button
                          v-if="approvalAllows('accept')"
                          type="button"
                          class="inline-flex h-6 items-center rounded-full bg-white px-2.5 text-[11px] font-medium leading-none text-emerald-700 ring-1 ring-emerald-300 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
                          :disabled="approvalResponding"
                          @click="respondApproval('accept', selectedComposerApproval)"
                        >
                          Accept
                        </button>
                        <button
                          v-for="a in approvalExtraActions"
                          :key="a.id"
                          type="button"
                          class="inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2"
                          :class="a.variant === 'emerald-solid'
                            ? 'bg-white text-slate-800 ring-1 ring-black/8 hover:bg-slate-50 focus-visible:ring-slate-500/30'
                            : (a.variant === 'red-outline'
                              ? 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50 focus-visible:ring-red-500/30'
                              : 'bg-white text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50 focus-visible:ring-emerald-500/30')"
                          :disabled="approvalResponding"
                          @click="respondApproval(a.decision, selectedComposerApproval)"
                        >
                          {{ a.label }}
                        </button>
                        <button
                          v-if="approvalAllows('cancel')"
                          type="button"
                          class="inline-flex h-6 items-center rounded-full bg-white px-2.5 text-[11px] font-medium leading-none text-slate-700 ring-1 ring-black/8 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          :disabled="approvalResponding"
                          @click="respondApproval('cancel', selectedComposerApproval)"
                        >
                          Cancel
                        </button>
                        <button
                          v-if="approvalAllows('decline')"
                          type="button"
                          class="inline-flex h-6 items-center rounded-full bg-white px-2.5 text-[11px] font-medium leading-none text-red-700 ring-1 ring-red-200 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                          :disabled="approvalResponding"
                          @click="respondApproval('decline', selectedComposerApproval)"
                        >
                          Decline
                        </button>
                      </template>
                      <button
                        v-if="otherPendingApprovalsCount"
                        type="button"
                        class="inline-flex h-6 items-center rounded-full bg-white px-2.5 text-[11px] font-medium leading-none text-slate-700 ring-1 ring-black/8 transition-colors hover:bg-slate-50"
                        @click="nextOtherPendingApproval?.sessionId ? openSession(nextOtherPendingApproval.sessionId) : null"
                      >
                        {{ otherPendingApprovalsCount }} more waiting
                      </button>
                    </div>
                  </div>

                  <div class="border-t border-black/[0.05] bg-[#fbfbfa] px-4 py-3">
                    <div v-if="selectedComposerApproval.kind === 'userInput'">
                      <div
                        v-if="Array.isArray(selectedComposerApproval.questions) && selectedComposerApproval.questions.length"
                        class="space-y-4"
                      >
                        <div v-for="(q, idx) in selectedComposerApproval.questions" :key="q?.id ?? idx">
                          <div v-if="q?.id && userInputForm[String(q.id)]">
                            <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                              {{ q.header || q.id }}
                            </div>
                            <div class="mt-1 whitespace-pre-wrap text-sm text-slate-900">{{ q.question }}</div>

                            <div v-if="Array.isArray(q.options) && q.options.length" class="mt-3 space-y-2">
                              <label
                                v-for="opt in q.options"
                                :key="opt.label"
                                class="flex cursor-pointer gap-3 rounded-2xl border border-black/[0.06] bg-white px-3 py-3 text-sm text-slate-800 transition-colors hover:bg-slate-50"
                              >
                                <input
                                  v-model="userInputForm[String(q.id)].choice"
                                  type="radio"
                                  class="mt-0.5 accent-slate-900"
                                  :name="`q-${q.id}`"
                                  :value="opt.label"
                                />
                                <div class="min-w-0">
                                  <div class="text-sm text-slate-900">{{ opt.label }}</div>
                                  <div class="text-xs text-slate-500">{{ opt.description }}</div>
                                </div>
                              </label>

                              <label
                                v-if="q.isOther"
                                class="flex cursor-pointer gap-3 rounded-2xl border border-black/[0.06] bg-white px-3 py-3 text-sm text-slate-800 transition-colors hover:bg-slate-50"
                              >
                                <input
                                  v-model="userInputForm[String(q.id)].choice"
                                  type="radio"
                                  class="mt-0.5 accent-slate-900"
                                  :name="`q-${q.id}`"
                                  value="__other__"
                                />
                                <div class="min-w-0 w-full">
                                  <div class="text-sm text-slate-900">Other</div>
                                  <input
                                    v-if="userInputForm[String(q.id)].choice === '__other__'"
                                    v-model="userInputForm[String(q.id)].other"
                                    :type="q.isSecret ? 'password' : 'text'"
                                    class="mt-2 w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-black/[0.14]"
                                    placeholder="Type an answer…"
                                  />
                                </div>
                              </label>
                            </div>

                            <div v-else class="mt-3">
                              <input
                                v-model="userInputForm[String(q.id)].text"
                                :type="q.isSecret ? 'password' : 'text'"
                                class="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-black/[0.14]"
                                placeholder="Type an answer…"
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div v-if="userInputError" class="mt-3 text-sm text-red-600">{{ userInputError }}</div>

                      <div class="mt-4 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          class="rounded-full bg-white px-3 py-1.5 text-sm text-slate-800 ring-1 ring-black/8 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          :disabled="userInputSubmitting"
                          @click="cancelUserInput(selectedComposerApproval)"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          class="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                          :disabled="userInputSubmitting"
                          @click="submitUserInput(selectedComposerApproval)"
                        >
                          <Loader2 v-if="userInputSubmitting" class="h-4 w-4 animate-spin" />
                          Submit
                        </button>
                      </div>
                    </div>

                    <div v-else class="space-y-2.5">
                      <div v-if="selectedComposerApproval.reason">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Reason</div>
                        <div class="mt-1 rounded-2xl border border-black/[0.06] bg-white px-3 py-2 text-[12px] leading-5 text-slate-800 whitespace-pre-wrap">
                          {{ selectedComposerApproval.reason }}
                        </div>
                      </div>

                      <div v-if="selectedComposerApproval.command">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Command</div>
                        <pre class="mt-1 overflow-x-auto rounded-2xl border border-black/[0.06] bg-white px-3 py-2 text-[11px] font-mono leading-5 text-slate-800 whitespace-pre-wrap">{{ selectedComposerApproval.command }}</pre>
                      </div>

                      <div v-if="selectedComposerApproval.cwd">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Working directory</div>
                        <pre class="mt-1 overflow-x-auto rounded-2xl border border-black/[0.06] bg-white px-3 py-2 text-[11px] font-mono leading-5 text-slate-800 whitespace-pre-wrap">{{ selectedComposerApproval.cwd }}</pre>
                      </div>

                      <div v-if="selectedComposerApproval.grantRoot">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Grant root</div>
                        <pre class="mt-1 overflow-x-auto rounded-2xl border border-black/[0.06] bg-white px-3 py-2 text-[11px] font-mono leading-5 text-slate-800 whitespace-pre-wrap">{{ selectedComposerApproval.grantRoot }}</pre>
                      </div>

                      <div v-if="approvalRespondError" class="pt-0.5 text-[12px] text-red-600">
                        {{ approvalRespondError }}
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  v-if="selectedSessionId && selectedQueuedPrompts.length"
                  class="border-b border-black/[0.06] bg-[#f5f5f2]"
                >
                  <div class="flex items-center justify-between gap-3 px-4 py-2 text-left text-xs text-slate-700">
                    <div class="font-medium uppercase tracking-wider text-slate-500">Next up</div>
                    <div class="text-[11px] text-slate-400">
                      {{ selectedQueuedPrompts.length }} queued
                    </div>
                  </div>

                  <div class="border-t border-black/[0.05] bg-[#fbfbfa] px-4 py-3">
                    <div class="space-y-2.5">
                      <div
                        v-for="(queued, idx) in selectedQueuedPrompts"
                        :key="queued.promptId ?? queued.id"
                        class="flex items-center gap-2 text-sm"
                      >
                        <span class="shrink-0 text-xs tabular-nums text-slate-500">{{ idx + 1 }}.</span>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center justify-between gap-3">
                            <div class="min-w-0 flex-1">
                              <textarea
                                v-if="isQueuedPromptEditing(queued)"
                                v-model="queuedPromptEditDraft"
                                rows="2"
                                class="w-full resize-none rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-[13px] leading-6 text-slate-800 outline-none placeholder:text-slate-400 focus:border-black/[0.12]"
                                placeholder="Queued follow-up…"
                                @keydown.enter.exact.prevent="saveQueuedPromptText(queued)"
                                @keydown.esc.prevent="cancelQueuedPromptEdit()"
                              />
                              <div v-else class="min-w-0">
                                <div class="whitespace-pre-wrap text-[13px] leading-6 text-slate-900">
                                  {{ queued.text || '(attachments only)' }}
                                </div>
                                <div
                                  v-if="Array.isArray(queued.attachments) && queued.attachments.length"
                                  class="mt-1 text-xs text-slate-500"
                                  :title="queuedPromptAttachmentSummary(queued)"
                                >
                                  {{ queuedPromptAttachmentSummary(queued) }}
                                </div>
                              </div>
                            </div>

                            <div class="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                class="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 ring-1 ring-black/6 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                :disabled="selectedQueueSending"
                                @click="steerQueuedPrompt(queued.promptId ?? queued.id)"
                              >
                                {{ selectedQueueSending ? 'Steering…' : 'Steer' }}
                              </button>
                              <button
                                v-if="isQueuedPromptEditing(queued)"
                                type="button"
                                class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-700 ring-1 ring-black/6 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                :disabled="selectedQueueSending"
                                @click="saveQueuedPromptText(queued)"
                                title="Save"
                              >
                                <CheckCircle2 class="h-4 w-4" />
                              </button>
                              <button
                                v-else
                                type="button"
                                class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-700 ring-1 ring-black/6 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                :disabled="selectedQueueSending"
                                @click="beginQueuedPromptEdit(queued)"
                                title="Edit"
                              >
                                <Pencil class="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-700 ring-1 ring-black/6 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                :disabled="selectedQueueSending"
                                @click="deleteQueuedPrompt(queued.promptId ?? queued.id)"
                                title="Delete"
                              >
                                <Trash2 class="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="px-3 py-3">
                <textarea
                  v-model="messageDraft"
                  rows="2"
                  class="w-full resize-none bg-transparent px-1.5 text-[14px] leading-6 text-slate-800 outline-none placeholder:text-slate-400"
                  placeholder="Ask for follow-up changes…"
                  @keydown.enter.exact.prevent="submit"
                  @paste="onComposerPaste"
                />

                <div v-if="attachments.length" class="mt-2 flex flex-wrap gap-2 px-1">
                  <div
                    v-for="a in attachments"
                    :key="a.id"
                    class="relative rounded-2xl border border-black/[0.06] bg-[#fafaf8] p-2"
                  >
                    <button
                      class="absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-700 ring-1 ring-black/10 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                      @click="removeAttachment(a.id)"
                      title="Remove"
                    >
                      <X class="h-3.5 w-3.5" />
                    </button>

                    <img
                      v-if="a.previewUrl"
                      :src="a.previewUrl"
                      :alt="a.filename"
                      class="block max-h-16 max-w-[72px] rounded-xl object-contain"
                    />
                    <div v-else class="flex h-14 w-40 items-center justify-center rounded-xl bg-slate-50 px-2 text-xs text-slate-800">
                      <div class="truncate" :title="a.filename">{{ a.filename }}</div>
                    </div>
                  </div>
                </div>

                <div class="mt-2 flex items-center justify-between gap-2">
                  <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto pb-1 sm:gap-1">
                    <input
                      ref="fileInputEl"
                      type="file"
                      class="hidden"
                      multiple
                      @change="onFilesPicked"
                    />
                    <button
                      class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-transparent text-slate-600 transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 active:scale-[0.99] sm:h-8 sm:w-8"
                      @click="openFilePicker"
                      title="Upload files/images"
                    >
                      <Plus class="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    </button>

                    <ComposerPillSelect
                      v-model="composerModel"
                      class="min-w-0 max-w-[220px]"
                      title="Choose model"
                      :options="composerModelSelectOptions"
                      :disabled="modelCatalogLoading && !composerModelOptions.length"
                      size="md"
                    />

                    <ComposerPillSelect
                      v-model="composerReasoningEffort"
                      class="min-w-0 max-w-[220px]"
                      title="Select reasoning"
                      :options="composerReasoningSelectOptions"
                      size="md"
                    />

                  </div>

                  <button
                    class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-700 text-white transition-colors hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 active:scale-[0.99] sm:h-8 sm:w-8"
                    @click="submit"
                    :disabled="sending || (!messageDraft.trim() && !attachments.length && selectedSession?.turnState !== 'running')"
                    :title="selectedSession?.turnState === 'running'
                      ? ((messageDraft.trim() || attachments.length) ? 'Queue follow-up' : 'Stop')
                      : 'Send'"
                  >
                    <Loader2 v-if="sending" class="h-3.5 w-3.5 animate-spin sm:h-4 sm:w-4" />
                    <Square v-else-if="selectedSession?.turnState === 'running' && !messageDraft.trim() && !attachments.length" class="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    <ArrowUp v-else class="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  </button>
                </div>
                </div>
              </div>

              <div class="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-slate-400">
                <div class="flex min-w-0 flex-wrap items-center gap-1 sm:gap-1.5">
                  <div
                    class="relative shrink-0"
                    data-machine-upgrade-root="true"
                    @mouseenter="handleComposerMachineMouseEnter"
                    @mouseleave="composerMachinePopoverHover = false"
                  >
                    <button
                      type="button"
                      class="rg-pill-button inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors sm:px-2.5 sm:py-1 sm:text-[11px]"
                      :class="(composerMachineVersionMismatch || composerMachineUnknownVersion) ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100' : 'border-black/[0.08] bg-transparent text-slate-500 hover:bg-transparent'"
                      :title="composerMachineVersionMismatch
                        ? `Version mismatch: runner ${composerMachineRunnerVersion} · host ${appSettings.appVersion || 'unknown'}`
                        : (composerMachineUnknownVersion
                            ? `Runner version unknown · host ${appSettings.appVersion || 'unknown'}`
                            : composerMachineLabel)"
                      @click.stop="toggleComposerMachinePopover"
                    >
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="composerMachineOnline ? 'bg-emerald-500' : 'bg-slate-400'" />
                      <span class="truncate">{{ composerMachineLabel }}</span>
                    </button>

                    <div
                      v-if="composerMachineUpgradePopoverVisible"
                      class="absolute bottom-full left-0 z-30 mb-2 w-[248px] rounded-2xl border border-red-200 bg-white px-3 py-3 text-left shadow-[0_12px_30px_rgba(15,23,42,0.14)]"
                    >
                      <div class="text-[11px] font-semibold text-red-700">
                        {{ composerMachineVersionMismatch ? 'Runner upgrade available' : 'Runner may be outdated' }}
                      </div>
                      <div class="mt-1 text-[11px] text-slate-600">
                        <span class="font-medium text-slate-700">Runner:</span>
                        <span class="font-mono text-slate-700">{{ composerMachineRunnerVersion }}</span>
                      </div>
                      <div class="mt-1 text-[11px] text-slate-600">
                        <span class="font-medium text-slate-700">Host:</span>
                        <span class="font-mono text-slate-700">{{ appSettings.appVersion || 'unknown' }}</span>
                      </div>
                      <div
                        v-if="composerMachineUpgradeStatus"
                        class="mt-2 text-[11px]"
                        :class="composerMachine?.upgrade?.state === 'failed' ? 'text-red-600' : 'text-slate-500'"
                      >
                        {{ composerMachineUpgradeStatus }}
                      </div>
                      <div v-if="composerMachineUpgradeErrorText" class="mt-2 text-[11px] text-red-600">
                        {{ composerMachineUpgradeErrorText }}
                      </div>
                      <div v-else-if="composerMachineUpgradeLocked" class="mt-2 text-[11px] text-amber-700">
                        {{ composerMachineUpgradeLockedReason }}
                      </div>
                      <div v-else-if="composerMachineUpgradeAvailable" class="mt-2 text-[11px] text-slate-500">
                        Upgrade this runner from the updated host.
                      </div>
                      <div v-else-if="composerMachineUnknownVersion" class="mt-2 text-[11px] text-slate-500">
                        This runner does not report a Rootgrid version. It is likely from an older install and may not support newer features like the current terminal protocol.
                      </div>
                      <div v-else-if="!composerMachineOnline" class="mt-2 text-[11px] text-slate-500">
                        Reconnect this runner to upgrade it from the web UI.
                      </div>
                      <div v-else class="mt-2 text-[11px] text-slate-500">
                        Remote upgrade is unavailable for this runner.
                      </div>

                      <button
                        v-if="composerMachineUpgradeAvailable"
                        type="button"
                        class="mt-3 inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                        :disabled="composerMachineUpgradeLocked || composerMachineUpgradeWorking || composerMachineUpgradeBusy"
                        :title="composerMachineUpgradeLockedReason || null"
                        @click.stop="composerMachine ? upgradeMachine(composerMachine.machineId) : null"
                      >
                        <Loader2 v-if="composerMachineUpgradeWorking" class="h-3.5 w-3.5 animate-spin" />
                        {{ composerMachineUnknownVersion && !composerMachineUpgradeSupported ? 'Try upgrade runner' : 'Upgrade runner' }}
                      </button>
                    </div>
                  </div>

                  <ComposerPillSelect
                    v-model="composerApprovalPolicy"
                    class="min-w-0 max-w-[170px]"
                    :title="selectedSession ? 'Session approval policy' : 'Default approval policy'"
                    :options="composerApprovalSelectOptions"
                    size="sm"
                  />

                  <ComposerPillSelect
                    v-model="composerSandbox"
                    class="min-w-0 max-w-[190px]"
                    :title="selectedSession ? 'Session sandbox' : 'Default sandbox'"
                    :options="composerSandboxSelectOptions"
                    size="sm"
                  />
                </div>
                <div class="flex items-center self-center gap-2">
                  <div
                    v-if="composerContextUsage"
                    class="relative flex shrink-0 items-center self-center"
                    data-context-usage-root="true"
                    @mouseenter="composerContextPopoverHover = true"
                    @mouseleave="composerContextPopoverHover = false"
                  >
                    <button
                      class="relative inline-flex h-5 w-5 items-center justify-center rounded-full align-middle transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                      type="button"
                      :title="composerContextUsage.usageLabel"
                      @click.stop="composerContextPopoverOpen = !composerContextPopoverOpen"
                    >
                      <svg class="absolute inset-0" viewBox="0 0 20 20" aria-hidden="true">
                        <circle
                          cx="10"
                          cy="10"
                          r="7.5"
                          fill="none"
                          stroke="rgba(15, 23, 42, 0.1)"
                          stroke-width="3.5"
                        />
                        <circle
                          cx="10"
                          cy="10"
                          r="7.5"
                          fill="none"
                          stroke="#94a3b8"
                          stroke-width="3.5"
                          transform="rotate(-90 10 10)"
                          stroke-linecap="round"
                          :style="composerContextRingStrokeStyle"
                        />
                      </svg>
                      <span class="absolute inset-[3.75px] rounded-full bg-white" />
                    </button>
                    <div
                      v-if="composerContextPopoverVisible"
                      class="absolute bottom-8 right-0 z-20 w-44 rounded-2xl border border-black/[0.06] bg-white px-3 py-2 text-center shadow-lg shadow-black/10"
                    >
                      <div class="text-[11px] text-slate-500">Context window:</div>
                      <div v-if="composerContextUsage.percentLabel" class="text-[11px] text-slate-500">
                        {{ composerContextUsage.percentLabel }}
                      </div>
                      <div class="mt-1 text-xs font-medium text-slate-900">
                        {{ composerContextUsage.usageLabel }}
                      </div>
                      <div
                        v-if="composerContextUsage.totalLabel && composerContextUsage.totalLabel !== composerContextUsage.usedLabel"
                        class="mt-1 text-[11px] text-slate-500"
                      >
                        Session total {{ composerContextUsage.totalLabel }}
                      </div>
                      <div v-if="composerContextUsage.lastLabel" class="mt-1 text-[11px] text-slate-500">
                        Last turn {{ composerContextUsage.lastLabel }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </footer>

          <div
            v-else-if="mainPaneMode === 'new-thread' || mainPaneMode === 'settings'"
            class="min-h-0 flex-1 px-4 py-4 sm:px-6 sm:py-6"
            :class="mainPaneMode === 'new-thread' ? 'overflow-hidden' : 'overflow-auto'"
          >
            <div class="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
              <div v-if="mainPaneMode === 'new-thread'" class="flex min-h-0 flex-1 flex-col gap-4">
                <section class="space-y-3">
                  <div>
                    <div class="text-sm font-medium text-slate-900">Machine</div>
                    <div class="mt-1 text-xs text-slate-500">Choose where the new thread should run.</div>
                  </div>

                  <div v-if="!machinesForSelect.length" class="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">
                    No machines yet.
                  </div>

                  <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <button
                      v-for="m in machinesForSelect"
                      :key="m.machineId"
                      class="rounded-2xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                      :class="newThreadMachineId === m.machineId
                        ? 'border-indigo-300 bg-indigo-50/70'
                        : 'border-slate-200 bg-white hover:bg-slate-50'"
                      :disabled="!machineIsOnline(m)"
                      @click="newThreadMachineId = m.machineId"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="truncate text-sm font-medium text-slate-900">{{ machineDisplayName(m) }}</div>
                          <div
                            v-if="m.machineAlias && m.machineName && m.machineAlias !== m.machineName"
                            class="mt-0.5 truncate text-xs text-slate-500"
                            :title="m.machineName"
                          >
                            {{ m.machineName }}
                          </div>
                        </div>
                        <span class="mt-1 h-2.5 w-2.5 rounded-full" :class="machineIsOnline(m) ? 'bg-emerald-500' : 'bg-slate-400'" />
                      </div>
                      <div class="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                        <span class="uppercase tracking-wider">{{ m.platform }}</span>
                        <span class="truncate">
                          {{ machineIsOnline(m) ? 'Online' : (m.lastSeenMs ? `Last seen ${formatAgeShort(m.lastSeenMs)}` : 'Offline') }}
                        </span>
                      </div>
                    </button>
                  </div>
                </section>

                <section class="space-y-3">
                  <div>
                    <div class="text-sm font-medium text-slate-900">Recent projects</div>
                    <div class="mt-1 text-xs text-slate-500">Pick a recent workspace or browse from the root filesystem.</div>
                  </div>
                  <div v-if="!newThreadRecentWorkspaces.length" class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                    No recent projects for this machine yet.
                  </div>
                  <div v-else class="-mx-1 overflow-x-auto px-1 pb-1">
                    <div class="flex min-w-max gap-3">
                      <button
                        v-for="p in newThreadRecentWorkspaces"
                        :key="p.cwd"
                        class="w-64 shrink-0 rounded-2xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        :class="String(newThreadCwd ?? '').trim() === p.cwd
                          ? 'border-indigo-300 bg-indigo-50/70'
                          : 'border-slate-200 bg-white hover:bg-slate-50'"
                        :title="p.cwd"
                        @click="useRecentWorkspaceForNewThread(p.cwd)"
                      >
                        <div class="truncate text-sm font-medium text-slate-900">{{ p.label }}</div>
                        <div class="mt-2 truncate text-xs text-slate-500">{{ p.cwd }}</div>
                      </button>
                    </div>
                  </div>
                </section>

                <section class="flex min-h-[280px] flex-1 flex-col rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 sm:min-h-[360px] sm:p-3">
                  <div v-if="newThreadBrowseError" class="mt-2 text-sm text-red-600">{{ newThreadBrowseError }}</div>

                  <div class="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-slate-200 bg-white">
                    <div class="truncate border-b border-slate-100 px-4 py-2 text-xs text-slate-500" :title="newThreadBrowsePath">
                      {{ newThreadBrowsePath || NEW_THREAD_ROOT_PATH }}
                    </div>
                    <div class="min-h-0 flex-1 overflow-auto">
                      <div v-if="!newThreadMachineId" class="px-4 py-8 text-center text-sm text-slate-500">
                        Select a machine first.
                      </div>
                      <div v-else-if="newThreadBrowseLoading && !newThreadBrowseEntries.length" class="px-4 py-8 text-center text-sm text-slate-500">
                        Loading folders…
                      </div>
                      <div v-else-if="!newThreadBrowseEntries.length" class="px-4 py-8 text-center text-sm text-slate-500">
                        No folders found.
                      </div>
                      <div v-else class="px-2 py-2">
                        <WorkspaceFolderTreeNode
                          v-for="entry in newThreadBrowseEntries"
                          :key="entry.path"
                          :entry="entry"
                          :depth="0"
                          :selected-path="newThreadCwd"
                          :expanded-dirs="newThreadTreeExpandedDirs"
                          :loading-dirs="newThreadTreeLoadingDirs"
                          :directory-entries="newThreadTreeDirectoryEntries"
                          @toggle-dir="toggleNewThreadTreeDir"
                          @select-dir="selectNewThreadFolder"
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <div v-if="newThreadError" class="text-sm text-red-600">{{ newThreadError }}</div>

                <div class="mt-auto flex shrink-0 flex-col gap-3 border-t border-black/[0.04] bg-white px-0 py-3 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
                    <div class="text-[11px] uppercase tracking-wider text-slate-500">Selected folder</div>
                    <div class="mt-1 truncate text-sm text-slate-900" :title="newThreadCwd || newThreadBrowsePath">
                      {{ newThreadCwd || newThreadBrowsePath || 'Choose a machine to browse folders.' }}
                    </div>
                  </div>
                  <button
                    class="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 sm:w-auto"
                    @click="confirmNewThreadDialog"
                    :disabled="newThreadCreating"
                  >
                    <Loader2 v-if="newThreadCreating" class="h-4 w-4 animate-spin" />
                    Start
                  </button>
                </div>
              </div>

              <div v-else class="space-y-8">
                <section class="space-y-3">
                  <div>
                    <div class="text-sm font-medium text-slate-900">System</div>
                    <div class="mt-1 text-xs text-slate-500">Notifications, retention, and browser integration.</div>
                  </div>

                  <div>
                    <div class="text-xs uppercase tracking-wider text-slate-500">Retention (days)</div>
                    <input
                      v-model="retentionDraft"
                      type="number"
                      min="1"
                      max="3650"
                      class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <div class="mt-2 text-xs text-slate-500">Rootgrid prunes its own sessions/events beyond this window.</div>
                  </div>

                  <div>
                    <div class="text-xs uppercase tracking-wider text-slate-500">SSE notifications</div>
                    <select
                      v-model="sseToastsDraft"
                      class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
                    >
                      <option value="if-not-visible">If not visible</option>
                      <option value="always">Always</option>
                      <option value="never">Never</option>
                    </select>
                    <div class="mt-2 text-xs text-slate-500">Controls toast/desktop notifications emitted over SSE (approvals, ready, failures).</div>

                    <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div class="min-w-0">
                        <div class="text-[11px] uppercase tracking-wider text-slate-500">Browser notifications</div>
                        <div class="mt-1 text-xs text-slate-700">Permission: {{ notificationPermission }}</div>
                        <div class="mt-1 text-xs text-slate-500">Needed to alert you while the tab/app is not visible.</div>
                      </div>
                      <button
                        class="shrink-0 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        @click="requestNotificationPermission"
                        :disabled="!notificationSupported || notificationPermission === 'granted'"
                      >
                        Enable
                      </button>
                    </div>

                    <div class="mt-3">
                      <div class="text-xs uppercase tracking-wider text-slate-500">Web Push notifications</div>
                      <select
                        v-model="webPushDraft"
                        class="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
                      >
                        <option value="if-not-visible">If not visible</option>
                        <option value="always">Always</option>
                        <option value="never">Never</option>
                      </select>
                      <div class="mt-2 text-xs text-slate-500">Uses the PWA service worker + VAPID. Requires a secure context (localhost/https) and subscription. “If not visible” means the relevant session isn’t currently open in a visible Rootgrid tab.</div>

                      <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div class="min-w-0">
                          <div class="text-[11px] uppercase tracking-wider text-slate-500">Push subscription</div>
                          <div class="mt-1 text-xs text-slate-700">Status: {{ pushStatus }}</div>
                          <div v-if="pushEndpoint" class="mt-1 truncate text-[11px] text-slate-500" :title="pushEndpoint">endpoint: {{ pushEndpoint }}</div>
                          <div v-if="pushError" class="mt-1 text-xs text-red-600">{{ pushError }}</div>
                        </div>
                        <div class="shrink-0 flex items-center gap-2">
                          <button
                            class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                            @click="enablePush"
                            :disabled="pushWorking || pushStatus === 'subscribed' || pushStatus === 'unsupported' || pushStatus === 'insecure'"
                          >
                            Enable
                          </button>
                          <button
                            class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                            @click="disablePush"
                            :disabled="pushWorking || pushStatus !== 'subscribed'"
                          >
                            Disable
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div class="text-[11px] uppercase tracking-wider text-slate-500">Host</div>
                      <div class="mt-2 font-mono text-xs text-slate-900">
                        {{ appSettings.host?.listen?.host ?? '—' }}:{{ appSettings.host?.listen?.port ?? '—' }}
                      </div>
                      <div class="mt-2 text-xs text-slate-500">trustProxy: {{ appSettings.host?.trustProxy ? 'true' : 'false' }}</div>
                      <div v-if="appSettings.host?.publicUrl" class="mt-2 truncate text-xs text-slate-500" :title="appSettings.host.publicUrl">
                        publicUrl: <span class="text-slate-700">{{ appSettings.host.publicUrl }}</span>
                      </div>
                    </div>

                    <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div class="text-[11px] uppercase tracking-wider text-slate-500">Runner</div>
                      <div class="mt-2 text-xs text-slate-900">
                        {{ appSettings.runner?.enabled ? 'enabled' : 'disabled' }}
                      </div>
                      <div class="mt-2 truncate text-xs text-slate-500" :title="appSettings.runner?.machineId ?? ''">
                        machineId: <span class="font-mono text-slate-700">{{ appSettings.runner?.machineId ? appSettings.runner.machineId.slice(0, 12) + '…' : '—' }}</span>
                      </div>
                      <div class="mt-2 truncate text-xs text-slate-500" :title="appSettings.runner?.machineName ?? ''">
                        machineName: <span class="text-slate-700">{{ appSettings.runner?.machineName ?? '—' }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-slate-900">Host self-update</div>
                        <div class="mt-1 text-xs text-slate-500">
                          Fetch the configured branch, rebuild Rootgrid, and restart the host from this machine.
                        </div>
                      </div>
                      <button
                        class="inline-flex shrink-0 items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        :disabled="!hostSelfUpdateEnabled || hostSelfUpdateWorking"
                        :title="hostSelfUpdateEnabled ? 'Fetch, rebuild, and restart the host.' : 'Set host.selfUpdate.enabled=true in config.json to enable web-triggered host updates.'"
                        @click="startHostSelfUpdate"
                      >
                        <Loader2 v-if="hostSelfUpdateWorking" class="h-4 w-4 animate-spin" />
                        Update host
                      </button>
                    </div>

                    <div class="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-500 sm:grid-cols-2">
                      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
                        Remote:
                        <span class="ml-1 break-all font-mono text-slate-700">{{ hostSelfUpdateInfo?.repo ?? 'origin' }}</span>
                      </div>
                      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
                        Branch:
                        <span class="ml-1 font-mono text-slate-700">{{ hostSelfUpdateInfo?.branch ?? 'main' }}</span>
                      </div>
                      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2 sm:col-span-2">
                        Workdir:
                        <span class="ml-1 break-all font-mono text-slate-700">{{ hostSelfUpdateInfo?.workdir ?? '—' }}</span>
                      </div>
                      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
                        Install:
                        <span class="ml-1 break-all font-mono text-slate-700">{{ hostSelfUpdateInfo?.installCommand ?? 'npm ci' }}</span>
                      </div>
                      <div class="rounded-xl border border-slate-200 bg-white px-3 py-2">
                        Build:
                        <span class="ml-1 break-all font-mono text-slate-700">{{ hostSelfUpdateInfo?.buildCommand ?? 'npm run build' }}</span>
                      </div>
                    </div>

                    <div v-if="hostSelfUpdateInfo?.restartMode === 'command'" class="mt-2 text-xs text-slate-500">
                      Restart mode: configured command, then Rootgrid exits.
                    </div>
                    <div v-else class="mt-2 text-xs text-slate-500">
                      Restart mode: Rootgrid exits after a successful update so your service/container can restart it.
                    </div>

                    <div v-if="hostSelfUpdateError" class="mt-2 text-sm text-red-600">{{ hostSelfUpdateError }}</div>
                    <div v-else-if="hostSelfUpdateStatus" class="mt-2 text-sm text-emerald-700">{{ hostSelfUpdateStatus }}</div>
                    <div v-else-if="!hostSelfUpdateEnabled" class="mt-2 text-xs text-amber-700">
                      Configure <span class="font-mono">host.selfUpdate</span> in <span class="font-mono">~/.rootgrid/config.json</span> to enable this button.
                    </div>
                  </div>

                  <div v-if="appSettingsError" class="text-sm text-red-600">{{ appSettingsError }}</div>

                  <div class="flex items-center justify-end">
                    <button
                      class="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                      @click="saveRetentionDays"
                      :disabled="appSettingsSaving"
                    >
                      <Loader2 v-if="appSettingsSaving" class="h-4 w-4 animate-spin" />
                      Save
                    </button>
                  </div>
                </section>

                <section class="space-y-3">
                  <div>
                    <div class="text-sm font-medium text-slate-900">Machines</div>
                    <div class="mt-1 text-xs text-slate-500">Connected runners, upgrades, and machine installation.</div>
                  </div>

                  <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-slate-900">Add machine</div>
                        <div class="mt-1 text-xs text-slate-500">
                          Install a runner with a one-liner. The target machine only needs
                          <span class="font-medium text-slate-700">curl</span>,
                          <span class="font-medium text-slate-700">node</span>, and
                          <span class="font-medium text-slate-700">tar</span>.
                        </div>
                      </div>
                      <div v-if="runnerInstallExpiryLabel" class="shrink-0 text-[11px] text-slate-500">
                        {{ runnerInstallExpiryLabel }}
                      </div>
                    </div>

                    <div class="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        class="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        :disabled="runnerInstallLoading"
                        @click="loadRunnerInstallBootstrap({ force: true })"
                      >
                        <Loader2 v-if="runnerInstallLoading" class="h-3.5 w-3.5 animate-spin" />
                        {{ runnerInstallCommand ? 'Regenerate command' : 'Generate command' }}
                      </button>
                      <button
                        class="rounded-md bg-white px-3 py-1.5 text-xs text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        :disabled="!runnerInstallCommand"
                        @click="copyRunnerInstallCommand"
                      >
                        Copy command
                      </button>
                      <button
                        class="rounded-md bg-white px-3 py-1.5 text-xs text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        :disabled="!runnerInstallUrl"
                        @click="copyRunnerInstallUrl"
                      >
                        Copy URL
                      </button>
                    </div>

                    <div
                      v-if="runnerInstallCommand"
                      class="mt-3 overflow-x-auto rounded-xl bg-slate-950 px-3 py-3 text-[11px] text-slate-100"
                    >
                      <code class="font-mono break-all">{{ runnerInstallCommand }}</code>
                    </div>
                    <div v-if="runnerInstallUrl" class="mt-2 break-all text-[11px] text-slate-500">
                      URL: <span class="font-mono text-slate-700">{{ runnerInstallUrl }}</span>
                    </div>
                    <div v-if="runnerInstallNeedsReachableUrl" class="mt-2 text-[11px] text-amber-700">
                      This command currently points at localhost. Set <span class="font-mono">host.publicUrl</span> if the runner is being installed on another machine.
                    </div>
                    <div v-if="runnerInstallLoading && runnerInstallStatusText" class="mt-2 text-sm text-slate-600">
                      {{ runnerInstallStatusText }}
                    </div>
                    <div v-if="runnerInstallError" class="mt-2 text-sm text-red-600">{{ runnerInstallError }}</div>
                  </div>

                  <div v-if="!machines.length" class="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">
                    No machines connected yet.
                  </div>

                  <div v-else class="space-y-2">
                    <div v-if="machineDisconnectError" class="text-sm text-red-600">{{ machineDisconnectError }}</div>
                    <div v-if="machineUpgradeError" class="text-sm text-red-600">{{ machineUpgradeError }}</div>
                    <div v-if="machineAliasError" class="text-sm text-red-600">{{ machineAliasError }}</div>
                    <div
                      v-for="m in machinesForSelect"
                      :key="m.machineId"
                      class="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0 flex items-center gap-2">
                          <span class="h-2.5 w-2.5 rounded-full" :class="machineIsOnline(m) ? 'bg-emerald-500' : 'bg-slate-400'" />
                          <div class="min-w-0">
                            <div class="truncate text-sm font-medium text-slate-900">{{ machineDisplayName(m) }}</div>
                            <div
                              v-if="m.machineAlias && m.machineName && m.machineAlias !== m.machineName"
                              class="truncate text-[11px] text-slate-500"
                              :title="m.machineName"
                            >
                              {{ m.machineName }}
                            </div>
                          </div>
                          <div class="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                            {{ m.platform }}
                          </div>
                        </div>
                        <div class="shrink-0 flex items-center gap-2">
                          <button
                            v-if="machineIsOnline(m) && ((machineHasVersionMismatch(m) && machineSupportsWebUpgrade(m)) || machineHasUnknownVersion(m))"
                            class="inline-flex items-center gap-2 rounded-md bg-indigo-50 px-2.5 py-1.5 text-xs text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                            @click="upgradeMachine(m.machineId)"
                            :disabled="Boolean(machineUpgradeLockReason(m)) || machineUpgradeWorkingId === m.machineId || machineUpgradeBusy(m)"
                            :title="machineUpgradeButtonTitle(m)"
                          >
                            <Loader2 v-if="machineUpgradeWorkingId === m.machineId" class="h-3.5 w-3.5 animate-spin" />
                            {{ machineHasUnknownVersion(m) ? 'Try upgrade' : 'Upgrade' }}
                          </button>
                          <button
                            v-if="machineIsOnline(m)"
                            class="inline-flex items-center gap-2 rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                            @click="disconnectMachine(m.machineId)"
                            :disabled="machineDisconnectWorkingId === m.machineId"
                            title="Disconnect the runner (it may reconnect if the runner process is still running)."
                          >
                            <Loader2 v-if="machineDisconnectWorkingId === m.machineId" class="h-3.5 w-3.5 animate-spin" />
                            Disconnect
                          </button>
                          <button
                            v-else
                            class="inline-flex items-center gap-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
                            @click="openDeleteMachineModal(m.machineId)"
                            title="Delete this machine and all its sessions."
                          >
                            <Trash2 class="h-3.5 w-3.5" />
                            Delete
                          </button>
                        </div>
                      </div>
                      <div class="mt-2 flex items-center justify-between gap-3">
                        <div class="min-w-0 truncate text-xs font-mono text-slate-500" :title="m.machineId">{{ m.machineId }}</div>
                        <div class="shrink-0 text-[11px]" :class="machineIsOnline(m) ? 'text-emerald-600' : 'text-slate-500'">
                          {{ machineStatusLabel(m) }}
                        </div>
                      </div>
                      <div class="mt-3 flex flex-wrap items-center gap-2">
                        <input
                          :value="machineAliasDrafts[m.machineId] ?? m.machineAlias ?? ''"
                          class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
                          placeholder="Machine alias"
                          @input="machineAliasDrafts[m.machineId] = $event.target.value"
                          @keydown.enter.prevent="saveMachineAlias(m.machineId)"
                        />
                        <button
                          class="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                          :disabled="machineAliasSavingId === m.machineId || String(machineAliasDrafts[m.machineId] ?? '').trim() === String(m.machineAlias ?? '').trim()"
                          @click="saveMachineAlias(m.machineId)"
                        >
                          <Loader2 v-if="machineAliasSavingId === m.machineId" class="h-3.5 w-3.5 animate-spin" />
                          <span v-else>Save alias</span>
                        </button>
                      </div>
                      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        <div>
                          Runner:
                          <span class="font-mono text-slate-700">{{ machineRootgridVersion(m) ?? 'unknown' }}</span>
                        </div>
                        <div v-if="appSettings.appVersion">
                          Host:
                          <span class="font-mono text-slate-700">{{ appSettings.appVersion }}</span>
                        </div>
                        <div v-if="machineHasVersionMismatch(m)" class="text-amber-700">
                          Version mismatch
                        </div>
                        <div v-else-if="machineHasUnknownVersion(m)" class="text-red-700">
                          Runner version unknown
                        </div>
                      </div>
                      <div v-if="machineUpgradeStatusText(m)" class="mt-2 text-xs" :class="m.upgrade?.state === 'failed' ? 'text-red-600' : 'text-slate-500'">
                        {{ machineUpgradeStatusText(m) }}
                      </div>
                      <div v-if="machineUpgradeLockReason(m)" class="mt-2 text-xs text-amber-700">
                        {{ machineUpgradeLockReason(m) }}
                      </div>
                    </div>
                  </div>
                </section>

                <section class="space-y-3">
                  <div>
                    <div class="text-sm font-medium text-slate-900">Archived threads</div>
                    <div class="mt-1 text-xs text-slate-500">Hidden threads stay here until restored.</div>
                  </div>
                  <div v-if="archiveError" class="text-sm text-red-600">{{ archiveError }}</div>
                  <div class="max-h-[420px] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div v-if="archiveLoading" class="rounded-xl bg-white p-6 text-center text-sm text-slate-600">
                      Loading archived threads…
                    </div>
                    <div v-else-if="!archivedSessions.length" class="rounded-xl bg-white p-6 text-center text-sm text-slate-600">
                      No archived threads.
                    </div>
                    <div v-else class="space-y-2">
                      <div
                        v-for="s in archivedSessions"
                        :key="s.sessionId"
                        class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3"
                      >
                        <button class="min-w-0 flex-1 text-left" @click="openSession(s.sessionId); defaultsOpen = false">
                          <div class="truncate text-sm font-medium text-slate-900">{{ sessionListTitle(s) }}</div>
                          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span class="inline-flex min-w-0 max-w-full items-center rounded-full border border-black/[0.08] px-2 py-0.5 text-[10px] font-medium text-slate-500" :title="`${sessionHostName(s)} / ${sessionProject(s)}`">
                              <span class="truncate">{{ sessionHostName(s) }} / {{ sessionProject(s) }}</span>
                            </span>
                            <span>{{ formatAgeShort(s.updatedMs) }}</span>
                          </div>
                        </button>
                        <button
                          class="rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200"
                          @click="unarchiveFromArchiveModal(s.sessionId)"
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
          <div v-else class="min-h-0 flex-1 bg-white" />
        </section>
        <section
          v-else
          class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-none bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
        >
          <div class="flex items-center justify-between gap-3 px-4 py-2.5">
            <div class="flex items-center gap-2">
              <button
                class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
                title="Back to chat"
                @click="restoreMobileSessionPane"
              >
                <ArrowLeft class="h-4 w-4" />
              </button>
              <div>
                <div class="text-[13px] font-semibold text-slate-800">{{ workspacePaneTitle }}</div>
                <div class="truncate text-[11px] text-slate-500" :title="currentWorkspaceContext.cwd">{{ currentWorkspaceContext.cwd }}</div>
              </div>
            </div>
          </div>
          <div class="border-t border-black/[0.04] px-4 py-2">
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                :class="workspacePaneTab === 'code' ? 'bg-black/[0.06] text-slate-800' : 'text-slate-500 hover:bg-black/[0.04]'"
                @click="openWorkspaceTool('code')"
              >Code</button>
              <button
                class="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                :class="workspacePaneTab === 'terminal' ? 'bg-black/[0.06] text-slate-800' : 'text-slate-500 hover:bg-black/[0.04]'"
                @click="openWorkspaceTool('terminal')"
              >Terminal</button>
              <button
                class="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                :class="workspacePaneTab === 'files' ? 'bg-black/[0.06] text-slate-800' : 'text-slate-500 hover:bg-black/[0.04]'"
                @click="openWorkspaceTool('files')"
              >Files</button>
              <button
                class="rounded-full px-2.5 py-1 text-[11px] transition-colors"
                :class="workspacePaneTab === 'git' ? 'bg-black/[0.06] text-slate-800' : 'text-slate-500 hover:bg-black/[0.04]'"
                @click="openWorkspaceTool('git')"
              >Git</button>
            </div>
          </div>
          <div class="min-h-0 flex-1">
            <div v-if="workspacePaneTab === 'code'" class="relative h-full bg-[#f7f7f4]">
              <div
                v-if="ideFrameLoading"
                class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/75 text-sm text-slate-500"
              >
                Opening workspace…
              </div>
              <iframe
                v-if="activeIdeSession?.urlPath"
                :src="activeIdeSession.urlPath"
                class="h-full w-full border-0 bg-white"
                title="Workspace"
                @load="onIdeFrameLoad"
              />
              <div v-else class="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                Open the code workspace to view it here.
              </div>
            </div>

            <div v-else-if="workspacePaneTab === 'terminal'" class="min-h-0 h-full">
              <WorkspaceTerminalPane
                :session="workspaceTerminalSession"
                :error="workspaceTerminalError"
                :opening="workspaceTerminalOpening"
                @ready="onWorkspaceTerminalReady"
                @input="sendWorkspaceTerminalInput"
                @resize="queueWorkspaceTerminalResize"
                @open="reopenWorkspaceTerminal"
              />
            </div>

            <div v-else-if="workspacePaneTab === 'files'" class="min-h-0 h-full">
              <WorkspaceFilesPane
                :root-path="workspaceFilesPath || currentWorkspaceContext.cwd"
                :root-entries="workspaceRootEntries"
                :directory-entries="workspaceDirectoryEntries"
                :expanded-dirs="workspaceExpandedDirs"
                :loading-dirs="workspaceLoadingDirs"
                :files-loading="workspaceFilesLoading"
                :files-error="workspaceFilesError"
                :selected-file-path="workspaceSelectedFilePath"
                :selected-file="workspaceSelectedFile"
                :file-loading="workspaceFileLoading"
                :file-error="workspaceFileError"
                @refresh="loadWorkspaceFiles()"
                @toggle-dir="toggleWorkspaceDirectory"
                @open-file="loadWorkspaceFile"
              />
            </div>

            <WorkspaceGitPane
              v-else
              :cwd="currentWorkspaceContext.cwd"
              :status="workspaceGitStatus"
              :loading="workspaceGitLoading"
              :error="workspaceGitError"
              :action-working="workspaceGitActionWorking"
              :branch-working="workspaceGitBranchWorking"
              :branch-draft="workspaceGitBranchDraft"
              @refresh="refreshWorkspaceGit"
              @open-file="openGitFile"
              @stage="stageWorkspaceGitPaths"
              @unstage="unstageWorkspaceGitPaths"
              @switch-branch="switchWorkspaceGitBranch"
              @create-branch="createWorkspaceGitBranch"
              @update:branch-draft="workspaceGitBranchDraft = $event"
            />
          </div>
        </section>
      </main>

      <div
        v-if="showWorkspacePane && !isMobileLayout"
        class="group relative shrink-0 w-3 cursor-col-resize touch-none"
        title="Drag to resize the chat and workspace panes"
        @pointerdown.prevent="beginWorkspacePaneDrag"
      >
        <div
          class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full transition-colors"
          :class="workspaceSplitDragging ? 'bg-slate-400/70' : 'bg-transparent group-hover:bg-slate-300/70'"
        />
      </div>

      <aside
        v-if="showWorkspacePane"
        class="relative min-w-0 flex flex-1 flex-col overflow-hidden rounded-none bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
      >
        <button
          class="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-slate-500 shadow-sm shadow-black/5 transition-colors hover:bg-white hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
          title="Close workspace"
          @click="closeWorkspacePane"
        >
          <X class="h-4 w-4" />
        </button>

        <div v-if="workspacePaneTab === 'code'" class="relative min-h-0 flex-1 bg-[#f7f7f4]">
          <div
            v-if="ideFrameLoading"
            class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/75 text-sm text-slate-500"
          >
            Opening workspace…
          </div>
          <iframe
            v-if="activeIdeSession?.urlPath"
            :src="activeIdeSession.urlPath"
            class="h-full w-full border-0 bg-white"
            title="Workspace"
            @load="onIdeFrameLoad"
          />
          <div v-else class="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
            Open the code workspace to view it here.
          </div>
        </div>

        <div v-else-if="workspacePaneTab === 'terminal'" class="min-h-0 flex-1">
          <WorkspaceTerminalPane
            :session="workspaceTerminalSession"
            :error="workspaceTerminalError"
            :opening="workspaceTerminalOpening"
            @ready="onWorkspaceTerminalReady"
            @input="sendWorkspaceTerminalInput"
            @resize="queueWorkspaceTerminalResize"
            @open="reopenWorkspaceTerminal"
          />
        </div>

        <div v-else-if="workspacePaneTab === 'files'" class="min-h-0 flex-1">
          <WorkspaceFilesPane
            :root-path="workspaceFilesPath || currentWorkspaceContext.cwd"
            :root-entries="workspaceRootEntries"
            :directory-entries="workspaceDirectoryEntries"
            :expanded-dirs="workspaceExpandedDirs"
            :loading-dirs="workspaceLoadingDirs"
            :files-loading="workspaceFilesLoading"
            :files-error="workspaceFilesError"
            :selected-file-path="workspaceSelectedFilePath"
            :selected-file="workspaceSelectedFile"
            :file-loading="workspaceFileLoading"
            :file-error="workspaceFileError"
            @refresh="loadWorkspaceFiles()"
            @toggle-dir="toggleWorkspaceDirectory"
            @open-file="loadWorkspaceFile"
          />
        </div>

        <WorkspaceGitPane
          v-else
          :cwd="currentWorkspaceContext.cwd"
          :status="workspaceGitStatus"
          :loading="workspaceGitLoading"
          :error="workspaceGitError"
          :action-working="workspaceGitActionWorking"
          :branch-working="workspaceGitBranchWorking"
          :branch-draft="workspaceGitBranchDraft"
          @refresh="refreshWorkspaceGit"
          @open-file="openGitFile"
          @stage="stageWorkspaceGitPaths"
          @unstage="unstageWorkspaceGitPaths"
          @switch-branch="switchWorkspaceGitBranch"
          @create-branch="createWorkspaceGitBranch"
          @update:branch-draft="workspaceGitBranchDraft = $event"
        />
      </aside>
      </div>

      </div>
      </div>

      <!-- Delete machine modal -->
	      <transition name="rg-fade">
	        <div v-if="deleteMachineOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Delete machine?</div>
	            <div class="mt-1 text-xs text-slate-600">This permanently deletes the machine and all of its sessions and history from Rootgrid.</div>

	            <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
	              <div class="text-sm font-medium text-slate-900">
	                {{ machineDisplayName(deleteMachineRow) }}
	              </div>
	              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
	                <span class="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">{{ deleteMachineRow?.platform ?? 'unknown' }}</span>
	                <span class="text-slate-300">·</span>
	                <span class="font-mono">{{ deleteMachineId }}</span>
	              </div>
	              <div class="mt-2 text-xs" :class="deleteMachineRow && machineIsOnline(deleteMachineRow) ? 'text-red-700' : 'text-slate-600'">
	                {{ deleteMachineRow && machineIsOnline(deleteMachineRow) ? 'This machine is online. Disconnect the runner before deleting.' : 'Runner disconnected (ok to delete).' }}
	              </div>
	            </div>

	            <div v-if="deleteMachineError" class="mt-3 text-sm text-red-600">{{ deleteMachineError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="deleteMachineOpen = false"
	                :disabled="deleteMachineWorking"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
	                @click="confirmDeleteMachine"
	                :disabled="deleteMachineWorking || (deleteMachineRow && machineIsOnline(deleteMachineRow))"
	              >
	                <Loader2 v-if="deleteMachineWorking" class="h-4 w-4 animate-spin" />
	                Delete
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Delete chat modal -->
	      <transition name="rg-fade">
	        <div v-if="deleteOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Delete thread?</div>
	            <div class="mt-1 text-xs text-slate-600">This permanently deletes the session and its history.</div>

	            <div v-if="deleteError" class="mt-3 text-sm text-red-600">{{ deleteError }}</div>

	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="deleteOpen = false"
	                :disabled="deleteWorking"
	              >
	                Cancel
	              </button>
	              <button
	                class="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
	                @click="confirmDeleteSession"
	                :disabled="deleteWorking"
	              >
	                <Loader2 v-if="deleteWorking" class="h-4 w-4 animate-spin" />
	                Delete
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>
	
	      <!-- Rename modal -->
	      <transition name="rg-fade">
	        <div v-if="renameOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
	          <div class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
	            <div class="text-sm font-semibold text-slate-900">Edit thread</div>
	            <div class="mt-1 text-xs text-slate-600">Update the thread title and/or project alias. Project alias changes apply to all sessions for this workspace on this machine.</div>
	
	            <div class="mt-4 space-y-3">
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Chat title</div>
	                <input
	                  v-model="renameTitleValue"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="(leave empty to use the default title)"
	                  :autofocus="renameFocus === 'title'"
	                  @keydown.enter.prevent="saveRenameSession"
	                />
	              </div>
	
	              <div>
	                <div class="text-xs uppercase tracking-wider text-slate-500">Project Alias</div>
	                <input
	                  v-model="renameProjectValue"
	                  class="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
	                  placeholder="(leave empty to use folder name)"
	                  :autofocus="renameFocus === 'project'"
	                  @keydown.enter.prevent="saveRenameSession"
	                />
	              </div>

	              <div v-if="renameError" class="text-sm text-red-600">{{ renameError }}</div>
	            </div>
	
	            <div class="mt-5 flex items-center justify-end gap-2">
	              <button
	                class="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
	                @click="renameOpen = false"
	              >
	                Cancel
	              </button>
	              <button
	                class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
	                @click="saveRenameSession"
	              >
	                Save
	              </button>
	            </div>
	          </div>
	        </div>
	      </transition>

	      <!-- Toasts -->
	      <div class="pointer-events-none fixed right-4 top-4 z-40 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
	        <transition-group name="rg-fade">
	          <div
	            v-for="t in toasts"
	            :key="t.id"
	            class="pointer-events-auto rounded-xl border p-3 shadow-lg"
	            :class="toastBorderClass(t.level)"
	            @click="t.sessionId ? openSession(t.sessionId) : null"
	          >
	            <div class="flex items-start justify-between gap-3">
	              <div class="min-w-0">
	                <div class="text-sm font-medium text-slate-900 truncate">{{ t.title }}</div>
	                <div v-if="t.message" class="mt-1 text-xs text-slate-700 whitespace-pre-wrap">{{ t.message }}</div>
	              </div>
	              <button
	                class="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-slate-700 transition-colors hover:bg-slate-50"
	                @click.stop="dismissToast(t.id)"
	                title="Dismiss"
	              >
	                <X class="h-4 w-4" />
	              </button>
	            </div>
	          </div>
	        </transition-group>
	      </div>
    </div>
  </div>
</template>
