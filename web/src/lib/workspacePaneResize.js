export const DEFAULT_WORKSPACE_CHAT_WIDTH = 420
export const MIN_WORKSPACE_CHAT_WIDTH = 320

export function clampWorkspaceChatWidth(value, viewportWidth = 0) {
  const total = Number(viewportWidth ?? 0)
  const maxByViewport = total > 0
    ? Math.max(MIN_WORKSPACE_CHAT_WIDTH, Math.floor(total - 12))
    : null
  const width = Number(value ?? DEFAULT_WORKSPACE_CHAT_WIDTH)
  const fallback = Number.isFinite(maxByViewport)
    ? Math.min(DEFAULT_WORKSPACE_CHAT_WIDTH, maxByViewport)
    : DEFAULT_WORKSPACE_CHAT_WIDTH
  if (!Number.isFinite(width)) return fallback
  const clamped = Math.max(MIN_WORKSPACE_CHAT_WIDTH, Math.round(width))
  return Number.isFinite(maxByViewport) ? Math.min(clamped, maxByViewport) : clamped
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
