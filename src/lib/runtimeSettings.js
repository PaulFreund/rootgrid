export const DEFAULT_RETENTION_DAYS = 30

export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  sseToasts: 'if-not-visible',
  webPush: 'if-not-visible',
  sound: false
})

const VALID_NOTIFICATION_POLICIES = new Set([
  'always',
  'never',
  'if-not-visible'
])

export function normalizeRetentionDays(value, fallback = DEFAULT_RETENTION_DAYS) {
  const fallbackValue = Number.parseInt(String(fallback ?? DEFAULT_RETENTION_DAYS), 10)
  const safeFallback = Number.isFinite(fallbackValue) && fallbackValue >= 1 && fallbackValue <= 3650
    ? fallbackValue
    : DEFAULT_RETENTION_DAYS
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : safeFallback
}

export function normalizeNotificationPolicy(value, fallback = DEFAULT_NOTIFICATION_SETTINGS.sseToasts) {
  const safeFallback = VALID_NOTIFICATION_POLICIES.has(String(fallback ?? '').trim())
    ? String(fallback).trim()
    : DEFAULT_NOTIFICATION_SETTINGS.sseToasts
  const policy = String(value ?? '').trim()
  return VALID_NOTIFICATION_POLICIES.has(policy) ? policy : safeFallback
}

export function normalizeNotificationSettings(input, fallback = DEFAULT_NOTIFICATION_SETTINGS) {
  const base = (fallback && typeof fallback === 'object') ? fallback : DEFAULT_NOTIFICATION_SETTINGS
  return {
    sseToasts: normalizeNotificationPolicy(input?.sseToasts, base.sseToasts),
    webPush: normalizeNotificationPolicy(input?.webPush, base.webPush),
    sound: input?.sound === true || (input?.sound === undefined && base.sound === true)
  }
}

export function normalizeRuntimeSettings(input, fallback = {}) {
  const base = (fallback && typeof fallback === 'object') ? fallback : {}
  return {
    retentionDays: normalizeRetentionDays(input?.retentionDays, base.retentionDays),
    notifications: normalizeNotificationSettings(input?.notifications, base.notifications)
  }
}

export function readRuntimeSettingsFromConfig(config, fallback = {}) {
  return normalizeRuntimeSettings({
    retentionDays: config?.retentionDays,
    notifications: config?.notifications
  }, fallback)
}

export function applyRuntimeSettingsToConfig(config, settings) {
  const normalized = normalizeRuntimeSettings(settings, readRuntimeSettingsFromConfig(config))
  config.retentionDays = normalized.retentionDays
  config.notifications = normalized.notifications
  return normalized
}
