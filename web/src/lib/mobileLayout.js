export const MOBILE_LAYOUT_MAX_WIDTH = 700

export function isMobileViewportWidth(value, {
  coarsePointer = false,
  screenWidth = 0,
  screenHeight = 0
} = {}) {
  const width = Number(value ?? 0)
  if (!Number.isFinite(width) || width <= 0) return false
  if (width <= MOBILE_LAYOUT_MAX_WIDTH) return true
  if (!coarsePointer) return false
  const shortScreenSide = Math.min(
    Number(screenWidth ?? 0),
    Number(screenHeight ?? 0)
  )
  if (!Number.isFinite(shortScreenSide) || shortScreenSide <= 0) return false
  return shortScreenSide <= MOBILE_LAYOUT_MAX_WIDTH
}

export function preferredMobilePane(sessionId) {
  return String(sessionId ?? '').trim() ? 'session' : 'list'
}
