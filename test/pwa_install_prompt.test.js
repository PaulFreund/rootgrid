import test from 'node:test'
import assert from 'node:assert/strict'

import {
  browserSupportsPwaInstallPrompt,
  createPwaInstallPromptActions,
  isStandaloneDisplay,
  shouldShowPwaInstallPrompt
} from '../web/src/lib/pwaInstallPrompt.js'

function createWindowStub({ installPromptSupported = false } = {}) {
  const listeners = new Map()
  const windowObj = {
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type)
    },
    dispatch(type, event = {}) {
      const handler = listeners.get(type)
      if (handler) handler(event)
    },
    matchMedia() {
      return { matches: false }
    }
  }
  if (installPromptSupported) windowObj.onbeforeinstallprompt = null
  return windowObj
}

function createStorageStub() {
  const values = new Map()
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    }
  }
}

test('browserSupportsPwaInstallPrompt detects native install-prompt support', () => {
  assert.equal(browserSupportsPwaInstallPrompt({
    windowObj: { onbeforeinstallprompt: null }
  }), true)
  assert.equal(browserSupportsPwaInstallPrompt({
    windowObj: {}
  }), false)
})

test('shouldShowPwaInstallPrompt only shows when native install prompting is available', () => {
  assert.equal(shouldShowPwaInstallPrompt({
    supported: true,
    canPrompt: true,
    installed: false,
    dismissed: false
  }), true)
  assert.equal(shouldShowPwaInstallPrompt({
    supported: false,
    canPrompt: false,
    installed: false,
    dismissed: false
  }), false)
  assert.equal(shouldShowPwaInstallPrompt({
    supported: true,
    canPrompt: false,
    installed: false,
    dismissed: false
  }), false)
  assert.equal(shouldShowPwaInstallPrompt({
    supported: true,
    canPrompt: true,
    installed: true,
    dismissed: false
  }), false)
  assert.equal(shouldShowPwaInstallPrompt({
    supported: true,
    canPrompt: true,
    installed: false,
    dismissed: true
  }), false)
})

test('isStandaloneDisplay detects standalone browser modes', () => {
  assert.equal(isStandaloneDisplay({
    windowObj: {
      matchMedia(query) {
        return { matches: query === '(display-mode: standalone)' }
      }
    },
    navigatorObj: {}
  }), true)

  assert.equal(isStandaloneDisplay({
    windowObj: {
      matchMedia() {
        return { matches: false }
      }
    },
    navigatorObj: { standalone: true }
  }), true)
})

test('createPwaInstallPromptActions captures and triggers beforeinstallprompt', async () => {
  const windowObj = createWindowStub({ installPromptSupported: true })
  const localStorageObj = createStorageStub()
  let prompted = 0

  const actions = createPwaInstallPromptActions({
    windowObj,
    navigatorObj: { userAgent: 'Android Chrome' },
    localStorageObj
  })

  actions.attachPwaInstallPrompt()

  const promptEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
    async prompt() {
      prompted += 1
    },
    userChoice: Promise.resolve({ outcome: 'accepted' })
  }
  windowObj.dispatch('beforeinstallprompt', promptEvent)

  assert.equal(promptEvent.prevented, true)
  assert.equal(actions.showPwaInstallPrompt.value, true)
  assert.equal(actions.pwaInstallCanPrompt.value, true)

  const ok = await actions.triggerPwaInstallPrompt()
  assert.equal(ok, true)
  assert.equal(prompted, 1)
  assert.equal(actions.pwaInstallDismissed.value, true)
  assert.equal(localStorageObj.getItem('rootgrid.pwa-install-dismissed'), '1')

  actions.dismissPwaInstallPrompt()
  assert.equal(actions.showPwaInstallPrompt.value, false)

  actions.disposePwaInstallPrompt()
})

test('createPwaInstallPromptActions hides the install banner on unsupported browsers', () => {
  const actions = createPwaInstallPromptActions({
    windowObj: createWindowStub(),
    navigatorObj: { userAgent: 'Firefox Desktop' },
    localStorageObj: createStorageStub()
  })

  assert.equal(actions.pwaInstallSupported.value, false)
  assert.equal(actions.pwaInstallCanPrompt.value, false)
  assert.equal(actions.showPwaInstallPrompt.value, false)
})

test('createPwaInstallPromptActions hides the install banner on iOS without native prompt support', () => {
  const actions = createPwaInstallPromptActions({
    windowObj: createWindowStub(),
    navigatorObj: { userAgent: 'iPhone' },
    localStorageObj: createStorageStub()
  })

  assert.equal(actions.pwaInstallSupported.value, false)
  assert.equal(actions.showPwaInstallPrompt.value, false)
})
