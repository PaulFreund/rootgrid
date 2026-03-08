import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'

import {
  createMachineControlActions,
  resolveIdeSessionRequest
} from '../web/src/lib/machineControls.js'

test('resolveIdeSessionRequest prefers the selected session workspace and machine', () => {
  const resolved = resolveIdeSessionRequest({
    selectedSession: {
      cwd: '/session/workspace',
      machineId: 'machine-session'
    },
    defaults: {
      cwd: '/default/workspace',
      machineId: 'machine-default'
    }
  })

  assert.deepEqual(resolved, {
    ok: true,
    body: {
      cwd: '/session/workspace',
      machineId: 'machine-session'
    }
  })
})

test('openVSCode launches IDE for the selected session even if defaults cwd is empty', async () => {
  const opened = []
  const navigated = []
  const ideError = ref('')
  const ideStarting = ref(false)

  const { openVSCode } = createMachineControlActions({
    apiFetch: async (path, init = {}) => {
      assert.equal(path, '/api/ide-sessions')
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), {
        cwd: '/session/workspace',
        machineId: 'machine-1'
      })
      return {
        ok: true,
        status: 200,
        async json() {
          return { urlPath: '/ide/session-1/' }
        }
      }
    },
    defaults: reactive({
      cwd: '',
      machineId: '',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    openSettings: () => {
      throw new Error('openSettings should not be called when session cwd exists')
    },
    selectedSession: ref({
      cwd: '/session/workspace',
      machineId: 'machine-1'
    }),
    machineDisconnectWorkingId: ref(null),
    machineDisconnectError: ref(''),
    machineUpgradeWorkingId: ref(null),
    machineUpgradeError: ref(''),
    ideError,
    ideStarting,
    windowObj: {
      open: (...args) => {
        opened.push(args)
        return {
          document: {
            title: '',
            body: { innerHTML: '' }
          },
          location: {
            replace: (value) => navigated.push(value)
          }
        }
      }
    }
  })

  const ok = await openVSCode()

  assert.equal(ok, true)
  assert.equal(ideError.value, '')
  assert.equal(ideStarting.value, false)
  assert.deepEqual(opened, [['', '_blank']])
  assert.deepEqual(navigated, ['/ide/session-1/'])
})

test('openVSCode closes the pending tab when the IDE session start fails', async () => {
  const opened = []
  const closed = []
  const ideError = ref('')
  const ideStarting = ref(false)

  const { openVSCode } = createMachineControlActions({
    apiFetch: async () => ({
      ok: false,
      status: 503,
      async json() {
        return { error: 'runner not connected' }
      }
    }),
    defaults: reactive({
      cwd: '/default/workspace',
      machineId: 'machine-1',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    openSettings: () => {},
    selectedSession: ref(null),
    machineDisconnectWorkingId: ref(null),
    machineDisconnectError: ref(''),
    machineUpgradeWorkingId: ref(null),
    machineUpgradeError: ref(''),
    ideError,
    ideStarting,
    windowObj: {
      open: (...args) => {
        opened.push(args)
        return {
          document: {
            title: '',
            body: { innerHTML: '' }
          },
          close: () => closed.push(true),
          location: {
            replace: () => {}
          }
        }
      }
    }
  })

  const ok = await openVSCode()

  assert.equal(ok, false)
  assert.equal(ideError.value, 'runner not connected')
  assert.equal(ideStarting.value, false)
  assert.deepEqual(opened, [['', '_blank']])
  assert.deepEqual(closed, [true])
})

test('openVSCode reports IDE session metadata to the caller when embedding in-app', async () => {
  const started = []
  const ideError = ref('')
  const ideStarting = ref(false)

  const { openVSCode } = createMachineControlActions({
    apiFetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ideId: 'ide-embedded-1', urlPath: '/vscode/ide-embedded-1/' }
      }
    }),
    defaults: reactive({
      cwd: '/embedded/workspace',
      machineId: 'machine-embedded',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    openSettings: () => {},
    selectedSession: ref(null),
    machineDisconnectWorkingId: ref(null),
    machineDisconnectError: ref(''),
    machineUpgradeWorkingId: ref(null),
    machineUpgradeError: ref(''),
    ideError,
    ideStarting,
    onIdeSessionStarted: (info) => started.push(info),
    windowObj: {
      open: () => {
        throw new Error('window.open should not be used for embedded IDE mode')
      }
    }
  })

  const ok = await openVSCode()

  assert.equal(ok, true)
  assert.deepEqual(started, [{
    ideId: 'ide-embedded-1',
    urlPath: '/vscode/ide-embedded-1/',
    cwd: '/embedded/workspace',
    machineId: 'machine-embedded'
  }])
})

test('disconnectMachine surfaces HTTP failures and clears the working flag', async () => {
  const machineDisconnectWorkingId = ref(null)
  const machineDisconnectError = ref('')

  const { disconnectMachine } = createMachineControlActions({
    apiFetch: async () => {
      return {
        ok: false,
        status: 404,
        async json() {
          return { error: 'runner not connected' }
        }
      }
    },
    defaults: reactive({
      cwd: '',
      machineId: '',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    openSettings: () => {},
    selectedSession: ref(null),
    machineDisconnectWorkingId,
    machineDisconnectError,
    machineUpgradeWorkingId: ref(null),
    machineUpgradeError: ref(''),
    ideError: ref(''),
    ideStarting: ref(false)
  })

  const ok = await disconnectMachine('machine-offline')

  assert.equal(ok, false)
  assert.equal(machineDisconnectError.value, 'runner not connected')
  assert.equal(machineDisconnectWorkingId.value, null)
})

test('upgradeMachine posts the host version and clears the working flag', async () => {
  const machineUpgradeWorkingId = ref(null)
  const machineUpgradeError = ref('')

  const { upgradeMachine } = createMachineControlActions({
    apiFetch: async (path, init = {}) => {
      assert.equal(path, '/api/machines/machine-upgrade/upgrade')
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { hostVersion: '1.2.3' })
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true }
        }
      }
    },
    defaults: reactive({
      cwd: '',
      machineId: '',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    openSettings: () => {},
    selectedSession: ref(null),
    machineDisconnectWorkingId: ref(null),
    machineDisconnectError: ref(''),
    machineUpgradeWorkingId,
    machineUpgradeError,
    appSettings: reactive({ appVersion: '1.2.3' }),
    ideError: ref(''),
    ideStarting: ref(false)
  })

  const ok = await upgradeMachine('machine-upgrade')
  assert.equal(ok, true)
  assert.equal(machineUpgradeError.value, '')
  assert.equal(machineUpgradeWorkingId.value, null)
})

test('stopVSCode posts the IDE stop route', async () => {
  const ideError = ref('')
  const { stopVSCode } = createMachineControlActions({
    apiFetch: async (path, init = {}) => {
      assert.equal(path, '/api/ide-sessions/ide-stop-1/stop')
      assert.equal(init.method, 'POST')
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true }
        }
      }
    },
    defaults: reactive({
      cwd: '',
      machineId: '',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    }),
    openSettings: () => {},
    selectedSession: ref(null),
    machineDisconnectWorkingId: ref(null),
    machineDisconnectError: ref(''),
    machineUpgradeWorkingId: ref(null),
    machineUpgradeError: ref(''),
    ideError,
    ideStarting: ref(false)
  })

  const ok = await stopVSCode('ide-stop-1')
  assert.equal(ok, true)
  assert.equal(ideError.value, '')
})
