import { computed, ref } from 'vue'

export const NOTIFICATION_ACCESS_DISMISS_KEY = 'rootgrid.notification-access-dismissed'

export function readStoredNotificationAccessDismissed(storageObj = globalThis.localStorage) {
  try {
    return storageObj?.getItem?.(NOTIFICATION_ACCESS_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function writeStoredNotificationAccessDismissed(value, storageObj = globalThis.localStorage) {
  try {
    if (value) storageObj?.setItem?.(NOTIFICATION_ACCESS_DISMISS_KEY, '1')
    else storageObj?.removeItem?.(NOTIFICATION_ACCESS_DISMISS_KEY)
  } catch {
  }
}

export function shouldShowNotificationAccessPrompt({
  previousStepComplete,
  supported,
  permission,
  dismissed,
  enabled = false,
  ready = true
}) {
  return Boolean(previousStepComplete && supported && ready && !enabled && permission !== 'denied' && !dismissed)
}

export function createNotificationAccessPromptActions({
  previousStepComplete,
  notificationSupported,
  notificationPermission,
  notificationEnabled,
  notificationReady,
  localStorageObj = globalThis.localStorage
}) {
  const notificationAccessDismissed = ref(readStoredNotificationAccessDismissed(localStorageObj))

  const showNotificationAccessPrompt = computed(() => {
    return shouldShowNotificationAccessPrompt({
      previousStepComplete: previousStepComplete?.value,
      supported: notificationSupported?.value,
      permission: notificationPermission?.value,
      dismissed: notificationAccessDismissed.value,
      enabled: notificationEnabled?.value,
      ready: notificationReady?.value ?? true
    })
  })

  function dismissNotificationAccessPrompt() {
    notificationAccessDismissed.value = true
    writeStoredNotificationAccessDismissed(true, localStorageObj)
  }

  function resetNotificationAccessPrompt() {
    notificationAccessDismissed.value = false
    writeStoredNotificationAccessDismissed(false, localStorageObj)
  }

  return {
    notificationAccessDismissed,
    showNotificationAccessPrompt,
    dismissNotificationAccessPrompt,
    resetNotificationAccessPrompt
  }
}
