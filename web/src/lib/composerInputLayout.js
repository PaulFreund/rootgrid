export const COMPOSER_TEXTAREA_MIN_HEIGHT = 56
export const DEFAULT_COMPOSER_TEXTAREA_MAX_HEIGHT = 220

export function resolveComposerTextareaMaxHeight(viewportHeight) {
  const px = Number(viewportHeight ?? 0)
  if (!Number.isFinite(px) || px <= 0) return DEFAULT_COMPOSER_TEXTAREA_MAX_HEIGHT
  return Math.max(96, Math.floor(px / 3))
}
