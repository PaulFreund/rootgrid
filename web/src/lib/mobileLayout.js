export const MOBILE_LAYOUT_MAX_WIDTH = 767

export function isMobileViewportWidth(value) {
  const width = Number(value ?? 0)
  if (!Number.isFinite(width) || width <= 0) return false
  return width <= MOBILE_LAYOUT_MAX_WIDTH
}

export function preferredMobilePane(sessionId) {
  return String(sessionId ?? '').trim() ? 'session' : 'list'
}
