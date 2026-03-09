export const DEFAULT_WORKSPACE_CHAT_WIDTH = 420
export const MIN_WORKSPACE_CHAT_WIDTH = 320
export const MIN_WORKSPACE_TOOL_WIDTH = 360
export const MAX_WORKSPACE_CHAT_WIDTH = 720

export function clampWorkspaceChatWidth(value, viewportWidth = 0) {
  const total = Number(viewportWidth ?? 0)
  const maxByViewport = total > 0
    ? Math.floor(total - MIN_WORKSPACE_TOOL_WIDTH - 12)
    : MAX_WORKSPACE_CHAT_WIDTH
  const dynamicMax = Math.max(
    MIN_WORKSPACE_CHAT_WIDTH,
    Math.min(
      MAX_WORKSPACE_CHAT_WIDTH,
      Number.isFinite(maxByViewport) && maxByViewport > 0 ? maxByViewport : MAX_WORKSPACE_CHAT_WIDTH
    )
  )
  const width = Number(value ?? DEFAULT_WORKSPACE_CHAT_WIDTH)
  if (!Number.isFinite(width)) return Math.min(DEFAULT_WORKSPACE_CHAT_WIDTH, dynamicMax)
  return Math.max(MIN_WORKSPACE_CHAT_WIDTH, Math.min(dynamicMax, Math.round(width)))
}

export function readStoredWorkspaceChatWidth(storage = globalThis.localStorage, viewportWidth = 0) {
  try {
    const raw = storage?.getItem?.('rootgrid.workspaceChatWidth')
    return clampWorkspaceChatWidth(raw, viewportWidth)
  } catch {
    return clampWorkspaceChatWidth(DEFAULT_WORKSPACE_CHAT_WIDTH, viewportWidth)
  }
}

export function persistWorkspaceChatWidth(value, storage = globalThis.localStorage) {
  const width = clampWorkspaceChatWidth(value)
  try {
    storage?.setItem?.('rootgrid.workspaceChatWidth', String(width))
  } catch {
  }
  return width
}
