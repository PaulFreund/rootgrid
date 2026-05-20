import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'

import { createMachineToolActions } from '../web/src/lib/machineTools.js'

test('machine tool actions load and upgrade runner tools per machine', async () => {
  const requests = []
  const machineToolsByMachineId = reactive({})
  const machineToolsLoadingByMachineId = reactive({})
  const machineToolsErrorByMachineId = reactive({})
  const machineToolUpgradeWorking = reactive({})
  const machineToolUpgradeError = reactive({})
  const machineToolUpgradeStatus = reactive({})
  const machineToolAuthWorking = reactive({})
  const machineToolAuthError = reactive({})
  const machineToolAuthStatus = reactive({})

  const { loadMachineTools, upgradeMachineTool, authMachineTool } = createMachineToolActions({
    apiFetch: async (path, init = {}) => {
      requests.push({ path, init })
      if (path === '/api/machines/machine-1/tools') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              tools: {
                codex: { id: 'codex', label: 'Codex', version: 'codex-cli 1.2.3', installed: true, auth: { status: 'reauth-required' } }
              }
            }
          }
        }
      }
      if (path === '/api/machines/machine-1/tools/codex/upgrade') {
        assert.equal(init.method, 'POST')
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              message: 'Codex is now codex-cli 9.9.9.',
              tools: {
                codex: { id: 'codex', label: 'Codex', version: 'codex-cli 9.9.9', installed: true, auth: { status: 'reauth-required' } }
              }
            }
          }
        }
      }
      if (path === '/api/machines/machine-1/tools/codex/auth') {
        assert.equal(init.method, 'POST')
        const body = JSON.parse(String(init.body ?? '{}'))
        if (body.action === 'refresh') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                message: 'Codex sign-in state was refreshed.',
                tools: {
                  codex: {
                    id: 'codex',
                    label: 'Codex',
                    version: 'codex-cli 9.9.9',
                    installed: true,
                    auth: { status: 'authenticated', provider: 'ChatGPT' }
                  }
                }
              }
            }
          }
        }
        assert.equal(body.action, 'startDeviceAuth')
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              message: 'ChatGPT sign-in for Codex started on this runner.',
              tools: {
                codex: {
                  id: 'codex',
                  label: 'Codex',
                  version: 'codex-cli 9.9.9',
                  installed: true,
                  auth: {
                    status: 'pending-browser-auth',
                    flow: {
                      active: true,
                      method: 'device-auth',
                      verificationUrl: 'https://auth.openai.com/activate',
                      userCode: 'ABCD-EFGH'
                    }
                  }
                }
              }
            }
          }
        }
      }
      throw new Error(`unexpected request: ${path}`)
    },
    machineToolsByMachineId,
    machineToolsLoadingByMachineId,
    machineToolsErrorByMachineId,
    machineToolUpgradeWorking,
    machineToolUpgradeError,
    machineToolUpgradeStatus,
    machineToolAuthWorking,
    machineToolAuthError,
    machineToolAuthStatus
  })

  const loaded = await loadMachineTools('machine-1')
  const upgraded = await upgradeMachineTool('machine-1', 'codex')
  const started = await authMachineTool('machine-1', 'codex', 'startDeviceAuth')
  const rechecked = await authMachineTool('machine-1', 'codex', 'refresh')

  assert.equal(loaded?.codex?.version, 'codex-cli 1.2.3')
  assert.equal(upgraded, true)
  assert.equal(started, true)
  assert.equal(rechecked, true)
  assert.equal(machineToolsByMachineId['machine-1']?.codex?.version, 'codex-cli 9.9.9')
  assert.equal(machineToolUpgradeStatus['machine-1:codex'], 'Codex is now codex-cli 9.9.9.')
  assert.equal(machineToolAuthStatus['machine-1:codex'], 'Codex sign-in state was refreshed.')
  assert.equal(machineToolsByMachineId['machine-1']?.codex?.auth?.status, 'authenticated')
  assert.equal(machineToolUpgradeWorking['machine-1:codex'], false)
  assert.deepEqual(requests.map((req) => req.path), [
    '/api/machines/machine-1/tools',
    '/api/machines/machine-1/tools/codex/upgrade',
    '/api/machines/machine-1/tools/codex/auth',
    '/api/machines/machine-1/tools/codex/auth'
  ])
})
