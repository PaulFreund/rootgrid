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
    ideError,
    ideStarting,
    windowObj: {
      open: (...args) => opened.push(args)
    }
  })

  const ok = await openVSCode()

  assert.equal(ok, true)
  assert.equal(ideError.value, '')
  assert.equal(ideStarting.value, false)
  assert.deepEqual(opened, [['/ide/session-1/', '_blank', 'noopener']])
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
    ideError: ref(''),
    ideStarting: ref(false)
  })

  const ok = await disconnectMachine('machine-offline')

  assert.equal(ok, false)
  assert.equal(machineDisconnectError.value, 'runner not connected')
  assert.equal(machineDisconnectWorkingId.value, null)
})
