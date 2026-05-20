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

export function browserSupportsPwaInstallPrompt({
  windowObj = globalThis.window
} = {}) {
  try {
    if ('onbeforeinstallprompt' in (windowObj ?? {})) return true
  } catch {
  }
  try {
    if (typeof windowObj?.BeforeInstallPromptEvent === 'function') return true
  } catch {
  }
  return false
}

export function writeStoredPwaInstallDismissed(value, storageObj = globalThis.localStorage) {
  try {
    if (value) storageObj?.setItem?.(PWA_INSTALL_DISMISS_KEY, '1')
    else storageObj?.removeItem?.(PWA_INSTALL_DISMISS_KEY)
  } catch {
  }
}

export function shouldShowPwaInstallPrompt({
  installed,
  dismissed,
  supported,
  canPrompt
}) {
  return Boolean(supported && canPrompt && !installed && !dismissed)
}

export function createPwaInstallPromptActions({
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  localStorageObj = globalThis.localStorage
}) {
  const deferredPrompt = ref(null)
  const pwaInstalled = ref(isStandaloneDisplay({ windowObj, navigatorObj }))
  const pwaInstallDismissed = ref(readStoredPwaInstallDismissed(localStorageObj))
  const pwaInstallWorking = ref(false)
  const pwaInstallInstructionsVisible = ref(false)

  let beforeInstallPromptHandler = null
  let appInstalledHandler = null

  const pwaInstallSupported = computed(() => browserSupportsPwaInstallPrompt({ windowObj }))
  const pwaInstallCanPrompt = computed(() => Boolean(deferredPrompt.value))
  const pwaInstallManualOnly = computed(() => isLikelyIosBrowser({ navigatorObj }) && !pwaInstallCanPrompt.value)
  const pwaInstallActionLabel = computed(() => 'Install')
  const pwaInstallMessage = computed(() => {
    if (pwaInstallCanPrompt.value) return 'Install Rootgrid for faster access and app-like behavior.'
    if (pwaInstallManualOnly.value) return 'Install Rootgrid from Safari using Share → Add to Home Screen.'
    return 'Install Rootgrid from your browser menu for faster access.'
  })
  const pwaInstallInstructions = computed(() => {
    if (pwaInstallManualOnly.value) {
      return 'Open the Share menu in Safari, then choose Add to Home Screen.'
    }
    return 'Open your browser menu and choose Install app, Add to Home Screen, or Create shortcut.'
  })
  const showPwaInstallPrompt = computed(() => {
    return shouldShowPwaInstallPrompt({
      installed: pwaInstalled.value,
      dismissed: pwaInstallDismissed.value,
      supported: pwaInstallSupported.value,
      canPrompt: pwaInstallCanPrompt.value
    })
  })

  function refreshPwaInstalledState() {
    const installed = isStandaloneDisplay({ windowObj, navigatorObj })
    pwaInstalled.value = installed
    if (installed) {
      pwaInstallDismissed.value = true
      pwaInstallInstructionsVisible.value = false
      writeStoredPwaInstallDismissed(true, localStorageObj)
    }
    return installed
  }

  function dismissPwaInstallPrompt() {
    pwaInstallDismissed.value = true
    pwaInstallInstructionsVisible.value = false
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
    if (!prompt?.prompt) {
      pwaInstallInstructionsVisible.value = !pwaInstallInstructionsVisible.value
      return false
    }
    pwaInstallWorking.value = true
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice?.catch(() => null)
      deferredPrompt.value = null
      if (choice?.outcome === 'accepted') {
        pwaInstallDismissed.value = true
        writeStoredPwaInstallDismissed(true, localStorageObj)
        pwaInstallInstructionsVisible.value = false
        refreshPwaInstalledState()
        return true
      }
      return false
    } finally {
      pwaInstallWorking.value = false
    }
  }

  return {
    pwaInstallSupported,
    pwaInstallCanPrompt,
    pwaInstallDismissed,
    pwaInstalled,
    pwaInstallManualOnly,
    pwaInstallActionLabel,
    pwaInstallInstructions,
    pwaInstallInstructionsVisible,
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
