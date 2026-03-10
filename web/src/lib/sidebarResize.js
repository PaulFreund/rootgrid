export const DEFAULT_SESSION_SIDEBAR_WIDTH = 300
export const MIN_SESSION_SIDEBAR_WIDTH = 220
export const MAX_SESSION_SIDEBAR_WIDTH = 420
export const COMPACT_SESSION_SIDEBAR_WIDTH = 56
export const DEFAULT_DESKTOP_SIDEBAR_MODE = 'expanded'
export const DESKTOP_SIDEBAR_MODES = Object.freeze(['expanded', 'collapsed', 'hover'])

export function normalizeDesktopSidebarMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return DESKTOP_SIDEBAR_MODES.includes(mode) ? mode : DEFAULT_DESKTOP_SIDEBAR_MODE
}

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
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed < MIN_SESSION_SIDEBAR_WIDTH) {
      return clampSessionSidebarWidth(DEFAULT_SESSION_SIDEBAR_WIDTH, viewportWidth)
    }
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

export function readStoredDesktopSidebarMode(storage = globalThis.localStorage) {
  try {
    return normalizeDesktopSidebarMode(storage?.getItem?.('rootgrid.desktopSidebarMode'))
  } catch {
    return DEFAULT_DESKTOP_SIDEBAR_MODE
  }
}

export function persistDesktopSidebarMode(value, storage = globalThis.localStorage) {
  const mode = normalizeDesktopSidebarMode(value)
  try {
    storage?.setItem?.('rootgrid.desktopSidebarMode', mode)
  } catch {
  }
  return mode
}
