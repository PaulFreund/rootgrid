import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionDraftOptions,
  chooseInitialNewThreadMachine,
  validateNewThreadSelection
} from '../web/src/lib/newThreadDialog.js'

test('buildSessionDraftOptions trims optional fields and keeps policy defaults', () => {
  const options = buildSessionDraftOptions({
    model: ' gpt-5 ',
    reasoningEffort: ' medium ',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })

  assert.deepEqual(options, {
    model: 'gpt-5',
    reasoningEffort: 'medium',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
})

test('chooseInitialNewThreadMachine prefers online default machine and falls back to first selectable', () => {
  const machineIsOnline = (m) => Boolean(m?.online)

  assert.equal(chooseInitialNewThreadMachine({
    preferredMachineId: 'm-2',
    machines: [
      { machineId: 'm-1', online: true },
      { machineId: 'm-2', online: true }
    ],
    machinesForSelect: [{ machineId: 'm-1' }],
    machineIsOnline
  }), 'm-2')

  assert.equal(chooseInitialNewThreadMachine({
    preferredMachineId: 'm-2',
    machines: [
      { machineId: 'm-2', online: false }
    ],
    machinesForSelect: [{ machineId: 'm-1' }],
    machineIsOnline
  }), 'm-1')
})

test('validateNewThreadSelection enforces machine, connectivity, and workspace', () => {
  assert.equal(validateNewThreadSelection({ machineId: '', machineOnline: true, cwd: '/work' }), 'Machine is required.')
  assert.equal(validateNewThreadSelection({ machineId: 'm-1', machineOnline: false, cwd: '/work' }), 'Runner not connected for this machine. Choose an online machine.')
  assert.equal(validateNewThreadSelection({ machineId: 'm-1', machineOnline: true, cwd: '' }), 'Workspace is required.')
  assert.equal(validateNewThreadSelection({ machineId: 'm-1', machineOnline: true, cwd: '/work' }), '')
})
