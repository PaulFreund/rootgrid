import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'

import {
  createNotificationAccessPromptActions,
  shouldShowNotificationAccessPrompt
} from '../web/src/lib/notificationAccessPrompt.js'

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

test('shouldShowNotificationAccessPrompt only shows after the install prompt flow is complete', () => {
  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: true,
    supported: true,
    permission: 'default',
    dismissed: false,
    enabled: false,
    ready: true
  }), true)

  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: false,
    supported: true,
    permission: 'default',
    dismissed: false,
    enabled: false,
    ready: true
  }), false)

  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: true,
    supported: true,
    permission: 'granted',
    dismissed: false,
    enabled: true,
    ready: true
  }), false)

  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: true,
    supported: false,
    permission: 'default',
    dismissed: false,
    enabled: false,
    ready: true
  }), false)

  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: true,
    supported: true,
    permission: 'granted',
    dismissed: false,
    enabled: false,
    ready: false
  }), false)

  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: true,
    supported: true,
    permission: 'granted',
    dismissed: false,
    enabled: false,
    ready: true
  }), true)

  assert.equal(shouldShowNotificationAccessPrompt({
    previousStepComplete: true,
    supported: true,
    permission: 'denied',
    dismissed: false,
    enabled: false,
    ready: true
  }), false)
})

test('createNotificationAccessPromptActions persists dismissals locally', () => {
  const storage = createStorageStub()
  const notificationEnabled = ref(false)
  const notificationReady = ref(true)
  const actions = createNotificationAccessPromptActions({
    previousStepComplete: ref(true),
    notificationSupported: ref(true),
    notificationPermission: ref('default'),
    notificationEnabled,
    notificationReady,
    localStorageObj: storage
  })

  assert.equal(actions.showNotificationAccessPrompt.value, true)
  actions.dismissNotificationAccessPrompt()
  assert.equal(actions.showNotificationAccessPrompt.value, false)
  assert.equal(storage.getItem('rootgrid.notification-access-dismissed'), '1')

  actions.resetNotificationAccessPrompt()
  assert.equal(actions.showNotificationAccessPrompt.value, true)
  assert.equal(storage.getItem('rootgrid.notification-access-dismissed'), null)

  notificationEnabled.value = true
  assert.equal(actions.showNotificationAccessPrompt.value, false)
})
