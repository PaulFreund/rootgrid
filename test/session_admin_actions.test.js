import test from 'node:test'
import assert from 'node:assert/strict'

import { getMachineDeleteError } from '../web/src/lib/sessionAdminActions.js'

test('getMachineDeleteError blocks deletion for online machines only', () => {
  const machineIsOnline = (m) => Boolean(m?.connected)

  assert.equal(getMachineDeleteError({ machineId: 'm-1', connected: true }, { machineIsOnline }), 'Machine is online. Disconnect the runner before deleting.')
  assert.equal(getMachineDeleteError({ machineId: 'm-1', connected: false }, { machineIsOnline }), '')
  assert.equal(getMachineDeleteError(null, { machineIsOnline }), '')
})
