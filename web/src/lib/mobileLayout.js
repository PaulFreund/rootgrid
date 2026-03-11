export const MOBILE_LAYOUT_MAX_WIDTH = 700
export const SESSION_CHAT_MAX_WIDTH = 800
export const SESSION_CHAT_HEADER_MENU_MAX_WIDTH = SESSION_CHAT_MAX_WIDTH + 48

export function isMobileViewportWidth(value) {
  const width = Number(value ?? 0)
  if (!Number.isFinite(width) || width <= 0) return false
  return width <= MOBILE_LAYOUT_MAX_WIDTH
}

export function shouldUseSessionChatHeaderMenu(value) {
  const width = Number(value ?? 0)
  if (!Number.isFinite(width) || width <= 0) return false
  return width <= SESSION_CHAT_HEADER_MENU_MAX_WIDTH
}

export function preferredMobilePane(sessionId) {
  return String(sessionId ?? '').trim() ? 'session' : 'list'
}
