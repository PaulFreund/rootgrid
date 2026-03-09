import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'

import {
  createSystemSettingsActions,
  urlBase64ToUint8Array
} from '../web/src/lib/systemSettings.js'

test('urlBase64ToUint8Array decodes URL-safe base64 strings', () => {
  const bytes = urlBase64ToUint8Array('SGVsbG8td29ybGQ')
  assert.equal(Buffer.from(bytes).toString('utf8'), 'Hello-world')
})

test('openSettings loads app settings and refreshes push state for the system tab', async () => {
  let loaded = 0

  const actions = createSystemSettingsActions({
    apiFetch: async () => {
      throw new Error('apiFetch should not be called in this test')
    },
    authed: ref(true),
    appSettingsLoaded: ref(false),
    loadAppSettings: async () => {
      loaded += 1
    },
    settingsTab: ref('defaults'),
    defaultsOpen: ref(false),
    windowObj: { isSecureContext: true, PushManager: function PushManager() {} },
    navigatorObj: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            async getSubscription() {
              return null
            }
          }
        })
      }
    },
    notificationCtor: {
      permission: 'default',
      async requestPermission() {
        return 'default'
      }
    }
  })

  actions.openSettings('system')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(actions.pushStatus.value, 'unsubscribed')
  assert.equal(loaded, 1)
})

test('enablePush requests permission, subscribes, and persists the subscription', async () => {
  let subscription = null
  const requests = []
  const notificationCtor = {
    permission: 'default',
    async requestPermission() {
      this.permission = 'granted'
      return 'granted'
    }
  }

  const actions = createSystemSettingsActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/push/vapid-public-key') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { publicKey: 'SGVsbG8td29ybGQ' }
          }
        }
      }
      if (path === '/api/push/subscribe') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    authed: ref(true),
    appSettingsLoaded: ref(true),
    loadAppSettings: async () => {},
    settingsTab: ref('system'),
    defaultsOpen: ref(true),
    windowObj: { isSecureContext: true, PushManager: function PushManager() {} },
    navigatorObj: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            async getSubscription() {
              return subscription
            },
            async subscribe(params) {
              subscription = {
                endpoint: 'https://push.example.test/sub/1',
                keys: {
                  p256dh: 'p256dh-key',
                  auth: 'auth-key'
                }
              }
              assert.equal(params.userVisibleOnly, true)
              assert.ok(params.applicationServerKey instanceof Uint8Array)
              return subscription
            }
          }
        })
      }
    },
    notificationCtor
  })

  const ok = await actions.enablePush()

  assert.equal(ok, true)
  assert.equal(actions.notificationPermission.value, 'granted')
  assert.equal(actions.pushStatus.value, 'subscribed')
  assert.equal(actions.pushEndpoint.value, 'https://push.example.test/sub/1')
  assert.deepEqual(requests.map((req) => req.path), [
    '/api/push/vapid-public-key',
    '/api/push/subscribe'
  ])
})

test('autoEnablePushOnLoad silently subscribes when push is preferred', async () => {
  let subscription = null
  let subscribeCalls = 0

  const actions = createSystemSettingsActions({
    apiFetch: async (path) => {
      if (path === '/api/push/vapid-public-key') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { publicKey: 'SGVsbG8td29ybGQ' }
          }
        }
      }
      if (path === '/api/push/subscribe') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    authed: ref(true),
    appSettings: {
      notifications: {
        webPush: 'if-not-visible'
      }
    },
    appSettingsLoaded: ref(true),
    loadAppSettings: async () => {},
    settingsTab: ref('defaults'),
    defaultsOpen: ref(false),
    windowObj: { isSecureContext: true, PushManager: function PushManager() {} },
    navigatorObj: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            async getSubscription() {
              return subscription
            },
            async subscribe() {
              subscribeCalls += 1
              subscription = {
                endpoint: 'https://push.example.test/sub/auto',
                keys: {
                  p256dh: 'p256dh-key',
                  auth: 'auth-key'
                }
              }
              return subscription
            }
          }
        })
      }
    },
    notificationCtor: {
      permission: 'granted',
      async requestPermission() {
        return 'granted'
      }
    }
  })

  const ok = await actions.autoEnablePushOnLoad()
  assert.equal(ok, true)
  assert.equal(subscribeCalls, 1)
  assert.equal(actions.pushStatus.value, 'subscribed')
  assert.equal(actions.pushError.value, '')
})

test('autoEnablePushOnLoad does nothing when web push policy is never', async () => {
  let apiCalls = 0

  const actions = createSystemSettingsActions({
    apiFetch: async () => {
      apiCalls += 1
      throw new Error('should not be called')
    },
    authed: ref(true),
    appSettings: {
      notifications: {
        webPush: 'never'
      }
    },
    appSettingsLoaded: ref(true),
    loadAppSettings: async () => {},
    settingsTab: ref('defaults'),
    defaultsOpen: ref(false),
    windowObj: { isSecureContext: true, PushManager: function PushManager() {} },
    navigatorObj: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            async getSubscription() {
              return null
            }
          }
        })
      }
    },
    notificationCtor: {
      permission: 'granted',
      async requestPermission() {
        return 'granted'
      }
    }
  })

  const ok = await actions.autoEnablePushOnLoad()
  assert.equal(ok, false)
  assert.equal(apiCalls, 0)
})
