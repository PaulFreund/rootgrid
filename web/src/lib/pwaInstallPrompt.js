import { computed, ref } from 'vue'

export const PWA_INSTALL_DISMISS_KEY = 'rootgrid.pwa-install-dismissed'

export function isStandaloneDisplay({
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator
} = {}) {
  try {
    if (windowObj?.matchMedia?.('(display-mode: standalone)')?.matches) return true
  } catch {
  }
  try {
    if (windowObj?.matchMedia?.('(display-mode: fullscreen)')?.matches) return true
  } catch {
  }
  try {
    if (navigatorObj?.standalone === true) return true
  } catch {
  }
  return false
}

export function isLikelyIosBrowser({
  navigatorObj = globalThis.navigator
} = {}) {
  const ua = String(navigatorObj?.userAgent ?? '')
  const platform = String(navigatorObj?.platform ?? '')
  if (!ua && !platform) return false
  return /iPad|iPhone|iPod/i.test(ua) || /iPad|iPhone|iPod/i.test(platform)
}

export function readStoredPwaInstallDismissed(storageObj = globalThis.localStorage) {
  try {
    return storageObj?.getItem?.(PWA_INSTALL_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function writeStoredPwaInstallDismissed(value, storageObj = globalThis.localStorage) {
  try {
    if (value) storageObj?.setItem?.(PWA_INSTALL_DISMISS_KEY, '1')
    else storageObj?.removeItem?.(PWA_INSTALL_DISMISS_KEY)
  } catch {
  }
}

export function shouldShowPwaInstallPrompt({
  isMobileLayout,
  installed,
  dismissed
}) {
  return Boolean(isMobileLayout && !installed && !dismissed)
}

export function createPwaInstallPromptActions({
  isMobileLayout,
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  localStorageObj = globalThis.localStorage
}) {
  const deferredPrompt = ref(null)
  const pwaInstalled = ref(isStandaloneDisplay({ windowObj, navigatorObj }))
  const pwaInstallDismissed = ref(readStoredPwaInstallDismissed(localStorageObj))
  const pwaInstallWorking = ref(false)

  let beforeInstallPromptHandler = null
  let appInstalledHandler = null

  const pwaInstallCanPrompt = computed(() => Boolean(deferredPrompt.value))
  const pwaInstallManualOnly = computed(() => isLikelyIosBrowser({ navigatorObj }) && !pwaInstallCanPrompt.value)
  const pwaInstallMessage = computed(() => {
    if (pwaInstallCanPrompt.value) return 'Install Rootgrid for faster access and better mobile notifications.'
    if (pwaInstallManualOnly.value) return 'Install Rootgrid from Safari using Share → Add to Home Screen.'
    return 'Install Rootgrid from your browser menu for a better mobile experience.'
  })
  const showPwaInstallPrompt = computed(() => {
    return shouldShowPwaInstallPrompt({
      isMobileLayout: isMobileLayout?.value,
      installed: pwaInstalled.value,
      dismissed: pwaInstallDismissed.value
    })
  })

  function refreshPwaInstalledState() {
    const installed = isStandaloneDisplay({ windowObj, navigatorObj })
    pwaInstalled.value = installed
    if (installed) {
      pwaInstallDismissed.value = false
      writeStoredPwaInstallDismissed(false, localStorageObj)
    }
    return installed
  }

  function dismissPwaInstallPrompt() {
    pwaInstallDismissed.value = true
    writeStoredPwaInstallDismissed(true, localStorageObj)
  }

  function attachPwaInstallPrompt() {
    refreshPwaInstalledState()
    if (!windowObj?.addEventListener) return
    beforeInstallPromptHandler = (event) => {
      try { event?.preventDefault?.() } catch {
      }
      deferredPrompt.value = event ?? null
    }
    appInstalledHandler = () => {
      deferredPrompt.value = null
      refreshPwaInstalledState()
    }
    try { windowObj.addEventListener('beforeinstallprompt', beforeInstallPromptHandler) } catch {
    }
    try { windowObj.addEventListener('appinstalled', appInstalledHandler) } catch {
    }
  }

  function disposePwaInstallPrompt() {
    if (!windowObj?.removeEventListener) return
    if (beforeInstallPromptHandler) {
      try { windowObj.removeEventListener('beforeinstallprompt', beforeInstallPromptHandler) } catch {
      }
    }
    if (appInstalledHandler) {
      try { windowObj.removeEventListener('appinstalled', appInstalledHandler) } catch {
      }
    }
    beforeInstallPromptHandler = null
    appInstalledHandler = null
  }

  async function triggerPwaInstallPrompt() {
    const prompt = deferredPrompt.value
    if (!prompt?.prompt) return false
    pwaInstallWorking.value = true
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice?.catch(() => null)
      deferredPrompt.value = null
      if (choice?.outcome === 'accepted') {
        refreshPwaInstalledState()
        return true
      }
      return false
    } finally {
      pwaInstallWorking.value = false
    }
  }

  return {
    pwaInstallCanPrompt,
    pwaInstallDismissed,
    pwaInstalled,
    pwaInstallManualOnly,
    pwaInstallMessage,
    pwaInstallWorking,
    showPwaInstallPrompt,
    refreshPwaInstalledState,
    dismissPwaInstallPrompt,
    attachPwaInstallPrompt,
    disposePwaInstallPrompt,
    triggerPwaInstallPrompt
  }
}
