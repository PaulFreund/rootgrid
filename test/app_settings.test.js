import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'

import {
  createAppSettingsActions,
  normalizeAppSettingsPayload,
  validateAppSettingsDraft
} from '../web/src/lib/appSettings.js'

test('normalizeAppSettingsPayload applies defaults for invalid values', () => {
  const out = normalizeAppSettingsPayload({
    appVersion: '1.2.3',
    retentionDays: 0,
    notifications: {
      sseToasts: 'always',
      webPush: 'bad-value'
    },
    host: { url: 'http://127.0.0.1:7337' }
  }, {
    retentionDays: 45,
    notifications: {
      sseToasts: 'if-not-visible',
      webPush: 'never'
    },
    runner: { kind: 'local' }
  })

  assert.equal(out.retentionDays, 45)
  assert.equal(out.appVersion, '1.2.3')
  assert.deepEqual(out.notifications, {
    sseToasts: 'always',
    webPush: 'never'
  })
  assert.deepEqual(out.host, { url: 'http://127.0.0.1:7337' })
  assert.deepEqual(out.runner, { kind: 'local' })
})

test('validateAppSettingsDraft rejects invalid retention days and notification policies', () => {
  assert.equal(
    validateAppSettingsDraft({
      retentionDraft: '0',
      sseToastsDraft: 'always',
      webPushDraft: 'never'
    }).error,
    'Retention days must be an integer between 1 and 3650.'
  )

  assert.equal(
    validateAppSettingsDraft({
      retentionDraft: '30',
      sseToastsDraft: 'sometimes',
      webPushDraft: 'never'
    }).error,
    'Notification policy must be Always/Never/If not visible.'
  )

  const ok = validateAppSettingsDraft({
    retentionDraft: '30',
    sseToastsDraft: 'if-not-visible',
    webPushDraft: 'always'
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.payload, {
    retentionDays: 30,
    notifications: {
      sseToasts: 'if-not-visible',
      webPush: 'always'
    }
  })
})

test('createAppSettingsActions login loads settings and connects SSE on success', async () => {
  const authed = ref(false)
  const authToken = ref('secret-token')
  const authError = ref('')
  const appSettings = reactive({
    appVersion: null,
    retentionDays: 30,
    notifications: { sseToasts: 'if-not-visible', webPush: 'if-not-visible' },
    host: null,
    runner: null
  })
  const appSettingsLoaded = ref(false)
  const appSettingsError = ref('')
  const appSettingsSaving = ref(false)
  const retentionDraft = ref('')
  const sseToastsDraft = ref('if-not-visible')
  const webPushDraft = ref('if-not-visible')
  const requests = []
  let connected = 0

  const { login } = createAppSettingsActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/auth') {
        return {
          ok: true,
          status: 200,
          async json() { return { ok: true } }
        }
      }
      if (path === '/api/settings') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              appVersion: '9.9.9',
              retentionDays: 14,
              notifications: {
                sseToasts: 'always',
                webPush: 'never'
              },
              host: { bind: '127.0.0.1' },
              runner: { mode: 'local' }
            }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    authed,
    authToken,
    authError,
    appSettings,
    appSettingsLoaded,
    appSettingsError,
    appSettingsSaving,
    retentionDraft,
    sseToastsDraft,
    webPushDraft,
    onLogin: () => { connected += 1 }
  })

  const ok = await login()

  assert.equal(ok, true)
  assert.equal(authed.value, true)
  assert.equal(authError.value, '')
  assert.equal(appSettingsLoaded.value, true)
  assert.equal(appSettings.appVersion, '9.9.9')
  assert.equal(appSettings.retentionDays, 14)
  assert.deepEqual(appSettings.notifications, {
    sseToasts: 'always',
    webPush: 'never'
  })
  assert.equal(retentionDraft.value, '14')
  assert.equal(sseToastsDraft.value, 'always')
  assert.equal(webPushDraft.value, 'never')
  assert.equal(connected, 1)
  assert.deepEqual(requests.map((req) => req.path), ['/api/auth', '/api/settings'])
})

test('createAppSettingsActions starts host self-update and keeps the working flag set while restart is pending', async () => {
  const hostSelfUpdateWorking = ref(false)
  const hostSelfUpdateError = ref('')
  const hostSelfUpdateStatus = ref('')

  const { startHostSelfUpdate } = createAppSettingsActions({
    apiFetch: async (path, init = {}) => {
      assert.equal(path, '/api/host/self-update')
      assert.equal(init.method, 'POST')
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, message: 'Host update succeeded. Rootgrid is restarting.' }
        }
      }
    },
    authed: ref(true),
    authToken: ref(''),
    authError: ref(''),
    appSettings: reactive({
      appVersion: '1.2.3',
      retentionDays: 30,
      notifications: { sseToasts: 'if-not-visible', webPush: 'if-not-visible' },
      host: null,
      runner: null
    }),
    appSettingsLoaded: ref(true),
    appSettingsError: ref(''),
    appSettingsSaving: ref(false),
    retentionDraft: ref('30'),
    sseToastsDraft: ref('if-not-visible'),
    webPushDraft: ref('if-not-visible'),
    hostSelfUpdateWorking,
    hostSelfUpdateError,
    hostSelfUpdateStatus
  })

  const ok = await startHostSelfUpdate()

  assert.equal(ok, true)
  assert.equal(hostSelfUpdateError.value, '')
  assert.equal(hostSelfUpdateStatus.value, 'Host update succeeded. Rootgrid is restarting.')
  assert.equal(hostSelfUpdateWorking.value, true)
})
