import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'

import {
  createPwaInstallPromptActions,
  isStandaloneDisplay,
  shouldShowPwaInstallPrompt
} from '../web/src/lib/pwaInstallPrompt.js'

function createWindowStub() {
  const listeners = new Map()
  return {
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

test('shouldShowPwaInstallPrompt only shows on mobile when not installed or dismissed', () => {
  assert.equal(shouldShowPwaInstallPrompt({
    isMobileLayout: true,
    installed: false,
    dismissed: false
  }), true)
  assert.equal(shouldShowPwaInstallPrompt({
    isMobileLayout: false,
    installed: false,
    dismissed: false
  }), false)
  assert.equal(shouldShowPwaInstallPrompt({
    isMobileLayout: true,
    installed: true,
    dismissed: false
  }), false)
  assert.equal(shouldShowPwaInstallPrompt({
    isMobileLayout: true,
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
  const windowObj = createWindowStub()
  const localStorageObj = createStorageStub()
  const isMobileLayout = ref(true)
  let prompted = 0

  const actions = createPwaInstallPromptActions({
    isMobileLayout,
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

  actions.dismissPwaInstallPrompt()
  assert.equal(actions.showPwaInstallPrompt.value, false)

  actions.disposePwaInstallPrompt()
})

test('createPwaInstallPromptActions shows manual install copy on iOS without prompt support', () => {
  const actions = createPwaInstallPromptActions({
    isMobileLayout: ref(true),
    windowObj: createWindowStub(),
    navigatorObj: { userAgent: 'iPhone' },
    localStorageObj: createStorageStub()
  })

  assert.equal(actions.showPwaInstallPrompt.value, true)
  assert.equal(actions.pwaInstallCanPrompt.value, false)
  assert.equal(actions.pwaInstallMessage.value.includes('Add to Home Screen'), true)
})
