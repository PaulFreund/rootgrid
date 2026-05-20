export const SESSION_CHAT_MAX_WIDTH = 800
export const SESSION_CHAT_HEADER_MENU_COLLAPSE_PADDING = 48
export const SESSION_CHAT_HEADER_MENU_MAX_WIDTH = SESSION_CHAT_MAX_WIDTH + SESSION_CHAT_HEADER_MENU_COLLAPSE_PADDING

export function buildSessionChatShellStyle(maxWidth = SESSION_CHAT_MAX_WIDTH) {
  const width = Number(maxWidth ?? SESSION_CHAT_MAX_WIDTH)
  const resolved = Number.isFinite(width) && width > 0
    ? Math.round(width)
    : SESSION_CHAT_MAX_WIDTH
  return { maxWidth: `${resolved}px` }
}

export function shouldUseSessionChatHeaderMenu(value, collapseWidth = SESSION_CHAT_HEADER_MENU_MAX_WIDTH) {
  const width = Number(value ?? 0)
  const threshold = Number(collapseWidth ?? SESSION_CHAT_HEADER_MENU_MAX_WIDTH)
  if (!Number.isFinite(width) || width <= 0) return false
  if (!Number.isFinite(threshold) || threshold <= 0) return false
  return width <= threshold
}
