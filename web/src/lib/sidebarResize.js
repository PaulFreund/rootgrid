export const DEFAULT_SESSION_SIDEBAR_WIDTH = 228
export const MIN_SESSION_SIDEBAR_WIDTH = 180
export const MAX_SESSION_SIDEBAR_WIDTH = 420

export function clampSessionSidebarWidth(value, viewportWidth = 0) {
  const maxByViewport = Math.floor(Number(viewportWidth ?? 0) * 0.45)
  const dynamicMax = Math.max(
    MIN_SESSION_SIDEBAR_WIDTH,
    Math.min(
      MAX_SESSION_SIDEBAR_WIDTH,
      Number.isFinite(maxByViewport) && maxByViewport > 0 ? maxByViewport : MAX_SESSION_SIDEBAR_WIDTH
    )
  )
  const width = Number(value ?? DEFAULT_SESSION_SIDEBAR_WIDTH)
  if (!Number.isFinite(width)) return Math.min(DEFAULT_SESSION_SIDEBAR_WIDTH, dynamicMax)
  return Math.max(MIN_SESSION_SIDEBAR_WIDTH, Math.min(dynamicMax, Math.round(width)))
}

export function readStoredSessionSidebarWidth(storage = globalThis.localStorage, viewportWidth = 0) {
  try {
    const raw = storage?.getItem?.('rootgrid.sessionSidebarWidth')
    return clampSessionSidebarWidth(raw, viewportWidth)
  } catch {
    return clampSessionSidebarWidth(DEFAULT_SESSION_SIDEBAR_WIDTH, viewportWidth)
  }
}

export function persistSessionSidebarWidth(value, storage = globalThis.localStorage) {
  const width = clampSessionSidebarWidth(value)
  try {
    storage?.setItem?.('rootgrid.sessionSidebarWidth', String(width))
  } catch {
  }
  return width
}
