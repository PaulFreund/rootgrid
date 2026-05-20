export function shouldAutoOpenNewThreadScreen({
  authed,
  suppressAutoNewThreadScreen,
  selectedSessionId,
  deepLinkSessionId,
  hasCompleteDefaultWorkspaceSelection,
  isMobileLayout,
  forceEmptyHomeScreen
}) {
  void authed
  void suppressAutoNewThreadScreen
  void selectedSessionId
  void deepLinkSessionId
  void hasCompleteDefaultWorkspaceSelection
  void isMobileLayout
  void forceEmptyHomeScreen
  return false
}

export function resolveMainPaneMode({
  newThreadOpen,
  defaultsOpen,
  authed,
  suppressAutoNewThreadScreen,
  selectedSessionId,
  deepLinkSessionId,
  hasCompleteDefaultWorkspaceSelection,
  isMobileLayout,
  forceEmptyHomeScreen
}) {
  if (newThreadOpen) return 'new-thread'
  if (defaultsOpen) return 'settings'
  if (
    authed
    && !String(selectedSessionId ?? '').trim()
    && !String(deepLinkSessionId ?? '').trim()
  ) {
    return 'empty'
  }

  return 'chat'
}

export function isSidebarSessionEntryActive({
  mainPaneMode,
  selectedSessionId,
  sessionId
}) {
  const currentSessionId = String(selectedSessionId ?? '').trim()
  const targetSessionId = String(sessionId ?? '').trim()
  if (!currentSessionId || !targetSessionId) return false
  return mainPaneMode === 'chat' && currentSessionId === targetSessionId
}

export function isSidebarSettingsActive(mainPaneMode) {
  return mainPaneMode === 'settings'
}
